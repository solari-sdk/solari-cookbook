"""Canonical evidence-bundle generation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .models import (
    ArtifactRecord,
    BrowserResult,
    CleanupRecord,
    DesktopObservation,
    RunSpec,
    RunState,
    SandboxAnalysis,
    Verdict,
    utc_now,
)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_evidence_bundle(
    bundle_dir: Path,
    *,
    spec: RunSpec,
    state: RunState,
    browser: BrowserResult | None,
    artifact: ArtifactRecord | None,
    sandbox: SandboxAnalysis | None,
    desktop: DesktopObservation | None,
    verdict: Verdict,
    cleanup: list[CleanupRecord],
) -> None:
    bundle_dir.mkdir(parents=True, exist_ok=True)
    operational_clean = (
        all(item.cleanup_succeeded and not item.cleanup_error for item in cleanup)
        if cleanup
        else True
    )
    cleanup_value = {
        "operational_clean": operational_clean,
        "resources": [item.to_dict() for item in cleanup],
    }
    spec_value = spec.to_evidence_dict()
    browser_value = browser.to_dict() if browser else None
    artifact_value = artifact.to_dict() if artifact else None
    sandbox_value = sandbox.to_dict() if sandbox else None
    desktop_value = desktop.to_dict() if desktop else None
    verdict_value = verdict.to_dict()

    _write_json(bundle_dir / "run-spec.json", spec_value)
    _write_json(bundle_dir / "verdict.json", verdict_value)
    _write_json(bundle_dir / "cleanup.json", cleanup_value)
    _write_json(bundle_dir / "browser" / "assertions.json", browser_value)
    _write_json(
        bundle_dir / "browser" / "download.json",
        {
            "completed": browser.download_completed if browser else False,
            "filename": browser.filename if browser else None,
            "mime_type": browser.mime_type if browser else None,
            "byte_length": browser.byte_length if browser else None,
            "sha256": browser.sha256 if browser else None,
            "timestamp": browser.timestamp if browser else None,
        },
    )
    _write_json(
        bundle_dir / "artifacts" / "hashes.json",
        {
            "canonical": artifact.sha256 if artifact else None,
            "sandbox": sandbox.hash if sandbox else None,
            "desktop": desktop.artifact_hash if desktop else None,
            "all_match": bool(
                artifact
                and sandbox
                and desktop
                and artifact.sha256 == sandbox.hash == desktop.artifact_hash
            ),
        },
    )
    if sandbox is not None:
        _write_json(bundle_dir / "sandbox" / "analysis.json", sandbox_value)
        _write_json(bundle_dir / "sandbox" / "environment.json", sandbox.environment)
    if desktop is not None:
        _write_json(bundle_dir / "desktop" / "environment.json", desktop.environment)

    report = {
        "schema_version": "1.0",
        "generated_at": utc_now(),
        "run": state.to_dict(),
        "spec": spec_value,
        "browser": browser_value,
        "artifact": artifact_value,
        "sandbox": sandbox_value,
        "desktop": desktop_value,
        "verdict": verdict_value,
        "cleanup": cleanup_value,
    }
    _write_json(bundle_dir / "report.json", report)
    (bundle_dir / "report.md").write_text(
        _render_report(spec, artifact, sandbox, desktop, verdict, operational_clean),
        encoding="utf-8",
    )

    files: list[dict[str, Any]] = []
    for path in sorted(bundle_dir.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        content = path.read_bytes()
        files.append(
            {
                "path": str(path.relative_to(bundle_dir)),
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    _write_json(
        bundle_dir / "manifest.json",
        {
            "schema_version": "1.0",
            "run_id": state.run_id,
            "generated_at": utc_now(),
            "verdict": verdict.status.value,
            "operational_clean": operational_clean,
            "files": files,
        },
    )


def _render_report(
    spec: RunSpec,
    artifact: ArtifactRecord | None,
    sandbox: SandboxAnalysis | None,
    desktop: DesktopObservation | None,
    verdict: Verdict,
    operational_clean: bool,
) -> str:
    digest = artifact.sha256 if artifact else "unavailable"
    raw = sandbox.raw_value if sandbox else None
    observed = desktop.solari_clipboard_value if desktop else None
    version = desktop.libreoffice_version if desktop else "unavailable"
    identity = bool(
        artifact
        and sandbox
        and desktop
        and artifact.sha256 == sandbox.hash == desktop.artifact_hash
    )
    return f"""# REPROLAB

## Verdict

{verdict.status.value}

## Claim

Web-exported `{spec.target_column}` should remain `{spec.expected_text}` when opened in
LibreOffice Calc.

## Browser

Export {"completed" if artifact else "did not complete"}.

Artifact SHA-256: `{digest}`

## Sandbox

Raw `{spec.target_column}` = `{raw}`

{"PASS" if sandbox and sandbox.raw_matches_expected else "FAIL"}

## Desktop

LibreOffice version: `{version}`

Observed `{spec.target_column}` = `{observed}`

## Artifact identity

Browser == Sandbox == Desktop: {"PASS" if identity else "FAIL"}

## Conclusion

{verdict.reason}

Screenshots support this report but do not determine the verdict.

Operational cleanup: {"CLEAN" if operational_clean else "WARNING"}
"""
