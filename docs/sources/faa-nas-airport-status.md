# FAA NAS airport operational status

- **Adapter:** `faa-nas-airport-status`
- **Authority:** U.S. Federal Aviation Administration, National Airspace System Status
- **Human source:** `https://nasstatus.faa.gov/`
- **Machine-readable endpoint:** `https://nasstatus.faa.gov/api/airport-status-information`
- **Access:** unauthenticated public HTTPS XML
- **Configured cadence:** 300 seconds
- **Response bound:** 2 MiB

## Purpose and semantics

The source reports active FAA airport operational events such as airport closures, ground stops/delay programs and arrival/departure delays. The adapter records the FAA's observed event type, airport identifier, reason and available start/reopen/average/maximum-delay text. It does **not** infer airport status from weather observations, and it does not synthesize precise event coordinates from airport codes.

The source update timestamp is the normalized event observation time. Event-specific time strings are preserved as source properties instead of guessing missing year/timezone context beyond what the source explicitly provides.

## Parser and safety boundary

The adapter uses `defusedxml` for untrusted XML parsing, enforces the 2 MiB body limit before parsing, requires the expected `AIRPORT_STATUS_INFORMATION` root and `Update_Time`, and rejects entity expansion. Event IDs are deterministic across acquisitions from the observed event type/airport/status fields. Source response content is treated as data only.

## Terms / attribution

This is public U.S. government FAA operational-status information. Preserve FAA attribution and the original source wording. The dashboard is an analytical display, not an authoritative air-traffic-control system; users should consult FAA/NAS Status for operational decisions.

## Validation state

On 2026-09-02 UTC the public endpoint was reachable by the validation client but returned `application/xml`, which that client could not render as a normal webpage. That is recorded as a live content-type/tooling limitation, not as empty source data. The official FAA NAS Status user guide documents the machine-readable XML interface, and deterministic fixture tests cover current airport closure and ground-delay structures plus XML entity rejection.
