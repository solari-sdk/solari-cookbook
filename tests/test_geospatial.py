import pytest

from app.contracts import GeoPoint
from app.geospatial import distance_km, in_bbox, initial_bearing_degrees, within_radius


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
