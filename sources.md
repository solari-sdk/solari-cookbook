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
| Tropical cyclones | NOAA/NHC public tropical cyclone RSS products | feed | Implemented baseline |
| Tsunami | NOAA/NWS Tsunami Warning System public products | feed/web | Implemented RSS baseline |
| Humanitarian/disaster | GDACS, OpenFEMA; ReliefWeb where configured/authorized | API/feed | Implemented GDACS/OpenFEMA/ReliefWeb baseline |
| Public safety/emergency | OpenFEMA and public emergency-management sources | API/feed | Implemented OpenFEMA baseline |
| Satellite/orbital | CelesTrak public GP data | API/download | Implemented weather-group baseline |
| Geospatial reference | OpenStreetMap/Nominatim, Natural Earth, public boundaries/gazetteers | API/download | Implemented Nominatim + boundary foundation |
| Observable registration/network | RDAP bootstrap services, RIPEstat | public API | Implemented enrichment |
| DNS/email-domain posture | system DNS plus Google Public DNS JSON API for TXT lookups | DNS/API | Implemented enrichment |
| Certificate transparency | crt.sh public certificate search | public web/API-style JSON | Implemented enrichment |
| TLS/HTTP metadata | user-supplied public HTTPS targets | direct network | Implemented enrichment |
| Web history | Internet Archive CDX API for user-supplied public URLs | public API | Implemented enrichment |
| Volcanoes | USGS Volcano Hazards Program HANS | API | Implemented elevated-status baseline |
| Wildfire | NASA FIRMS and public fire/perimeter datasets | API/download | Implemented credential-gated FIRMS Area API baseline; live collection requires a user-supplied MAP_KEY and bounded area |
| Flood/hydrology | USGS Water Data APIs and public river/gauge sources | API/feed | Implemented bounded latest-continuous baseline |
| Aviation | FAA/public airport/status datasets and other lawful open aviation data | API/download/web | Planned |
| Maritime | NOAA NDBC environmental observations; additional public maritime safety sources where reuse is permitted | API/feed/web | Implemented NDBC environmental-observation baseline; safety/vessel/port expansion planned |
| Environmental | EPA AirNow and NOAA NDBC public environmental observations | API/download/feed | Implemented AirNow + NDBC baselines |
| Air quality | EPA AirNow public daily data | feed/download | Implemented daily preliminary-observation baseline |
| Infrastructure/public status | Public government infrastructure/outage/status datasets where redistribution is permitted | API/web | Planned |
| Transportation | Public GTFS/GTFS-Realtime and government transportation feeds | API/feed | Planned |
| Sanctions/watchlists | Official public government sanctions/watchlists where lawful for demonstration | API/download | Implemented OFAC SDN CSV baseline |
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
- **Static mode:** the documented GeoJSON endpoint is the first browser-side CORS adapter; browser network/CORS failures can optionally route through the bounded static broker rather than being treated as empty data.
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

### NOAA National Hurricane Center tropical cyclone products
- **Adapter ID:** `nhc-tropical-cyclones`
- **Authoritative documentation:** `https://www.nhc.noaa.gov/aboutrss.shtml` and `https://www.nhc.noaa.gov/mobile/rss.html`.
- **Baseline endpoint:** `https://www.nhc.noaa.gov/index-at.xml` (Atlantic basin dynamic tropical cyclone feed).
- **Acquisition:** public RSS/XML feed; no authentication; nominal poll interval 3600 seconds, consistent with NHC guidance that feed readers generally check about hourly.
- **Scope/category:** current NHC Atlantic-basin tropical cyclone public products; `tropical-cyclone` events. Eastern/Central Pacific basin expansion remains straightforward but is not claimed as implemented by this baseline adapter.
- **Raw/normalized mapping:** RSS item title, link, GUID, publication date and inert-text description are normalized into the common event/evidence contract.
- **Evidence/deduplication:** acquisition ID plus RSS item path; deterministic source + GUID/link identity.
- **Safety:** response is capped at 2 MiB; XML with DTD/entity declarations is rejected before parsing; RSS description markup is stripped and decoded to inert text.
- **Health:** standard acquisition/job/source-health telemetry, bounded retry/circuit-breaker behavior and parser/record/response metrics apply through the common collector path.
- **Terms:** public NOAA/NWS/NHC operational products; preserve NOAA/NHC attribution. NHC explicitly warns that Internet delivery is not guaranteed and these convenience feeds should not be relied on for life-threatening decisions.
- **Known limits:** current RSS baseline represents issued products, not forecast cones/wind polygons or a canonical storm-track object; it does not infer coordinates from advisory prose.
- **Status:** implemented with deterministic fixture/security tests; live network validation is tracked separately.

### NOAA/NWS tsunami bulletins
- **Adapter ID:** `noaa-tsunami-bulletins`
- **Authoritative library:** `https://www.weather.gov/rss/index.php` (NWS RSS Library; All Tsunami Bulletins link).
- **Baseline endpoint:** `https://wcatwc.arh.noaa.gov/rss/tsunamirss.xml`.
- **Acquisition:** public RSS/XML; no authentication; nominal poll interval 300 seconds.
- **Scope/category:** public tsunami bulletins exposed by the NWS RSS library; `tsunami` events.
- **Raw/normalized mapping:** title, link, GUID, publication date and inert-text description become deterministic event fields. Warning/advisory/watch/information wording maps conservatively to display severity without inventing affected geography.
- **Evidence/deduplication:** acquisition ID plus RSS item path; deterministic source + GUID/link identity.
- **Safety:** response capped at 2 MiB; DTD/entity declarations rejected; markup converted to inert text.
- **Terms/limits:** public NOAA/NWS operational products; preserve attribution. This demo is not a life-safety warning channel and Internet/RSS delivery must not substitute for official emergency instructions.
- **Known limits:** no coordinates are inferred from bulletin prose and the baseline does not normalize warning polygons.
- **Status:** implemented with deterministic fixture/security tests; live endpoint pull remains tracked separately.

### OpenFEMA Disaster Declarations Summaries
- **Adapter ID:** `fema-disaster-declarations`
- **Authoritative documentation:** `https://www.fema.gov/about/openfema/disaster-declarations-summaries`.
- **Baseline endpoint:** OpenFEMA v1 `DisasterDeclarationsSummaries`, newest declarations first, bounded to 100 rows per collection.
- **Acquisition:** public JSON API; no authentication; nominal poll interval 1200 seconds; 4 MiB response cap.
- **Scope/category:** U.S. federal disaster declarations; `disaster-declaration` events.
- **Raw/normalized mapping:** disaster/declaration IDs, title, state/designated area, declaration/incident dates, incident type, declaration type and assistance-program flags are retained in the normalized contract.
- **Evidence/deduplication:** deterministic source identity plus row identity/hash/fallback key; acquisition ID and source row path retained.
- **Health:** common acquisition/job/source-health telemetry applies.
- **Terms:** public OpenFEMA government dataset; preserve FEMA attribution and current OpenFEMA citation/usage guidance.
- **Known limits:** designated-area text is retained rather than guessed into coordinates; geocoding is a separate explicit analyst/enrichment step.
- **Status:** implemented with fixture tests; live network validation tracked separately.

### Global Disaster Alert and Coordination System (GDACS)
- **Adapter ID:** `gdacs-disasters`
- **Authoritative documentation:** `https://www.gdacs.org/gdacsapi/swagger/index.html` and GDACS API documentation/quickstart.
- **Baseline endpoint:** public `EVENTS4APP` GeoJSON event list.
- **Acquisition:** public HTTPS JSON/GeoJSON API; no project credential; nominal poll interval 360 seconds; 5 MiB response cap.
- **Scope/category:** global multi-hazard disaster alerts including earthquakes, tropical cyclones, floods, volcanoes, drought, wildfire and tsunami where present in the source.
- **Raw/normalized mapping:** event/episode IDs, hazard type, alert level/score, source dates, centroid, country/ISO3, affected-country list, severity fields, current-state indicator and report URL are retained.
- **Evidence/deduplication:** deterministic source + event type + event ID + episode ID; acquisition ID and GeoJSON feature path retained.
- **Health:** common acquisition/job/source-health telemetry applies; parser/record/response metrics are recorded.
- **Terms:** GDACS public data; preserve attribution to the Global Disaster Alert and Coordination System (GDACS) and follow current GDACS terms/disclaimer.
- **Known limits:** GDACS centroid is represented as a point with explicit provider-centroid precision; this baseline does not import every hazard-specific geometry/detail endpoint.
- **Status:** implemented with deterministic fixture tests; live network validation tracked separately.

### CelesTrak weather-satellite GP data
- **Adapter ID:** `celestrak-weather-satellites`
- **Authoritative documentation:** `https://celestrak.org/NORAD/documentation/gp-data-formats.php` and CelesTrak's current query/usage policy pages.
- **Baseline query:** `https://celestrak.org/NORAD/elements/gp.php?GROUP=WEATHER&FORMAT=JSON`.
- **Acquisition:** public GP JSON query; no authentication; fixed `WEATHER` group only; configured poll interval 7200 seconds to respect CelesTrak's current once-per-update guidance; 3 MiB response cap and 2,000-object parser limit.
- **Scope/category:** general-perturbations orbital-element snapshots for CelesTrak's weather group; `satellite-orbit` events keyed to NORAD catalog ID and epoch.
- **Raw/normalized mapping:** object name/ID/catalog ID, epoch, mean motion, eccentricity, inclination, ascending node, argument of pericenter, mean anomaly, classification, ephemeris type, element-set number and revolution-at-epoch are retained.
- **Evidence/deduplication:** deterministic source + NORAD catalog ID + epoch; acquisition ID and array index retained.
- **Terms:** request only data needed and no more frequently than the provider's update cadence; current adapter intentionally requests one named group rather than the full catalog.
- **Known limits:** GP elements are not converted to a current latitude/longitude without an orbital propagator; the adapter therefore does not fabricate a map position or claim TLE visualization.
- **Status:** implemented with deterministic fixture/bounds tests; live network validation tracked separately.

### NASA FIRMS active fire detections
- **Adapter ID:** `nasa-firms-fires`
- **Authoritative documentation:** `https://firms.modaps.eosdis.nasa.gov/api/area/`.
- **Acquisition:** NASA FIRMS Area API CSV; a free evaluator/user-owned `FIRMS_MAP_KEY` is required. Collection additionally requires an explicit bounded `FIRMS_AREA_COORDINATES` west,south,east,north rectangle; supported day range is 1–5.
- **Scope/category:** satellite-derived active fire/hotspot detections from an allowlisted FIRMS source; `active-fire-detection` events.
- **Raw/normalized mapping:** coordinates, acquisition date/time, satellite, instrument, confidence, fire radiative power, day/night, scan/track and brightness fields are retained. The adapter explicitly does not infer a confirmed wildfire perimeter from a hotspot detection.
- **Evidence/deduplication:** deterministic identity from rounded coordinates, observed time, satellite and instrument; acquisition ID and CSV row path retained.
- **Safety:** 15 MiB response cap, bounded area/day range, fixed NASA HTTPS host and supported-source allowlist. Provider key is redacted from persisted request metadata.
- **Terms:** preserve NASA FIRMS attribution and current use guidance. A user-supplied provider credential is never committed or exported.
- **Known limits:** fixture/unit coverage is credential-free; live collection remains blocked until a valid evaluator/user key and collection area are supplied.
- **Status:** implemented credential-gated adapter with deterministic normalization tests.

### ReliefWeb disasters
- **Adapter ID:** `reliefweb-disasters`
- **Authoritative documentation:** `https://apidoc.reliefweb.int/`.
- **Acquisition:** ReliefWeb v2 disasters API; current API access requires a pre-approved user/evaluator `RELIEFWEB_APPNAME`; bounded to 100 records per pull with a 5 MiB response cap.
- **Scope/category:** humanitarian disaster records; `humanitarian-disaster` events.
- **Raw/normalized mapping:** record ID, name, status, disaster types, countries, primary country, created/changed dates, GLIDE identifier and ReliefWeb record URL are retained.
- **Evidence/deduplication:** deterministic source + ReliefWeb record ID; acquisition ID and response-array path retained.
- **Safety:** fixed ReliefWeb HTTPS endpoint and bounded result/response size. The configured appname is redacted from persisted request metadata.
- **Terms:** attribute ReliefWeb and preserve downstream/source copyright obligations. The adapter does not claim partner content is project-owned.
- **Known limits:** current implementation does not infer coordinates when the API record lacks deterministic geospatial data.
- **Status:** implemented credential/configuration-gated adapter with deterministic fixture tests; live validation requires an approved appname.

### U.S. Treasury OFAC SDN list
- **Adapter ID:** `ofac-sdn`
- **Authoritative source:** `https://ofac.treasury.gov/sanctions-list-service`.
- **Baseline endpoint:** official OFAC Sanctions List Service `SDN.CSV` publication export.
- **Acquisition:** public CSV feed; no project credential; nominal poll interval 3600 seconds; 25 MiB response cap.
- **Scope/category:** official Specially Designated Nationals list records; `sanctions-listing` events/reference records.
- **Raw/normalized mapping:** OFAC entity number, name, SDN type, program, title, vessel/call-sign/tonnage/flag/owner fields and remarks are retained without guessing identity matches.
- **Evidence/deduplication:** deterministic source + OFAC entity number; acquisition ID and CSV row path retained.
- **Safety/interpretation:** each normalized record carries `identity_resolution_required=true`; a name or observable resemblance is not treated as an independent identity-resolution conclusion.
- **Terms:** official U.S. Treasury data; preserve OFAC attribution and current guidance.
- **Status:** implemented with deterministic fixture tests; live network validation tracked separately.

### EPA AirNow daily air-quality data
- **Adapter ID:** `airnow-daily-quality`
- **Authoritative documentation:** `https://files.airnowtech.org/airnow/docs/DailyDataFactSheet.pdf`.
- **Baseline endpoint:** `https://files.airnowtech.org/airnow/today/daily_data_v2.dat`.
- **Acquisition:** public pipe-delimited daily data; no authentication; nominal poll interval 1800 seconds; 10 MiB response and 50,000-record bounds.
- **Scope/category:** preliminary AirNow monitor observations/aggregates; `air-quality` events.
- **Raw/normalized mapping:** valid date, AQS/site identifiers, site name, parameter, units, value, averaging period, reporting data source, AQI/category code and monitor coordinates are retained. The daily local-standard-time date is anchored deterministically at 00:00 UTC only for storage; no exact observation clock time is invented.
- **Evidence/deduplication:** deterministic source + date + AQS/site ID + parameter + averaging period; acquisition ID and source-row path retained.
- **Interpretation:** AirNow data are preliminary and are not represented as certified regulatory AQS observations. AQI values are mapped only to coarse display severity categories; missing `-999` values remain null.
- **Health:** common acquisition/job/source-health telemetry applies, including parser timing and accepted/rejected counts.
- **Terms:** preserve EPA/AirNow and reporting-agency attribution and current AirNow use guidance.
- **Status:** implemented, registered, and covered by deterministic parser/normalization/boundary tests; live network validation is tracked separately.

### USGS Water Data latest continuous observations
- **Adapter ID:** `usgs-water-latest`
- **Authoritative collection:** `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous`.
- **Baseline endpoint:** `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items`.
- **Acquisition:** modern public USGS Water Data OGC API. The adapter intentionally requires an explicit bounded `USGS_WATER_SITE_IDS` list (maximum 25 sites) and at most 10 five-digit parameter codes; default parameters are discharge (`00060`) and gage height (`00065`). A user-owned `USGS_WATER_API_KEY` is optional for applicable rate-limit behavior and is never persisted.
- **Scope/category:** latest continuous observations for explicitly selected USGS monitoring locations; `water-observation` events.
- **Raw/normalized mapping:** monitoring location ID, parameter code, value, unit, approval status, qualifier, series ID, observation/update timestamps and source point coordinates are retained.
- **Evidence/deduplication:** deterministic source + feature/site + parameter + observation timestamp; acquisition ID and GeoJSON feature path retained.
- **Interpretation:** latest continuous data may be provisional. Raw discharge/gage-height values do not automatically become flood alerts or severity labels; flood interpretation requires an authoritative threshold/status source.
- **Health/safety:** 5 MiB response cap, 5,000-feature limit, bounded explicit sites/parameters, response/parser telemetry and common source-health handling.
- **Status:** implemented, registered, and fixture-tested against the modern API contract; live endpoint validation is tracked separately.

### USGS Hazard Notification System elevated volcanoes
- **Adapter ID:** `usgs-volcano-elevated`
- **Authoritative API family:** `https://volcanoes.usgs.gov/hans-public/api/volcano/default`.
- **Baseline endpoint:** `https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes`.
- **Acquisition:** public USGS HANS JSON API; no project credential; nominal poll interval 900 seconds; 2 MiB response and 1,000-record bounds.
- **Scope/category:** volcanoes in elevated USGS status and their public notification metadata; `volcano-status` events.
- **Raw/normalized mapping:** Smithsonian volcano number, volcano name, official aviation color code, alert level, observatory name/abbreviation, notice identity/type/URL and notice timestamp are retained.
- **Evidence/deduplication:** deterministic source + volcano number + notice identity/timestamp; acquisition ID and array path retained.
- **Interpretation:** display severity follows official HANS color/alert levels conservatively. The elevated-status response does not provide coordinates in this adapter, so no coordinates are inferred from volcano name or prose.
- **Terms:** preserve USGS and issuing-observatory attribution; use official observatory notices for authoritative hazard interpretation.
- **Status:** implemented, registered, and fixture-tested; live endpoint validation is tracked separately.

### NOAA National Data Buoy Center latest observations
- **Adapter ID:** `ndbc-latest-observations`
- **Authoritative data guide:** `https://www.ndbc.noaa.gov/docs/ndbc_web_data_guide.pdf`.
- **Baseline endpoint:** `https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt`.
- **Acquisition:** public fixed-format/latest-observation text feed; no authentication; nominal poll interval 300 seconds; 2 MiB response and 5,000-record bounds.
- **Scope/category:** latest public NDBC station environmental observations; `marine-observation` events.
- **Raw/normalized mapping:** station ID and coordinates plus UTC observation time, wind direction/speed/gust, wave height/period/direction, pressure/tendency, air/water/dewpoint temperature, visibility and tide where present. `MM` missing values remain null.
- **Evidence/deduplication:** deterministic source + station + observation timestamp; acquisition ID and parsed-record path retained.
- **Interpretation:** station measurements are environmental observations, not inferred hazard warnings. The adapter does not infer vessel movements, port status, or marine-warning severity.
- **Terms:** preserve NOAA/NDBC attribution; use official NOAA/NWS warning products for safety-critical decisions.
- **Status:** implemented, registered, and fixture-tested; live endpoint validation is tracked separately.

## Implemented observable/reference enrichment sources
These are analyst-invoked enrichment adapters rather than continuously polled event feeds. They accept user-supplied public observables/places, impose bounded requests where applicable, and retain the source URL/provider in returned provenance. They must not be used to probe private/internal targets.

### OpenStreetMap Nominatim
- **Endpoint family:** `https://nominatim.openstreetmap.org/search` and `/reverse`.
- **Acquisition:** public HTTPS JSON; analyst-invoked; project throttle is at least 1.05 seconds between calls and results are capped at 10.
- **Data:** place-name search, reverse geocoding, provider object identity, display name, point, bounding box, address fields, category/type and importance.
- **Uncertainty/provenance:** provider bounding boxes are retained and converted to a conservative point-to-corner uncertainty estimate; source query URL, attribution and query timestamp are retained.
- **Terms:** retain OpenStreetMap/Nominatim attribution and follow the current public Nominatim usage policy. No bulk geocoding is implemented.
- **Status:** implemented with mocked deterministic tests; live network validation tracked separately.

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

### RIPEstat prefix overview / geolocation enrichment
- **Endpoint families:** `https://stat.ripe.net/data/prefix-overview/data.json` and the RIPEstat MaxMind GeoLite data endpoint used for approximate network geolocation.
- **Acquisition:** unauthenticated HTTPS JSON, analyst-invoked for public IP/prefix observables.
- **Data:** announced prefix, originating ASNs, holder text and approximate provider geolocation where available.
- **Uncertainty:** network geolocation explicitly reports that coordinates are approximate and that the current provider integration does not expose a per-result accuracy radius; it must not be treated as exact device/person location.
- **Rate/cadence:** no automatic polling; bounded interactive requests.
- **Health:** explicit request failure and bounded response.
- **Terms/limits:** routing/holder/geolocation metadata is network context, not proof of physical location, operator identity or user identity.
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

### Public code-search navigation and alias-correlation enrichment
- **Providers/data:** credential-free navigation pivots for public GitHub, GitLab and Sourcegraph code search plus caller-supplied public alias observations.
- **Acquisition:** the project builds public HTTPS navigation URLs; it does not scrape repository search results or require hidden credentials. Alias correlation accepts only public HTTPS evidence URLs.
- **Interpretation:** exact normalized alias matches across distinct public evidence URLs are review-required hypotheses. They never assert that matching aliases identify the same person.
- **Status:** implemented with deterministic safety/interpretation tests.

## Solari acquisition routing
Use the least-complex reliable acquisition method:
1. Direct documented API/feed/download when available and sufficient.
2. Solari Browser when the public source requires browser rendering, browser state, JavaScript interaction, screenshots, or browser-level evidence.
3. Solari Desktop only when the source/workflow genuinely requires GUI/screen interaction that is not cleanly represented through an API or browser workflow.
4. Solari Sandbox for isolated parsing, transformation, generated extraction logic, document processing, enrichment, and untrusted-input handling when isolation adds value.

Static-browser adapters use the same principle. A browser-side network/CORS failure is not silently treated as an empty source: when an evaluator/operator supplies the optional broker endpoint, the console can retry the allowlisted public source through the bounded broker. The broker address is session-only and not hard-coded. Direct Solari browser-side orchestration remains unclaimed until provider CORS/browser-client behavior is verified.

## Prohibited source material
Do not register private customer feeds, proprietary internal feeds, credentialed sources without explicit public-demo authorization, leaked datasets, private personal data, or source lists copied from unrelated private systems.
