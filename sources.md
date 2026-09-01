# Public Source Registry

This file is the authoritative registry for source families planned or implemented by the OSINT operations-center showcase.

## Inclusion rules
Sources must be lawful public/open sources suitable for a public demonstration. Prefer no-cost APIs, feeds, downloadable datasets, public alert systems, and openly accessible web applications. A source being technically reachable does not automatically make collection appropriate; document access/terms constraints where relevant.

Media-monitoring/news-monitoring sources are explicitly out of scope.

## Required source-adapter metadata
Each implemented adapter must record canonical provider/source, public documentation/homepage, acquisition mode, authentication requirement, rate/update cadence, geographic scope, data categories, raw format, normalization mapping, provenance retained, deduplication key, health strategy, known limitations, license/terms notes, implementation status, and live-test state.

## Source families

| Family | Candidate public/open sources | Primary mode | Status |
|---|---|---|---|
| Earthquakes | USGS Earthquake Hazards Program | API/feed + static CORS | Implemented |
| Weather alerts | NOAA/NWS public alerts | API/feed | Implemented |
| Space weather | NOAA Space Weather Prediction Center | API/feed | Implemented |
| Observable registration/network | RDAP bootstrap services, RIPEstat | public API | Implemented enrichment |
| DNS/email-domain posture | system DNS plus Google Public DNS JSON API for TXT lookups | DNS/API | Implemented enrichment |
| Certificate transparency | crt.sh public certificate search | public web/API-style JSON | Implemented enrichment |
| TLS/HTTP metadata | user-supplied public HTTPS targets | direct network | Implemented enrichment |
| Web history | Internet Archive CDX API for user-supplied public URLs | public API | Implemented enrichment |
| Volcanoes | USGS Volcano Hazards Program / Smithsonian public volcano data where terms permit | API/web | Planned |
| Wildfire | NASA FIRMS and public fire/perimeter datasets | API/download | Planned |
| Tropical cyclones | NOAA/NHC and other authoritative public warning centers | API/feed/web | Planned |
| Flood/hydrology | NOAA/NWS/NWPS and public river/gauge sources | API/feed | Planned |
| Tsunami | NOAA/NWS Tsunami Warning System public products | feed/web | Planned |
| Humanitarian/disaster | GDACS, ReliefWeb and other openly reusable humanitarian event sources | API/feed | Planned |
| Aviation | FAA/public airport/status datasets and other lawful open aviation data | API/download/web | Planned |
| Maritime | NOAA/USCG/public maritime safety and environmental datasets; AIS only where a lawful free/open source explicitly permits reuse | API/feed/web | Planned |
| Environmental | EPA and other public air/water/environmental sensor datasets | API/download | Planned |
| Geospatial reference | OpenStreetMap, Natural Earth, public government boundaries/gazetteers subject to their licenses | API/download | Planned |
| Infrastructure/public status | Public government infrastructure/outage/status datasets where redistribution is permitted | API/web | Planned |
| Transportation | Public GTFS/GTFS-Realtime and government transportation feeds | API/feed | Planned |
| Public safety/emergency | FEMA, public emergency-management alerts, CAP feeds and comparable official sources | API/feed | Planned |
| Sanctions/watchlists | Official public government sanctions/watchlists where lawful for demonstration | API/download | Planned |
| Public notices | Government/public-agency operational notices excluding general media monitoring | API/web | Planned |

## Implemented adapters

### USGS Earthquake Hazards Program
- **Adapter ID:** `usgs-earthquakes`
- **Authoritative documentation:** `https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php`
- **Acquisition:** public GeoJSON feed; no authentication; nominal poll interval 300 seconds.
- **Scope/category:** global earthquakes; earthquake events.
- **Raw/normalized mapping:** GeoJSON feature ID becomes deterministic source identity; event time/update, magnitude, place, depth, tsunami flag, and coordinates are normalized into the common event/evidence contract.
- **Evidence:** acquisition ID plus source feature path; acquisition retains content SHA-256 and request/final URL metadata.
- **Deduplication:** deterministic source ID + USGS feature ID.
- **Health:** persisted acquisition status/duration and source-health endpoint; stale threshold is three configured poll intervals.
- **Terms:** public U.S. government earthquake feed; retain USGS attribution and review current USGS terms before redistribution changes.
- **Static mode:** the documented GeoJSON endpoint is the first browser-side CORS adapter; browser network/CORS failures are reported as routing limitations.
- **Known limits:** point epicenter representation does not model shakemap polygons or uncertainty surfaces.
- **Status:** implemented with deterministic fixture/unit coverage; live network validation is tracked separately.

### National Weather Service alerts
- **Adapter ID:** `nws-alerts`
- **Authoritative endpoint:** `https://api.weather.gov/alerts`
- **Acquisition:** public API/GeoJSON; no authentication; nominal poll interval 300 seconds.
- **Scope/category:** U.S. NWS active alerts; weather-alert events.
- **Raw/normalized mapping:** CAP/GeoJSON alert identity, sent/effective time, headline/event, description, end/expiry, severity, area, urgency, certainty, instruction, and sender are normalized deterministically.
- **Evidence/deduplication:** acquisition ID plus feature identity/path; deterministic source + alert record ID.
- **Health:** persisted acquisition status/duration and source-health endpoint.
- **Terms:** public U.S. government weather alert API; use a descriptive User-Agent and respect published API guidance.
- **Known limits:** current baseline does not polygon-normalize alert geometries into the common geospatial model.
- **Status:** implemented; live network validation is tracked separately.

### NOAA Space Weather Prediction Center
- **Adapter ID:** `swpc-alerts`
- **Authoritative endpoint:** `https://services.swpc.noaa.gov/products/alerts.json`
- **Acquisition:** public JSON API/feed; no authentication; nominal poll interval 300 seconds.
- **Scope/category:** NOAA SWPC alerts/products; space-weather events.
- **Raw/normalized mapping:** product ID, issue time, and message are normalized into event identity/title/summary/properties.
- **Evidence/deduplication:** acquisition ID plus product ID; deterministic source + product ID.
- **Health:** persisted acquisition status/duration and source-health endpoint.
- **Terms:** public NOAA space-weather products; preserve source attribution.
- **Known limits:** products are not inherently geospatial and remain non-map events unless a later deterministic product model supports location.
- **Status:** implemented; live network validation is tracked separately.

## Implemented observable-enrichment sources
These are analyst-invoked enrichment adapters rather than continuously polled event feeds. They accept user-supplied public observables, impose bounded response sizes/timeouts, and retain the source URL/provider in returned provenance. They must not be used to probe private/internal targets.

### RDAP.org bootstrap service
- **Endpoint family:** `https://rdap.org/domain/{domain}` and `https://rdap.org/ip/{address}`.
- **Acquisition:** unauthenticated HTTPS JSON; analyst-invoked.
- **Data:** public registration/network allocation fields returned through RDAP.
- **Rate/cadence:** no project polling cadence; calls occur only on analyst request. Respect provider policies and downstream registry limits.
- **Health:** request failure is explicit; response is bounded before parsing.
- **Terms/limits:** RDAP data originates from registry/RIR services and may have registry-specific terms or redactions; this tool does not treat RDAP as ownership proof.
- **Status:** implemented with mocked parsing/safety tests; live network validation tracked separately.

### crt.sh certificate transparency search
- **Endpoint:** `https://crt.sh/?q=...&output=json`.
- **Acquisition:** unauthenticated public HTTPS JSON-style response; analyst-invoked.
- **Data:** certificate transparency observations including names, issuer text, validity timestamps and serial metadata.
- **Rate/cadence:** no background polling; bounded analyst requests only. Avoid high-rate or bulk harvesting.
- **Health:** bounded response and JSON-shape validation.
- **Terms/limits:** CT observations show certificate issuance/visibility, not necessarily current control of a hostname.
- **Status:** implemented with mocked parsing tests; live network validation tracked separately.

### Google Public DNS JSON API
- **Endpoint:** `https://dns.google/resolve`.
- **Acquisition:** unauthenticated HTTPS DNS-over-JSON queries, presently limited to TXT lookups for SPF/DMARC enrichment.
- **Data:** DNS TXT answers used to identify published SPF and DMARC records.
- **Rate/cadence:** analyst-invoked; no continuous polling.
- **Health:** explicit request/parse failure and bounded response.
- **Terms/limits:** published DNS posture is descriptive only; presence of a record is not a full mail-security assessment.
- **Status:** implemented with mocked tests; live network validation tracked separately.

### RIPEstat prefix overview
- **Endpoint:** `https://stat.ripe.net/data/prefix-overview/data.json`.
- **Acquisition:** unauthenticated HTTPS JSON, analyst-invoked for a public IP observable.
- **Data:** announced prefix, originating ASNs and holder text exposed by the endpoint.
- **Rate/cadence:** no automatic polling; bounded interactive requests.
- **Health:** explicit request failure and bounded response.
- **Terms/limits:** routing/holder metadata is network context, not proof of physical location or operator identity.
- **Status:** implemented with mocked tests; live network validation tracked separately.

### Internet Archive CDX
- **Endpoint family:** `https://web.archive.org/cdx/search/cdx`.
- **Acquisition:** public HTTPS query for a user-supplied public HTTPS URL.
- **Data:** capture timestamps, original URL, HTTP status and digest for deduplicated historical captures.
- **Rate/cadence:** analyst-invoked and result-limited; no crawler or bulk history harvesting in this project.
- **Health:** explicit parse failure and bounded response.
- **Terms/limits:** archive availability is incomplete and must not be interpreted as proof that a page did or did not exist outside captured timestamps.
- **Status:** implemented with mocked tests; live network validation tracked separately.

### Direct DNS, TLS and HTTPS metadata
- **Targets:** user-supplied public hostnames/IPs/HTTPS URLs only.
- **Acquisition:** system DNS/reverse DNS, TLS handshake metadata, HTTPS HEAD/header inspection and redirect-chain observation.
- **Safety boundary:** targets must resolve only to public addresses; private, loopback, link-local, multicast, reserved and unspecified destinations are rejected. Embedded URL credentials are rejected.
- **Data:** DNS addresses/PTR, peer certificate metadata, TLS version/cipher, selected response headers and redirect hops.
- **Rate/cadence:** analyst-invoked only; bounded timeouts and redirect limits.
- **Terms/limits:** passive connection metadata is descriptive; fingerprint fields are hints, not definitive software identification.
- **Status:** implemented with deterministic/mocked safety tests; live network validation tracked separately.

## Solari acquisition routing
Use the least-complex reliable acquisition method:
1. Direct documented API/feed/download when available and sufficient.
2. Solari Browser when the public source requires browser rendering, browser state, JavaScript interaction, screenshots, or browser-level evidence.
3. Solari Desktop only when the source/workflow genuinely requires GUI/screen interaction that is not cleanly represented through an API or browser automation.
4. Solari Sandbox for isolated parsing, transformation, generated extraction logic, document processing, enrichment, and untrusted-input handling when isolation adds value.

Static-browser adapters use the same principle. A browser-side network/CORS failure is not silently treated as an empty source: the console reports that the source requires Browser or optional broker routing. Direct Solari browser-side orchestration remains unclaimed until provider CORS/browser-client behavior is verified.

## Prohibited source material
Do not register private customer feeds, proprietary internal feeds, credentialed sources without explicit public-demo authorization, leaked datasets, private personal data, or source lists copied from unrelated private systems.