"""Explicit ReproLab V1 run state machine."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .browser_runner import run_browser
from .desktop_runner import run_desktop
from .evidence import write_evidence_bundle
from .models import (
    ArtifactRecord,
    BrowserResult,
    CleanupRecord,
    DesktopObservation,
    RunSpec,
    RunStage,
    RunState,
    SandboxAnalysis,
    StageStatus,
    Verdict,
)
from .sandbox_runner import run_sandbox
from .verdict import decide_verdict


@dataclass(frozen=True)
class CompletedRun:
    state: RunState
    verdict: Verdict
    bundle_dir: Path
    browser: BrowserResult | None
    artifact: ArtifactRecord | None
    sandbox: SandboxAnalysis | None
    desktop: DesktopObservation | None
    cleanup: list[CleanupRecord]


async def execute_run(spec: RunSpec, *, api_key: str, bundle_dir: Path) -> CompletedRun:
    state = RunState()
    cleanup: list[CleanupRecord] = []
    browser: BrowserResult | None = None
    artifact: ArtifactRecord | None = None
    sandbox: SandboxAnalysis | None = None
    desktop: DesktopObservation | None = None
    state.record(RunStage.CREATED, StageStatus.SUCCEEDED, output={"run_id": state.run_id})

    try:
        spec.validate()
        state.record(
            RunStage.VALIDATED,
            StageStatus.SUCCEEDED,
            output={"schema_version": spec.schema_version, "recipe": spec.recipe},
        )
    except Exception as exc:  # noqa: BLE001 - validation failures become structured evidence
        state.record(
            RunStage.VALIDATED,
            StageStatus.FAILED,
            error=f"{type(exc).__name__}: {exc}",
        )

    validated = state.stages[-1].status == StageStatus.SUCCEEDED
    if validated:
        try:
            browser, artifact = await run_browser(
                spec, api_key=api_key, bundle_dir=bundle_dir, cleanup=cleanup
            )
            state.record(
                RunStage.BROWSER_RUNNING,
                StageStatus.SUCCEEDED if browser.correct_page else StageStatus.FAILED,
                output=browser.to_dict(),
                error=None if browser.correct_page else "page assertion failed",
            )
        except Exception as exc:  # noqa: BLE001 - runner failures become structured evidence
            state.record(
                RunStage.BROWSER_RUNNING,
                StageStatus.FAILED,
                error=f"{type(exc).__name__}: {exc}",
            )
    else:
        state.record(RunStage.BROWSER_RUNNING, StageStatus.SKIPPED, error="validation failed")

    if artifact is not None:
        state.record(RunStage.ARTIFACT_CAPTURED, StageStatus.SUCCEEDED, output=artifact.to_dict())
    else:
        state.record(
            RunStage.ARTIFACT_CAPTURED,
            StageStatus.SKIPPED,
            error="browser did not produce a canonical artifact",
        )

    if artifact is not None:
        try:
            sandbox = await run_sandbox(
                spec, artifact, api_key=api_key, bundle_dir=bundle_dir, cleanup=cleanup
            )
            sandbox_ok = (
                sandbox.hash_matches
                and sandbox.schema_valid
                and sandbox.row_found
                and sandbox.raw_matches_expected
            )
            state.record(
                RunStage.SANDBOX_VERIFIED,
                StageStatus.SUCCEEDED if sandbox_ok else StageStatus.FAILED,
                output=sandbox.to_dict(),
                error=None if sandbox_ok else "sandbox required checks failed",
            )
        except Exception as exc:  # noqa: BLE001 - runner failures become structured evidence
            state.record(
                RunStage.SANDBOX_VERIFIED,
                StageStatus.FAILED,
                error=f"{type(exc).__name__}: {exc}",
            )
    else:
        state.record(RunStage.SANDBOX_VERIFIED, StageStatus.SKIPPED, error="no artifact")

    sandbox_passed = state.stages[-1].status == StageStatus.SUCCEEDED
    if artifact is not None and sandbox_passed:
        try:
            desktop = await run_desktop(
                spec, artifact, api_key=api_key, bundle_dir=bundle_dir, cleanup=cleanup
            )
            state.record(
                RunStage.DESKTOP_RUNNING,
                StageStatus.SUCCEEDED,
                output={
                    "libreoffice_version": desktop.libreoffice_version,
                    "artifact_hash": desktop.artifact_hash,
                },
            )
        except Exception as exc:  # noqa: BLE001 - runner failures become structured evidence
            state.record(
                RunStage.DESKTOP_RUNNING,
                StageStatus.FAILED,
                error=f"{type(exc).__name__}: {exc}",
            )
    else:
        state.record(
            RunStage.DESKTOP_RUNNING,
            StageStatus.SKIPPED,
            error="sandbox verification did not pass",
        )

    if desktop is not None:
        observed = (
            desktop.hash_matches
            and desktop.active_window_verified
            and desktop.selection_verified
            and desktop.clipboard_sentinel_changed
            and bool(desktop.solari_clipboard_value)
            and (not desktop.x11_available or desktop.observations_agree)
        )
        state.record(
            RunStage.DESKTOP_OBSERVED,
            StageStatus.SUCCEEDED if observed else StageStatus.FAILED,
            output=desktop.to_dict(),
            error=None if observed else "desktop observation required checks failed",
        )
    else:
        state.record(RunStage.DESKTOP_OBSERVED, StageStatus.SKIPPED, error="desktop did not run")

    verdict = decide_verdict(spec, browser, artifact, sandbox, desktop)
    state.record(RunStage.VERDICT_COMPLETE, StageStatus.SUCCEEDED, output=verdict.to_dict())

    try:
        write_evidence_bundle(
            bundle_dir,
            spec=spec,
            state=state,
            browser=browser,
            artifact=artifact,
            sandbox=sandbox,
            desktop=desktop,
            verdict=verdict,
            cleanup=cleanup,
        )
        state.record(
            RunStage.EVIDENCE_COMPLETE,
            StageStatus.SUCCEEDED,
            output={"bundle_dir": str(bundle_dir)},
        )
    except Exception as exc:  # noqa: BLE001 - evidence failures become structured state
        state.record(
            RunStage.EVIDENCE_COMPLETE,
            StageStatus.FAILED,
            error=f"{type(exc).__name__}: {exc}",
        )

    operational_clean = (
        all(item.cleanup_succeeded and not item.cleanup_error for item in cleanup)
        if cleanup
        else True
    )
    state.record(
        RunStage.CLEANUP_COMPLETE,
        StageStatus.SUCCEEDED if operational_clean else StageStatus.FAILED,
        output={"operational_clean": operational_clean},
        error=None if operational_clean else "one or more remote resources were not cleaned up",
    )
    write_evidence_bundle(
        bundle_dir,
        spec=spec,
        state=state,
        browser=browser,
        artifact=artifact,
        sandbox=sandbox,
        desktop=desktop,
        verdict=verdict,
        cleanup=cleanup,
    )
    return CompletedRun(
        state=state,
        verdict=verdict,
        bundle_dir=bundle_dir,
        browser=browser,
        artifact=artifact,
        sandbox=sandbox,
        desktop=desktop,
        cleanup=cleanup,
    )
