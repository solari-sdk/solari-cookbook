from __future__ import annotations

import ipaddress
from typing import Any
from urllib.parse import quote_plus, urlencode

from app.recon import _json_get

RIPESTAT_MAXMIND_ENDPOINT = "https://stat.ripe.net/data/maxmind-geo-lite/data.json"
MAX_PIVOT_QUERY_LENGTH = 200


def network_geolocation(resource: str, *, timeout_seconds: int = 15) -> dict[str, object]:
    """Return public IP/prefix geolocation with explicit uncertainty semantics.

    RIPEstat's MaxMind GeoLite endpoint is useful for approximate network
    geolocation, but it does not expose a per-result accuracy radius in the
    contract used here. The result therefore records that uncertainty rather
    than presenting provider coordinates as an exact physical location.
    """
    clean = resource.strip()
    if not clean:
        raise ValueError("IP address or prefix is required")
    try:
        canonical = str(ipaddress.ip_network(clean, strict=False)) if "/" in clean else str(ipaddress.ip_address(clean))
    except ValueError as exc:
        raise ValueError("resource must be a valid public IP address or prefix") from exc

    query = urlencode({"resource": canonical})
    source = f"{RIPESTAT_MAXMIND_ENDPOINT}?{query}"
    payload = _json_get(source, timeout_seconds=timeout_seconds)
    data = payload.get("data", {}) if isinstance(payload, dict) else {}
    located = data.get("located_resources", []) if isinstance(data, dict) else []

    locations: list[dict[str, object]] = []
    if isinstance(located, list):
        for resource_item in located:
            if not isinstance(resource_item, dict):
                continue
            provider_resource = resource_item.get("resource") or canonical
            raw_locations = resource_item.get("locations", [])
            if not isinstance(raw_locations, list):
                continue
            for item in raw_locations:
                if not isinstance(item, dict):
                    continue
                latitude = item.get("latitude")
                longitude = item.get("longitude")
                try:
                    latitude = float(latitude) if latitude is not None else None
                    longitude = float(longitude) if longitude is not None else None
                except (TypeError, ValueError):
                    latitude = longitude = None
                locations.append(
                    {
                        "resource": str(provider_resource),
                        "country": item.get("country"),
                        "city": item.get("city"),
                        "latitude": latitude,
                        "longitude": longitude,
                    }
                )

    return {
        "resource": canonical,
        "locations": locations,
        "uncertainty": {
            "accuracy_radius_km": None,
            "basis": "Approximate network geolocation; provider response does not expose a per-result accuracy radius in this integration.",
            "coordinates_are_exact": False,
        },
        "provider": "RIPEstat MaxMind GeoLite",
        "source": source,
    }


def public_code_search_pivots(query: str) -> list[dict[str, str]]:
    """Build credential-free navigation pivots for public source-code search.

    These are navigation URLs only. The application does not scrape result
    pages or claim that a provider returned a match; the analyst chooses which
    public service to open and remains subject to that provider's current terms.
    """
    clean = " ".join(query.split())
    if not 2 <= len(clean) <= MAX_PIVOT_QUERY_LENGTH:
        raise ValueError(f"code-search query must contain 2 to {MAX_PIVOT_QUERY_LENGTH} characters")
    encoded = quote_plus(clean)
    return [
        {
            "provider": "GitHub",
            "mode": "public-browser-pivot",
            "url": f"https://github.com/search?type=code&q={encoded}",
        },
        {
            "provider": "GitLab",
            "mode": "public-browser-pivot",
            "url": f"https://gitlab.com/search?scope=blobs&search={encoded}",
        },
        {
            "provider": "Sourcegraph",
            "mode": "public-browser-pivot",
            "url": f"https://sourcegraph.com/search?q=context%3Aglobal+{encoded}&patternType=literal",
        },
    ]
