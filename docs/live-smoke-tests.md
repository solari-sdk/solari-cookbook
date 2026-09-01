# Representative public-source live smoke checks

Validation date: 2026-09-02 UTC

This record distinguishes a successful endpoint response from a tooling/network failure. An unreachable or unrenderable endpoint is never interpreted as an empty source.

## Successful live checks

| Adapter | Endpoint | Result | Evidence observed |
| --- | --- | --- | --- |
| `usgs-earthquakes` | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` | Success | HTTP-readable GeoJSON FeatureCollection; metadata reported status `200` and 10 features at validation time. Feature objects contained event IDs, timestamps, magnitude, place and point coordinates matching the adapter contract. |
| `swpc-alerts` | `https://services.swpc.noaa.gov/products/alerts.json` | Success | HTTP-readable JSON array containing current/recent NOAA SWPC products with `product_id`, `issue_datetime`, and `message`, matching the adapter normalization contract. |
| `ndbc-latest-observations` | `https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt` | Success | HTTP-readable plain-text station table with documented header and current station rows containing station ID, coordinates, observation time and marine/environmental measurements, matching the bounded text parser contract. |

## Endpoint checks not counted as empty data

The validation client could not render the NWS active-alert GeoJSON endpoint because its response content type was `application/geo+json`, and it could not produce a usable body for the OpenFEMA query during this run. Those outcomes are recorded as validation-client/tooling failures, **not** as zero-alert or zero-declaration source results. Their fixture/unit coverage remains separate from this live smoke record.

## Interpretation boundary

These checks verify that representative public endpoints were live and returned structures compatible with the corresponding adapters on the date above. They do not replace deterministic fixture tests, and they do not assert continuous availability. Credential-gated sources such as FIRMS and ReliefWeb remain outside this unauthenticated smoke pass.
