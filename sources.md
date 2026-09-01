# Public Source Registry

This file is the authoritative registry for public-source families implemented or intentionally evaluated by the OSINT operations-center showcase. Detailed adapter-specific notes may also live under `docs/sources/`; Git history preserves earlier expanded source notes.

## Inclusion rules
Sources must be lawful public/open sources suitable for a public demonstration. Prefer no-cost APIs, feeds, downloadable datasets, public alert/status systems, and openly accessible web applications. Technical reachability alone does not make collection appropriate: access terms, cadence, interpretation boundaries, provenance, and redistribution constraints are engineering requirements.

Media-monitoring/news-monitoring sources are explicitly out of scope. Private customer feeds, leaked datasets, proprietary source inventories, authenticated-private material, private personal data, and unrelated operational source lists are prohibited.

## Required adapter metadata
Each registered adapter must identify its provider/homepage, acquisition mode, authentication requirement, cadence and resource bounds, geographic/data scope, raw format, normalization/provenance boundary, deterministic identity strategy, known interpretation limits, terms/attribution expectations, implementation state, and live-test state. These details are recorded below and, where useful, in `docs/sources/`.

## Source families

| Family | Public/open sources | Primary mode | Current status |
|---|---|---|---|
| Earthquakes | USGS Earthquake Hazards Program | API/feed + static CORS | Implemented |
| Weather alerts | NOAA/NWS public alerts | API/feed | Implemented |
| Space weather | NOAA Space Weather Prediction Center | API/feed | Implemented |
| Tropical cyclones | NOAA/NHC tropical cyclone RSS products | feed | Implemented Atlantic-basin baseline |
| Tsunami | NOAA/NWS tsunami bulletins | feed/web | Implemented RSS baseline |
| Humanitarian/disaster | GDACS, OpenFEMA, ReliefWeb when configured | API/feed | Implemented baselines |
| Satellite/orbital | CelesTrak public GP data | API/download | Implemented weather-group baseline |
| Wildfire | NASA FIRMS | API/download | Implemented credential-gated bounded Area API baseline |
| Flood/hydrology | USGS Water Data | API/feed | Implemented bounded latest-continuous baseline |
| Volcanoes | USGS Volcano Hazards Program HANS | API | Implemented elevated-status baseline |
| Environmental/marine | EPA AirNow, NOAA NDBC | download/feed | Implemented AirNow + NDBC baselines |
| Aviation weather | AviationWeather.gov METAR API | API | Implemented bounded observation baseline |
| Aviation operational status | FAA National Airspace System Status | API/XML | Implemented airport-status baseline |
| Maritime/port status | U.S. Coast Guard Navigation Center | public web/table | Implemented bounded COTP-zone port-status baseline |
| Transportation | WZDx/CWZ and MBTA static GTFS | API/feed/download | Implemented work-zone + planned-route baselines |
| Storm observations | NOAA Storm Prediction Center preliminary reports | feed/download | Implemented bounded hail-report baseline |
| Infrastructure/outage signals | Georgia Tech IODA | public API | Implemented bounded country-alert baseline |
| Sanctions/watchlists | U.S. Treasury OFAC SDN | download | Implemented CSV baseline |
| Geospatial reference | OpenStreetMap/Nominatim and bounded public boundaries | API/download | Implemented reference/enrichment foundation |
| Observable/network reference | RDAP, RIPEstat, DNS, CT, TLS/HTTPS metadata, Internet Archive | analyst-invoked API/network | Implemented bounded enrichment foundation |

## Registered collection adapters

### `usgs-earthquakes` — USGS Earthquake Hazards Program
- **Provider/docs:** `https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php`.
- **Mode/auth/cadence/bounds:** public GeoJSON; no authentication; 300-second nominal cadence; bounded response parsing.
- **Scope/normalization:** global earthquake feature identity, times, magnitude, place, depth, tsunami flag and source point coordinates become common events/evidence.
- **Provenance/identity:** acquisition URL/time/content hash plus feature path; deterministic source + USGS feature ID.
- **Limits/terms:** point epicenters do not model ShakeMap polygons/uncertainty; preserve USGS attribution.
- **Validation:** deterministic fixture/unit coverage; 2026-09-02 live smoke validation succeeded and is recorded in `docs/live-smoke-tests.md`.

### `nws-alerts` — National Weather Service active alerts
- **Provider:** `https://api.weather.gov/alerts`.
- **Mode/auth/cadence:** public GeoJSON/API; no authentication; 300-second nominal cadence; descriptive User-Agent required.
- **Scope/normalization:** NWS alert identity, source times, event/headline/description, severity/urgency/certainty, area/instruction/sender and evidence path.
- **Identity/provenance:** deterministic source + alert record ID; acquisition metadata/content hash retained.
- **Limits/terms:** baseline does not polygon-normalize alert geometry; use official NWS channels for life-safety decisions and preserve attribution.
- **Validation:** deterministic tests; a validation client unable to render `application/geo+json` is treated as a tooling/content-type failure, never as zero alerts.

### `swpc-alerts` — NOAA Space Weather Prediction Center
- **Provider:** `https://services.swpc.noaa.gov/products/alerts.json`.
- **Mode/auth/cadence:** public JSON; no auth; 300-second nominal cadence.
- **Scope/normalization:** product ID, issue time and message as non-geospatial space-weather products.
- **Identity/provenance:** source + product ID; acquisition metadata/content hash.
- **Limits/terms:** no coordinates invented from product text; preserve NOAA/SWPC attribution.
- **Validation:** deterministic tests plus successful 2026-09-02 live smoke check.

### `nhc-tropical-cyclones` — NOAA National Hurricane Center
- **Provider/docs:** `https://www.nhc.noaa.gov/aboutrss.shtml`; baseline `https://www.nhc.noaa.gov/index-at.xml`.
- **Mode/auth/cadence/bounds:** public RSS/XML; no auth; 3600-second nominal cadence; 2 MiB body limit; DTD/entity constructs rejected before parsing.
- **Scope/normalization:** current Atlantic-basin issued products; title/link/GUID/publication time and inert-text description.
- **Identity/provenance:** deterministic GUID/link identity and RSS path.
- **Limits/terms:** issued products are not forecast cones/wind polygons or canonical storm tracks; no coordinates inferred from prose; preserve NOAA/NHC attribution and Internet-delivery disclaimer.
- **Validation:** deterministic fixture/security tests; live validation tracked separately.

### `noaa-tsunami-bulletins` — NOAA/NWS tsunami bulletins
- **Provider:** NWS RSS library; baseline `https://wcatwc.arh.noaa.gov/rss/tsunamirss.xml`.
- **Mode/auth/cadence/bounds:** public RSS/XML; no auth; 300-second nominal cadence; 2 MiB body limit; DTD/entities rejected.
- **Scope/normalization:** bulletin title/link/GUID/publication time and inert text; conservative display severity only from explicit warning/advisory/watch/information wording.
- **Identity/provenance:** deterministic source + GUID/link; RSS path retained.
- **Limits/terms:** no affected geography inferred from prose; not a life-safety warning channel; preserve NOAA/NWS attribution.
- **Validation:** deterministic fixture/security tests; live endpoint validation tracked separately.

### `fema-disaster-declarations` — OpenFEMA Disaster Declarations Summaries
- **Provider/docs:** `https://www.fema.gov/about/openfema/disaster-declarations-summaries`.
- **Mode/auth/cadence/bounds:** public JSON API; no auth; 1200-second cadence; newest 100 rows; 4 MiB response cap.
- **Scope/normalization:** U.S. federal declarations, state/designated-area text, incident/declaration dates/types and assistance flags.
- **Identity/provenance:** row identity/hash/fallback + acquisition source path.
- **Limits/terms:** designated-area text is not guessed into coordinates; preserve FEMA/OpenFEMA attribution/citation guidance.
- **Validation:** deterministic fixture coverage; a live validation-client fetch failure is recorded as a tool/network failure, not empty data.

### `gdacs-disasters` — Global Disaster Alert and Coordination System
- **Provider/docs:** `https://www.gdacs.org/gdacsapi/swagger/index.html`.
- **Mode/auth/cadence/bounds:** public JSON/GeoJSON; no project credential; 360-second cadence; 5 MiB cap.
- **Scope/normalization:** global multi-hazard event/episode IDs, hazard/alert metadata, dates, provider centroid, countries, severity fields/current state/report URL.
- **Identity/provenance:** event type + event ID + episode ID; feature path retained.
- **Limits/terms:** provider centroid remains labeled as such; baseline does not import every hazard detail/geometry endpoint; preserve GDACS attribution/disclaimer.
- **Validation:** deterministic fixtures; live validation tracked separately.

### `celestrak-weather-satellites` — CelesTrak weather-group GP data
- **Provider/docs:** `https://celestrak.org/NORAD/documentation/gp-data-formats.php`.
- **Mode/auth/cadence/bounds:** public JSON query for `GROUP=WEATHER`; no auth; 7200-second cadence; 3 MiB/2,000-object bounds.
- **Scope/normalization:** public general-perturbations orbital elements keyed to catalog ID and epoch.
- **Identity/provenance:** NORAD catalog ID + epoch; acquisition/array path retained.
- **Limits/terms:** adapter does not fabricate current latitude/longitude; dashboard orbital visualization is an explicitly bounded two-body approximation, not SGP4/navigation-grade. Respect provider update cadence.
- **Validation:** deterministic fixture/bounds tests; live validation tracked separately.

### `nasa-firms-fires` — NASA FIRMS active fire detections
- **Provider/docs:** `https://firms.modaps.eosdis.nasa.gov/api/area/`.
- **Mode/auth/bounds:** Area API CSV; evaluator/user `FIRMS_MAP_KEY` plus explicit bounded `FIRMS_AREA_COORDINATES`; supported day range 1–5; 15 MiB cap; supported-source allowlist.
- **Scope/normalization:** satellite hotspot/detection coordinates/time, satellite/instrument, confidence, FRP, day/night, scan/track and brightness.
- **Identity/provenance:** rounded coordinates + observation time + satellite/instrument; credential redacted from persisted metadata.
- **Limits/terms:** hotspot is not represented as confirmed wildfire perimeter; preserve NASA FIRMS attribution/current guidance.
- **Validation:** deterministic credential-free tests; live collection remains blocked on evaluator/user key + area.

### `reliefweb-disasters` — ReliefWeb disasters
- **Provider/docs:** `https://apidoc.reliefweb.int/`.
- **Mode/auth/bounds:** v2 API; approved evaluator/user `RELIEFWEB_APPNAME`; 100 records/5 MiB per pull.
- **Scope/normalization:** humanitarian disaster ID/name/status/type/country/timestamps/GLIDE/record URL.
- **Identity/provenance:** ReliefWeb record ID + source path; configured appname redacted.
- **Limits/terms:** no coordinates inferred when absent; preserve ReliefWeb and downstream source attribution/copyright obligations.
- **Validation:** deterministic fixtures; live validation requires approved appname.

### `ofac-sdn` — U.S. Treasury OFAC SDN
- **Provider:** `https://ofac.treasury.gov/sanctions-list-service` official `SDN.CSV` export.
- **Mode/auth/cadence/bounds:** public CSV; no project credential; 3600-second cadence; 25 MiB cap.
- **Scope/normalization:** official list entity number/name/type/program/title/vessel and remarks fields.
- **Identity/provenance:** deterministic source + OFAC entity number; CSV row path.
- **Limits/terms:** every record requires downstream identity resolution; name resemblance is not an identity conclusion. Preserve Treasury/OFAC attribution.
- **Validation:** deterministic fixture tests; live validation tracked separately.

### `usgs-volcano-elevated` — USGS HANS elevated volcanoes
- **Provider:** `https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes`.
- **Mode/auth/cadence/bounds:** public JSON; no auth; 900-second cadence; 2 MiB/1,000-record bounds.
- **Scope/normalization:** volcano number/name, official aviation color code/alert level, observatory and notice metadata.
- **Identity/provenance:** volcano + notice identity/time; array path.
- **Limits/terms:** no coordinates inferred from name/prose; preserve USGS/issuing-observatory attribution.
- **Validation:** deterministic fixtures; live validation tracked separately.

### `ndbc-latest-observations` — NOAA National Data Buoy Center
- **Provider/guide:** `https://www.ndbc.noaa.gov/docs/ndbc_web_data_guide.pdf`; feed `https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt`.
- **Mode/auth/cadence/bounds:** public text feed; no auth; 300-second cadence; 2 MiB/5,000-record bounds.
- **Scope/normalization:** latest station coordinates/time plus wind/wave/pressure/temperature/visibility/tide fields; `MM` remains null.
- **Identity/provenance:** station + observation time; parsed-record path.
- **Limits/terms:** measurements are environmental observations, not inferred marine warnings, vessel movement or port status. Preserve NOAA/NDBC attribution.
- **Validation:** deterministic fixtures plus successful 2026-09-02 live smoke check.

### `usgs-water-latest` — USGS Water Data latest continuous observations
- **Provider:** `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items`.
- **Mode/auth/bounds:** public OGC API; explicit max-25 `USGS_WATER_SITE_IDS`, max-10 parameter codes; optional user API key; 5 MiB/5,000-feature bounds.
- **Scope/normalization:** selected monitoring-location/parameter latest value, unit, approval/qualifier, observation/update times and source coordinates.
- **Identity/provenance:** site/feature + parameter + observation time; feature path.
- **Limits/terms:** latest data may be provisional; raw discharge/gage-height does not become flood alert/severity without authoritative thresholds. Preserve USGS attribution.
- **Validation:** deterministic fixtures; live validation tracked separately.

### `airnow-daily-quality` — EPA AirNow daily preliminary data
- **Provider:** `https://files.airnowtech.org/airnow/today/daily_data_v2.dat`.
- **Mode/auth/cadence/bounds:** public pipe-delimited data; no auth; 1800-second cadence; 10 MiB/50,000-record bounds.
- **Scope/normalization:** site/date/parameter/units/value/averaging period/reporting source/AQI/category/monitor coordinates; missing sentinels remain null.
- **Identity/provenance:** date + site/AQS ID + parameter + averaging period; row path.
- **Limits/terms:** preliminary AirNow data are not certified regulatory AQS observations; date-only storage never invents an observation clock time. Preserve AirNow/reporting-agency attribution.
- **Validation:** deterministic parser/normalization tests; live validation tracked separately.

### `usdot-wzdx-workzones` — configurable public WZDx/CWZ feed
- **Provider/docs:** `https://www.transportation.gov/av/data/wzdx` and public WZDx schema.
- **Mode/auth/bounds:** operator supplies one lawful public `WZDX_FEED_URL` plus exact `WZDX_ALLOWED_HOSTS`; HTTPS/port 443, public-address and redirect revalidation; 10 MiB/5,000-feature bounds.
- **Scope/normalization:** work-zone/detour identity, source data ID, roads/direction/name/description/times/vehicle impact/work-zone type and geometry type.
- **Identity/provenance:** source + feature ID/fallback; feature path.
- **Limits/terms:** first valid coordinate is not represented as full extent/centroid; no project safety severity inferred; producer attribution/terms remain source-specific.
- **Validation:** deterministic safety/fixture tests; live producer feed remains operator-configured.

### `aviationweather-metars` — Aviation Weather Center METAR observations
- **Provider/docs:** `https://aviationweather.gov/data/api/`.
- **Mode/auth/cadence/bounds:** public JSON API; no auth; 3600-second cadence; explicit max-25 station list; 2 MiB response and provider result bounds.
- **Scope/normalization:** selected terminal weather observation/raw METAR, station metadata/coordinates, temperature/dewpoint/wind/visibility/altimeter/cloud/flight-category/QC fields.
- **Identity/provenance:** station + observation time + raw report; array path.
- **Limits/terms:** weather observations never imply airport closure/delay/airspace restriction/flight safety. Provider API does not currently support direct browser CORS; preserve Aviation Weather Center/NOAA/NWS attribution.
- **Validation:** deterministic fixtures/current CI; operational-status semantics are handled separately by FAA NAS Status.

### `faa-nas-airport-status` — FAA National Airspace System airport status
- **Provider:** `https://nasstatus.faa.gov/`; machine-readable endpoint `https://nasstatus.faa.gov/api/airport-status-information`.
- **Mode/auth/cadence/bounds:** public HTTPS XML; no auth; 300-second cadence; 2 MiB response cap; hardened `defusedxml` parsing.
- **Scope/normalization:** FAA-published airport operational event type, airport identifier, reason, source start/reopen text, average/max delay text and source update timestamp.
- **Identity/provenance:** deterministic observed event values + acquisition/XML path; XML entity expansion rejected.
- **Limits/terms:** no airport status inferred from METAR data and no coordinates inferred from airport code; analytical display is not an ATC system. Preserve FAA attribution/source wording.
- **Validation:** deterministic status/ID/XML-security tests; official endpoint/documentation reviewed 2026-09-02. See `docs/sources/faa-nas-airport-status.md`.

### `mbta-gtfs-static` — MBTA static GTFS planned-service routes
- **Provider/docs:** `https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md`; feed `https://cdn.mbta.com/MBTA_GTFS.zip`.
- **Mode/auth/cadence/bounds:** public ZIP; no auth; daily cadence; 64 MiB response, 128-entry archive, selected-member 4 MiB, 2,000-route bounds; archive traversal paths rejected.
- **Scope/normalization:** planned-service route identity/names/type/description/URL/colors/feed version/dates.
- **Identity/provenance:** feed version/date + route ID; selected member/record path.
- **Limits/terms:** `schedule_only=true`; route presence is not vehicle position/delay/interruption/current-trip operation. Preserve MBTA attribution.
- **Validation:** deterministic archive/parser/bounds tests; live validation tracked separately.

### `spc-hail-reports` — NOAA Storm Prediction Center preliminary hail reports
- **Provider:** `https://www.spc.noaa.gov/climo/reports/today.html`; CSV `today_hail.csv`.
- **Mode/auth/cadence/bounds:** public CSV; no auth; 300-second cadence; 4 MiB/10,000-record bounds.
- **Scope/normalization:** preliminary convective-day report time, hail size, location/county/state, coordinates/comments; documented 1200 UTC rollover applied.
- **Identity/provenance:** convective-day/time/location/content identity; CSV path.
- **Limits/terms:** `preliminary=true`, `warning_or_forecast=false`; no severity/property-damage conclusion. Preserve NOAA/SPC attribution/disclaimer.
- **Validation:** deterministic convective-day/parser/bounds tests; live validation tracked separately.

### `ioda-outage-alerts` — Georgia Tech IODA outage-alert signals
- **Provider:** Georgia Tech Internet Outage Detection and Analysis public API/project.
- **Mode/auth/cadence/bounds:** public API; no repository credential; bounded six-hour acquisition window, maximum 300 alerts and 2 MiB response.
- **Scope/normalization:** country-level detector alert signals and source timing/identity fields.
- **Identity/provenance:** deterministic source alert identity + acquisition path/metadata.
- **Limits/terms:** detector signals are not asserted causes, impacts, service-provider responsibility, or proof of a specific infrastructure failure. Preserve IODA attribution.
- **Validation:** deterministic normalization/bounds tests and source registration; live validation tracked separately.

### `uscg-port-status` — U.S. Coast Guard Navigation Center port status
- **Provider:** `https://navcen.uscg.gov/port-status`.
- **Mode/auth/cadence/bounds:** unauthenticated public HTML table selected by exact published COTP-zone allowlist; default demo zone `SAN JUAN`; 1800-second cadence; 2 MiB/500-row bounds.
- **Scope/normalization:** published port name/status and optional condition/comments/date-only `Last Changed` fields. Date-only values normalize to UTC midnight with explicit `time_basis=source-date-only`; missing dates use acquisition time with `acquisition-time-fallback`.
- **Identity/provenance:** zone + observed row values; source table-row path.
- **Limits/terms:** no vessel movement/cargo/coordinates inferred; analytical copy does not replace current COTP orders or operational instructions. Preserve USCG attribution/source wording.
- **Validation:** deterministic allowlist/table/date/bounds tests; official index/current zone structures reviewed 2026-09-02. See `docs/sources/uscg-port-status.md`.

## Implemented analyst-invoked reference/enrichment sources
These are not continuously polled event feeds. They accept public analyst-supplied observables/places, impose bounded requests, retain provider/source provenance, and must not probe private/internal targets.

- **OpenStreetMap Nominatim:** public search/reverse JSON; at least 1.05 seconds between project calls, max 10 results; retains provider object ID/display name/point/bounding box/address/type/importance and explicit uncertainty. No bulk geocoding; preserve OSM/Nominatim attribution/current policy.
- **RDAP.org/bootstrap services:** bounded analyst-invoked public domain/IP registration/allocation JSON; registry/RIR data can be redacted and is not ownership proof.
- **crt.sh certificate transparency:** bounded analyst-invoked public JSON-style certificate observations; issuance/visibility is not current-control proof.
- **Google Public DNS JSON:** bounded TXT queries used for SPF/DMARC posture; published record presence is descriptive rather than a complete mail-security conclusion.
- **RIPEstat:** bounded public prefix/ASN/holder and approximate provider geolocation; network geolocation is never represented as exact device/person location.
- **Internet Archive CDX:** bounded history lookups for user-supplied public URLs; archive absence is not proof a page never existed.
- **Direct DNS/TLS/HTTPS metadata:** public targets only; private/loopback/link-local/multicast/reserved/unspecified destinations and embedded credentials rejected; observations are descriptive fingerprints, not definitive software/ownership identity.
- **Public code-search navigation / alias correlation:** credential-free navigation pivots for public code search and caller-supplied public evidence; exact alias matches remain review-required hypotheses, never same-person assertions.

## Live smoke validation record
`docs/live-smoke-tests.md` records dated representative network checks separately from deterministic fixture tests. A validation client that cannot render a content type or reach a source is recorded as a tooling/network failure; it is never converted into an empty event set.

## Solari acquisition routing
Use the least-complex reliable method:
1. Direct documented public API/feed/download when sufficient.
2. Solari Browser when a public source genuinely requires rendering/state/JavaScript interaction/screenshots/browser evidence.
3. Solari Desktop only for legitimate GUI/screen workflows not cleanly represented through API/browser acquisition.
4. Solari Sandbox when isolated parsing/transformation/generated logic/document processing materially improves the untrusted-input boundary.

Static-browser adapters follow the same principle. A browser-side CORS/network failure is not treated as empty data; an evaluator/operator can configure the optional narrow allowlisted broker when appropriate. Current official Solari Browser/Sandbox TypeScript client examples are Node/process-environment clients, Browser maintains a Node-side loopback proxy, and Desktop is documented through a process-environment client. No safe browser-script/short-lived credential flow is currently published, so direct static Solari Browser/Sandbox/Desktop orchestration is intentionally not claimed. See `docs/static-solari-client-verification.md`.

## Prohibited source material
Do not register private customer feeds, proprietary internal feeds, credentialed-private sources without explicit public-demo authorization, leaked datasets, private personal data, or source lists copied from unrelated private systems.
