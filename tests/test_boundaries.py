from app.boundaries import Boundary, intersect_boundaries
from app.contracts import GeoPoint


def test_boundary_intersection_preserves_dataset_provenance():
    boundary=Boundary(
        id="region-1",name="Example Region",level="admin1",source_id="open-boundary-fixture",
        vertices=(GeoPoint(latitude=0,longitude=0),GeoPoint(latitude=0,longitude=10),GeoPoint(latitude=10,longitude=10),GeoPoint(latitude=10,longitude=0)),
        properties={"dataset_version":"fixture-1"},
    )
    matches=intersect_boundaries(GeoPoint(latitude=5,longitude=5),[boundary])
    assert matches[0]["boundary_id"] == "region-1"
    assert matches[0]["source_id"] == "open-boundary-fixture"
    assert matches[0]["transformed_evidence"] is True
    assert intersect_boundaries(GeoPoint(latitude=20,longitude=20),[boundary]) == []
