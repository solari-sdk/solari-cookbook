"""LibreOffice observation in a real Solari Desktop."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from uuid import uuid4

from solari_desktop import DesktopClient

from .models import (
    ArtifactRecord,
    CleanupRecord,
    DesktopObservation,
    RunSpec,
    redact_identifier,
    utc_now,
)

BASE_URL = "https://api.getsolari.com"
REMOTE_ARTIFACT = "/work/input/export.csv"
TIP_CONFIG = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Misc">
    <prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop>
  </item>
</oor:items>
"""


async def run_desktop(
    spec: RunSpec,
    artifact: ArtifactRecord,
    *,
    api_key: str,
    bundle_dir: Path,
    cleanup: list[CleanupRecord],
) -> DesktopObservation:
    output_dir = bundle_dir / "desktop"
    output_dir.mkdir(parents=True, exist_ok=True)
    actions_path = output_dir / "actions.jsonl"

    def action(name: str, *, succeeded: bool, detail: str = "") -> None:
        with actions_path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "timestamp": utc_now(),
                        "action": name,
                        "succeeded": succeeded,
                        "detail": detail,
                    },
                    sort_keys=True,
                )
                + "\n"
            )

    client = DesktopClient(api_key=api_key, base_url=BASE_URL)
    desktop = None
    cleanup_record: CleanupRecord | None = None
    try:
        desktop = await client.create(
            template="default",
            resolution="1280x720",
            timeout_ms=10 * 60_000,
            lifecycle={"onTimeout": "kill"},
        )
        cleanup_record = CleanupRecord(
            resource_type="desktop",
            resource_id=redact_identifier(desktop.sessionId) or "unavailable",
        )
        cleanup.append(cleanup_record)
        await desktop.connect()

        health_data: dict[str, object] = {}
        for _ in range(60):
            health = await desktop.health()
            health_data = {
                "ready": bool(getattr(health, "ready", False)),
                "display": bool(getattr(health, "display", False)),
                "vnc": bool(getattr(health, "vnc", False)),
            }
            if health_data["ready"] and health_data["display"]:
                break
            await asyncio.sleep(1)
        else:
            action("wait_for_desktop", succeeded=False, detail=str(health_data))
            raise RuntimeError(f"desktop did not become ready: {health_data}")
        action("wait_for_desktop", succeeded=True)

        probe = await desktop.exec(
            "sh",
            args=[
                "-lc",
                (
                    'printf \'USER=%s\\nHOME=%s\\nLANG=%s\\n\' "$USER" "$HOME" "$LANG"; '
                    "command -v libreoffice; libreoffice --version; "
                    "printf 'xdotool='; command -v xdotool || true; "
                    "printf 'xclip='; command -v xclip || true; uname -a"
                ),
            ],
            timeout_ms=30_000,
        )
        if probe.exitCode != 0 or "LibreOffice" not in probe.stdout:
            action("libreoffice_preflight", succeeded=False, detail=probe.stderr.strip())
            raise RuntimeError(probe.stderr.strip() or "LibreOffice preflight failed")
        version = next(line for line in probe.stdout.splitlines() if "LibreOffice" in line)
        home = next(
            line.removeprefix("HOME=")
            for line in probe.stdout.splitlines()
            if line.startswith("HOME=")
        )
        xdotool_available = any(line.startswith("xdotool=/") for line in probe.stdout.splitlines())
        xclip_available = any(line.startswith("xclip=/") for line in probe.stdout.splitlines())
        if not xdotool_available:
            raise RuntimeError("xdotool is required by the V1 LibreOffice recipe")
        environment = {
            "template": "default",
            "resolution": "1280x720",
            "health": health_data,
            "libreoffice_version": version,
            "xclip_available": xclip_available,
            "system": probe.stdout,
        }
        (output_dir / "environment.json").write_text(
            json.dumps(environment, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        action("libreoffice_preflight", succeeded=True, detail=version)

        await desktop.exec("mkdir", args=["-p", "/work/input"])
        await desktop.fs.write(REMOTE_ARTIFACT, artifact.content)
        remote_hash = await desktop.exec("sha256sum", args=[REMOTE_ARTIFACT], timeout_ms=15_000)
        if remote_hash.exitCode != 0:
            raise RuntimeError(remote_hash.stderr.strip() or "desktop sha256sum failed")
        desktop_hash = remote_hash.stdout.split()[0]
        hash_matches = desktop_hash == artifact.sha256
        (output_dir / "artifact-hash.txt").write_text(desktop_hash + "\n", encoding="utf-8")
        action("verify_artifact_hash", succeeded=hash_matches, detail=desktop_hash)
        if not hash_matches:
            raise RuntimeError("desktop artifact hash does not match canonical artifact")

        config_dir = f"{home}/.config/libreoffice/4/user"
        config_mkdir = await desktop.exec("mkdir", args=["-p", config_dir])
        if config_mkdir.exitCode != 0:
            raise RuntimeError(config_mkdir.stderr.strip() or "LibreOffice config mkdir failed")
        await desktop.fs.write(f"{config_dir}/registrymodifications.xcu", TIP_CONFIG)
        action("disable_tip_of_the_day", succeeded=True)

        await desktop.open(
            "libreoffice",
            ["--norestore", "--nodefault", "--nolockcheck", "--calc", REMOTE_ARTIFACT],
        )
        await asyncio.sleep(6)
        action("open_calc", succeeded=True)

        import_search = await desktop.exec(
            "xdotool", args=["search", "--onlyvisible", "--name", "Text Import"], timeout_ms=10_000
        )
        if import_search.exitCode == 0 and import_search.stdout.strip():
            import_window = import_search.stdout.splitlines()[-1]
            activate = await desktop.exec(
                "xdotool", args=["windowactivate", "--sync", import_window], timeout_ms=10_000
            )
            accept = await desktop.exec(
                "xdotool", args=["key", "--clearmodifiers", "Return"], timeout_ms=10_000
            )
            if activate.exitCode != 0 or accept.exitCode != 0:
                raise RuntimeError("could not activate and accept the CSV import dialog")
            action("accept_csv_import", succeeded=True)
        else:
            action("accept_csv_import", succeeded=True, detail="dialog not present")
        await asyncio.sleep(6)

        processes = await desktop.exec(
            "pgrep", args=["-af", "soffice|libreoffice"], timeout_ms=10_000
        )
        if processes.exitCode != 0 or not processes.stdout.strip():
            raise RuntimeError("LibreOffice process is not running")
        window_search = await desktop.exec(
            "xdotool",
            args=["search", "--onlyvisible", "--name", "export.csv.*LibreOffice Calc"],
            timeout_ms=10_000,
        )
        if window_search.exitCode != 0 or not window_search.stdout.strip():
            raise RuntimeError("expected export.csv Calc window was not found")
        window_id = window_search.stdout.splitlines()[-1]
        activate = await desktop.exec(
            "xdotool", args=["windowactivate", "--sync", window_id], timeout_ms=10_000
        )
        title = await desktop.exec(
            "xdotool", args=["getactivewindow", "getwindowname"], timeout_ms=10_000
        )
        active_window_verified = (
            activate.exitCode == 0
            and title.exitCode == 0
            and "export.csv" in title.stdout
            and "LibreOffice Calc" in title.stdout
        )
        action(
            "verify_active_calc_window",
            succeeded=active_window_verified,
            detail=title.stdout.strip(),
        )
        if not active_window_verified:
            raise RuntimeError(f"wrong active window: {title.stdout.strip()!r}")

        target_steps = [
            ["key", "--clearmodifiers", "ctrl+shift+F5"],
            ["type", "--clearmodifiers", "--delay", "100", spec.target_cell],
            ["key", "--clearmodifiers", "Return"],
        ]
        selection_verified = True
        for args in target_steps:
            step = await desktop.exec("xdotool", args=args, timeout_ms=10_000)
            selection_verified = selection_verified and step.exitCode == 0
        action("select_target_cell", succeeded=selection_verified, detail=spec.target_cell)
        if not selection_verified:
            raise RuntimeError(f"could not select target cell {spec.target_cell}")
        await asyncio.sleep(2)

        sentinel = f"REPROLAB_{uuid4().hex}_SENTINEL"
        await desktop.clipboard.set(sentinel)
        copy = await desktop.exec(
            "xdotool", args=["key", "--clearmodifiers", "ctrl+c"], timeout_ms=10_000
        )
        if copy.exitCode != 0:
            raise RuntimeError("Calc copy command failed")
        await asyncio.sleep(2)
        solari_value = (await desktop.clipboard.get()).strip()
        sentinel_changed = bool(solari_value) and solari_value != sentinel
        action("read_solari_clipboard", succeeded=sentinel_changed)

        x11_value: str | None = None
        if xclip_available:
            x11 = await desktop.exec(
                "xclip", args=["-selection", "clipboard", "-o"], timeout_ms=10_000
            )
            if x11.exitCode == 0:
                x11_value = x11.stdout.strip()
            action("read_x11_clipboard", succeeded=bool(x11_value))
        observations_agree = not xclip_available or (bool(x11_value) and x11_value == solari_value)
        (output_dir / "clipboard.txt").write_text(
            f"solari={solari_value}\nx11={x11_value or ''}\n", encoding="utf-8"
        )

        screenshot_path = output_dir / "selected-cell.png"
        screenshot_path.write_bytes(await desktop.screenshot(format="png"))
        action("capture_screenshot", succeeded=True)
        return DesktopObservation(
            artifact_hash=desktop_hash,
            hash_matches=hash_matches,
            libreoffice_version=version,
            active_window_verified=active_window_verified,
            target_cell=spec.target_cell,
            selection_verified=selection_verified,
            clipboard_sentinel_changed=sentinel_changed,
            solari_clipboard_value=solari_value if sentinel_changed else None,
            x11_available=xclip_available,
            x11_clipboard_value=x11_value,
            observations_agree=observations_agree,
            screenshot="desktop/selected-cell.png",
            environment=environment,
        )
    finally:
        if desktop is not None and cleanup_record is not None:
            cleanup_record.cleanup_attempted = True
            try:
                await client.destroy(desktop.sessionId)
                cleanup_record.cleanup_succeeded = True
            except Exception as exc:  # noqa: BLE001 - cleanup evidence must survive
                cleanup_record.cleanup_error = f"{type(exc).__name__}: {exc}"
                try:
                    await desktop.kill()
                    cleanup_record.cleanup_succeeded = True
                except Exception as fallback_exc:  # noqa: BLE001 - preserve both cleanup errors
                    cleanup_record.cleanup_error += (
                        f"; fallback kill: {type(fallback_exc).__name__}: {fallback_exc}"
                    )
            try:
                await desktop.close()
            except Exception as close_exc:  # noqa: BLE001 - remote cleanup outcome is already known
                cleanup_record.cleanup_error = (
                    (cleanup_record.cleanup_error + "; ") if cleanup_record.cleanup_error else ""
                ) + f"local close: {type(close_exc).__name__}: {close_exc}"
        await client.aclose()
