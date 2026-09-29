"""Forge - an autonomous coding agent that writes code, runs it inside a
Solari sandbox, reads the real output, and self-debugs until it actually
works.

Driven by a Mistral model via AWS Bedrock (same setup as qa-agent - see
code-agent/README.md for why not Claude).

Usage:
    python main.py
    python main.py --task "Write a script that computes the first 20 prime numbers and prints them"
"""

from __future__ import annotations

import argparse
import asyncio
import os
import pathlib
import sys

from dotenv import load_dotenv

# Windows consoles default to cp1252; keep output encoding-safe like qa-agent.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from agent.orchestrator import Orchestrator
from agent.report import write_report
from agent.verify import verify_service

load_dotenv()

DEFAULT_TASK = (
    "Write a tiny Python HTTP server (standard library only, no third-party "
    "packages) that listens on port 8000 and responds to GET /reverse?text=<value> "
    "with the value reversed, as the plain-text response body. Start it in the "
    "background, expose port 8000 with expose_port, then request "
    "<exposed-url>/reverse?text=hello yourself from inside the sandbox (curl or "
    "urllib) to confirm it returns 'olleh' before calling finish. Set service_url "
    "to that exact request URL and verify_contains to 'olleh'."
)


async def run(task: str, max_steps: int) -> None:
    solari_key = os.environ["SOLARI_API_KEY"]
    # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are picked up from the
    # environment by boto3's default credential chain once load_dotenv()
    # has put them in os.environ.
    aws_region = os.environ["AWS_REGION"]
    bedrock_model_id = os.environ.get("BEDROCK_MODEL_ID", "mistral.mistral-large-3-675b-instruct")

    out_dir = pathlib.Path(__file__).parent / "reports"
    out_dir.mkdir(exist_ok=True)

    orchestrator = Orchestrator(solari_key, bedrock_model_id, aws_region)

    print("Forge working on:")
    print(f"  {task}")
    print()
    try:
        result = await orchestrator.run(task, max_steps=max_steps)

        # Verify BEFORE tearing down the sandbox - if the task exposed a
        # service, it's still running in there, and killing the sandbox
        # first would make every independent check fail regardless of
        # whether the service actually worked.
        service_url = result.get("service_url") or ""
        if service_url:
            print(f"Independently verifying {service_url} from outside the sandbox ...")
            result["verification"] = verify_service(service_url, result.get("verify_contains") or "")
    finally:
        await orchestrator.toolkit.close()

    report_path = write_report(out_dir, task, result, orchestrator.transcript)

    print()
    print(f"success (self-reported) : {result.get('success')}")
    print(f"summary                 : {result.get('summary')}")
    if result.get("verification"):
        print(f"independently verified  : {result['verification']}")
    print(f"report                  : {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--task",
        default=DEFAULT_TASK,
        help="The coding task to give Forge, in plain English.",
    )
    parser.add_argument("--max-steps", type=int, default=25)
    args = parser.parse_args()

    asyncio.run(run(args.task, args.max_steps))


if __name__ == "__main__":
    main()
