from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from app.workflows import Playbook

TriggerKind = Literal["schedule", "event", "source-health"]


@dataclass(frozen=True, slots=True)
class WorkflowTrigger:
    id: str
    playbook_id: str
    kind: TriggerKind
    config: dict[str, Any]
    enabled: bool = True


class PlaybookRegistry:
    """Reusable named workflow presets without embedding credentials or targets."""

    def __init__(self) -> None:
        self._items: dict[str, Playbook] = {}

    def register(self, playbook: Playbook) -> None:
        if playbook.id in self._items:
            raise ValueError(f"playbook already registered: {playbook.id}")
        self._items[playbook.id] = playbook.model_copy(deep=True)

    def get(self, playbook_id: str) -> Playbook:
        try:
            return self._items[playbook_id].model_copy(deep=True)
        except KeyError as exc:
            raise KeyError("unknown playbook") from exc

    def list(self) -> list[dict[str, object]]:
        return [
            {"id": item.id, "name": item.name, "version": item.version, "step_count": len(item.steps)}
            for item in sorted(self._items.values(), key=lambda value: value.id)
        ]


def trigger_matches(trigger: WorkflowTrigger, payload: dict[str, Any], *, now: datetime | None = None) -> bool:
    """Evaluate declarative workflow triggers. No expressions or source code are executed."""
    if not trigger.enabled:
        return False
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    if trigger.kind == "schedule":
        interval = int(trigger.config.get("interval_minutes", 0))
        last_run = trigger.config.get("last_run_at")
        if interval < 1:
            raise ValueError("schedule trigger requires positive interval_minutes")
        if not last_run:
            return True
        last = datetime.fromisoformat(str(last_run).replace("Z", "+00:00"))
        if last.tzinfo is None:
            raise ValueError("last_run_at must include timezone information")
        return (now.astimezone(timezone.utc) - last.astimezone(timezone.utc)).total_seconds() >= interval * 60

    if trigger.kind == "event":
        expected_category = trigger.config.get("category")
        expected_source = trigger.config.get("source_id")
        if expected_category is not None and payload.get("category") != expected_category:
            return False
        if expected_source is not None and payload.get("source_id") != expected_source:
            return False
        return expected_category is not None or expected_source is not None

    if trigger.kind == "source-health":
        expected_source = trigger.config.get("source_id")
        statuses = set(trigger.config.get("statuses") or ["stale", "failure", "open-circuit"])
        if expected_source is not None and payload.get("source_id") != expected_source:
            return False
        return payload.get("status") in statuses

    raise ValueError("unsupported workflow trigger kind")
