from __future__ import annotations

from math import atan2, cos, degrees, radians, sin, sqrt

from app.contracts import GeoPoint

EARTH_RADIUS_KM = 6371.0088


def distance_km(a: GeoPoint, b: GeoPoint) -> float:
    """Great-circle distance using the haversine formula."""
    lat1, lon1, lat2, lon2 = map(radians, (a.latitude, a.longitude, b.latitude, b.longitude))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * atan2(sqrt(h), sqrt(max(0.0, 1.0 - h)))


def initial_bearing_degrees(a: GeoPoint, b: GeoPoint) -> float:
    """Initial great-circle bearing from a to b, normalized to [0, 360)."""
    lat1, lat2 = radians(a.latitude), radians(b.latitude)
    dlon = radians(b.longitude - a.longitude)
    y = sin(dlon) * cos(lat2)
    x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dlon)
    return (degrees(atan2(y, x)) + 360.0) % 360.0


def in_bbox(point: GeoPoint, *, min_lat: float, max_lat: float, min_lon: float, max_lon: float) -> bool:
    if min_lat > max_lat:
        raise ValueError("min_lat must be <= max_lat")
    if not (-90 <= min_lat <= 90 and -90 <= max_lat <= 90):
        raise ValueError("latitude bounds must be between -90 and 90")
    if not (-180 <= min_lon <= 180 and -180 <= max_lon <= 180):
        raise ValueError("longitude bounds must be between -180 and 180")
    if min_lon <= max_lon:
        longitude_match = min_lon <= point.longitude <= max_lon
    else:
        # Antimeridian-crossing bounding boxes are represented by min_lon > max_lon.
        longitude_match = point.longitude >= min_lon or point.longitude <= max_lon
    return min_lat <= point.latitude <= max_lat and longitude_match


def within_radius(point: GeoPoint, center: GeoPoint, radius_km: float) -> bool:
    if radius_km < 0:
        raise ValueError("radius_km must be non-negative")
    return distance_km(point, center) <= radius_km
