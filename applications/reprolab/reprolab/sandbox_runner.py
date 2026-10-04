"""Deterministic CSV analysis in a Solari Sandbox."""

from __future__ import annotations

import json
from pathlib import Path

from solari_sandbox import SandboxClient

from .models import ArtifactRecord, CleanupRecord, RunSpec, SandboxAnalysis, redact_identifier

BASE_URL = "https://api.getsolari.com"
REMOTE_ARTIFACT = "/work/input/export.csv"

ANALYZER = r"""import csv, hashlib, json, sys
from pathlib import Path

path = Path(sys.argv[1])
selector = json.loads(sys.argv[2])
target_column = sys.argv[3]
expected = sys.argv[4]
data = path.read_bytes()
schema_valid = False
row = None
try:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or []
        schema_valid = target_column in fields and all(key in fields for key in selector)
        if schema_valid:
            row = next(
                (candidate for candidate in reader
                 if all(candidate.get(key) == value for key, value in selector.items())),
                None,
            )
except (UnicodeDecodeError, csv.Error):
    schema_valid = False
raw = row.get(target_column) if row else None
analysis = {
    "hash": hashlib.sha256(data).hexdigest(),
    "schema_valid": schema_valid,
    "row_found": row is not None,
    "raw_value": raw,
    "expected_value": expected,
    "raw_matches_expected": raw == expected,
}
Path("/work/input/analysis.json").write_text(json.dumps(analysis, indent=2) + "\n")
print(json.dumps(analysis))
"""


async def run_sandbox(
    spec: RunSpec,
    artifact: ArtifactRecord,
    *,
    api_key: str,
    bundle_dir: Path,
    cleanup: list[CleanupRecord],
) -> SandboxAnalysis:
    output_dir = bundle_dir / "sandbox"
    output_dir.mkdir(parents=True, exist_ok=True)
    client = SandboxClient(api_key=api_key, base_url=BASE_URL)
    sandbox = None
    cleanup_record: CleanupRecord | None = None
    try:
        sandbox = await client.create(
            template="base",
            timeout_ms=5 * 60_000,
            lifecycle={"onTimeout": "kill"},
        )
        cleanup_record = CleanupRecord(
            resource_type="sandbox",
            resource_id=redact_identifier(sandbox.sandboxId) or "unavailable",
        )
        cleanup.append(cleanup_record)
        await sandbox.connect()
        await sandbox.commands.run("mkdir", args=["-p", "/work/input"])
        await sandbox.files.write(REMOTE_ARTIFACT, artifact.content)

        environment_result = await sandbox.commands.run(
            "sh", args=["-c", "python3 --version 2>&1; uname -a"], timeout_ms=15_000
        )
        environment = {
            "template": "base",
            "python_and_kernel": environment_result.stdout.strip(),
        }
        (output_dir / "environment.json").write_text(
            json.dumps(environment, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        command = await sandbox.commands.run(
            "python3",
            args=[
                "-c",
                ANALYZER,
                REMOTE_ARTIFACT,
                json.dumps(spec.row_selector, sort_keys=True),
                spec.target_column,
                spec.expected_text,
            ],
            timeout_ms=30_000,
        )
        if command.exitCode != 0:
            raise RuntimeError(command.stderr.strip() or "sandbox CSV analyzer failed")
        analysis_bytes = await sandbox.files.read("/work/input/analysis.json")
        (output_dir / "analysis.json").write_bytes(analysis_bytes)
        value = json.loads(analysis_bytes)
        return SandboxAnalysis(
            hash=value["hash"],
            hash_matches=value["hash"] == artifact.sha256,
            schema_valid=bool(value["schema_valid"]),
            row_found=bool(value["row_found"]),
            raw_value=value["raw_value"],
            expected_value=value["expected_value"],
            raw_matches_expected=bool(value["raw_matches_expected"]),
            environment=environment,
        )
    finally:
        if sandbox is not None and cleanup_record is not None:
            cleanup_record.cleanup_attempted = True
            try:
                await sandbox.kill()
                cleanup_record.cleanup_succeeded = True
            except Exception as exc:  # noqa: BLE001 - cleanup evidence must survive
                cleanup_record.cleanup_error = f"{type(exc).__name__}: {exc}"
            try:
                await sandbox.close()
            except Exception as close_exc:  # noqa: BLE001 - remote cleanup outcome is already known
                cleanup_record.cleanup_error = (
                    (cleanup_record.cleanup_error + "; ") if cleanup_record.cleanup_error else ""
                ) + f"local close: {type(close_exc).__name__}: {close_exc}"
        await client.aclose()
