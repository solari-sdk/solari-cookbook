# Geospatial and time normalization

This project preserves source observations first and adds normalized values as explicit transformations. A normalized location or time must never silently replace the source representation or imply more precision than the source supports.

## Coordinates

The normalized point contract uses WGS 84 latitude/longitude in decimal degrees. When a source already supplies WGS 84 coordinates, retain those values and preserve the source precision/uncertainty metadata. When a source declares another coordinate reference system, transform only with an explicit, documented CRS mapping and record the original CRS, original values, transformation method/version, and resulting precision.

Coordinates with no known CRS are not transformed by assumption. Invalid latitude/longitude values are rejected rather than clamped.

## Place names and geocoding

A place-only observation remains place-only until an explicit geocoding step runs. Geocoding is enrichment, not an observed source fact. An open/public geocoder or gazetteer adapter should retain the query, provider/source identifier, returned stable place identifier when available, display name, bounding box or point, provider precision/class, lookup timestamp, and evidence/provenance. Multiple plausible matches stay as candidates until a deterministic rule or human review selects a preferred display value.

Reverse geocoding follows the same rule: the coordinate remains the observed value and the place label is transformed evidence. No geocoder result may overwrite the original source text.

## Geographic conflict handling

Conflicting source locations are preserved independently. Cross-source correlation may identify candidates, but preferred display values must use explicit reliability/quality rules and retain alternatives. Proximity alone does not create an inferred relationship.

## Time normalization

Normalized timestamps use UTC for ordering and comparison while preserving the original source representation and timezone provenance. `app.temporal.normalize_source_time` enforces this boundary:

- timezone-aware values are converted to UTC and retain their source offset provenance;
- naive timestamps are rejected unless the adapter provides an explicit assumed IANA timezone;
- an assumed timezone is marked as assumed provenance rather than presented as source-observed fact;
- daylight-saving behavior is delegated to the IANA timezone database through `zoneinfo` rather than hard-coded offsets.

Adapters should retain publication, observation, update, and acquisition timestamps separately when the source distinguishes them. Acquisition time is not a substitute for event time.

## Precision and uncertainty

A point without precision metadata must not be presented as exact merely because the storage type is floating point. Future geocoder/boundary adapters should carry point/bounding-box precision and uncertainty into the UI and portable case format. Administrative-boundary intersection and reverse-geocoding outputs remain transformed evidence with their dataset/version provenance.
