"""Live Solari Desktop runner for the ledger tournament."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from solari_desktop import DesktopClient
from solari_sandbox import SandboxClient

from .ledger import BASE_LEDGER, candidate_ledger, sha256_text, verify_ledger
from .models import BranchResult, Candidate, CleanupEvidence, EnvironmentEvidence

BASE_URL = "https://api.getsolari.com"
REMOTE_DIR = "/tmp/worldline"
REMOTE_LEDGER = f"{REMOTE_DIR}/expense-ledger.csv"


def redact_identifier(value: str) -> str:
    if len(value) <= 18:
        return value
    return f"{value[:8]}…{value[-6:]}"


class SolariDesktopRunner:
    """Sequentially explores candidate GUI edits from one desktop snapshot."""

    def __init__(
        self, artifact_dir: Path, *, api_key: str, base_url: str = BASE_URL
    ) -> None:
        if not api_key:
            raise ValueError("SOLARI_API_KEY is required for live mode")
        self.artifact_dir = artifact_dir
        self.screen_dir = artifact_dir / "screens"
        self.client = DesktopClient(
            api_key=api_key, base_url=base_url, call_timeout_ms=30_000
        )
        self.snapshot_client = SandboxClient(api_key=api_key, base_url=base_url)
        self.desktop = None
        self.session_id: str | None = None
        self.snapshot_id: str | None = None
        self._destroyed = False
        self._reset_count = 0

    async def prepare(self) -> EnvironmentEvidence:
        self.screen_dir.mkdir(parents=True, exist_ok=True)
        self.desktop = await self.client.create(
            template="default",
            resolution="1280x720",
            cpu=2,
            mem_mb=2048,
            timeout_ms=10 * 60_000,
            lifecycle={"onTimeout": "kill"},
            metadata={"product": "worldline", "purpose": "branch-tournament"},
        )
        self.session_id = self.desktop.sessionId
        await self.desktop.connect()
        await self._wait_until_ready()
        await self.desktop.exec("mkdir", args=["-p", REMOTE_DIR])
        await self.desktop.fs.write(REMOTE_LEDGER, BASE_LEDGER)
        await self.desktop.open("mousepad", [REMOTE_LEDGER])
        await asyncio.sleep(3.0)
        await self._focus_editor()
        (self.screen_dir / "base.png").write_bytes(
            await self.desktop.screenshot(format="png")
        )
        self.snapshot_id = await self.desktop.snapshot("worldline-ledger-base")
        return EnvironmentEvidence(
            provider="Solari Desktop",
            mode="live",
            environment_id=redact_identifier(self.session_id),
            checkpoint_id=redact_identifier(self.snapshot_id),
            base_sha256=sha256_text(BASE_LEDGER),
        )

    async def reset(self) -> None:
        desktop = self._require_desktop()
        if self.snapshot_id is None:
            raise RuntimeError("live runner has no checkpoint")
        try:
            await desktop.revert(self.snapshot_id)
        except Exception as exc:
            if (
                type(exc).__name__ != "GatewayError"
                or "not revertable" not in str(exc).lower()
            ):
                raise
            await desktop.pause()
            await desktop.revert(self.snapshot_id)
            await desktop.resume()
        else:
            # Reverting RAM restores the control channel to its checkpoint-era
            # state; reconnect explicitly before sending the next action.
            await asyncio.sleep(1.0)
            await desktop.reconnect()
        await self._wait_until_ready()
        self._reset_count += 1

    async def execute(self, candidate: Candidate, *, phase: str) -> BranchResult:
        desktop = self._require_desktop()
        started = time.perf_counter()
        intended = candidate_ledger(candidate.id)
        await self._focus_editor()
        await desktop.keyboard.hotkey("ctrl", "a")
        await desktop.clipboard.set(intended)
        await desktop.keyboard.hotkey("ctrl", "v")
        await desktop.keyboard.hotkey("ctrl", "s")
        await asyncio.sleep(1.0)

        observed = await desktop.fs.read_text(REMOTE_LEDGER)
        checks = verify_ledger(observed)
        filename = f"{phase}-{candidate.id}.png"
        (self.screen_dir / filename).write_bytes(await desktop.screenshot(format="png"))
        artifact_name = f"{phase}-{candidate.id}.csv"
        # Preserve the exact remote bytes across Windows and POSIX hosts so the
        # recorded digest always hashes the artifact reviewers download.
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
        attempted = self.session_id is not None
        snapshot_deleted = self.snapshot_id is None
        try:
            if self.session_id is not None and not self._destroyed:
                await self.client.destroy(self.session_id)
                self._destroyed = True
        except Exception as exc:  # noqa: BLE001 - cleanup must remain best-effort
            errors.append(f"destroy: {type(exc).__name__}: {exc}")
            try:
                if self.desktop is not None:
                    await self.desktop.kill()
                    self._destroyed = True
            except Exception as fallback_exc:  # noqa: BLE001 - cleanup fallback
                errors.append(
                    f"fallback kill: {type(fallback_exc).__name__}: {fallback_exc}"
                )
        finally:
            if self.snapshot_id is not None:
                try:
                    await self.snapshot_client.delete_snapshot(self.snapshot_id)
                    snapshot_deleted = True
                except Exception as exc:  # noqa: BLE001 - report every cleanup edge
                    errors.append(f"delete snapshot: {type(exc).__name__}: {exc}")
            try:
                if self.desktop is not None:
                    await self.desktop.close()
            except Exception as exc:  # noqa: BLE001 - report every cleanup edge
                errors.append(f"close: {type(exc).__name__}: {exc}")
            await self.client.aclose()
            await self.snapshot_client.aclose()

        return CleanupEvidence(
            attempted=attempted,
            succeeded=self._destroyed and snapshot_deleted and not errors,
            detail=(
                f"destroyed live desktop and deleted checkpoint after {self._reset_count} restores"
                if self._destroyed and snapshot_deleted and not errors
                else "; ".join(errors) or "no live desktop was created"
            ),
        )

    async def _wait_until_ready(self, attempts: int = 30) -> None:
        desktop = self._require_desktop()
        for _ in range(attempts):
            health = await desktop.health()
            if health.ready and health.display:
                return
            await asyncio.sleep(0.5)
        raise TimeoutError("Solari desktop did not become display-ready")

    async def _focus_editor(self) -> None:
        desktop = self._require_desktop()
        await desktop.mouse.click(320, 300, humanize=True)
        await asyncio.sleep(0.2)

    def _require_desktop(self):
        if self.desktop is None:
            raise RuntimeError("live runner was not prepared")
        return self.desktop
