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


def test_network_geolocation_accepts_public_prefixes_and_rejects_nonpublic(monkeypatch):
    monkeypatch.setattr(enrichment, "_json_get", lambda url, **kwargs: {"data": {"located_resources": []}})
    assert enrichment.network_geolocation("93.184.216.44/24")["resource"] == "93.184.216.0/24"
    with pytest.raises(ValueError, match="valid public IP"):
        enrichment.network_geolocation("not-an-address")
    with pytest.raises(ValueError, match="globally routable"):
        enrichment.network_geolocation("127.0.0.1")


def test_public_code_search_pivots_are_navigation_only():
    pivots = enrichment.public_code_search_pivots("example parser")
    assert {item["provider"] for item in pivots} == {"GitHub", "GitLab", "Sourcegraph"}
    assert all(item["mode"] == "public-browser-pivot" for item in pivots)
    assert all(item["url"].startswith("https://") for item in pivots)
    assert "example+parser" in pivots[0]["url"]
    with pytest.raises(ValueError):
        enrichment.public_code_search_pivots("x")


def test_alias_correlation_requires_multiple_public_evidence_urls_and_never_asserts_identity():
    candidates = enrichment.correlate_alias_observations([
        {"alias": "Example_User", "source_name": "Public A", "source_url": "https://example.org/a"},
        {"username": "example_user", "source_name": "Public B", "source_url": "https://example.net/b"},
        {"alias": "different", "source_name": "Public C", "source_url": "https://example.com/c"},
    ])
    assert len(candidates) == 1
    assert candidates[0]["canonical_alias"] == "example_user"
    assert candidates[0]["review_required"] is True
    assert candidates[0]["identity_asserted"] is False
    assert candidates[0]["source_count"] == 2


def test_alias_correlation_rejects_non_https_and_embedded_credentials():
    with pytest.raises(ValueError, match="public HTTPS"):
        enrichment.correlate_alias_observations([{"alias": "example", "source_url": "http://example.org/u"}])
    with pytest.raises(ValueError, match="embedded credentials"):
        enrichment.correlate_alias_observations([{"alias": "example", "source_url": "https://user:pass@example.org/u"}])
