from __future__ import annotations

from types import ModuleType

from app.contracts import SourceDescriptor
from app.sources import (
    airnow_daily_quality,
    aviationweather_metars,
    celestrak_weather_satellites,
    fema_disaster_declarations,
    gdacs_disasters,
    mbta_gtfs_static,
    nasa_firms_fires,
    ndbc_latest_observations,
    nhc_tropical_cyclones,
    noaa_tsunami_bulletins,
    nws_alerts,
    ofac_sdn,
    reliefweb_disasters,
    spc_hail_reports,
    swpc_alerts,
    usdot_wzdx_workzones,
    usgs_earthquakes,
    usgs_volcano_elevated,
    usgs_water_latest,
)

REGISTERED_ADAPTERS: tuple[ModuleType, ...] = (
    usgs_earthquakes,
    nws_alerts,
    swpc_alerts,
    nhc_tropical_cyclones,
    noaa_tsunami_bulletins,
    fema_disaster_declarations,
    gdacs_disasters,
    celestrak_weather_satellites,
    nasa_firms_fires,
    reliefweb_disasters,
    ofac_sdn,
    usgs_volcano_elevated,
    ndbc_latest_observations,
    usgs_water_latest,
    airnow_daily_quality,
    usdot_wzdx_workzones,
    aviationweather_metars,
    mbta_gtfs_static,
    spc_hail_reports,
)

ADAPTERS: dict[str, ModuleType] = {adapter.SOURCE.id: adapter for adapter in REGISTERED_ADAPTERS}
SOURCES: dict[str, SourceDescriptor] = {source_id: adapter.SOURCE for source_id, adapter in ADAPTERS.items()}

if len(ADAPTERS) != len(REGISTERED_ADAPTERS):
    raise RuntimeError("duplicate public source adapter ID in registry")
