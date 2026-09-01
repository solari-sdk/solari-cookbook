from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.alerts import (
    acknowledge_alert,
    emit_alert,
    evaluate_change,
    evaluate_correlation,
    evaluate_event,
    list_alerts,
    list_watch_rules,
    save_watch_rule,
)

router = APIRouter(prefix="/api/v1", tags=["alerts"])


class WatchRuleInput(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=200)
    rule_type: Literal["source", "category", "severity", "geo", "entity", "observable", "correlation", "change"]
    config: dict[str, Any]
    enabled: bool = True


class EventEvaluationInput(BaseModel):
    event: dict[str, Any]


class CorrelationEvaluationInput(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    payload: dict[str, Any] = Field(default_factory=dict)


class ChangeEvaluationInput(BaseModel):
    previous: dict[str, Any]
    current: dict[str, Any]


class AlertInput(BaseModel):
    rule_id: str = Field(min_length=1, max_length=120)
    subject_id: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=500)
    payload: dict[str, Any] = Field(default_factory=dict)
    severity: str = Field(default="info", max_length=40)
    suppression_seconds: int = Field(default=300, ge=0, le=604800)


class AckInput(BaseModel):
    analyst: str | None = Field(default=None, max_length=120)
    status: Literal["acknowledged", "resolved", "dismissed"] = "acknowledged"


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError): return HTTPException(404, str(exc).strip("'"))
    if isinstance(exc, ValueError): return HTTPException(400, str(exc))
    return HTTPException(500, type(exc).__name__)


@router.get("/watch-rules")
def watch_rules(enabled_only: bool = False, rule_type: str | None = None) -> list[dict[str, object]]:
    return list_watch_rules(enabled_only=enabled_only, rule_type=rule_type)


@router.put("/watch-rules/{rule_id}")
def put_watch_rule(rule_id: str, body: WatchRuleInput) -> dict[str, object]:
    if rule_id != body.id: raise HTTPException(400, "path rule_id must equal body id")
    try: return save_watch_rule(body.id, body.name, body.rule_type, body.config, enabled=body.enabled)
    except Exception as exc: raise _error(exc) from exc


@router.post("/watch-rules/evaluate-event")
def evaluate_event_rules(body: EventEvaluationInput) -> list[dict[str, object]]:
    return evaluate_event(body.event)


@router.post("/watch-rules/evaluate-correlation")
def evaluate_correlation_rules(body: CorrelationEvaluationInput) -> list[dict[str, object]]:
    return evaluate_correlation(body.score, body.payload)


@router.post("/watch-rules/evaluate-change")
def evaluate_change_rules(body: ChangeEvaluationInput) -> list[dict[str, object]]:
    return evaluate_change(body.previous, body.current)


@router.get("/alerts")
def alerts(status: str | None = None, rule_id: str | None = None, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    return list_alerts(status=status, rule_id=rule_id, limit=limit)


@router.post("/alerts")
def create_alert(body: AlertInput) -> dict[str, object]:
    try:
        result = emit_alert(body.rule_id, body.subject_id, body.title, body.payload, severity=body.severity, suppression_seconds=body.suppression_seconds)
    except Exception as exc:
        raise _error(exc) from exc
    return {"created": result is not None, "alert": result}


@router.post("/alerts/{alert_id}/acknowledge")
def acknowledge(alert_id: str, body: AckInput) -> dict[str, object]:
    try: return acknowledge_alert(alert_id, analyst=body.analyst, status=body.status)
    except Exception as exc: raise _error(exc) from exc
