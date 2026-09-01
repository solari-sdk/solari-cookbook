from app.sources.gdacs_disasters import normalize


def test_gdacs_geojson_normalization_preserves_hazard_alert_and_provenance():
    payload = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "eventid": 1557413,
                "episodeid": 1724396,
                "eventtype": "EQ",
                "name": "Earthquake in Exampleland",
                "alertlevel": "Orange",
                "alertscore": 1,
                "fromdate": "2026-08-11T09:10:00Z",
                "todate": "2026-08-11T10:10:00Z",
                "country": "Exampleland",
                "iso3": "EXP",
                "iscurrent": "true",
                "affectedcountries": [{"iso3": "EXP", "countryname": "Exampleland"}],
                "severitydata": {"severity": 5.6, "severitytext": "Magnitude 5.6"},
                "url": {"report": "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1557413"},
            },
            "geometry": {"type": "Point", "coordinates": [12.25, 45.5]},
        }],
    }
    event = normalize(payload, "acq-1")[0]
    assert event.source_record_id == "EQ:1557413:1724396"
    assert event.category == "earthquake"
    assert event.severity == "high"
    assert event.location is not None
    assert event.location.latitude == 45.5
    assert event.location.longitude == 12.25
    assert event.properties["severity_value"] == 5.6
    assert event.evidence[0].acquisition_id == "acq-1"


def test_gdacs_rejects_non_feature_collection():
    try:
        normalize({"features": []}, "acq-1")
        raise AssertionError("invalid response should fail")
    except ValueError:
        pass
