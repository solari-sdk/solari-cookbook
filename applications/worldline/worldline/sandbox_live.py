"""Free-tier live Solari Sandbox runner."""

from __future__ import annotations

import time
from pathlib import Path

from solari_sandbox import SandboxClient

from .ledger import BASE_LEDGER, sha256_text, verify_ledger
from .live import BASE_URL, redact_identifier
from .models import BranchResult, Candidate, CleanupEvidence, EnvironmentEvidence
from .screens import write_terminal_screen

REMOTE_DIR = "/tmp/worldline"
REMOTE_LEDGER = f"{REMOTE_DIR}/expense-ledger.csv"


def strategy_script(candidate_id: str) -> str:
    scripts = {
        "global-replace": """from pathlib import Path
p=Path('/tmp/worldline/expense-ledger.csv')
s=p.read_text()
s=s.replace(',250,', ',275,')
s=s.replace('Pinetree Travel,275,pending', 'Pinetree Travel,275,approved')
p.write_text(s)
print('global replacement applied')
""",
        "collateral-edit": """from pathlib import Path
p=Path('/tmp/worldline/expense-ledger.csv')
s=p.read_text().replace('Pinetree Travel,250,pending,research', 'Pinetree Travel,275,approved,research')
s=s.replace('Northstar Data,250,pending,data', 'Northstar Data,250,pending,')
p.write_text(s)
print('target row rewritten by sight')
""",
        "surgical-update": """from pathlib import Path
p=Path('/tmp/worldline/expense-ledger.csv')
s=p.read_text().replace('Pinetree Travel,250,pending,research', 'Pinetree Travel,275,approved,research')
p.write_text(s)
print('exact target transition applied')
""",
    }
    try:
        return scripts[candidate_id]
    except KeyError as exc:
        raise ValueError(f"unknown sandbox candidate: {candidate_id}") from exc


class SolariSandboxRunner:
    def __init__(
        self, artifact_dir: Path, *, api_key: str, base_url: str = BASE_URL
    ) -> None:
        if not api_key:
            raise ValueError("SOLARI_API_KEY is required for live mode")
        self.artifact_dir = artifact_dir
        self.screen_dir = artifact_dir / "screens"
        self.client = SandboxClient(
            api_key=api_key, base_url=base_url, call_timeout_ms=30_000
        )
        self.sandbox = None
        self.base_id: str | None = None
        self.worker_id: str | None = None
        self.snapshot_id: str | None = None
        self._base_killed = False
        self._workers_created = 0
        self._workers_killed = 0

    async def prepare(self) -> EnvironmentEvidence:
        self.screen_dir.mkdir(parents=True, exist_ok=True)
        self.sandbox = await self.client.create(
            template="base",
            cpu=2,
            mem_mb=2048,
            timeout_ms=10 * 60_000,
            lifecycle={"onTimeout": "kill"},
            metadata={"product": "worldline", "purpose": "branch-tournament"},
        )
        self.base_id = self.sandbox.sandboxId
        await self.sandbox.connect()
        await self.sandbox.commands.run("mkdir", args=["-p", REMOTE_DIR])
        await self.sandbox.files.write(REMOTE_LEDGER, BASE_LEDGER)
        self.snapshot_id = await self.sandbox.snapshot("worldline-ledger-base")
        write_terminal_screen(
            self.screen_dir / "base.svg",
            "Live checkpoint",
            [
                "$ sha256sum expense-ledger.csv",
                sha256_text(BASE_LEDGER),
                "",
                *BASE_LEDGER.strip().splitlines(),
            ],
            "snapshot",
        )
        await self.client.kill(self.base_id)
        self._base_killed = True
        await self.sandbox.close()
        self.sandbox = None

        return EnvironmentEvidence(
            provider="Solari Sandbox · snapshot clones",
            mode="live",
            environment_id=redact_identifier(self.base_id),
            checkpoint_id=redact_identifier(self.snapshot_id),
            base_sha256=sha256_text(BASE_LEDGER),
        )

    async def reset(self) -> None:
        if self.snapshot_id is None:
            raise RuntimeError("live sandbox runner has no checkpoint")
        await self._drop_active_worker()
        self.sandbox = await self.client.create(
            template="base",
            from_snapshot=self.snapshot_id,
            cpu=2,
            mem_mb=2048,
            timeout_ms=10 * 60_000,
            lifecycle={"onTimeout": "kill"},
            metadata={"product": "worldline", "purpose": "branch-worker"},
        )
        self.worker_id = self.sandbox.sandboxId
        self._workers_created += 1
        await self.sandbox.connect()
        restored = await self.sandbox.files.read_text(REMOTE_LEDGER)
        if sha256_text(restored) != sha256_text(BASE_LEDGER):
            raise RuntimeError("snapshot clone did not restore the base ledger exactly")

    async def execute(self, candidate: Candidate, *, phase: str) -> BranchResult:
        sandbox = self._require_sandbox()
        started = time.perf_counter()
        command = await sandbox.commands.run(
            "python3",
            args=["-c", strategy_script(candidate.id)],
            timeout_ms=30_000,
        )
        if command.exitCode != 0:
            raise RuntimeError(f"remote strategy failed: {command.stderr.strip()}")
        observed = await sandbox.files.read_text(REMOTE_LEDGER)
        checks = verify_ledger(observed)
        filename = f"{phase}-{candidate.id}.svg"
        check_lines = [
            f"[{'PASS' if check.passed else 'FAIL'}] {check.label}: {check.actual}"
            for check in checks
        ]
        write_terminal_screen(
            self.screen_dir / filename,
            candidate.label,
            [
                f"$ {command.stdout.strip()}",
                "",
                *observed.strip().splitlines(),
                "",
                *check_lines,
            ],
            "live",
        )
        artifact_name = f"{phase}-{candidate.id}.csv"
        # Preserve remote LF bytes on Windows; text mode would silently rewrite
        # line endings and invalidate the evidence digest.
        (self.artifact_dir / artifact_name).write_bytes(observed.encode("utf-8"))
        duration_ms = round((time.perf_counter() - started) * 1000)
        return BranchResult(
            candidate_id=candidate.id,
            label=candidate.label,
            hypothesis=candidate.hypothesis,
            status="pass"
            if all(check.passed for check in checks if check.required)
            else "fail",
            duration_ms=duration_ms,
            action_count=len(candidate.actions),
            checks=checks,
            screenshot=f"screens/{filename}",
            artifact=artifact_name,
            artifact_sha256=sha256_text(observed),
            phase="commit" if phase == "commit" else "explore",
        )

    async def cleanup(self) -> CleanupEvidence:
        errors: list[str] = []
        attempted = self.base_id is not None
        snapshot_deleted = self.snapshot_id is None
        try:
            await self._drop_active_worker()
            if self.base_id is not None and not self._base_killed:
                await self.client.kill(self.base_id)
                self._base_killed = True
        except Exception as exc:  # noqa: BLE001 - cleanup must remain best-effort
            errors.append(f"kill: {type(exc).__name__}: {exc}")
        finally:
            if self.snapshot_id is not None:
                try:
                    await self.client.delete_snapshot(self.snapshot_id)
                    snapshot_deleted = True
                except Exception as exc:  # noqa: BLE001 - report every cleanup edge
                    errors.append(f"delete snapshot: {type(exc).__name__}: {exc}")
            await self.client.aclose()

        all_workers_killed = self._workers_killed == self._workers_created
        return CleanupEvidence(
            attempted=attempted,
            succeeded=self._base_killed
            and all_workers_killed
            and snapshot_deleted
            and not errors,
            detail=(
                f"destroyed base plus {self._workers_killed} snapshot clones; deleted checkpoint"
                if self._base_killed
                and all_workers_killed
                and snapshot_deleted
                and not errors
                else "; ".join(errors) or "no live sandbox was created"
            ),
        )

    async def _drop_active_worker(self) -> None:
        if self.worker_id is None:
            return
        worker_id = self.worker_id
        try:
            await self.client.kill(worker_id)
            self._workers_killed += 1
        finally:
            if self.sandbox is not None:
                await self.sandbox.close()
            self.sandbox = None
            self.worker_id = None

    def _require_sandbox(self):
        if self.sandbox is None:
            raise RuntimeError("live sandbox runner was not prepared")
        return self.sandbox
