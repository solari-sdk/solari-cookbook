from datetime import datetime, timezone

import pytest

from app.sources import nasa_firms_fires, ofac_sdn, reliefweb_disasters


def test_firms_normalization_preserves_detection_semantics():
    rows = [{
        "latitude": "34.1234",
        "longitude": "-118.1234",
        "acq_date": "2026-08-31",
        "acq_time": "0315",
        "satellite": "N21",
        "instrument": "VIIRS",
        "confidence": "h",
        "frp": "12.5",
        "daynight": "N",
        "bright_ti4": "320.1",
        "bright_ti5": "290.2",
        "version": "2.0NRT",
    }]
    events = nasa_firms_fires.normalize(rows, "acq-fixture")
    assert len(events) == 1
    event = events[0]
    assert event.category == "active-fire-detection"
    assert event.location.latitude == pytest.approx(34.1234)
    assert event.observed_at.tzinfo == timezone.utc
    assert event.quality_score == pytest.approx(0.95)
    assert event.properties["frp_mw"] == pytest.approx(12.5)
    assert "not by itself a confirmed wildfire perimeter" in event.summary


def test_firms_area_validation_is_bounded():
    assert nasa_firms_fires._area("-125,24,-66,50") == "-125,24,-66,50"
    with pytest.raises(ValueError):
        nasa_firms_fires._area("-180,-90,180")
    with pytest.raises(ValueError):
        nasa_firms_fires._area("10,20,-10,30")


def test_reliefweb_disaster_normalization():
    payload = {
        "data": [{
            "id": 12345,
            "href": "https://api.reliefweb.int/v2/disasters/12345",
            "fields": {
                "name": "Sample public disaster fixture",
                "status": "current",
                "type": [{"name": "Flood"}],
                "country": [{"name": "Exampleland"}],
                "primary_country": {"name": "Exampleland"},
                "date": {"created": "2026-08-30T10:00:00+00:00", "changed": "2026-08-31T11:00:00+00:00"},
                "glide": "FL-2026-000000-XXX",
            },
        }]
    }
    events = reliefweb_disasters.normalize(payload, "acq-fixture")
    assert len(events) == 1
    event = events[0]
    assert event.source_record_id == "12345"
    assert event.category == "humanitarian-disaster"
    assert event.properties["disaster_types"] == ["Flood"]
    assert event.properties["primary_country"] == "Exampleland"
    assert event.updated_at.isoformat().startswith("2026-08-31T11:00:00")


def test_reliefweb_requires_data_array():
    with pytest.raises(ValueError, match="data array"):
        reliefweb_disasters.normalize({}, "acq-fixture")


def test_ofac_sdn_normalization_preserves_listing_and_identity_boundary():
    observed = datetime(2026, 9, 1, tzinfo=timezone.utc)
    rows = [["123", "Sample Entity", "Entity", "TEST-PROGRAM", "-0-", "-0-", "-0-", "-0-", "-0-", "-0-", "-0-", "Public fixture remarks"]]
    events = ofac_sdn.normalize(rows, "acq-fixture", observed)
    assert len(events) == 1
    event = events[0]
    assert event.source_record_id == "123"
    assert event.category == "sanctions-listing"
    assert event.properties["name"] == "Sample Entity"
    assert event.properties["program"] == "TEST-PROGRAM"
    assert event.properties["identity_resolution_required"] is True
    assert event.observed_at == observed


def test_ofac_sdn_skips_header_and_incomplete_rows():
    events = ofac_sdn.normalize([["ent_num", "SDN_Name", "SDN_Type", "Program"], ["1"]], "acq-fixture", datetime.now(timezone.utc))
    assert events == []
