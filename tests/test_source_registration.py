from app.main import ADAPTERS, SOURCES


def test_public_disaster_adapters_are_registered():
    assert "fema-disaster-declarations" in ADAPTERS
    assert "gdacs-disasters" in ADAPTERS
    assert "noaa-tsunami-bulletins" in ADAPTERS
    assert SOURCES["fema-disaster-declarations"].method.value == "api"
    assert SOURCES["gdacs-disasters"].method.value == "api"
    assert SOURCES["noaa-tsunami-bulletins"].method.value == "feed"
