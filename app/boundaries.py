from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from app.contracts import GeoPoint
from app.geospatial import point_in_polygon


@dataclass(frozen=True, slots=True)
class Boundary:
    id: str
    name: str
    level: str
    vertices: tuple[GeoPoint, ...]
    source_id: str
    properties: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if len(self.vertices) < 3:
            raise ValueError("boundary requires at least three vertices")
        if not self.id or not self.name or not self.source_id:
            raise ValueError("boundary id, name and source_id are required")


def intersect_boundaries(point: GeoPoint, boundaries: Iterable[Boundary]) -> list[dict[str, object]]:
    """Return every caller-supplied boundary containing a point with dataset provenance."""
    matches=[]
    for boundary in boundaries:
        if point_in_polygon(point, boundary.vertices):
            matches.append({
                "boundary_id": boundary.id,
                "name": boundary.name,
                "level": boundary.level,
                "source_id": boundary.source_id,
                "properties": dict(boundary.properties),
                "transformed_evidence": True,
            })
    return sorted(matches, key=lambda item: (str(item["level"]), str(item["name"]), str(item["boundary_id"])))
