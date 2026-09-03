"""Upload a trusted oracle into an auditor VM and parse one bound verdict."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Protocol

from .auditor_manifest import AUDITOR_FILES, auditor_bundle_digest
from .case_generation import case_digest, case_payload
from .domain import PurchaseCase
from .oracle import Check, OracleVerdict


VERDICT_PREFIX = "FORKLIFT_VERDICT="
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class RemoteFiles(Protocol):
    async def mkdir(self, path: str) -> None: ...

    async def write(self, path: str, data: bytes | str, mode: int | None = None) -> None: ...

    async def remove(self, path: str, recursive: bool = False) -> None: ...


class RemoteCommands(Protocol):
    async def run(
        self,
        cmd: str,
        *,
        args: list[str] | None = None,
        cwd: str | None = None,
        timeout_ms: int | None = None,
    ): ...


class AuditorBranch(Protocol):
    files: RemoteFiles
    commands: RemoteCommands


def parse_remote_verdict(stdout: str) -> OracleVerdict:
    lines = [line for line in stdout.splitlines() if line.startswith(VERDICT_PREFIX)]
    if len(lines) != 1:
        raise ValueError(f"expected exactly one verdict marker, got {len(lines)}")
    raw = json.loads(lines[0][len(VERDICT_PREFIX) :])
    if not isinstance(raw, dict) or not isinstance(raw.get("checks"), list):
        raise ValueError("malformed remote verdict")
    checks_list: list[Check] = []
    for item in raw["checks"]:
        if not isinstance(item, dict):
            raise ValueError("malformed remote check")
        code = item.get("code")
        detail = item.get("detail")
        if not isinstance(code, str) or not code or not isinstance(detail, str):
            raise ValueError("malformed remote check fields")
        checks_list.append(
            Check(code=code, passed=item.get("passed") is True, detail=detail)
        )
    checks = tuple(checks_list)
    bundle_digest = raw.get("auditor_bundle_digest")
    runtime_digest = raw.get("auditor_runtime_digest")
    if not isinstance(bundle_digest, str) or SHA256_RE.fullmatch(bundle_digest) is None:
        raise ValueError("malformed auditor bundle digest")
    if not isinstance(runtime_digest, str) or SHA256_RE.fullmatch(runtime_digest) is None:
        raise ValueError("malformed auditor runtime digest")
    return OracleVerdict(
        accepted=raw.get("accepted") is True,
        checks=checks,
        oracle_version=str(raw.get("oracle_version", "")),
        auditor_bundle_digest=bundle_digest,
        auditor_runtime_digest=runtime_digest,
    )


async def evaluate_in_auditor(
    branch: AuditorBranch,
    case: PurchaseCase,
    *,
    database_url: str,
    timeout_ms: int = 120_000,
) -> OracleVerdict:
    """Run host-supplied code after sealing so the worker cannot edit it first."""

    token = uuid.uuid4().hex
    root = f"/tmp/forklift-auditor-{case_digest(case)[:12]}-{token}"
    package_dir = f"{root}/forklift"
    source_dir = Path(__file__).resolve().parent
    expected_bundle_digest = auditor_bundle_digest(source_dir)

    try:
        await branch.files.mkdir(root)
        await branch.files.mkdir(package_dir)
        for filename in AUDITOR_FILES:
            await branch.files.write(
                f"{package_dir}/{filename}",
                (source_dir / filename).read_bytes(),
                0o500,
            )

        case_path = f"{root}/case.json"
        await branch.files.write(
            case_path,
            json.dumps(case_payload(case), sort_keys=True, separators=(",", ":")),
            0o400,
        )
        launcher_path = f"{root}/launch.py"
        launcher = (
            "import sys\n"
            f"sys.path.insert(0, {root!r})\n"
            "from forklift.remote_runner import main\n"
            "main()\n"
        )
        await branch.files.write(launcher_path, launcher, 0o500)

        result = await branch.commands.run(
            "python3",
            args=["-I", launcher_path, case_path, database_url],
            cwd=root,
            timeout_ms=timeout_ms,
        )
        if result.exitCode != 0:
            raise RuntimeError(
                f"remote oracle exited {result.exitCode}: {result.stderr[-500:]}"
            )
        verdict = parse_remote_verdict(result.stdout)
        if verdict.auditor_bundle_digest != expected_bundle_digest:
            raise ValueError("remote auditor bundle digest mismatch")
        return verdict
    finally:
        try:
            await branch.files.remove(root, recursive=True)
        except Exception:
            # The caller destroys the whole auditor branch. Cleanup uncertainty
            # must not replace or forge the verdict.
            pass
