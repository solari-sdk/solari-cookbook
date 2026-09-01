from __future__ import annotations

import argparse
import os
import socket
import time
from pathlib import Path
from typing import Any

from app.collection import collect_many
from app.entities import derive_graph
from app.job_store import record_collection_result
from app.sources.registry import ADAPTERS
from app.storage import DB_PATH, save_acquisition, save_entities, save_events, save_relationships
from app.task_queue import claim_task, complete_task, fail_task, heartbeat_worker
from app.workflow_api import ACTIONS, MAX_INPUT_KEYS, MAX_WORKFLOW_STEPS
from app.workflows import Playbook, WorkflowEngine

WORKFLOW_ENGINE = WorkflowEngine(ACTIONS, max_workers=4)
SUPPORTED_TASK_KINDS = {"collect-source", "workflow-run"}
MAX_APPROVALS = 50


def _persist_collection(result, *, path: Path) -> dict[str, Any]:
    if not result.succeeded or result.acquisition is None:
        detail = result.error_message or result.error_type or "collection failed"
        raise RuntimeError(f"{result.source_id}: {detail}")
    save_acquisition(result.acquisition, path)
    events_saved = save_events(result.events, path)
    entities, relationships = derive_graph(result.events)
    save_entities(entities, path)
    save_relationships(relationships, path)
    return {
        "source_id": result.source_id,
        "acquisition_id": result.acquisition.id,
        "events_saved": events_saved,
        "entities_saved": len(entities),
        "relationships_saved": len(relationships),
        "attempts": result.attempts,
    }


def _run_collection(payload: dict[str, Any], *, path: Path) -> dict[str, Any]:
    source_id = str(payload.get("source_id") or "")
    if source_id not in ADAPTERS:
        raise ValueError("collect-source task requires a registered public source_id")
    result = collect_many(ADAPTERS, [source_id], max_workers=1)[0]
    record_collection_result(result, path=path)
    return _persist_collection(result, path=path)


def _run_workflow(payload: dict[str, Any]) -> dict[str, Any]:
    raw_playbook = payload.get("playbook")
    if not isinstance(raw_playbook, dict):
        raise ValueError("workflow-run task requires a playbook object")
    playbook = Playbook.model_validate(raw_playbook)
    if not playbook.steps or len(playbook.steps) > MAX_WORKFLOW_STEPS:
        raise ValueError(f"workflow must contain between 1 and {MAX_WORKFLOW_STEPS} steps")
    for step in playbook.steps:
        if step.action not in ACTIONS:
            raise ValueError(f"unsupported workflow action: {step.action}")
        if step.fallback_action and step.fallback_action not in ACTIONS:
            raise ValueError(f"unsupported fallback workflow action: {step.fallback_action}")
    inputs = payload.get("inputs") or {}
    if not isinstance(inputs, dict) or len(inputs) > MAX_INPUT_KEYS:
        raise ValueError(f"workflow inputs must be an object with at most {MAX_INPUT_KEYS} keys")
    approvals = payload.get("approvals") or []
    if not isinstance(approvals, list) or len(approvals) > MAX_APPROVALS or any(not isinstance(item, str) for item in approvals):
        raise ValueError(f"workflow approvals must contain at most {MAX_APPROVALS} step IDs")
    known_steps = {step.id for step in playbook.steps}
    if any(item not in known_steps for item in approvals):
        raise ValueError("workflow approvals may reference only workflow step IDs")
    run = WORKFLOW_ENGINE.run(playbook, inputs, approvals=set(approvals))
    return {
        "playbook_id": run.playbook_id,
        "playbook_version": run.playbook_version,
        "status": run.status,
        "trace": run.trace,
        "waiting_for_review": run.waiting_for_review,
        "output_keys": sorted(run.outputs),
    }


def execute_task(task: dict[str, Any], *, path: Path = DB_PATH) -> dict[str, Any]:
    kind = str(task.get("kind") or "")
    payload = task.get("payload")
    if kind not in SUPPORTED_TASK_KINDS:
        raise ValueError(f"unsupported durable task kind: {kind}")
    if not isinstance(payload, dict):
        raise ValueError("durable task payload must be an object")
    if kind == "collect-source":
        return _run_collection(payload, path=path)
    return _run_workflow(payload)


def default_worker_id() -> str:
    return f"{socket.gethostname()[:80]}:{os.getpid()}"


def run_once(worker_id: str, *, path: Path = DB_PATH) -> bool:
    heartbeat_worker(worker_id, status="idle", path=path)
    task = claim_task(worker_id, path=path)
    if task is None:
        return False
    heartbeat_worker(worker_id, status="running", current_task_id=str(task["id"]), path=path)
    try:
        result = execute_task(task, path=path)
        complete_task(str(task["id"]), result, path=path)
        heartbeat_worker(worker_id, status="idle", completed_delta=1, path=path)
    except Exception as exc:
        attempts = int(task.get("attempt_count") or 1)
        retry_delay = min(60.0, float(2 ** max(0, attempts - 1)))
        failed = fail_task(str(task["id"]), exc, retry_delay_seconds=retry_delay, path=path)
        heartbeat_worker(worker_id, status="idle", failed_delta=1 if failed["status"] == "failed" else 0, path=path)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local durable Solari OSINT background worker.")
    parser.add_argument("--once", action="store_true", help="Claim at most one available task, then exit.")
    parser.add_argument("--poll-seconds", type=float, default=2.0, help="Idle polling interval, 0.25 to 60 seconds.")
    parser.add_argument("--worker-id", default=default_worker_id(), help="Stable worker label for telemetry.")
    args = parser.parse_args()
    if args.poll_seconds < 0.25 or args.poll_seconds > 60:
        parser.error("--poll-seconds must be between 0.25 and 60")
    try:
        while True:
            worked = run_once(args.worker_id)
            if args.once:
                return 0
            if not worked:
                time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        heartbeat_worker(args.worker_id, status="stopping")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
