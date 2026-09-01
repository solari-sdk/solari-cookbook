from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.graph import connected_components, explain_path, neighborhood, shortest_path
from app.graph_store import relationship_models

router = APIRouter(prefix="/api/v1/graph", tags=["graph"])


@router.get("/neighborhood/{entity_id}")
def graph_neighborhood(
    entity_id: str,
    depth: int = Query(1, ge=0, le=8),
    max_nodes: int = Query(500, ge=1, le=5000),
) -> dict[str, object]:
    result = neighborhood(entity_id, relationship_models(), depth=depth, max_nodes=max_nodes)
    return {
        "entity_ids": result["entity_ids"],
        "relationships": [edge.model_dump(mode="json") for edge in result["relationships"]],
        "truncated": result["truncated"],
    }


@router.get("/path")
def graph_path(
    source_id: str,
    target_id: str,
    max_depth: int = Query(8, ge=1, le=16),
) -> dict[str, object]:
    result = shortest_path(source_id, target_id, relationship_models(), max_depth=max_depth)
    if result is None:
        raise HTTPException(404, "no path found within max_depth")
    return {
        "entity_ids": result["entity_ids"],
        "relationships": [edge.model_dump(mode="json") for edge in result["relationships"]],
        "explanation": explain_path(result),
    }


@router.get("/components")
def graph_components() -> dict[str, object]:
    groups = connected_components(relationship_models())
    return {"components": groups, "count": len(groups)}
