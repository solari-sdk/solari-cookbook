from __future__ import annotations

import ipaddress
import re
from urllib.parse import quote_plus, urlencode, urlparse

from app.recon import _json_get

RIPESTAT_MAXMIND_ENDPOINT = "https://stat.ripe.net/data/maxmind-geo-lite/data.json"
MAX_PIVOT_QUERY_LENGTH = 200
_ALIAS_RE = re.compile(r"^[A-Za-z0-9_.-]{2,80}$")


def network_geolocation(resource: str, *, timeout_seconds: int = 15) -> dict[str, object]:
    """Return public IP/prefix geolocation with explicit uncertainty semantics."""
    clean = resource.strip()
    if not clean:
        raise ValueError("IP address or prefix is required")
    try:
        parsed = ipaddress.ip_network(clean, strict=False) if "/" in clean else ipaddress.ip_address(clean)
    except ValueError as exc:
        raise ValueError("resource must be a valid public IP address or prefix") from exc
    if not parsed.is_global:
        raise ValueError("resource must be a globally routable public IP address or prefix")
    canonical = str(parsed)

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
                locations.append({
                    "resource": str(provider_resource),
                    "country": item.get("country"),
                    "city": item.get("city"),
                    "latitude": latitude,
                    "longitude": longitude,
                })

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
    """Build credential-free navigation pivots for public source-code search."""
    clean = " ".join(query.split())
    if not 2 <= len(clean) <= MAX_PIVOT_QUERY_LENGTH:
        raise ValueError(f"code-search query must contain 2 to {MAX_PIVOT_QUERY_LENGTH} characters")
    encoded = quote_plus(clean)
    return [
        {"provider": "GitHub", "mode": "public-browser-pivot", "url": f"https://github.com/search?type=code&q={encoded}"},
        {"provider": "GitLab", "mode": "public-browser-pivot", "url": f"https://gitlab.com/search?scope=blobs&search={encoded}"},
        {"provider": "Sourcegraph", "mode": "public-browser-pivot", "url": f"https://sourcegraph.com/search?q=context%3Aglobal+{encoded}&patternType=literal"},
    ]


def correlate_alias_observations(observations: list[dict[str, object]], *, max_observations: int = 1000) -> list[dict[str, object]]:
    """Suggest exact normalized-alias matches across caller-supplied public evidence.

    This deliberately does not assert that matching usernames identify the same
    person. Every candidate remains a review-required hypothesis and preserves
    its public source URLs.
    """
    if not 1 <= max_observations <= 5000:
        raise ValueError("max_observations must be between 1 and 5000")
    if len(observations) > max_observations:
        raise ValueError("alias observation set exceeds configured limit")
    grouped: dict[str, list[dict[str, str]]] = {}
    for index, observation in enumerate(observations):
        raw_alias = str(observation.get("alias") or observation.get("username") or "").strip().lstrip("@")
        if not _ALIAS_RE.fullmatch(raw_alias):
            raise ValueError(f"observation {index} has an invalid alias")
        source_url = str(observation.get("source_url") or "").strip()
        parsed = urlparse(source_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError(f"observation {index} requires a public HTTPS source_url without embedded credentials")
        source_name = str(observation.get("source_name") or parsed.hostname)[:120]
        canonical = raw_alias.casefold()
        grouped.setdefault(canonical, []).append({"alias": raw_alias, "source_name": source_name, "source_url": source_url})

    candidates: list[dict[str, object]] = []
    for canonical, items in sorted(grouped.items()):
        distinct_urls = {item["source_url"] for item in items}
        if len(distinct_urls) < 2:
            continue
        candidates.append({
            "canonical_alias": canonical,
            "observations": items,
            "source_count": len(distinct_urls),
            "match_basis": "exact case-insensitive normalized alias",
            "review_required": True,
            "identity_asserted": False,
        })
    return candidates
