from __future__ import annotations

from collections import Counter, deque
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.storage import list_entities, list_events
from app.workflows import Playbook, WorkflowEngine

router = APIRouter(prefix="/api/v1/workflows", tags=["workflows"])
MAX_WORKFLOW_STEPS = 50
MAX_INPUT_KEYS = 50
MAX_RESULT_ROWS = 250


class WorkflowRequest(BaseModel):
    playbook: Playbook
    inputs: dict[str, Any] = Field(default_factory=dict)
    approvals: list[str] = Field(default_factory=list, max_length=50)


def _bounded_int(value: Any, default: int = 100) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(1, min(MAX_RESULT_ROWS, number))


def _current_events(context: dict[str, Any]) -> list[dict[str, object]]:
    inputs = context["inputs"]
    source_id = inputs.get("source_id")
    category = inputs.get("category")
    query = inputs.get("query")
    return list_events(
        _bounded_int(inputs.get("limit")),
        source_id=str(source_id) if source_id else None,
        category=str(category) if category else None,
        query=str(query)[:200] if query else None,
    )


def _current_entities(context: dict[str, Any]) -> list[dict[str, object]]:
    inputs = context["inputs"]
    entity_type = inputs.get("entity_type")
    query = inputs.get("query")
    return list_entities(
        _bounded_int(inputs.get("limit")),
        entity_type=str(entity_type) if entity_type else None,
        query=str(query)[:200] if query else None,
    )


def _category_counts(context: dict[str, Any]) -> dict[str, int]:
    rows = _first_dependency_list(context)
    return dict(sorted(Counter(str(row.get("category") or "uncategorized") for row in rows if isinstance(row, dict)).items()))


def _entity_type_counts(context: dict[str, Any]) -> dict[str, int]:
    rows = _first_dependency_list(context)
    return dict(sorted(Counter(str(row.get("type") or "unknown") for row in rows if isinstance(row, dict)).items()))


def _row_count(context: dict[str, Any]) -> int:
    return len(_first_dependency_list(context))


def _first_dependency_list(context: dict[str, Any]) -> list[Any]:
    dependencies = context.get("dependencies") or {}
    if not dependencies:
        return []
    value = dependencies[sorted(dependencies)[0]]
    return value if isinstance(value, list) else []


ACTIONS = {
    "current_events": _current_events,
    "current_entities": _current_entities,
    "category_counts": _category_counts,
    "entity_type_counts": _entity_type_counts,
    "row_count": _row_count,
}
ENGINE = WorkflowEngine(ACTIONS, max_workers=4)


def _validate_request(body: WorkflowRequest) -> None:
    if not body.playbook.steps:
        raise HTTPException(400, "workflow must contain at least one step")
    if len(body.playbook.steps) > MAX_WORKFLOW_STEPS:
        raise HTTPException(400, f"workflow exceeds {MAX_WORKFLOW_STEPS} step limit")
    if len(body.inputs) > MAX_INPUT_KEYS:
        raise HTTPException(400, f"workflow inputs exceed {MAX_INPUT_KEYS} key limit")
    known = {step.id for step in body.playbook.steps}
    for step in body.playbook.steps:
        if step.action not in ACTIONS:
            raise HTTPException(400, f"unsupported workflow action: {step.action}")
        if step.fallback_action and step.fallback_action not in ACTIONS:
            raise HTTPException(400, f"unsupported fallback workflow action: {step.fallback_action}")
    if any(item not in known for item in body.approvals):
        raise HTTPException(400, "approvals may reference only workflow step IDs")
    _topological_order(body.playbook)


def _topological_order(playbook: Playbook) -> list[str]:
    dependencies = {step.id: set(step.depends_on) for step in playbook.steps}
    reverse: dict[str, set[str]] = {step.id: set() for step in playbook.steps}
    for step in playbook.steps:
        for dependency in step.depends_on:
            reverse[dependency].add(step.id)
    ready = deque(sorted(step_id for step_id, deps in dependencies.items() if not deps))
    order: list[str] = []
    while ready:
        step_id = ready.popleft()
        order.append(step_id)
        for child in sorted(reverse[step_id]):
            dependencies[child].discard(step_id)
            if not dependencies[child] and child not in order and child not in ready:
                ready.append(child)
    if len(order) != len(dependencies):
        raise HTTPException(400, "workflow dependency graph contains a cycle")
    return order


def _graph(body: WorkflowRequest) -> dict[str, object]:
    order = _topological_order(body.playbook)
    return {
        "playbook_id": body.playbook.id,
        "name": body.playbook.name,
        "nodes": [
            {
                "id": step.id,
                "action": step.action,
                "requires_review": step.requires_review,
                "retries": step.retries,
                "fallback_action": step.fallback_action,
            }
            for step in body.playbook.steps
        ],
        "edges": [{"source": dependency, "target": step.id} for step in body.playbook.steps for dependency in step.depends_on],
        "topological_order": order,
        "available_actions": sorted(ACTIONS),
    }


@router.post("/validate")
def validate_workflow(body: WorkflowRequest) -> dict[str, object]:
    _validate_request(body)
    return _graph(body)


@router.post("/run")
def run_workflow(body: WorkflowRequest) -> dict[str, object]:
    _validate_request(body)
    run = ENGINE.run(body.playbook, body.inputs, approvals=set(body.approvals))
    return asdict(run)


@router.post("/rerun")
def rerun_workflow(body: WorkflowRequest) -> dict[str, object]:
    """Run the same declarative playbook again against current persisted public-source data."""
    _validate_request(body)
    run = ENGINE.run(body.playbook, body.inputs, approvals=set(body.approvals))
    result = asdict(run)
    result["rerun"] = True
    return result
