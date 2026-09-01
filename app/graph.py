from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime

from app.contracts import EntityRecord, RelationshipRecord


def adjacency(relationships: list[RelationshipRecord]) -> dict[str, list[tuple[str, RelationshipRecord]]]:
    graph: dict[str, list[tuple[str, RelationshipRecord]]] = defaultdict(list)
    for edge in relationships:
        graph[edge.source_entity_id].append((edge.target_entity_id, edge))
        graph[edge.target_entity_id].append((edge.source_entity_id, edge))
    return graph


def neighborhood(entity_id: str, relationships: list[RelationshipRecord], *, depth: int = 1, max_nodes: int = 500) -> dict[str, object]:
    if depth < 0 or depth > 8:
        raise ValueError("depth must be between 0 and 8")
    if max_nodes < 1 or max_nodes > 5000:
        raise ValueError("max_nodes must be between 1 and 5000")
    graph = adjacency(relationships)
    seen = {entity_id}
    edges: dict[str, RelationshipRecord] = {}
    queue = deque([(entity_id, 0)])
    while queue and len(seen) < max_nodes:
        current, level = queue.popleft()
        if level >= depth:
            continue
        for neighbor, edge in graph.get(current, []):
            edges[edge.id] = edge
            if neighbor not in seen and len(seen) < max_nodes:
                seen.add(neighbor)
                queue.append((neighbor, level + 1))
    return {"entity_ids": sorted(seen), "relationships": list(edges.values()), "truncated": len(seen) >= max_nodes}


def shortest_path(source_id: str, target_id: str, relationships: list[RelationshipRecord], *, max_depth: int = 8) -> dict[str, object] | None:
    if max_depth < 1 or max_depth > 16:
        raise ValueError("max_depth must be between 1 and 16")
    if source_id == target_id:
        return {"entity_ids": [source_id], "relationships": []}
    graph = adjacency(relationships)
    queue = deque([(source_id, [source_id], [])])
    seen = {source_id}
    while queue:
        node, node_path, edge_path = queue.popleft()
        if len(edge_path) >= max_depth:
            continue
        for neighbor, edge in graph.get(node, []):
            if neighbor in seen:
                continue
            next_nodes = node_path + [neighbor]
            next_edges = edge_path + [edge]
            if neighbor == target_id:
                return {"entity_ids": next_nodes, "relationships": next_edges}
            seen.add(neighbor)
            queue.append((neighbor, next_nodes, next_edges))
    return None


def connected_components(relationships: list[RelationshipRecord]) -> list[list[str]]:
    graph = adjacency(relationships)
    remaining = set(graph)
    groups: list[list[str]] = []
    while remaining:
        start = min(remaining)
        component = {start}
        queue = deque([start])
        while queue:
            node = queue.popleft()
            for neighbor, _ in graph.get(node, []):
                if neighbor not in component:
                    component.add(neighbor)
                    queue.append(neighbor)
        remaining -= component
        groups.append(sorted(component))
    return sorted(groups, key=lambda group: (-len(group), group))


def filter_entities(
    entities: list[EntityRecord], *,
    start: datetime | None = None, end: datetime | None = None,
    min_lat: float | None = None, max_lat: float | None = None,
    min_lon: float | None = None, max_lon: float | None = None,
) -> list[EntityRecord]:
    output=[]
    for entity in entities:
        moment = entity.last_seen or entity.first_seen
        if start and moment and moment < start:
            continue
        if end and moment and moment > end:
            continue
        if any(value is not None for value in (min_lat,max_lat,min_lon,max_lon)):
            if not entity.location:
                continue
            if min_lat is not None and entity.location.latitude < min_lat: continue
            if max_lat is not None and entity.location.latitude > max_lat: continue
            if min_lon is not None and entity.location.longitude < min_lon: continue
            if max_lon is not None and entity.location.longitude > max_lon: continue
        output.append(entity)
    return output


def explain_path(path: dict[str, object] | None) -> list[dict[str, object]]:
    if not path:
        return []
    return [
        {
            "relationship_id": edge.id,
            "type": edge.type,
            "source_entity_id": edge.source_entity_id,
            "target_entity_id": edge.target_entity_id,
            "confidence": edge.confidence,
            "observed": edge.observed,
            "evidence": [item.model_dump(mode="json") for item in edge.evidence],
        }
        for edge in path["relationships"]
    ]
