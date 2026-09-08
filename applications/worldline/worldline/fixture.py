"""Deterministic offline runner used for development and reviewer rehearsal."""

from __future__ import annotations

import html
import time
from pathlib import Path

from .ledger import BASE_LEDGER, candidate_ledger, sha256_text, verify_ledger
from .models import BranchResult, Candidate, CleanupEvidence, EnvironmentEvidence


class FixtureRunner:
    def __init__(self, artifact_dir: Path) -> None:
        self.artifact_dir = artifact_dir
        self.screen_dir = artifact_dir / "screens"
        self.prepared = False

    async def prepare(self) -> EnvironmentEvidence:
        self.screen_dir.mkdir(parents=True, exist_ok=True)
        self.prepared = True
        self._write_screen("base.svg", "Checkpoint", BASE_LEDGER, "base")
        return EnvironmentEvidence(
            provider="deterministic fixture",
            mode="fixture",
            environment_id="fixture-ledger",
            checkpoint_id="fixture-base",
            base_sha256=sha256_text(BASE_LEDGER),
        )

    async def reset(self) -> None:
        if not self.prepared:
            raise RuntimeError("fixture was not prepared")

    async def execute(self, candidate: Candidate, *, phase: str) -> BranchResult:
        started = time.perf_counter()
        value = candidate_ledger(candidate.id)
        checks = verify_ledger(value)
        filename = f"{phase}-{candidate.id}.svg"
        self._write_screen(filename, candidate.label, value, phase)
        artifact_name = f"{phase}-{candidate.id}.csv"
        (self.artifact_dir / artifact_name).write_bytes(value.encode("utf-8"))
        duration_ms = {
            "global-replace": 790,
            "collateral-edit": 1120,
            "surgical-update": 1460,
        }[candidate.id]
        if phase == "commit":
            duration_ms += 90
        _ = started
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
            artifact_sha256=sha256_text(value),
            phase="commit" if phase == "commit" else "explore",
        )

    async def cleanup(self) -> CleanupEvidence:
        return CleanupEvidence(
            attempted=True,
            succeeded=True,
            detail="fixture state released; no remote resources created",
        )

    def _write_screen(self, filename: str, title: str, value: str, phase: str) -> None:
        lines = value.strip().splitlines()
        text = "".join(
            f'<text x="72" y="{152 + index * 34}" class="row">{html.escape(line)}</text>'
            for index, line in enumerate(lines)
        )
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="bg" x1="0" x2="1"><stop stop-color="#11151d"/><stop offset="1" stop-color="#202938"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#bg)"/><rect x="42" y="38" width="1196" height="644" rx="22" fill="#f4f0e8"/>
<circle cx="78" cy="75" r="8" fill="#ff7067"/><circle cx="104" cy="75" r="8" fill="#f6c453"/><circle cx="130" cy="75" r="8" fill="#63ce8c"/>
<text x="72" y="120" font-family="Arial" font-size="25" font-weight="700" fill="#17202c">{html.escape(title)}</text>
<text x="1150" y="120" font-family="Arial" font-size="14" text-anchor="end" fill="#657184">{html.escape(phase.upper())}</text>
<style>.row{{font: 22px 'Courier New',monospace;fill:#253247}}</style>{text}
<rect x="72" y="612" width="1136" height="1" fill="#d5d0c7"/><text x="72" y="650" font-family="Arial" font-size="15" fill="#657184">Worldline evidence preview · deterministic fixture</text>
</svg>"""
        (self.screen_dir / filename).write_text(svg, encoding="utf-8")
