#!/usr/bin/env python3
"""
Stand-in for a real DLQ consumer handler. In production this would be
whatever code originally processed payments.webhooks messages. It's run
here, unmodified, inside a Solari sandbox against the exact payload that
dead-lettered -- so we find out whether replaying it would fail again
*before* we touch the real queue.
"""
import json
import sys


def handle(event: dict) -> dict:
    data = event["data"]
    customer = data["customer"]

    # This is the line that originally panicked: plan_id was null on the
    # dead-lettered message, and the handler assumed it was always present.
    plan_id = customer["metadata"]["plan_id"]
    plan_tier = plan_id.split("_")[0]  # raises AttributeError if plan_id is None

    return {
        "reference": data["reference"],
        "amount": data["amount"],
        "plan_tier": plan_tier,
        "status": "processed",
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: handler.py <payload.json>", file=sys.stderr)
        return 2

    with open(sys.argv[1]) as f:
        message = json.load(f)

    try:
        result = handle(message["event"])
    except Exception as exc:  # noqa: BLE001 -- mirrors the original DLQ failure_reason
        print(f"handler failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
