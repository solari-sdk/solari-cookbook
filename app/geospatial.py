from __future__ import annotations

from math import acos, atan2, cos, degrees, radians, sin, sqrt

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


def point_in_polygon(point: GeoPoint, polygon: list[GeoPoint]) -> bool:
    """Return whether a point is inside a simple lon/lat polygon.

    This baseline ray-casting implementation is intended for polygons that do
    not cross the antimeridian. Antimeridian regions should use bounding-box
    logic or be split into two polygons before evaluation.
    """
    if len(polygon) < 3:
        raise ValueError("polygon requires at least three vertices")
    if max(vertex.longitude for vertex in polygon) - min(vertex.longitude for vertex in polygon) > 180:
        raise ValueError("antimeridian-crossing polygons must be split before evaluation")
    x, y = point.longitude, point.latitude
    inside = False
    j = len(polygon) - 1
    for i, current in enumerate(polygon):
        previous = polygon[j]
        xi, yi = current.longitude, current.latitude
        xj, yj = previous.longitude, previous.latitude
        if ((yi > y) != (yj > y)):
            denominator = yj - yi
            intersection = (xj - xi) * (y - yi) / denominator + xi
            if x < intersection:
                inside = not inside
        j = i
    return inside


def great_circle_route(start: GeoPoint, end: GeoPoint, *, segments: int = 64) -> list[GeoPoint]:
    """Interpolate points along the shortest great-circle path."""
    if segments < 1 or segments > 4096:
        raise ValueError("segments must be between 1 and 4096")
    lat1, lon1 = radians(start.latitude), radians(start.longitude)
    lat2, lon2 = radians(end.latitude), radians(end.longitude)
    a = (cos(lat1) * cos(lon1), cos(lat1) * sin(lon1), sin(lat1))
    b = (cos(lat2) * cos(lon2), cos(lat2) * sin(lon2), sin(lat2))
    dot = max(-1.0, min(1.0, sum(left * right for left, right in zip(a, b))))
    omega = acos(dot)
    if omega == 0:
        return [start.model_copy() for _ in range(segments + 1)]
    sin_omega = sin(omega)
    points: list[GeoPoint] = []
    for index in range(segments + 1):
        fraction = index / segments
        left_weight = sin((1 - fraction) * omega) / sin_omega
        right_weight = sin(fraction * omega) / sin_omega
        x = left_weight * a[0] + right_weight * b[0]
        y = left_weight * a[1] + right_weight * b[1]
        z = left_weight * a[2] + right_weight * b[2]
        latitude = degrees(atan2(z, sqrt(x * x + y * y)))
        longitude = degrees(atan2(y, x))
        points.append(GeoPoint(latitude=latitude, longitude=longitude, precision="great-circle interpolation"))
    return points
