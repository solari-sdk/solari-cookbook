import pytest

from app.contracts import GeoPoint
from app.geospatial import distance_km, great_circle_route, in_bbox, initial_bearing_degrees, point_in_polygon, within_radius


def test_distance_and_bearing_are_bounded() -> None:
    a = GeoPoint(latitude=0, longitude=0)
    b = GeoPoint(latitude=0, longitude=1)
    assert distance_km(a, b) == pytest.approx(111.195, rel=1e-3)
    assert initial_bearing_degrees(a, b) == pytest.approx(90.0)
    assert within_radius(b, a, 112)
    assert not within_radius(b, a, 100)


def test_bbox_supports_antimeridian() -> None:
    east = GeoPoint(latitude=10, longitude=179.5)
    west = GeoPoint(latitude=10, longitude=-179.5)
    assert in_bbox(east, min_lat=0, max_lat=20, min_lon=170, max_lon=-170)
    assert in_bbox(west, min_lat=0, max_lat=20, min_lon=170, max_lon=-170)
    with pytest.raises(ValueError):
        in_bbox(east, min_lat=20, max_lat=0, min_lon=-180, max_lon=180)


def test_polygon_filtering_and_antimeridian_guard() -> None:
    polygon = [
        GeoPoint(latitude=0, longitude=0),
        GeoPoint(latitude=0, longitude=10),
        GeoPoint(latitude=10, longitude=10),
        GeoPoint(latitude=10, longitude=0),
    ]
    assert point_in_polygon(GeoPoint(latitude=5, longitude=5), polygon)
    assert not point_in_polygon(GeoPoint(latitude=20, longitude=20), polygon)
    with pytest.raises(ValueError, match="antimeridian"):
        point_in_polygon(GeoPoint(latitude=0, longitude=179), [GeoPoint(latitude=-1, longitude=170), GeoPoint(latitude=1, longitude=-170), GeoPoint(latitude=2, longitude=170)])


def test_great_circle_route_includes_endpoints() -> None:
    start = GeoPoint(latitude=0, longitude=0)
    end = GeoPoint(latitude=0, longitude=90)
    points = great_circle_route(start, end, segments=4)
    assert len(points) == 5
    assert points[0].latitude == pytest.approx(start.latitude)
    assert points[0].longitude == pytest.approx(start.longitude)
    assert points[-1].latitude == pytest.approx(end.latitude)
    assert points[-1].longitude == pytest.approx(end.longitude)
    with pytest.raises(ValueError):
        great_circle_route(start, end, segments=0)
