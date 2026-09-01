from datetime import datetime, timezone

import pytest

from app.sources import uscg_port_status

FIXTURE = b"""<!doctype html><html><body>
<table>
<thead><tr><th>Port</th><th>Status</th><th>Condition</th><th>Comments</th><th>Last Changed</th></tr></thead>
<tbody>
<tr><td>PR, SAN JUAN</td><td>Open</td><td>FOUR</td><td>Public fixture status</td><td>2026-08-14</td></tr>
<tr><td>PR, MAYAGUEZ</td><td>Open With Restrictions</td><td>WHISKEY</td><td>Public fixture restrictions</td><td>2026-08-15</td></tr>
</tbody></table>
</body></html>"""


def test_zone_endpoint_is_exactly_allowlisted():
    assert uscg_port_status.endpoint("san juan") == "https://navcen.uscg.gov/port-status?zone=SAN+JUAN"
    with pytest.raises(ValueError, match="unsupported"):
        uscg_port_status.endpoint("not-a-real-zone")


def test_port_status_normalizes_observed_table_rows_without_geolocation_inference():
    acquired = datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc)
    events = uscg_port_status.normalize(FIXTURE, "acq-fixture", zone="SAN JUAN", acquired_at=acquired)
    assert len(events) == 2
    first = events[0]
    assert first.source_id == "uscg-port-status"
    assert first.category == "port-operational-status"
    assert first.title == "PR, SAN JUAN — Open"
    assert first.properties["condition"] == "FOUR"
    assert first.properties["time_basis"] == "source-date-only"
    assert first.observed_at.isoformat() == "2026-08-14T00:00:00+00:00"
    assert first.location is None
    assert first.evidence[0].kind.value == "observed"


def test_port_status_ids_are_deterministic_across_acquisitions():
    acquired = datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc)
    first = uscg_port_status.normalize(FIXTURE, "acq-one", zone="SAN JUAN", acquired_at=acquired)
    second = uscg_port_status.normalize(FIXTURE, "acq-two", zone="SAN JUAN", acquired_at=acquired)
    assert [event.id for event in first] == [event.id for event in second]


def test_port_status_falls_back_to_acquisition_time_when_source_date_absent():
    fixture = b"<table><tr><th>Port</th><th>Status</th></tr><tr><td>PR, PONCE</td><td>Open</td></tr></table>"
    acquired = datetime(2026, 9, 2, 12, 34, tzinfo=timezone.utc)
    event = uscg_port_status.normalize(fixture, "acq", zone="SAN JUAN", acquired_at=acquired)[0]
    assert event.observed_at == acquired
    assert event.properties["time_basis"] == "acquisition-time-fallback"


def test_port_status_requires_status_table():
    with pytest.raises(ValueError, match="Port/Status"):
        uscg_port_status.normalize(b"<html><body>No status table</body></html>", "acq", zone="SAN JUAN", acquired_at=datetime.now(timezone.utc))


def test_port_status_rejects_oversized_input():
    with pytest.raises(ValueError, match="2 MiB"):
        uscg_port_status.normalize(b"x" * (uscg_port_status.MAX_RESPONSE_BYTES + 1), "acq", zone="SAN JUAN", acquired_at=datetime.now(timezone.utc))
