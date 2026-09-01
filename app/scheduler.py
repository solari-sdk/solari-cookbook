from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from app.sources.registry import ADAPTERS
from app.task_queue import add_schedule, enqueue_due_schedules
from app.workflow_api import ACTIONS, MAX_INPUT_KEYS, MAX_WORKFLOW_STEPS
from app.workflows import Playbook


def _load_workflow_schedule(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size > 64 * 1024:
        raise ValueError("workflow schedule JSON must be a file no larger than 64 KiB")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("playbook"), dict):
        raise ValueError("workflow schedule JSON requires a playbook object")
    playbook = Playbook.model_validate(payload["playbook"])
    if not playbook.steps or len(playbook.steps) > MAX_WORKFLOW_STEPS:
        raise ValueError(f"workflow must contain between 1 and {MAX_WORKFLOW_STEPS} steps")
    for step in playbook.steps:
        if step.action not in ACTIONS:
            raise ValueError(f"unsupported workflow action: {step.action}")
        if step.fallback_action and step.fallback_action not in ACTIONS:
            raise ValueError(f"unsupported fallback workflow action: {step.fallback_action}")
    inputs = payload.get("inputs") or {}
    approvals = payload.get("approvals") or []
    if not isinstance(inputs, dict) or len(inputs) > MAX_INPUT_KEYS:
        raise ValueError(f"workflow inputs must be an object with at most {MAX_INPUT_KEYS} keys")
    if not isinstance(approvals, list) or len(approvals) > 50 or any(not isinstance(item, str) for item in approvals):
        raise ValueError("workflow approvals must contain at most 50 step IDs")
    known = {step.id for step in playbook.steps}
    if any(item not in known for item in approvals):
        raise ValueError("workflow approvals may reference only workflow step IDs")
    return {"playbook": playbook.model_dump(mode="json"), "inputs": inputs, "approvals": approvals}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run or configure the local durable Solari OSINT scheduler.")
    parser.add_argument("--once", action="store_true", help="Enqueue currently due schedules once, then exit.")
    parser.add_argument("--poll-seconds", type=float, default=5.0, help="Scheduler polling interval, 1 to 300 seconds.")
    parser.add_argument("--add-collection", metavar="SOURCE_ID", help="Create an interval schedule for a registered public source.")
    parser.add_argument("--add-workflow", metavar="JSON_FILE", help="Create an interval schedule from a bounded workflow request JSON file.")
    parser.add_argument("--interval-seconds", type=int, help="Interval for --add-collection or --add-workflow; 60 seconds to 31 days.")
    parser.add_argument("--name", help="Optional schedule display name.")
    args = parser.parse_args()

    if args.poll_seconds < 1 or args.poll_seconds > 300:
        parser.error("--poll-seconds must be between 1 and 300")
    if args.add_collection and args.add_workflow:
        parser.error("choose only one of --add-collection or --add-workflow")
    if (args.add_collection or args.add_workflow) and args.interval_seconds is None:
        parser.error("--interval-seconds is required when adding a schedule")

    if args.add_collection:
        if args.add_collection not in ADAPTERS:
            parser.error("--add-collection must name a registered public source")
        schedule = add_schedule(
            args.name or f"collect {args.add_collection}",
            "collect-source",
            {"source_id": args.add_collection},
            interval_seconds=args.interval_seconds,
        )
        print(json.dumps(schedule, sort_keys=True, default=str))
        return 0

    if args.add_workflow:
        try:
            payload = _load_workflow_schedule(Path(args.add_workflow))
            schedule = add_schedule(
                args.name or f"workflow {payload['playbook']['id']}",
                "workflow-run",
                payload,
                interval_seconds=args.interval_seconds,
            )
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            parser.error(str(exc))
        print(json.dumps(schedule, sort_keys=True, default=str))
        return 0

    while True:
        due = enqueue_due_schedules()
        if due:
            print(json.dumps({"enqueued": due}, sort_keys=True))
        if args.once:
            return 0
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
