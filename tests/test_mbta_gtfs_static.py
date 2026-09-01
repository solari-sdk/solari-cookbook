from __future__ import annotations

import io
import zipfile
from datetime import datetime, timezone
from hashlib import sha256

import pytest

from app.contracts import AcquisitionEnvelope, AcquisitionMethod
from app.sources.mbta_gtfs_static import SOURCE, normalize, parse_gtfs


def _fixture_zip(*, routes: str | None = None, include_feed_info: bool = True) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if include_feed_info:
            archive.writestr(
                "feed_info.txt",
                "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n"
                "MBTA,https://www.mbta.com,EN,20260901,20261231,Autumn 2026 version A\n",
            )
        archive.writestr(
            "routes.txt",
            routes
            or "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color\n"
            "Red,1,Red,Red Line,Rapid transit,1,https://www.mbta.com/schedules/Red,DA291C,FFFFFF\n"
            "1,1,1,Harvard Square - Nubian Station,Bus service,3,https://www.mbta.com/schedules/1,FFC72C,000000\n",
        )
    return output.getvalue()


def _acquisition(raw: bytes) -> AcquisitionEnvelope:
    now = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    return AcquisitionEnvelope(
        id="mbta-test-acquisition",
        source_id=SOURCE.id,
        method=AcquisitionMethod.FEED,
        requested_url="https://cdn.mbta.com/MBTA_GTFS.zip",
        final_url="https://cdn.mbta.com/MBTA_GTFS.zip",
        started_at=now,
        completed_at=now,
        status="success",
        http_status=200,
        content_type="application/zip",
        content_sha256=sha256(raw).hexdigest(),
    )


def test_gtfs_fixture_parses_and_normalizes_planned_routes():
    raw = _fixture_zip()
    feed_info, routes = parse_gtfs(raw)
    assert feed_info["feed_version"] == "Autumn 2026 version A"
    assert [row["route_id"] for row in routes] == ["Red", "1"]

    acquisition = _acquisition(raw)
    events = normalize(feed_info, routes, acquisition)
    assert len(events) == 2
    assert events[0].category == "transportation-schedule-route"
    assert events[0].properties["schedule_only"] is True
    assert events[0].properties["feed_start_date"] == "20260901"
    assert events[0].evidence[0].source_path == "routes.txt.records[0]"
    assert "not a real-time operational observation" in (events[0].evidence[0].note or "")
    assert events[0].id == normalize(feed_info, routes, acquisition)[0].id


def test_gtfs_archive_requires_feed_info():
    with pytest.raises(ValueError, match="missing required"):
        parse_gtfs(_fixture_zip(include_feed_info=False))


def test_gtfs_routes_are_bounded():
    rows = ["route_id,route_short_name,route_long_name,route_type"]
    rows.extend(f"route-{index},{index},Route {index},3" for index in range(2001))
    with pytest.raises(ValueError, match="exceeds 2000 records"):
        parse_gtfs(_fixture_zip(routes="\n".join(rows) + "\n"))
