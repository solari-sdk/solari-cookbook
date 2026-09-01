# Public Source Registry

This file is the authoritative registry for source families planned or implemented by the OSINT operations-center showcase.

## Inclusion rules

Sources must be lawful public/open sources suitable for a public demonstration. Prefer no-cost APIs, feeds, downloadable datasets, public alert systems, and openly accessible web applications. A source being technically reachable does not automatically make collection appropriate; document access/terms constraints where relevant.

Media-monitoring/news-monitoring sources are explicitly out of scope.

## Required source-adapter metadata

Each implemented adapter must record:
- canonical source/provider name;
- public homepage/documentation endpoint;
- acquisition mode: API / feed / browser / desktop / download;
- authentication requirement;
- rate/update cadence;
- geographic scope;
- event/data categories;
- raw format;
- normalization mapping;
- provenance/evidence retained;
- deduplication key strategy;
- health-check strategy;
- known limitations;
- license/terms notes where relevant;
- implementation status and last live test.

## Planned source families

| Family | Candidate public/open sources | Primary mode | Status |
|---|---|---|---|
| Earthquakes | USGS Earthquake Hazards Program and other authoritative national feeds where reusable | API/feed | Planned |
| Volcanoes | USGS Volcano Hazards Program / Smithsonian public volcano data where terms permit | API/web | Planned |
| Wildfire | NASA FIRMS and public fire/perimeter datasets | API/download | Planned |
| Weather alerts | NOAA/NWS public alerts and observations | API/feed | Planned |
| Tropical cyclones | NOAA/NHC and other authoritative public warning centers | API/feed/web | Planned |
| Flood/hydrology | NOAA/NWS/NWPS and public river/gauge sources | API/feed | Planned |
| Tsunami | NOAA/NWS Tsunami Warning System public products | feed/web | Planned |
| Space weather | NOAA Space Weather Prediction Center | API/feed | Planned |
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

## Solari acquisition routing

Use the least-complex reliable acquisition method:

1. Direct documented API/feed/download when available and sufficient.
2. Solari Browser when the public source requires browser rendering, browser state, JavaScript interaction, screenshots, or browser-level evidence.
3. Solari Desktop only when the source/workflow genuinely requires GUI/screen interaction that is not cleanly represented through an API or browser automation.
4. Solari Sandbox for isolated parsing, transformation, generated extraction logic, document processing, enrichment, and untrusted-input handling regardless of acquisition mode when isolation adds value.

## Prohibited source material

Do not register private customer feeds, proprietary internal feeds, credentialed sources without explicit public-demo authorization, leaked datasets, private personal data, or source lists copied from unrelated private systems.
