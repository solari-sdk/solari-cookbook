from __future__ import annotations

import heapq
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any, Callable

from pydantic import BaseModel, Field, model_validator

Action = Callable[[dict[str, Any]], Any]


class StepCondition(BaseModel):
    step_id: str
    key: str | None = None
    operator: str = Field(default="truthy", pattern=r"^(truthy|falsey|eq|ne)$")
    value: Any = None


class WorkflowStep(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9._-]+$")
    action: str
    depends_on: list[str] = Field(default_factory=list)
    condition: StepCondition | None = None
    retries: int = Field(default=0, ge=0, le=10)
    fallback_action: str | None = None
    requires_review: bool = False


class Playbook(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9._-]+$")
    name: str
    version: int = Field(default=1, ge=1)
    steps: list[WorkflowStep]

    @model_validator(mode="after")
    def validate_graph(self) -> "Playbook":
        ids = [step.id for step in self.steps]
        if len(ids) != len(set(ids)):
            raise ValueError("workflow step ids must be unique")
        known = set(ids)
        for step in self.steps:
            unknown = set(step.depends_on) - known
            if unknown:
                raise ValueError(f"unknown dependency for {step.id}: {sorted(unknown)}")
            if step.id in step.depends_on:
                raise ValueError("workflow step cannot depend on itself")
        return self


@dataclass(slots=True)
class WorkflowRun:
    playbook_id: str
    playbook_version: int
    status: str
    inputs: dict[str, Any]
    outputs: dict[str, Any] = field(default_factory=dict)
    trace: list[dict[str, Any]] = field(default_factory=list)
    waiting_for_review: list[str] = field(default_factory=list)


class WorkflowEngine:
    def __init__(self, actions: dict[str, Action], *, max_workers: int = 4) -> None:
        if max_workers < 1:
            raise ValueError("max_workers must be positive")
        self.actions = dict(actions)
        self.max_workers = max_workers

    def _condition_passes(self, condition: StepCondition | None, outputs: dict[str, Any]) -> bool:
        if condition is None:
            return True
        value = outputs.get(condition.step_id)
        if condition.key is not None:
            if not isinstance(value, dict):
                return False
            value = value.get(condition.key)
        if condition.operator == "truthy":
            return bool(value)
        if condition.operator == "falsey":
            return not bool(value)
        if condition.operator == "eq":
            return value == condition.value
        if condition.operator == "ne":
            return value != condition.value
        return False

    def _execute_step(self, step: WorkflowStep, context: dict[str, Any]) -> dict[str, Any]:
        action = self.actions.get(step.action)
        if action is None:
            raise KeyError(f"unknown workflow action: {step.action}")
        started = perf_counter()
        error: Exception | None = None
        for attempt in range(step.retries + 1):
            try:
                output = action(deepcopy(context))
                return {"status": "success", "output": output, "attempts": attempt + 1, "duration_ms": (perf_counter() - started) * 1000.0}
            except Exception as exc:
                error = exc
        if step.fallback_action:
            fallback = self.actions.get(step.fallback_action)
            if fallback is None:
                raise KeyError(f"unknown fallback workflow action: {step.fallback_action}")
            try:
                output = fallback(deepcopy(context))
                return {"status": "fallback", "output": output, "attempts": step.retries + 1, "duration_ms": (perf_counter() - started) * 1000.0, "error_type": type(error).__name__ if error else None}
            except Exception as exc:
                error = exc
        return {"status": "failure", "output": None, "attempts": step.retries + 1, "duration_ms": (perf_counter() - started) * 1000.0, "error_type": type(error).__name__ if error else None, "error_message": str(error) if error else None}

    def run(self, playbook: Playbook, inputs: dict[str, Any], *, approvals: set[str] | None = None) -> WorkflowRun:
        approvals = approvals or set()
        pending = {step.id: step for step in playbook.steps}
        completed: set[str] = set()
        outputs: dict[str, Any] = {}
        trace: list[dict[str, Any]] = []

        while pending:
            ready = [step for step in pending.values() if set(step.depends_on) <= completed]
            if not ready:
                return WorkflowRun(playbook.id, playbook.version, "failed", deepcopy(inputs), outputs, trace + [{"status": "failure", "error": "cyclic-or-unreachable-dependency"}])
            waiting = sorted(step.id for step in ready if step.requires_review and step.id not in approvals)
            if waiting:
                return WorkflowRun(playbook.id, playbook.version, "waiting_review", deepcopy(inputs), outputs, trace, waiting)

            runnable: list[WorkflowStep] = []
            for step in ready:
                if not self._condition_passes(step.condition, outputs):
                    completed.add(step.id)
                    pending.pop(step.id)
                    trace.append({"step_id": step.id, "status": "skipped", "reason": "condition"})
                else:
                    runnable.append(step)

            if not runnable:
                continue

            contexts = {
                step.id: {
                    "inputs": deepcopy(inputs),
                    "outputs": deepcopy(outputs),
                    "dependencies": {dep: deepcopy(outputs.get(dep)) for dep in step.depends_on},
                    "step_id": step.id,
                }
                for step in runnable
            }
            with ThreadPoolExecutor(max_workers=min(self.max_workers, len(runnable))) as pool:
                futures = {pool.submit(self._execute_step, step, contexts[step.id]): step for step in runnable}
                results: dict[str, dict[str, Any]] = {}
                for future in as_completed(futures):
                    step = futures[future]
                    results[step.id] = future.result()

            for step in sorted(runnable, key=lambda item: item.id):
                result = results[step.id]
                trace.append({"step_id": step.id, **{key: value for key, value in result.items() if key != "output"}})
                if result["status"] == "failure":
                    return WorkflowRun(playbook.id, playbook.version, "failed", deepcopy(inputs), outputs, trace)
                outputs[step.id] = result["output"]
                completed.add(step.id)
                pending.pop(step.id)

        return WorkflowRun(playbook.id, playbook.version, "success", deepcopy(inputs), outputs, trace)

    def rerun(self, playbook: Playbook, prior: WorkflowRun, *, approvals: set[str] | None = None) -> WorkflowRun:
        return self.run(playbook, deepcopy(prior.inputs), approvals=approvals)

    def run_batch(self, playbook: Playbook, targets: list[Any], *, base_inputs: dict[str, Any] | None = None, target_key: str = "target") -> list[WorkflowRun]:
        base_inputs = base_inputs or {}
        with ThreadPoolExecutor(max_workers=min(self.max_workers, max(1, len(targets)))) as pool:
            futures = []
            for target in targets:
                payload = deepcopy(base_inputs)
                payload[target_key] = target
                futures.append(pool.submit(self.run, playbook, payload))
            return [future.result() for future in futures]


def diff_workflow_runs(previous: WorkflowRun, current: WorkflowRun) -> dict[str, Any]:
    keys = sorted(set(previous.outputs) | set(current.outputs))
    changes = []
    for key in keys:
        before = previous.outputs.get(key)
        after = current.outputs.get(key)
        if before != after:
            changes.append({"step_id": key, "before": before, "after": after})
    return {"changed": bool(changes), "changes": changes}


class PriorityWorkflowQueue:
    def __init__(self) -> None:
        self._heap: list[tuple[int, int, str, dict[str, Any]]] = []
        self._counter = 0

    def push(self, playbook_id: str, inputs: dict[str, Any], *, priority: int = 100) -> None:
        self._counter += 1
        heapq.heappush(self._heap, (priority, self._counter, playbook_id, deepcopy(inputs)))

    def pop(self) -> dict[str, Any] | None:
        if not self._heap:
            return None
        priority, _, playbook_id, inputs = heapq.heappop(self._heap)
        return {"playbook_id": playbook_id, "inputs": inputs, "priority": priority}

    def __len__(self) -> int:
        return len(self._heap)
