from app.main import ADAPTERS, SOURCES


def test_public_disaster_and_orbital_adapters_are_registered():
    for source_id in (
        "fema-disaster-declarations",
        "gdacs-disasters",
        "noaa-tsunami-bulletins",
        "celestrak-weather-satellites",
    ):
        assert source_id in ADAPTERS
        assert source_id in SOURCES
    assert SOURCES["fema-disaster-declarations"].method.value == "api"
    assert SOURCES["gdacs-disasters"].method.value == "api"
    assert SOURCES["noaa-tsunami-bulletins"].method.value == "feed"
    assert SOURCES["celestrak-weather-satellites"].poll_interval_seconds == 7200
