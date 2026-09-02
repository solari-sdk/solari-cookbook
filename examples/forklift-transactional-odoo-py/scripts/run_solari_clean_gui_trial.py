"""Run, fault, seal, and independently audit one GUI trial on Solari."""

from __future__ import annotations

import asyncio
import argparse
import hashlib
import json
import os
import uuid
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path

from solari_desktop import DesktopClient

from forklift.case_generation import case_digest, case_payload
from forklift.faults import DEVELOPMENT_SCHEDULES, FaultKind, Milestone
from forklift.orchestrator import audit_sealed_candidate
from forklift.promotion import select_for_promotion
from forklift.remote_oracle import evaluate_in_auditor
from forklift.solari_adapter import SolariSandboxBranches
from scripts.bootstrap_solari_canonical import (
    _load_case,
    _must,
    _safe_diagnostic,
    _start_and_wait_for_odoo,
)
from scripts.check_solari_auth import _load_local_env, _safe_code, _safe_status


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CANONICAL_STATE = PROJECT_ROOT / "artifacts" / "development" / "solari-canonical.json"
CASE_PATH = PROJECT_ROOT / "lab" / "valid_fixture_case.json"
WORKER_PATH = PROJECT_ROOT / "forklift" / "gui_worker.py"
RESULT_DIR = PROJECT_ROOT / "artifacts" / "development" / "gui-trials"
EVENT_PREFIX = "FORKLIFT_EVENT="
COMPLETE_MARKER = "FORKLIFT_WORKER_COMPLETE=1"
STEP_GATE_PREFIX = "/tmp/forklift-step"
REMOTE_BROWSER_DISTRIBUTIONS = {
    "greenlet": "3.5.5",
    "playwright": "1.62.0",
    "pyee": "13.0.1",
    "typing-extensions": "4.16.0",
}

FULL_MILESTONES = (
    Milestone.BEFORE_LOGIN.value,
    Milestone.PO_DRAFT_SAVED.value,
    Milestone.PO_CONFIRMED.value,
    Milestone.RECEIPT_QUANTITY_ENTERED.value,
    Milestone.RECEIPT_VALIDATED.value,
    Milestone.BILL_DRAFT_CREATED.value,
    Milestone.BILL_POSTED.value,
    Milestone.PAYMENT_DIALOG_READY.value,
    Milestone.PAYMENT_SUBMITTED.value,
)


def _digest_actions(actions: list[dict[str, object]]) -> str:
    encoded = json.dumps(actions, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _expected_milestones(case) -> tuple[str, ...]:
    if not case.billable:
        return FULL_MILESTONES[:3]
    if not case.payment_expected:
        return FULL_MILESTONES[:7]
    return FULL_MILESTONES


def _worker_fault_controls(schedule, case) -> tuple[dict[str, str], list[str]]:
    overrides: dict[str, str] = {}
    duplicates: list[str] = []
    for fault in schedule.faults:
        if fault.kind == FaultKind.MUTATE_FIELD:
            if fault.target == "received_qty" and fault.replacement == "ordered_qty":
                overrides["received_qty"] = str(case.ordered_qty)
            elif fault.target == "unit_price" and fault.replacement == "unit_price_plus_0.01":
                overrides["unit_price"] = str(case.unit_price + Decimal("0.01"))
            else:
                raise ValueError(f"unsupported field mutation: {fault.target}/{fault.replacement}")
        elif fault.kind == FaultKind.DUPLICATE_ACTION:
            duplicates.append(fault.target)
    return overrides, duplicates


def _expected_acceptance(schedule) -> bool | None:
    kinds = {fault.kind for fault in schedule.faults}
    if not kinds or kinds == {FaultKind.PAUSE_WORKER}:
        return True
    if kinds & {FaultKind.KILL_WORKER, FaultKind.KILL_BROWSER, FaultKind.MUTATE_FIELD}:
        return False
    return None


async def _desktop_must(desktop, cmd: str, args: list[str], *, timeout_ms: int):
    result = await desktop.commands.run(cmd, args=args, timeout_ms=timeout_ms)
    if result.exitCode != 0:
        detail = _safe_diagnostic(Exception((result.stdout + "\n" + result.stderr)[-6000:]))
        raise RuntimeError(f"desktop command {cmd} exited {result.exitCode}: {detail}")
    return result


async def _run(
    *,
    schedule_id: str,
    case_path: Path,
    keep_accepted: bool,
    result_dir: Path = RESULT_DIR,
) -> int:
    _load_local_env(PROJECT_ROOT / ".env")
    api_key = os.environ.get("SOLARI_API_KEY", "").strip()
    if not api_key or not CANONICAL_STATE.exists():
        print(json.dumps({"trial": "not_run", "reason": "missing_prerequisite"}))
        return 2

    case = _load_case(case_path)
    canonical = json.loads(CANONICAL_STATE.read_text(encoding="utf-8"))
    canonical_snapshot_id = canonical["canonical_snapshot_id"]
    try:
        schedule = next(
            item for item in DEVELOPMENT_SCHEDULES if item.schedule_id == schedule_id
        )
    except StopIteration as exc:
        raise ValueError(f"unknown development schedule: {schedule_id}") from exc
    field_overrides, duplicate_actions = _worker_fault_controls(schedule, case)
    expected_acceptance = _expected_acceptance(schedule)
    trial_id = uuid.uuid4().hex[:12]
    result_path = result_dir / (
        f"{schedule.schedule_id}-{case_digest(case)[:12]}-{trial_id}.json"
    )
    base_url = os.environ.get("SOLARI_BASE_URL", "https://api.getsolari.com")

    state_branch = None
    browser = None
    browser_client = None
    candidate_snapshot_id = None
    keep_candidate_snapshot = False
    phase = "create-state-branch"
    result_payload: dict[str, object] = {"trial": "failed"}
    actions: list[dict[str, object]] = []
    fault_triggered: list[str] = []
    browser_binary_version: str | None = None
    browser_library_versions: dict[str, str] | None = None

    async with SolariSandboxBranches(
        api_key=api_key,
        base_url=base_url,
        call_timeout_ms=5 * 60 * 1000,
    ) as backend:
        try:
            state_branch = await backend.fork(
                snapshot_id=canonical_snapshot_id,
                metadata={
                    "forklift.role": "gui-candidate",
                    "forklift.protocol": "v2-browser-sandbox",
                    "forklift.case": case_digest(case)[:16],
                    "forklift.schedule": schedule.digest()[:16],
                },
                timeout_ms=15 * 60 * 1000,
            )
            await state_branch.connect()
            phase = "start-state-services"
            await _must(
                state_branch,
                "sh",
                [
                    "-lc",
                    "pg_isready -q || pg_ctlcluster $(pg_lsclusters -h | awk 'NR==1 {print $1, $2}') start",
                ],
                timeout_ms=2 * 60 * 1000,
            )
            await _start_and_wait_for_odoo(state_branch)
            preview = await state_branch.preview_url(8069)
            preview_url = str(preview.get("url", ""))
            if not preview_url.startswith("https://"):
                raise RuntimeError("Solari preview did not return an HTTPS URL")

            phase = "create-browser-worker"
            browser_client = DesktopClient(
                api_key=api_key,
                base_url=base_url,
                call_timeout_ms=2 * 60 * 1000,
            )
            browser = await browser_client.create(
                template="default",
                resolution="1280x800",
                cpu=4,
                mem_mb=8192,
                metadata={
                    "forklift.role": "gui-worker",
                    "forklift.protocol": "v2-browser-sandbox",
                    "forklift.case": case_digest(case)[:16],
                    "forklift.schedule": schedule.digest()[:16],
                },
                timeout_ms=12 * 60 * 1000,
                lifecycle={"onTimeout": "pause", "autoResume": False},
            )
            await browser.connect()
            health = await browser.health()
            if not health.ready or not health.display:
                raise RuntimeError("browser desktop display is not ready")
            await _desktop_must(
                browser,
                "python3",
                [
                    "-m",
                    "pip",
                    "install",
                    "--no-cache-dir",
                    *[
                        f"{name}=={version}"
                        for name, version in REMOTE_BROWSER_DISTRIBUTIONS.items()
                    ],
                ],
                timeout_ms=5 * 60 * 1000,
            )
            browser_library_versions = json.loads(
                (
                await _desktop_must(
                    browser,
                    "python3",
                    [
                        "-c",
                        (
                            "import importlib.metadata as m,json; "
                            f"names={list(REMOTE_BROWSER_DISTRIBUTIONS)!r}; "
                            "print(json.dumps({n:m.version(n) for n in names},sort_keys=True))"
                        ),
                    ],
                    timeout_ms=60_000,
                )
                ).stdout.strip()
            )
            if browser_library_versions != REMOTE_BROWSER_DISTRIBUTIONS:
                raise RuntimeError("remote browser-library version mismatch")
            browser_path = (
                await _desktop_must(
                    browser,
                    "sh",
                    [
                        "-lc",
                        "command -v google-chrome || command -v chromium || command -v chromium-browser",
                    ],
                    timeout_ms=60_000,
                )
            ).stdout.strip().splitlines()[0]
            browser_binary_version = (
                await _desktop_must(
                    browser,
                    browser_path,
                    ["--version"],
                    timeout_ms=60_000,
                )
            ).stdout.strip()

            phase = "run-gui-worker"
            remote_worker = "/tmp/forklift-gui-worker.py"
            remote_config = "/tmp/forklift-gui-config.json"
            await browser.files.write(remote_worker, WORKER_PATH.read_bytes(), 0o500)
            await browser.files.write(
                remote_config,
                json.dumps(
                    {
                        "browser_path": browser_path,
                        "case": case_payload(case),
                        "duplicate_actions": duplicate_actions,
                        "field_overrides": field_overrides,
                        "preview_token": preview.get("token"),
                        "preview_url": preview_url,
                        "step_gate_prefix": STEP_GATE_PREFIX,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                0o400,
            )

            output: list[str] = []
            complete = asyncio.Event()
            event_queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
            pending_output = ""

            def capture(data: str) -> None:
                nonlocal pending_output
                output.append(data)
                pending_output += data
                lines = pending_output.split("\n")
                pending_output = lines.pop()
                for line in lines:
                    line = line.rstrip("\r")
                    if line.startswith(EVENT_PREFIX):
                        action = json.loads(line[len(EVENT_PREFIX) :])
                        actions.append(action)
                        event_queue.put_nowait(action)
                    elif line == COMPLETE_MARKER:
                        complete.set()

            command = await browser.commands.start(
                "python3",
                args=[remote_worker, remote_config],
                on_stdout=capture,
                on_stderr=capture,
            )
            wait_task = asyncio.create_task(command.wait())
            complete_task = asyncio.create_task(complete.wait())
            expected = _expected_milestones(case)
            terminal_fault = False
            worker_exit_code: int | None = None

            for expected_sequence, expected_name in enumerate(expected):
                event_task = asyncio.create_task(event_queue.get())
                done, _ = await asyncio.wait(
                    {event_task, wait_task},
                    timeout=120,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if event_task not in done:
                    event_task.cancel()
                    if wait_task.done() and schedule.faults and fault_triggered:
                        worker_exit_code = wait_task.result()
                        break
                    if wait_task.done():
                        raise RuntimeError(
                            f"GUI worker exited {wait_task.result()}: "
                            f"{_safe_diagnostic(Exception(''.join(output)))}"
                        )
                    raise RuntimeError(f"GUI worker timed out before milestone {expected_name}")

                action = event_task.result()
                if (
                    action.get("sequence") != expected_sequence
                    or action.get("milestone") != expected_name
                ):
                    raise RuntimeError(f"GUI milestone sequence mismatch: {actions!r}")

                faults_here = tuple(
                    fault for fault in schedule.faults
                    if fault.milestone.value == expected_name
                )
                for fault in faults_here:
                    fault_triggered.append(f"{fault.kind.value}@{fault.milestone.value}")
                    if fault.kind == FaultKind.PAUSE_WORKER:
                        await asyncio.sleep(fault.duration_ms / 1000)
                    elif fault.kind == FaultKind.KILL_WORKER:
                        await command.kill(9)
                        terminal_fault = True
                    elif fault.kind == FaultKind.KILL_BROWSER:
                        await _desktop_must(
                            browser,
                            "pkill",
                            ["-9", "-f", "--", "--user-agent=ForkliftFaultTarget/1.0"],
                            timeout_ms=30_000,
                        )
                        await browser.files.write(
                            f"{STEP_GATE_PREFIX}-{expected_sequence}", "fault", 0o400
                        )
                        terminal_fault = True

                if terminal_fault:
                    break
                await browser.files.write(
                    f"{STEP_GATE_PREFIX}-{expected_sequence}", "continue", 0o400
                )

            if terminal_fault:
                try:
                    worker_exit_code = await asyncio.wait_for(wait_task, timeout=30)
                except asyncio.TimeoutError:
                    await command.kill(9)
                    worker_exit_code = await asyncio.wait_for(wait_task, timeout=30)
            elif worker_exit_code is None:
                done, _ = await asyncio.wait(
                    {wait_task, complete_task},
                    timeout=180,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if complete_task not in done or not complete.is_set():
                    if wait_task.done() and schedule.faults and fault_triggered:
                        worker_exit_code = wait_task.result()
                    elif wait_task.done():
                        raise RuntimeError(
                            f"GUI worker exited {wait_task.result()}: "
                            f"{_safe_diagnostic(Exception(''.join(output)))}"
                        )
                    else:
                        raise RuntimeError("GUI worker timed out before completion marker")

            screenshot = await browser.screenshot()
            if len(screenshot) < 1000:
                raise RuntimeError("GUI trial screenshot was unexpectedly empty")
            if complete.is_set():
                await browser.files.write("/tmp/forklift-worker-release", "ok", 0o400)
                worker_exit_code = await asyncio.wait_for(wait_task, timeout=30)
                if worker_exit_code != 0:
                    raise RuntimeError(
                        f"GUI worker exited {worker_exit_code} after host release"
                    )
            complete_task.cancel()

            observed = [str(action.get("milestone")) for action in actions]
            if observed != list(expected[: len(observed)]):
                raise RuntimeError(f"GUI milestone prefix mismatch: {observed!r}")
            if schedule.faults and not fault_triggered:
                raise RuntimeError("configured fault schedule was never triggered")

            await browser.kill()
            browser = None
            await browser_client.aclose()
            browser_client = None

            phase = "flush-candidate"
            await _must(
                state_branch,
                "runuser",
                ["-u", "postgres", "--", "psql", "-d", "forklift_clean", "-c", "CHECKPOINT"],
                timeout_ms=60_000,
            )
            action_log_digest = _digest_actions(actions)

            async def oracle(auditor):
                await _must(
                    auditor,
                    "sh",
                    [
                        "-lc",
                        "pg_isready -q || pg_ctlcluster $(pg_lsclusters -h | awk 'NR==1 {print $1, $2}') start",
                    ],
                    timeout_ms=2 * 60 * 1000,
                )
                return await evaluate_in_auditor(
                    auditor,
                    case,
                    database_url="postgresql://odoo:odoo@127.0.0.1:5432/forklift_clean",
                    timeout_ms=2 * 60 * 1000,
                )

            phase = "seal-and-audit"
            candidate = await audit_sealed_candidate(
                backend=backend,
                candidate=state_branch,
                canonical_snapshot_id=canonical_snapshot_id,
                case_digest=case_digest(case),
                fault_schedule_digest=schedule.digest(),
                action_log_digest=action_log_digest,
                oracle=oracle,
                expected_snapshot_kind="sandbox",
            )
            candidate_snapshot_id = candidate.candidate_snapshot_id
            decision = select_for_promotion(
                (candidate,),
                expected_case_digest=case_digest(case),
                canonical_snapshot_id=canonical_snapshot_id,
            )
            accepted = (
                candidate_snapshot_id is not None
                and decision.promoted_snapshot_id == candidate_snapshot_id
            )
            failed_codes = list(candidate.verdict.failed_codes) if candidate.verdict else []
            verdict_accepted = candidate.verdict.accepted if candidate.verdict else None
            selector_matches_oracle = verdict_accepted is not None and accepted == verdict_accepted
            expectation_matches = (
                verdict_accepted is not None
                and (
                    expected_acceptance is None
                    or verdict_accepted is expected_acceptance
                )
            )
            protocol_passed = selector_matches_oracle and expectation_matches
            outcome = (
                "valid_candidate"
                if accepted
                else "safe_refusal"
                if verdict_accepted is False
                else "protocol_failure"
            )
            keep_candidate_snapshot = accepted and keep_accepted

            state = {
                "accepted": accepted,
                "action_log": actions,
                "action_log_digest": action_log_digest,
                "audit_error": (
                    _safe_diagnostic(Exception(candidate.audit_error))
                    if candidate.audit_error else None
                ),
                "browser_runtime": {
                    "binary_version": browser_binary_version,
                    "distributions": browser_library_versions,
                },
                "candidate_snapshot_id": candidate_snapshot_id,
                "expected_acceptance": expected_acceptance,
                "failed_codes": failed_codes,
                "fault_schedule": json.loads(schedule.canonical_json()),
                "fault_triggered": fault_triggered,
                "oracle_checks": (
                    [asdict(check) for check in candidate.verdict.checks]
                    if candidate.verdict else None
                ),
                "outcome": outcome,
                "protocol_passed": protocol_passed,
                "receipt": asdict(candidate.receipt) if candidate.receipt else None,
                "rejection_reasons": decision.rejection_reasons,
                "screenshot_bytes": len(screenshot),
                "trial_id": trial_id,
                "worker_exit_code": worker_exit_code,
            }
            result_path.parent.mkdir(parents=True, exist_ok=True)
            result_path.write_text(
                json.dumps(state, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            result_payload = {
                "accepted": accepted,
                "browser_runtime": {
                    "binary_version": browser_binary_version,
                    "distributions": browser_library_versions,
                },
                "expected_acceptance": expected_acceptance,
                "failed_codes": failed_codes,
                "fault_triggered": fault_triggered,
                "milestones": observed,
                "oracle_ran": candidate.verdict is not None,
                "outcome": outcome,
                "protocol_passed": protocol_passed,
                "receipt_complete": candidate.receipt is not None,
                "schedule": schedule.schedule_id,
                "screenshot_bytes": len(screenshot),
                "snapshot_kept": keep_candidate_snapshot,
                "trial": "completed",
                "trial_id": trial_id,
            }
        except Exception as exc:
            result_payload = {
                "business_mutation_observed": any(
                    action.get("milestone") != Milestone.BEFORE_LOGIN.value
                    for action in actions
                ),
                "browser_runtime": {
                    "binary_version": browser_binary_version,
                    "distributions": browser_library_versions,
                },
                "case_digest": case_digest(case),
                "diagnostic_tail": _safe_diagnostic(exc),
                "error_code": _safe_code(exc),
                "error_type": type(exc).__name__,
                "fault_triggered": fault_triggered,
                "milestones": [
                    str(action.get("milestone")) for action in actions
                ],
                "phase": phase,
                "schedule": schedule.schedule_id,
                "status_code": _safe_status(exc),
                "trial": "failed",
                "trial_id": trial_id,
            }
        finally:
            if browser is not None:
                try:
                    await browser.kill()
                except Exception:
                    result_payload["browser_cleanup"] = "failed"
            if browser_client is not None:
                await browser_client.aclose()
            if state_branch is not None:
                try:
                    await state_branch.kill()
                except Exception:
                    result_payload["state_cleanup"] = "failed"
            if candidate_snapshot_id is not None and not keep_candidate_snapshot:
                try:
                    await backend.delete_snapshot(candidate_snapshot_id)
                except Exception:
                    result_payload["snapshot_cleanup"] = "failed"

    if not result_path.exists():
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(
            json.dumps(result_payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    print(json.dumps(result_payload, sort_keys=True))
    return 0 if result_payload.get("protocol_passed") is True else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--schedule", default="clean")
    parser.add_argument("--case", type=Path, default=CASE_PATH)
    parser.add_argument("--keep-accepted", action="store_true")
    parser.add_argument("--result-dir", type=Path, default=RESULT_DIR)
    args = parser.parse_args()
    raise SystemExit(
        asyncio.run(
            _run(
                schedule_id=args.schedule,
                case_path=args.case,
                keep_accepted=args.keep_accepted,
                result_dir=args.result_dir,
            )
        )
    )
