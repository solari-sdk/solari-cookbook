from app.sources import nws_alerts, swpc_alerts


def test_nws_normalization():
    payload={"features":[{"id":"x","properties":{"id":"urn:test","event":"Flood Warning","headline":"Flood Warning issued","sent":"2026-09-01T00:00:00+00:00","severity":"Severe","areaDesc":"Test County"}}]}
    rows=nws_alerts.normalize(payload,"acq")
    assert len(rows)==1
    assert rows[0].category=="weather-alert"
    assert rows[0].severity=="severe"
    assert rows[0].evidence[0].acquisition_id=="acq"


def test_swpc_normalization():
    payload=[{"product_id":"ALTTEST","issue_datetime":"2026-09-01T00:00:00+00:00","message":"Space Weather Alert\nPublic fixture text"}]
    rows=swpc_alerts.normalize(payload,"acq")
    assert len(rows)==1
    assert rows[0].category=="space-weather"
    assert rows[0].source_record_id=="ALTTEST"
    assert rows[0].title=="Space Weather Alert"
    assert rows[0].evidence[0].acquisition_id=="acq"


def test_swpc_descriptor_is_public_api():
    assert swpc_alerts.SOURCE.method.value=="api"
    assert swpc_alerts.SOURCE.category=="space-weather"
