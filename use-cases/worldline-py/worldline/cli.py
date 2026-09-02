"""Worldline command-line interface."""

from __future__ import annotations

import argparse
import asyncio
import http.server
import os
import socketserver
from pathlib import Path

from .engine import WorldlineEngine
from .fixture import FixtureRunner
from .ledger import TASK, TASK_DETAIL, candidates
from .live import BASE_URL, SolariDesktopRunner
from .report import write_report
from .sandbox_live import SolariSandboxRunner

DEFAULT_ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts" / "latest"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="worldline",
        description="Speculative execution and verified rollback for computer-use agents.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="run the deterministic offline tournament")
    demo.add_argument("--output", type=Path, default=DEFAULT_ARTIFACTS)
    live = sub.add_parser("live", help="run the tournament on a real Solari desktop")
    live.add_argument("--output", type=Path, default=DEFAULT_ARTIFACTS)
    live.add_argument("--base-url", default=BASE_URL)
    live.add_argument(
        "--surface", choices=("auto", "desktop", "sandbox"), default="auto"
    )
    live.add_argument(
        "--env-file",
        type=Path,
        default=Path(__file__).resolve().parents[1] / ".env",
        help="local env file used only when SOLARI_API_KEY is absent",
    )
    serve = sub.add_parser("serve", help="serve the latest interactive report")
    serve.add_argument("--directory", type=Path, default=DEFAULT_ARTIFACTS)
    serve.add_argument("--port", type=int, default=4173)
    return parser


async def run_demo(output: Path) -> int:
    runner = FixtureRunner(output)
    engine = WorldlineEngine(runner, TASK, TASK_DETAIL)
    run = await engine.run(candidates())
    report = write_report(run, output)
    print(f"run     : {run.run_id}")
    print(f"status  : {run.status}")
    print(f"winner  : {run.winner_id}")
    print(f"cleanup : {'ok' if run.cleanup.succeeded else 'failed'}")
    print(f"report  : {report}")
    return 0 if run.status == "committed" else 1


def load_key(env_file: Path) -> str:
    existing = os.environ.get("SOLARI_API_KEY", "").strip()
    if existing:
        return existing
    if env_file.exists():
        for raw_line in env_file.read_text(encoding="utf-8-sig").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip() == "SOLARI_API_KEY":
                return value.strip().strip('"').strip("'")
    raise SystemExit(
        f"SOLARI_API_KEY is not set and was not found in {env_file}. "
        "Do not pass the key on the command line."
    )


async def run_live(output: Path, *, api_key: str, base_url: str, surface: str) -> int:
    if surface == "sandbox":
        runner = SolariSandboxRunner(output, api_key=api_key, base_url=base_url)
        run = await WorldlineEngine(runner, TASK, TASK_DETAIL).run(candidates())
    else:
        desktop_runner = SolariDesktopRunner(output, api_key=api_key, base_url=base_url)
        try:
            run = await WorldlineEngine(desktop_runner, TASK, TASK_DETAIL).run(
                candidates()
            )
        except Exception as exc:
            is_plan_gate = (
                type(exc).__name__ == "PlanError" and "paid plan" in str(exc).lower()
            )
            if surface != "auto" or not is_plan_gate:
                raise
            print("desktop : paid plan required; falling back to a live sandbox")
            sandbox_runner = SolariSandboxRunner(
                output, api_key=api_key, base_url=base_url
            )
            run = await WorldlineEngine(sandbox_runner, TASK, TASK_DETAIL).run(
                candidates()
            )
    report = write_report(run, output)
    print(f"run     : {run.run_id}")
    print(f"status  : {run.status}")
    print(f"winner  : {run.winner_id}")
    print(f"cleanup : {'ok' if run.cleanup.succeeded else 'failed'}")
    print(f"report  : {report}")
    return 0 if run.status == "committed" and run.cleanup.succeeded else 1


def serve(directory: Path, port: int) -> int:
    if not (directory / "index.html").exists():
        raise SystemExit(f"no report found at {directory}; run `worldline demo` first")
    handler = lambda *args, **kwargs: http.server.SimpleHTTPRequestHandler(
        *args, directory=str(directory), **kwargs
    )
    with socketserver.TCPServer(("127.0.0.1", port), handler) as server:
        print(f"Worldline report: http://127.0.0.1:{port}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            return 0
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "demo":
        return asyncio.run(run_demo(args.output))
    if args.command == "live":
        return asyncio.run(
            run_live(
                args.output,
                api_key=load_key(args.env_file),
                base_url=args.base_url,
                surface=args.surface,
            )
        )
    if args.command == "serve":
        return serve(args.directory, args.port)
    raise AssertionError(f"unhandled command: {args.command}")
