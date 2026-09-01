from datetime import timezone

import pytest

from app.sources import usdot_wzdx_workzones
from app.sources.registry import SOURCES


def fixture_payload():
    return {
        "type": "FeatureCollection",
        "feed_info": {"publisher": "Fixture public road operator", "version": "4.2"},
        "features": [
            {
                "type": "Feature",
                "id": "work-zone-123",
                "properties": {
                    "core_details": {
                        "data_source_id": "fixture-source",
                        "event_type": "work-zone",
                        "road_names": ["Example Route"],
                        "direction": "northbound",
                        "name": "Example Route maintenance",
                        "description": "Scheduled public road maintenance.",
                        "creation_date": "2026-08-31T12:00:00Z",
                        "update_date": "2026-09-01T12:30:00Z",
                    },
                    "start_date": "2026-09-01T13:00:00Z",
                    "end_date": "2026-09-01T18:00:00Z",
                    "vehicle_impact": "some-lanes-closed",
                    "work_zone_type": "static",
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-104.9903, 39.7392], [-104.9800, 39.7450]],
                },
            }
        ],
    }


def test_wzdx_adapter_is_registered_as_transportation_infrastructure_source():
    assert "usdot-wzdx-workzones" in SOURCES
    source = SOURCES["usdot-wzdx-workzones"]
    assert "transportation" in source.capabilities
    assert "infrastructure" in source.capabilities


def test_wzdx_v42_normalization_preserves_source_semantics_without_severity_inference():
    events = usdot_wzdx_workzones.normalize(fixture_payload(), "acq-fixture")
    assert len(events) == 1
    event = events[0]
    assert event.category == "road-work-zone"
    assert event.source_record_id == "work-zone-123"
    assert event.title == "Example Route maintenance"
    assert event.severity is None
    assert event.observed_at.tzinfo == timezone.utc
    assert event.observed_at.isoformat() == "2026-09-01T12:30:00+00:00"
    assert event.properties["vehicle_impact"] == "some-lanes-closed"
    assert event.properties["work_zone_type"] == "static"
    assert event.location.latitude == pytest.approx(39.7392)
    assert event.location.longitude == pytest.approx(-104.9903)
    assert "first coordinate" in event.location.precision
    assert "no safety severity is inferred" in event.evidence[0].note


def test_wzdx_geometry_uses_first_source_coordinate_not_centroid():
    payload = fixture_payload()
    payload["features"][0]["geometry"] = {
        "type": "MultiLineString",
        "coordinates": [[[-77.0, 38.9], [-76.0, 39.9]], [[-75.0, 40.9], [-74.0, 41.9]]],
    }
    event = usdot_wzdx_workzones.normalize(payload, "acq-fixture")[0]
    assert event.location.longitude == pytest.approx(-77.0)
    assert event.location.latitude == pytest.approx(38.9)


def test_wzdx_bounds_and_required_time_are_enforced():
    with pytest.raises(ValueError, match="FeatureCollection"):
        usdot_wzdx_workzones.normalize({"type": "Feature", "features": []}, "acq")
    oversized = {"type": "FeatureCollection", "features": [{}] * (usdot_wzdx_workzones.MAX_FEATURES + 1)}
    with pytest.raises(ValueError, match="exceeds"):
        usdot_wzdx_workzones.normalize(oversized, "acq")
    payload = fixture_payload()
    core = payload["features"][0]["properties"]["core_details"]
    core.pop("creation_date")
    core.pop("update_date")
    payload["features"][0]["properties"].pop("start_date")
    assert usdot_wzdx_workzones.normalize(payload, "acq") == []


def test_wzdx_public_url_requires_explicit_exact_host_allowlist():
    hosts = usdot_wzdx_workzones._allowed_hosts("data.example.gov")
    assert usdot_wzdx_workzones._validated_url("https://data.example.gov/wzdx.json", hosts) == "https://data.example.gov/wzdx.json"
    for url in (
        "http://data.example.gov/wzdx.json",
        "https://user:pass@data.example.gov/wzdx.json",
        "https://other.example.gov/wzdx.json",
        "https://data.example.gov:8443/wzdx.json",
    ):
        with pytest.raises(RuntimeError):
            usdot_wzdx_workzones._validated_url(url, hosts)
    with pytest.raises(RuntimeError):
        usdot_wzdx_workzones._allowed_hosts("127.0.0.1")
    with pytest.raises(RuntimeError):
        usdot_wzdx_workzones._allowed_hosts("localhost")
