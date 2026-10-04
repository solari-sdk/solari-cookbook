"""Deterministic ReproLab verdict truth table."""

from __future__ import annotations

from .models import (
    ArtifactRecord,
    BrowserResult,
    DesktopObservation,
    RunSpec,
    SandboxAnalysis,
    Verdict,
    VerdictStatus,
)


def decide_verdict(
    spec: RunSpec,
    browser: BrowserResult | None,
    artifact: ArtifactRecord | None,
    sandbox: SandboxAnalysis | None,
    desktop: DesktopObservation | None,
) -> Verdict:
    desktop_value = desktop.solari_clipboard_value if desktop else None
    gates = {
        "B1_correct_target_page": bool(browser and browser.correct_page),
        "B2_expected_download_completed": bool(browser and browser.download_completed),
        "A1_canonical_artifact_hash_established": bool(artifact and artifact.sha256),
        "S1_sandbox_hash_matches": bool(sandbox and sandbox.hash_matches),
        "S2_csv_parses": bool(sandbox and sandbox.schema_valid),
        "S3_target_row_exists": bool(sandbox and sandbox.row_found),
        "S4_raw_value_matches_expected": bool(sandbox and sandbox.raw_matches_expected),
        "D1_desktop_hash_matches": bool(desktop and desktop.hash_matches),
        "D2_expected_calc_document_active": bool(desktop and desktop.active_window_verified),
        "D3_target_cell_selected": bool(desktop and desktop.selection_verified),
        "D4_clipboard_sentinel_changed": bool(desktop and desktop.clipboard_sentinel_changed),
        "D5_machine_observation_exists": bool(desktop_value),
        "D6_independent_observations_agree": bool(
            desktop and (not desktop.x11_available or desktop.observations_agree)
        ),
    }
    raw_value = sandbox.raw_value if sandbox else None
    failed = [name for name, passed in gates.items() if not passed]
    if failed:
        return Verdict(
            status=VerdictStatus.INCONCLUSIVE,
            reason=f"mandatory evidence failed: {', '.join(failed)}",
            gates=gates,
            raw_value=raw_value,
            desktop_value=desktop_value,
        )

    if raw_value == spec.expected_text and desktop_value == spec.known_failure_text:
        return Verdict(
            status=VerdictStatus.CONFIRMED,
            reason=(
                f"artifact contains {spec.expected_text!r}; LibreOffice observed the accepted "
                f"failure signature {spec.known_failure_text!r}"
            ),
            gates=gates,
            raw_value=raw_value,
            desktop_value=desktop_value,
        )
    if raw_value == spec.expected_text and desktop_value == spec.expected_text:
        return Verdict(
            status=VerdictStatus.NOT_REPRODUCED,
            reason="LibreOffice preserved the expected text exactly",
            gates=gates,
            raw_value=raw_value,
            desktop_value=desktop_value,
        )
    return Verdict(
        status=VerdictStatus.INCONCLUSIVE,
        reason=f"unexpected desktop value {desktop_value!r}; no accepted failure signature matched",
        gates=gates,
        raw_value=raw_value,
        desktop_value=desktop_value,
    )
