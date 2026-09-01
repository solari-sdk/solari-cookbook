# U.S. Coast Guard public port status

- **Adapter:** `uscg-port-status`
- **Authority:** U.S. Coast Guard Navigation Center
- **Human source:** `https://navcen.uscg.gov/port-status`
- **Access:** unauthenticated public HTTPS HTML by exact Coast Guard Captain of the Port zone
- **Default demonstration zone:** `SAN JUAN`
- **Configured cadence:** 1800 seconds
- **Response bound:** 2 MiB
- **Record bound:** 500 rows per acquisition

## Purpose and semantics

The Navigation Center publishes current port-status tables by Captain of the Port zone. Rows can include port name, operational status, condition, comments and a date-only `Last Changed` field. The adapter preserves those values as observed source facts. It does not infer vessel movements, individual ship status, cargo, closure causes beyond the published comment, or geographic coordinates from the port name.

The adapter uses a fixed allowlist of the zones published on the Coast Guard Navigation Center index. It is not a general-purpose HTML fetcher. The demonstration default is one bounded zone rather than bulk/high-frequency collection across every zone.

When `Last Changed` is a source `YYYY-MM-DD` value, the normalized event uses UTC midnight with `time_basis=source-date-only` so consumers can see that no time-of-day was supplied. If the source omits the date, the acquisition timestamp is used and marked `time_basis=acquisition-time-fallback` instead of inventing a source event time.

## Parser and safety boundary

The adapter enforces the response-size limit before parsing and uses Beautiful Soup's non-executing HTML parser. It locates a table only when headers include both `Port` and `Status`, derives the remaining available fields from the published headers, caps retained rows, and generates deterministic IDs from the observed row values and selected zone. Source HTML is treated as data only and is never rendered by the parser.

## Terms / attribution

This is public U.S. government Coast Guard Navigation Center information. Preserve USCG attribution and source wording. The analytical copy is not an authoritative substitute for current Coast Guard Captain of the Port orders, Local Notice to Mariners information, or direct operational instructions.

## Validation state

The official Navigation Center index and current zone pages were reviewed on 2026-09-02 UTC. Current pages exposed the expected `Port` / `Status` table structure, including optional condition/comments/date columns. Deterministic fixture coverage verifies status preservation, date-only provenance, acquisition-time fallback, zone allowlisting, missing-table rejection, and response-size enforcement.
