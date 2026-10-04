"""Small CLI for the single ReproLab V1 recipe."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path
from urllib.parse import quote

from .models import RunSpec, VerdictStatus
from .orchestrator import execute_run


def demo_spec() -> RunSpec:
    html = files("reprolab").joinpath("fixture.html").read_text(encoding="utf-8")
    return RunSpec.from_dict(
        {
            "schema_version": "1.0",
            "recipe": "csv_identifier_libreoffice",
            "target_url": "data:text/html;charset=utf-8," + quote(html),
            "profile_id": None,
            "page_assertion": {
                "title": "ReproLab CSV fixture",
                "contains_text": "September account report",
            },
            "row_selector": {"customer": "Northstar Labs"},
            "target_column": "account_code",
            "target_cell": "A2",
            "expected_text": "001234",
            "known_failure_text": "1234",
        }
    )


def _default_output() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Path("artifacts") / f"repro-run-{stamp}"


async def _run(args: argparse.Namespace) -> int:
    api_key = os.environ.get("SOLARI_API_KEY")
    if not api_key:
        raise SystemExit("SOLARI_API_KEY is not set")
    if args.command == "demo":
        spec = demo_spec()
    else:
        spec = RunSpec.from_dict(json.loads(Path(args.spec).read_text(encoding="utf-8")))
    bundle_dir = Path(args.output) if args.output else _default_output()
    completed = await execute_run(spec, api_key=api_key, bundle_dir=bundle_dir)
    print(f"verdict: {completed.verdict.status.value}")
    print(f"evidence: {completed.bundle_dir.resolve()}")
    return 2 if completed.verdict.status == VerdictStatus.INCONCLUSIVE else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Deterministic CSV identifier reproduction in LibreOffice Calc"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="run the bundled deterministic fixture")
    demo.add_argument("--output", help="evidence-bundle directory")
    run = sub.add_parser("run", help="run a validated V1 RunSpec JSON file")
    run.add_argument("--spec", required=True, help="path to run-spec JSON")
    run.add_argument("--output", help="evidence-bundle directory")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    raise SystemExit(asyncio.run(_run(args)))
