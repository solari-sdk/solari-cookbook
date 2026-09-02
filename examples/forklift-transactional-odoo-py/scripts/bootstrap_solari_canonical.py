"""Build, smoke-audit, and freeze Forklift's canonical Solari sandbox."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import httpx

from forklift.domain import PurchaseCase
from forklift.remote_oracle import evaluate_in_auditor
from forklift.solari_adapter import SolariSandboxBranches
from scripts.check_solari_auth import _load_local_env, _safe_code, _safe_status


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = PROJECT_ROOT / "artifacts" / "development"
RUNTIME_ARCHIVE = ARTIFACT_DIR / "odoo-runtime.tar.gz"
RUNTIME_MANIFEST = ARTIFACT_DIR / "odoo-runtime.manifest.json"
DATABASE_DUMP = ARTIFACT_DIR / "forklift_clean.dump"
DATABASE_MANIFEST = ARTIFACT_DIR / "forklift_clean.dump.manifest.json"
CANONICAL_STATE = ARTIFACT_DIR / "solari-canonical.json"
SMOKE_CASE = PROJECT_ROOT / "lab" / "valid_fixture_case.json"

APT_PACKAGES = (
    "adduser",
    "ca-certificates",
    "curl",
    "fonts-dejavu-core",
    "fonts-font-awesome",
    "fonts-inconsolata",
    "fonts-roboto-unhinted",
    "gsfonts",
    "libjs-underscore",
    "lsb-base",
    "postgresql",
    "postgresql-client",
    "python3",
    "python3-asn1crypto",
    "python3-babel",
    "python3-cbor2",
    "python3-chardet",
    "python3-cryptography",
    "python3-dateutil",
    "python3-docutils",
    "python3-freezegun",
    "python3-geoip2",
    "python3-gevent",
    "python3-greenlet",
    "python3-idna",
    "python3-jinja2",
    "python3-libsass",
    "python3-lxml",
    "python3-magic",
    "python3-markupsafe",
    "python3-num2words",
    "python3-ofxparse",
    "python3-openpyxl",
    "python3-openssl",
    "python3-passlib",
    "python3-pil",
    "python3-pip",
    "python3-polib",
    "python3-psutil",
    "python3-psycopg2",
    "python3-pypdf2",
    "python3-qrcode",
    "python3-renderpm",
    "python3-reportlab",
    "python3-requests",
    "python3-rjsmin",
    "python3-serial",
    "python3-stdnum",
    "python3-tz",
    "python3-urllib3",
    "python3-usb",
    "python3-vobject",
    "python3-werkzeug",
    "python3-xlrd",
    "python3-xlsxwriter",
    "python3-xlwt",
    "python3-zeep",
)

ODOO_CONFIG = """[options]
admin_passwd = forklift-development-master
addons_path = /opt/odoo/odoo/addons
data_dir = /var/lib/odoo
db_host = 127.0.0.1
db_port = 5432
db_user = odoo
db_password = odoo
dbfilter = ^forklift_clean$
list_db = False
http_interface = 0.0.0.0
http_port = 8069
proxy_mode = True
workers = 0
max_cron_threads = 0
log_level = warn
"""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


UPLOAD_PART_BYTES = 16 * 1024 * 1024


def _upload_bytes(url: str, payload: bytes) -> int:
    timeout = httpx.Timeout(15 * 60, connect=30)
    transport = httpx.HTTPTransport(retries=3)
    with httpx.Client(
        timeout=timeout,
        follow_redirects=True,
        transport=transport,
    ) as client:
        response = client.put(
            url,
            content=payload,
            headers={"Content-Type": "application/octet-stream"},
        )
        response.raise_for_status()
        body = response.json()
    return int(body.get("bytes", -1))


def _safe_diagnostic(exc: Exception) -> str:
    """Return bounded diagnostics without bearer tokens or signed capability URLs."""

    detail = str(exc)
    detail = re.sub(r"https?://[^\s'\"]+", "[REDACTED_URL]", detail)
    detail = re.sub(
        r"(?i)\b(token|api[_-]?key|authorization|secret)\s*[:=]\s*[^\s&'\"]+",
        r"\1=[REDACTED]",
        detail,
    )
    return detail[-12000:]


async def _upload_file_in_parts(sandbox, source: Path, remote_path: str) -> None:
    """Upload a file below the gateway's per-request ceiling and reassemble it."""

    if not re.fullmatch(r"/tmp/[a-zA-Z0-9_.-]+", remote_path):
        raise ValueError("remote upload path must be a simple /tmp path")
    uploaded_total = 0
    with source.open("rb") as stream:
        for part_number in range(
            (source.stat().st_size + UPLOAD_PART_BYTES - 1) // UPLOAD_PART_BYTES
        ):
            payload_part = stream.read(UPLOAD_PART_BYTES)
            part_path = f"{remote_path}.part{part_number:03d}"
            upload = await sandbox.upload_url(part_path)
            uploaded_bytes = await asyncio.to_thread(
                _upload_bytes,
                upload["url"],
                payload_part,
            )
            if uploaded_bytes != len(payload_part):
                raise RuntimeError(f"upload part {part_number} byte count mismatch")
            uploaded_total += uploaded_bytes
    if uploaded_total != source.stat().st_size:
        raise RuntimeError("multipart upload total byte count mismatch")
    await _must(
        sandbox,
        "sh",
        [
            "-lc",
            f"cat {remote_path}.part* > {remote_path} && rm -f {remote_path}.part*",
        ],
        timeout_ms=2 * 60 * 1000,
    )


async def _must(
    sandbox,
    cmd: str,
    args: list[str],
    *,
    timeout_ms: int,
    env: dict[str, str] | None = None,
    user: str | None = None,
):
    result = await sandbox.commands.run(
        cmd,
        args=args,
        timeout_ms=timeout_ms,
        env=env,
        user=user,
    )
    if result.exitCode != 0:
        detail = (result.stdout + "\n" + result.stderr)[-12000:]
        raise RuntimeError(f"command {cmd} exited {result.exitCode}: {detail}")
    return result


def _consume_task_exception(task: asyncio.Task[int]) -> None:
    try:
        task.exception()
    except (asyncio.CancelledError, Exception):
        pass


async def _wait_for_odoo(
    sandbox,
    *,
    process_task: asyncio.Task[int] | None = None,
    process_output: list[str] | None = None,
    attempts: int = 90,
) -> None:
    for _ in range(attempts):
        if process_task is not None and process_task.done():
            try:
                exit_code = process_task.result()
            except Exception as exc:
                raise RuntimeError(f"Odoo control process failed: {_safe_diagnostic(exc)}") from exc
            detail = "".join(process_output or [])[-12000:]
            raise RuntimeError(f"Odoo exited {exit_code} before readiness: {detail}")
        response = await sandbox.commands.run(
            "curl",
            args=["-fsS", "--max-time", "2", "http://127.0.0.1:8069/web/login"],
        )
        if response.exitCode == 0 and "Odoo" in response.stdout:
            return
        await asyncio.sleep(1)
    detail = "".join(process_output or [])[-12000:]
    raise RuntimeError(f"Odoo did not become ready: {detail}")


async def _start_and_wait_for_odoo(sandbox) -> None:
    probe = await sandbox.commands.run(
        "curl",
        args=["-fsS", "--max-time", "2", "http://127.0.0.1:8069/web/login"],
    )
    if probe.exitCode == 0 and "Odoo" in probe.stdout:
        return

    output: list[str] = []
    handle = await sandbox.commands.start(
        "python3",
        args=["-m", "odoo", "-c", "/etc/odoo.conf", "-d", "forklift_clean"],
        env={"PYTHONPATH": "/opt/odoo", "HOME": "/var/lib/odoo"},
        user="odoo",
        on_stdout=output.append,
        on_stderr=output.append,
    )
    process_task = asyncio.create_task(handle.wait())
    process_task.add_done_callback(_consume_task_exception)
    await _wait_for_odoo(
        sandbox,
        process_task=process_task,
        process_output=output,
    )


def _load_case(path: Path) -> PurchaseCase:
    raw = json.loads(path.read_text(encoding="utf-8"))
    for name in (
        "ordered_qty",
        "received_qty",
        "unit_price",
        "tax_rate",
        "currency_rounding",
    ):
        raw[name] = Decimal(raw[name])
    return PurchaseCase(**raw)


async def _bootstrap() -> int:
    _load_local_env(PROJECT_ROOT / ".env")
    api_key = os.environ.get("SOLARI_API_KEY", "").strip()
    if not api_key:
        print(json.dumps({"canonical": "not_built", "reason": "missing_key"}))
        return 2
    required_artifacts = (
        RUNTIME_ARCHIVE,
        RUNTIME_MANIFEST,
        DATABASE_DUMP,
        DATABASE_MANIFEST,
    )
    if not all(path.exists() for path in required_artifacts):
        print(json.dumps({"canonical": "not_built", "reason": "missing_frozen_artifact"}))
        return 2

    manifest = json.loads(RUNTIME_MANIFEST.read_text(encoding="utf-8"))
    runtime_digest = _sha256(RUNTIME_ARCHIVE)
    if runtime_digest != manifest.get("sha256"):
        print(json.dumps({"canonical": "not_built", "reason": "runtime_digest_mismatch"}))
        return 2
    database_manifest = json.loads(DATABASE_MANIFEST.read_text(encoding="utf-8"))
    database_digest = _sha256(DATABASE_DUMP)
    if database_digest != database_manifest.get("sha256"):
        print(json.dumps({"canonical": "not_built", "reason": "database_digest_mismatch"}))
        return 2

    base_url = os.environ.get("SOLARI_BASE_URL", "https://api.getsolari.com")
    builder = None
    auditor = None
    snapshot_id = None
    keep_snapshot = False
    phase = "connect-backend"
    payload: dict[str, object] = {"canonical": "failed"}

    async with SolariSandboxBranches(
        api_key=api_key,
        base_url=base_url,
        call_timeout_ms=10 * 60 * 1000,
    ) as backend:
        if CANONICAL_STATE.exists():
            saved = json.loads(CANONICAL_STATE.read_text(encoding="utf-8"))
            record = await backend.get_snapshot(saved["canonical_snapshot_id"])
            valid = (
                record.kind == "sandbox"
                and saved.get("runtime_sha256") == runtime_digest
                and saved.get("database_sha256") == database_digest
            )
            print(
                json.dumps(
                    {
                        "canonical": "already_present" if valid else "invalid_saved_state",
                        "kind": record.kind,
                        "runtime_digest_matches": saved.get("runtime_sha256") == runtime_digest,
                        "database_digest_matches": saved.get("database_sha256") == database_digest,
                    },
                    sort_keys=True,
                )
            )
            return 0 if valid else 1

        try:
            phase = "create-builder"
            builder = await backend.create_golden(
                metadata={
                    "forklift.role": "canonical-builder",
                    "forklift.protocol": "v2-browser-sandbox",
                    "forklift.runtime": runtime_digest[:16],
                    "forklift.database": database_digest[:16],
                },
                cpu=4,
                mem_mb=8192,
                disk_gb=100,
                timeout_ms=30 * 60 * 1000,
            )
            await builder.connect()

            phase = "upload-runtime"
            await _upload_file_in_parts(
                builder,
                RUNTIME_ARCHIVE,
                "/tmp/odoo-runtime.tar.gz",
            )
            remote_digest = await _must(
                builder,
                "sha256sum",
                ["/tmp/odoo-runtime.tar.gz"],
                timeout_ms=2 * 60 * 1000,
            )
            if remote_digest.stdout.split()[0] != runtime_digest:
                raise RuntimeError("runtime upload digest mismatch")

            phase = "upload-database"
            await _upload_file_in_parts(
                builder,
                DATABASE_DUMP,
                "/tmp/forklift_clean.dump",
            )
            remote_database_digest = await _must(
                builder,
                "sha256sum",
                ["/tmp/forklift_clean.dump"],
                timeout_ms=2 * 60 * 1000,
            )
            if remote_database_digest.stdout.split()[0] != database_digest:
                raise RuntimeError("database upload digest mismatch")

            phase = "install-dependencies"
            await _must(builder, "apt-get", ["update"], timeout_ms=3 * 60 * 1000)
            await _must(
                builder,
                "apt-get",
                ["install", "-y", "--no-install-recommends", *APT_PACKAGES],
                timeout_ms=10 * 60 * 1000,
                env={"DEBIAN_FRONTEND": "noninteractive"},
            )
            await _must(
                builder,
                "pip3",
                [
                    "install",
                    "--break-system-packages",
                    "--no-cache-dir",
                    "lxml_html_clean",
                    "psycopg[binary]>=3.2,<4",
                ],
                timeout_ms=3 * 60 * 1000,
            )

            phase = "install-runtime"
            await _must(builder, "mkdir", ["-p", "/opt/odoo"], timeout_ms=60_000)
            await _must(
                builder,
                "tar",
                ["-xzf", "/tmp/odoo-runtime.tar.gz", "-C", "/opt/odoo"],
                timeout_ms=5 * 60 * 1000,
            )
            await _must(builder, "rm", ["-f", "/tmp/odoo-runtime.tar.gz"], timeout_ms=60_000)
            await builder.files.mkdir("/opt/forklift")
            await builder.files.write("/opt/forklift/runtime.sha256", runtime_digest + "\n", 0o400)
            await builder.files.write("/opt/forklift/database.sha256", database_digest + "\n", 0o400)
            await builder.files.write("/etc/odoo.conf", ODOO_CONFIG, 0o640)

            phase = "create-service-user"
            user_check = await builder.commands.run("id", args=["-u", "odoo"])
            if user_check.exitCode != 0:
                await _must(
                    builder,
                    "adduser",
                    [
                        "--system",
                        "--group",
                        "--home",
                        "/var/lib/odoo",
                        "--no-create-home",
                        "odoo",
                    ],
                    timeout_ms=60_000,
                )
            await _must(builder, "mkdir", ["-p", "/var/lib/odoo", "/var/log/odoo"], timeout_ms=60_000)
            await _must(
                builder,
                "chown",
                ["-R", "odoo:odoo", "/var/lib/odoo", "/var/log/odoo", "/opt/odoo"],
                timeout_ms=2 * 60 * 1000,
            )
            await _must(
                builder,
                "chown",
                [
                    "root:odoo",
                    "/etc/odoo.conf",
                    "/opt/forklift/runtime.sha256",
                    "/opt/forklift/database.sha256",
                ],
                timeout_ms=60_000,
            )
            await _must(
                builder,
                "chmod",
                [
                    "640",
                    "/etc/odoo.conf",
                    "/opt/forklift/runtime.sha256",
                    "/opt/forklift/database.sha256",
                ],
                timeout_ms=60_000,
            )

            phase = "start-postgres"
            await _must(
                builder,
                "sh",
                [
                    "-lc",
                    "pg_isready -q || pg_ctlcluster $(pg_lsclusters -h | awk 'NR==1 {print $1, $2}') start",
                ],
                timeout_ms=2 * 60 * 1000,
            )
            await _must(
                builder,
                "runuser",
                [
                    "-u",
                    "postgres",
                    "--",
                    "psql",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-c",
                    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='odoo') "
                    "THEN CREATE ROLE odoo LOGIN CREATEDB PASSWORD 'odoo'; "
                    "ELSE ALTER ROLE odoo WITH LOGIN CREATEDB PASSWORD 'odoo'; END IF; END $$;",
                ],
                timeout_ms=60_000,
            )
            database_exists = await _must(
                builder,
                "runuser",
                [
                    "-u",
                    "postgres",
                    "--",
                    "psql",
                    "-Atc",
                    "SELECT 1 FROM pg_database WHERE datname='forklift_clean'",
                ],
                timeout_ms=60_000,
            )
            if database_exists.stdout.strip():
                raise RuntimeError("fresh canonical builder unexpectedly contains forklift_clean")
            await _must(
                builder,
                "runuser",
                [
                    "-u",
                    "postgres",
                    "--",
                    "createdb",
                    "-O",
                    "odoo",
                    "forklift_clean",
                ],
                timeout_ms=60_000,
            )

            phase = "restore-frozen-database"
            await _must(
                builder,
                "pg_restore",
                [
                    "-h",
                    "127.0.0.1",
                    "-U",
                    "odoo",
                    "--exit-on-error",
                    "--no-owner",
                    "-d",
                    "forklift_clean",
                    "/tmp/forklift_clean.dump",
                ],
                timeout_ms=5 * 60 * 1000,
                env={"PGPASSWORD": "odoo"},
            )
            await _must(builder, "rm", ["-f", "/tmp/forklift_clean.dump"], timeout_ms=60_000)

            phase = "start-odoo"
            await _start_and_wait_for_odoo(builder)

            phase = "verify-canonical"
            evidence = await _must(
                builder,
                "psql",
                [
                    "-h",
                    "127.0.0.1",
                    "-U",
                    "odoo",
                    "-d",
                    "forklift_clean",
                    "-Atc",
                    "SELECT (SELECT count(*) FROM purchase_order),"
                    "(SELECT count(*) FROM stock_picking),"
                    "(SELECT count(*) FROM account_move WHERE move_type='in_invoice'),"
                    "(SELECT count(*) FROM account_payment),"
                    "(SELECT count(*) FROM res_partner WHERE ref='SUP-ACME-04'),"
                    "(SELECT count(*) FROM product_product p JOIN product_template t ON t.id=p.product_tmpl_id "
                    "WHERE t.default_code='BEARING-6204')",
                ],
                timeout_ms=60_000,
                env={"PGPASSWORD": "odoo"},
            )
            if evidence.stdout.strip() != "0|0|0|0|1|1":
                raise RuntimeError(f"unexpected canonical counts: {evidence.stdout.strip()}")
            await builder.commands.run("apt-get", args=["clean"], timeout_ms=60_000)
            disk = await _must(
                builder,
                "sh",
                ["-lc", "df -Pk / | awk 'NR==2 {print $4}'"],
                timeout_ms=60_000,
            )
            free_disk_mib = int(disk.stdout.strip()) // 1024
            if free_disk_mib < 256:
                raise RuntimeError(f"insufficient free disk after canonical build: {free_disk_mib} MiB")

            phase = "snapshot-canonical"
            snapshot_id = await builder.snapshot("forklift-canonical-v2-browser-sandbox")
            record = await backend.get_snapshot(snapshot_id)
            if record.snapshot_id != snapshot_id or record.kind != "sandbox" or record.parent_id is not None:
                raise RuntimeError("canonical snapshot identity, kind, or root lineage mismatch")
            await builder.kill()
            builder = None

            phase = "smoke-audit-restored-canonical"
            auditor = await backend.fork(
                snapshot_id=snapshot_id,
                metadata={
                    "forklift.role": "canonical-smoke-auditor",
                    "forklift.protocol": "v2-browser-sandbox",
                },
            )
            await auditor.connect()
            await _must(
                auditor,
                "sh",
                [
                    "-lc",
                    "pg_isready -q || pg_ctlcluster $(pg_lsclusters -h | awk 'NR==1 {print $1, $2}') start",
                ],
                timeout_ms=2 * 60 * 1000,
            )
            await _start_and_wait_for_odoo(auditor)
            verdict = await evaluate_in_auditor(
                auditor,
                _load_case(SMOKE_CASE),
                database_url="postgresql://odoo:odoo@127.0.0.1:5432/forklift_clean",
                timeout_ms=2 * 60 * 1000,
            )
            failed_codes = [check.code for check in verdict.checks if not check.passed]
            if verdict.accepted or "one-purchase-order" not in failed_codes:
                raise RuntimeError(
                    "empty canonical smoke verdict mismatch: "
                    f"accepted={verdict.accepted} failed_codes={failed_codes!r}"
                )
            await auditor.kill()
            auditor = None

            phase = "promote-canonical"
            template_id = None
            promotion_error_code = None
            try:
                template_id = await backend.promote_snapshot(
                    snapshot_id,
                    name="forklift-canonical-v2-browser-sandbox",
                )
            except Exception as exc:
                promotion_error_code = _safe_code(exc) or type(exc).__name__

            state = {
                "canonical_snapshot_id": snapshot_id,
                "canonical_template_id": template_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "database_sha256": database_digest,
                "free_disk_mib": free_disk_mib,
                "kind": "sandbox",
                "promotion_error_code": promotion_error_code,
                "runtime_sha256": runtime_digest,
                "smoke_failed_checks": failed_codes,
                "smoke_oracle_version": verdict.oracle_version,
            }
            CANONICAL_STATE.write_text(
                json.dumps(state, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            keep_snapshot = True
            payload = {
                "canonical": "built",
                "database_sha256": database_digest,
                "free_disk_mib": free_disk_mib,
                "kind": "sandbox",
                "promoted": template_id is not None,
                "promotion_error_code": promotion_error_code,
                "runtime_sha256": runtime_digest,
                "smoke_rejected_empty_state": True,
            }
        except Exception as exc:
            payload = {
                "canonical": "failed",
                "action_method": getattr(exc, "method", None),
                "diagnostic_tail": _safe_diagnostic(exc),
                "error_code": _safe_code(exc),
                "error_type": type(exc).__name__,
                "phase": phase,
                "status_code": _safe_status(exc),
            }
        finally:
            if auditor is not None:
                try:
                    await auditor.kill()
                except Exception:
                    pass
            if builder is not None:
                try:
                    await builder.kill()
                except Exception:
                    pass
            if snapshot_id is not None and not keep_snapshot:
                try:
                    await backend.delete_snapshot(snapshot_id)
                except Exception:
                    payload["snapshot_cleanup"] = "failed"

    print(json.dumps(payload, sort_keys=True))
    return 0 if payload.get("canonical") in {"built", "already_present"} else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_bootstrap()))
