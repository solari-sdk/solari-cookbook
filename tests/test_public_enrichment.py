import pytest

import app.public_enrichment as enrichment


def test_network_geolocation_preserves_approximate_uncertainty(monkeypatch):
    monkeypatch.setattr(
        enrichment,
        "_json_get",
        lambda url, **kwargs: {
            "data": {
                "located_resources": [
                    {
                        "resource": "93.184.216.0/24",
                        "locations": [
                            {"country": "US", "city": "Example City", "latitude": 47.6, "longitude": -122.3}
                        ],
                    }
                ]
            }
        },
    )
    result = enrichment.network_geolocation("93.184.216.34")
    assert result["resource"] == "93.184.216.34"
    assert result["locations"][0]["resource"] == "93.184.216.0/24"
    assert result["locations"][0]["latitude"] == 47.6
    assert result["uncertainty"]["coordinates_are_exact"] is False
    assert result["uncertainty"]["accuracy_radius_km"] is None
    assert result["source"].startswith(enrichment.RIPESTAT_MAXMIND_ENDPOINT)


def test_network_geolocation_accepts_prefixes_and_rejects_invalid_values(monkeypatch):
    monkeypatch.setattr(enrichment, "_json_get", lambda url, **kwargs: {"data": {"located_resources": []}})
    assert enrichment.network_geolocation("192.0.2.44/24")["resource"] == "192.0.2.0/24"
    with pytest.raises(ValueError, match="valid public IP"):
        enrichment.network_geolocation("not-an-address")


def test_public_code_search_pivots_are_navigation_only():
    pivots = enrichment.public_code_search_pivots("example parser")
    assert {item["provider"] for item in pivots} == {"GitHub", "GitLab", "Sourcegraph"}
    assert all(item["mode"] == "public-browser-pivot" for item in pivots)
    assert all(item["url"].startswith("https://") for item in pivots)
    assert "example+parser" in pivots[0]["url"]
    with pytest.raises(ValueError):
        enrichment.public_code_search_pivots("x")
