"""FlakeProof — detect inconsistent pytest outcomes inside a Solari sandbox.

With no arguments, the program creates a tiny deterministic demo suite in the
sandbox. Pass ``--repo`` to scan a public GitHub repository instead. Untrusted
project setup and tests never execute on the caller's machine.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

BASE_URL = "https://api.getsolari.com"
RESULT_MARKER = "FLAKEPROOF_RESULT="
GITHUB_REPO_RE = re.compile(
    r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?/?$"
)

DEMO_TEST_FILE = '''from pathlib import Path


def test_stable_pass():
    assert 2 + 2 == 4


def test_stable_failure():
    assert "expected" == "actual"


def test_alternating_flake():
    counter = Path("/tmp/flakeproof-demo-counter")
    attempt = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(attempt + 1))
    assert attempt % 2 == 0
'''


def github_repo_url(value: str) -> str:
    """Accept only public GitHub HTTPS repository URLs."""
    if not GITHUB_REPO_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "repository must look like https://github.com/owner/repository"
        )
    return value.rstrip("/")


def bounded_int(name: str, minimum: int, maximum: int):
    """Build an argparse validator with a useful range error."""

    def parse(value: str) -> int:
        try:
            parsed = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"{name} must be an integer") from exc
        if not minimum <= parsed <= maximum:
            raise argparse.ArgumentTypeError(
                f"{name} must be between {minimum} and {maximum}"
            )
        return parsed

    return parse


def classify_runs(runs: list[dict[str, Any]]) -> str:
    """Classify one test from its repeated outcomes."""
    statuses = {run["status"] for run in runs}
    if statuses == {"passed"}:
        return "stable-pass"
    if statuses == {"failed"}:
        return "stable-fail"
    if "passed" in statuses and len(statuses) > 1:
        return "flaky"
    if statuses == {"timeout"}:
        return "timeout"
    return "error"


def build_remote_program(config: dict[str, Any]) -> str:
    """Return the program executed by Solari's stateful Python kernel."""
    encoded_config = json.dumps(config)
    return f'''import json
import shlex
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

CONFIG = json.loads({encoded_config!r})
MARKER = {RESULT_MARKER!r}
ROOT = Path("/tmp/flakeproof")
REPO = ROOT / "repo"


def run(command, cwd=REPO, timeout=None):
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={{**dict(__import__("os").environ), "PYTHONUNBUFFERED": "1"}},
        )
        return {{
            "exit_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "duration_seconds": round(time.perf_counter() - started, 3),
        }}
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        return {{
            "exit_code": 124,
            "stdout": stdout,
            "stderr": stderr,
            "duration_seconds": round(time.perf_counter() - started, 3),
            "timed_out": True,
        }}


def checked(command, label, cwd=REPO, timeout=180):
    result = run(command, cwd=cwd, timeout=timeout)
    if result["exit_code"] != 0:
        detail = (result["stdout"] + "\\n" + result["stderr"])[-1200:]
        raise RuntimeError(f"{{label}} failed (exit {{result['exit_code']}}):\\n{{detail}}")
    return result


try:
    shutil.rmtree(ROOT, ignore_errors=True)
    ROOT.mkdir(parents=True)

    if CONFIG["repo_url"]:
        checked(
            ["git", "clone", "--depth", "1", CONFIG["repo_url"], str(REPO)],
            "git clone",
            cwd=ROOT,
        )
        source = CONFIG["repo_url"]
    else:
        REPO.mkdir()
        (REPO / "test_demo.py").write_text(CONFIG["demo_test_file"])
        source = "built-in deterministic demo"

    if CONFIG["install_command"]:
        checked(
            shlex.split(CONFIG["install_command"]),
            "custom install command",
        )
    else:
        if (REPO / "requirements.txt").exists():
            checked(
                [sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"],
                "requirements installation",
            )
        if (REPO / "pyproject.toml").exists() or (REPO / "setup.py").exists():
            checked(
                [sys.executable, "-m", "pip", "install", "-q", "-e", "."],
                "project installation",
            )

    checked(
        [sys.executable, "-m", "pip", "install", "-q", "pytest"],
        "pytest installation",
    )

    collection = checked(
        [sys.executable, "-m", "pytest", "--collect-only", "-q"],
        "test collection",
        timeout=CONFIG["test_timeout_seconds"],
    )
    node_ids = [
        line.strip()
        for line in collection["stdout"].splitlines()
        if "::" in line and not line.lstrip().startswith("<")
    ]
    node_ids = list(dict.fromkeys(node_ids))[: CONFIG["max_tests"]]
    if not node_ids:
        raise RuntimeError("pytest collected no test node IDs")

    tests = []
    for node_id in node_ids:
        attempts = []
        for attempt in range(1, CONFIG["runs"] + 1):
            result = run(
                [sys.executable, "-m", "pytest", "-q", node_id],
                timeout=CONFIG["test_timeout_seconds"],
            )
            if result.get("timed_out"):
                status = "timeout"
            elif result["exit_code"] == 0:
                status = "passed"
            elif result["exit_code"] == 1:
                status = "failed"
            else:
                status = "error"
            combined = (result["stdout"] + "\\n" + result["stderr"]).strip()
            attempts.append({{
                "attempt": attempt,
                "status": status,
                "exit_code": result["exit_code"],
                "duration_seconds": result["duration_seconds"],
                "output_tail": combined[-400:],
            }})
        tests.append({{"node_id": node_id, "runs": attempts}})

    print(MARKER + json.dumps({{
        "source": source,
        "requested_runs": CONFIG["runs"],
        "max_tests": CONFIG["max_tests"],
        "tests": tests,
    }}, separators=(",", ":")))
except Exception as exc:
    print(MARKER + json.dumps({{
        "error": str(exc),
        "traceback": traceback.format_exc(limit=5),
    }}, separators=(",", ":")))
'''


def extract_payload(result: Any) -> dict[str, Any]:
    """Extract the marker-delimited JSON printed by the remote kernel."""
    if result.error:
        raise RuntimeError(f"Solari code execution failed: {result.error}")

    output = "\n".join(
        str(getattr(item, "text", "") or "") for item in result.results
    )
    marker_position = output.rfind(RESULT_MARKER)
    if marker_position == -1:
        raise RuntimeError("FlakeProof did not receive a result marker from the sandbox")

    encoded = output[marker_position + len(RESULT_MARKER) :].splitlines()[0]
    payload = json.loads(encoded)
    if payload.get("error"):
        raise RuntimeError(
            f"Sandbox scan failed: {payload['error']}\n{payload.get('traceback', '')}"
        )
    return payload


def enrich_results(payload: dict[str, Any]) -> dict[str, Any]:
    """Add classifications and aggregate counts to the remote observations."""
    counts = {
        "stable-pass": 0,
        "stable-fail": 0,
        "flaky": 0,
        "timeout": 0,
        "error": 0,
    }
    for test in payload["tests"]:
        classification = classify_runs(test["runs"])
        test["classification"] = classification
        counts[classification] += 1
    payload["summary"] = counts
    return payload


def render_markdown(payload: dict[str, Any]) -> str:
    """Render a compact reviewer-friendly report."""
    summary = payload["summary"]
    lines = [
        "# FlakeProof report",
        "",
        f"- Source: `{payload['source']}`",
        f"- Repetitions per test: {payload['requested_runs']}",
        f"- Tests analysed: {len(payload['tests'])}",
        f"- Flaky tests: {summary['flaky']}",
        "",
        "| Test | Classification | Outcomes |",
        "| --- | --- | --- |",
    ]
    for test in payload["tests"]:
        outcomes = ", ".join(run["status"] for run in test["runs"])
        lines.append(
            f"| `{test['node_id']}` | **{test['classification']}** | {outcomes} |"
        )
    lines.extend(["", "Generated by FlakeProof using an isolated Solari sandbox."])
    return "\n".join(lines) + "\n"


def write_reports(payload: dict[str, Any], output_dir: Path) -> tuple[Path, Path]:
    """Write machine-readable and human-readable evidence."""
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "flakeproof-report.json"
    markdown_path = output_dir / "flakeproof-report.md"
    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(payload), encoding="utf-8")
    return json_path, markdown_path


async def scan_with_solari(args: argparse.Namespace) -> dict[str, Any]:
    """Run the scan in a disposable Solari micro-VM."""
    from solari_sandbox import SandboxClient

    config = {
        "repo_url": args.repo,
        "runs": args.runs,
        "max_tests": args.max_tests,
        "test_timeout_seconds": args.test_timeout,
        "install_command": args.install_command,
        "demo_test_file": DEMO_TEST_FILE,
    }

    async with SandboxClient(
        api_key=os.environ["SOLARI_API_KEY"],
        base_url=BASE_URL,
        call_timeout_ms=10 * 60_000,
    ) as client:
        sandbox = await client.create(template="base", timeout_ms=10 * 60_000)
        print("sandbox:", sandbox.sandboxId)
        try:
            await sandbox.connect()
            context_id = await sandbox.create_code_context("python")
            result = await sandbox.run_code(
                build_remote_program(config), context_id=context_id
            )
            return enrich_results(extract_payload(result))
        finally:
            await sandbox.kill()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Detect inconsistent pytest outcomes inside a Solari sandbox."
    )
    parser.add_argument(
        "--repo",
        type=github_repo_url,
        help="public GitHub repository; omit it to run the built-in demo",
    )
    parser.add_argument(
        "--runs",
        type=bounded_int("runs", 2, 10),
        default=4,
        help="repetitions per test (default: 4)",
    )
    parser.add_argument(
        "--max-tests",
        type=bounded_int("max-tests", 1, 50),
        default=20,
        help="maximum collected tests to analyse (default: 20)",
    )
    parser.add_argument(
        "--test-timeout",
        type=bounded_int("test-timeout", 5, 300),
        default=30,
        help="seconds allowed for collection or one test attempt (default: 30)",
    )
    parser.add_argument(
        "--install-command",
        help="optional project setup command, parsed without a shell",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("output"),
        help="report directory (default: output)",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if "SOLARI_API_KEY" not in os.environ:
        raise SystemExit("SOLARI_API_KEY is not set")

    payload = asyncio.run(scan_with_solari(args))
    json_path, markdown_path = write_reports(payload, args.output)
    print("summary:", json.dumps(payload["summary"], sort_keys=True))
    print("json report:", json_path.resolve())
    print("markdown report:", markdown_path.resolve())


if __name__ == "__main__":
    main()
