"""Desktop-only spike for a deterministic LibreOffice Calc cell oracle."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

from solari_desktop import DesktopClient


HERE = Path(__file__).resolve().parent
BASE_URL = "https://api.getsolari.com"
REMOTE_CSV = "/work/input/export.csv"
CSV_BYTES = b"account_code,customer,amount\n001234,Northstar Labs,250.00\n"
SENTINEL = "REPROLAB_CLIPBOARD_SENTINEL"

TIP_CONFIG = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Misc">
    <prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop>
  </item>
</oor:items>
"""

UNO_READ = r'''import json
import uno

local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local
)
ctx = resolver.resolve(
    "uno:socket,host=127.0.0.1,port=2002;urp;StarOffice.ComponentContext"
)
desktop = ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.frame.Desktop", ctx
)
components = desktop.getComponents().createEnumeration()
document = None
while components.hasMoreElements():
    candidate = components.nextElement()
    if candidate.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
        document = candidate
        if candidate.getURL().endswith("/export.csv"):
            break
if document is None:
    raise RuntimeError("no live Calc spreadsheet document found")

controller = document.getCurrentController()
sheet = controller.getActiveSheet()
cell = sheet.getCellRangeByName("A2")
selection = controller.getSelection().getRangeAddress()
print(json.dumps({
    "document_url": document.getURL(),
    "cell": "A2",
    "selection": {
        "start_column": selection.StartColumn,
        "start_row": selection.StartRow,
        "end_column": selection.EndColumn,
        "end_row": selection.EndRow,
    },
    "String": cell.String,
    "Value": cell.Value,
    "Formula": cell.Formula,
    "Type": str(cell.Type),
}))
'''


async def main() -> int:
    api_key = os.environ.get("SOLARI_API_KEY")
    if not api_key:
        print("BLOCKED — SOLARI_API_KEY is not set")
        return 2

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = HERE / "artifacts" / f"desktop-observation-{stamp}"
    run_dir.mkdir(parents=True, exist_ok=False)
    result: dict[str, object] = {
        "run_dir": str(run_dir),
        "controller": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
        },
        "desktop": {"created": False, "cleanup": "not-created"},
        "solari_clipboard": {"result": "not-attempted"},
        "x11_clipboard": {"result": "not-attempted"},
        "uno": {"result": "not-attempted"},
        "saved_state": {"result": "not-attempted"},
    }

    client: DesktopClient | None = None
    desktop = None
    exit_code = 2
    try:
        client = DesktopClient(api_key=api_key, base_url=BASE_URL)
        desktop = await client.create(
            template="default",
            resolution="1280x720",
            timeout_ms=10 * 60_000,
            lifecycle={"onTimeout": "kill"},
        )
        result["desktop"] = {"created": True, "cleanup": "pending"}
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
            raise RuntimeError(f"desktop did not become ready: {health_data}")

        probe = await desktop.exec(
            "sh",
            args=[
                "-lc",
                "printf 'USER=%s\\nHOME=%s\\nLANG=%s\\n' \"$USER\" \"$HOME\" \"$LANG\"; "
                "command -v libreoffice; libreoffice --version; "
                "printf 'xdotool='; command -v xdotool || true; "
                "printf 'xclip='; command -v xclip || true; "
                "printf 'xsel='; command -v xsel || true; "
                "printf 'python_uno='; python3 -c 'import uno; print(\"available\")' 2>/dev/null || echo unavailable; "
                "uname -a",
            ],
            timeout_ms=30_000,
        )
        if probe.exitCode != 0 or "LibreOffice" not in probe.stdout:
            raise RuntimeError(probe.stderr.strip() or "LibreOffice preflight failed")
        (run_dir / "environment.txt").write_text(probe.stdout, encoding="utf-8")
        version = next(
            line for line in probe.stdout.splitlines() if "LibreOffice" in line
        )
        home = next(
            line.removeprefix("HOME=")
            for line in probe.stdout.splitlines()
            if line.startswith("HOME=")
        )
        tools = {
            "xdotool": any(line.startswith("xdotool=/") for line in probe.stdout.splitlines()),
            "xclip": any(line.startswith("xclip=/") for line in probe.stdout.splitlines()),
            "xsel": any(line.startswith("xsel=/") for line in probe.stdout.splitlines()),
            "python_uno": "python_uno=available" in probe.stdout,
        }
        result["desktop"].update(  # type: ignore[union-attr]
            {"health": health_data, "libreoffice": version, "tools": tools}
        )
        if not tools["xdotool"]:
            raise RuntimeError("xdotool is unavailable; cannot establish active window state")

        await desktop.exec("mkdir", args=["-p", "/work/input"])
        await desktop.fs.write(REMOTE_CSV, CSV_BYTES)

        config_dir = f"{home}/.config/libreoffice/4/user"
        mkdir = await desktop.exec("mkdir", args=["-p", config_dir])
        if mkdir.exitCode != 0:
            raise RuntimeError(mkdir.stderr.strip() or "could not create LibreOffice config")
        await desktop.fs.write(f"{config_dir}/registrymodifications.xcu", TIP_CONFIG)
        result["tip_of_day"] = {
            "disabled": True,
            "config": "org.openoffice.Office.Common/Misc/ShowTipOfTheDay=false",
        }

        await desktop.open(
            "libreoffice",
            [
                "--norestore",
                "--nodefault",
                "--nolockcheck",
                "--accept=socket,host=127.0.0.1,port=2002;urp;StarOffice.ServiceManager",
                "--calc",
                REMOTE_CSV,
            ],
        )
        await asyncio.sleep(6)
        (run_dir / "01-launched.png").write_bytes(
            await desktop.screenshot(format="png")
        )

        # Activate the import dialog if present, then accept the default import.
        import_state = await desktop.exec(
            "sh",
            args=[
                "-lc",
                "wid=$(xdotool search --onlyvisible --name 'Text Import' | tail -1); "
                "if [ -n \"$wid\" ]; then xdotool windowactivate --sync \"$wid\"; "
                "xdotool key --clearmodifiers Return; echo accepted; else echo absent; fi",
            ],
            timeout_ms=15_000,
        )
        if import_state.exitCode != 0:
            raise RuntimeError(import_state.stderr.strip() or "CSV import dialog activation failed")
        await asyncio.sleep(6)

        # Prove the process, document window, and active title before sending keys.
        window = await desktop.exec(
            "sh",
            args=[
                "-lc",
                "pgrep -af 'soffice|libreoffice' >/tmp/reprolab-processes.txt; "
                "wid=$(xdotool search --onlyvisible --name 'export.csv.*LibreOffice Calc' | tail -1); "
                "test -n \"$wid\"; xdotool windowactivate --sync \"$wid\"; "
                "printf 'window_id=%s\\nactive_title=' \"$wid\"; "
                "xdotool getactivewindow getwindowname",
            ],
            timeout_ms=15_000,
        )
        if window.exitCode != 0 or "export.csv" not in window.stdout:
            raise RuntimeError(
                window.stderr.strip() or f"Calc document window not active: {window.stdout!r}"
            )
        process_text = await desktop.fs.read_text("/tmp/reprolab-processes.txt")
        result["window"] = {
            "process_exists": bool(process_text.strip()),
            "document_window_active": True,
            "active_title": window.stdout.split("active_title=", 1)[-1].strip(),
            "import_dialog": import_state.stdout.strip(),
        }
        (run_dir / "02-document-active.png").write_bytes(
            await desktop.screenshot(format="png")
        )

        # LibreOffice's documented Name Box shortcut: Ctrl+Shift+F5.
        target = await desktop.exec(
            "sh",
            args=[
                "-lc",
                "wid=$(xdotool search --onlyvisible --name 'export.csv.*LibreOffice Calc' | tail -1); "
                "xdotool windowactivate --sync \"$wid\"; "
                "xdotool key --clearmodifiers ctrl+shift+F5; "
                "xdotool type --clearmodifiers --delay 100 A2; "
                "xdotool key --clearmodifiers Return",
            ],
            timeout_ms=15_000,
        )
        if target.exitCode != 0:
            raise RuntimeError(target.stderr.strip() or "Name Box targeting failed")
        await asyncio.sleep(2)
        result["target"] = {"cell": "A2", "method": "Calc Name Box Ctrl+Shift+F5"}

        # Attempt 1: Solari clipboard after an OS-targeted Ctrl+C.
        await desktop.clipboard.set(SENTINEL)
        copy = await desktop.exec(
            "sh",
            args=[
                "-lc",
                "wid=$(xdotool search --onlyvisible --name 'export.csv.*LibreOffice Calc' | tail -1); "
                "xdotool windowactivate --sync \"$wid\"; "
                "xdotool key --clearmodifiers ctrl+c",
            ],
            timeout_ms=15_000,
        )
        if copy.exitCode != 0:
            raise RuntimeError(copy.stderr.strip() or "Calc copy command failed")
        await asyncio.sleep(2)
        solari_value = (await desktop.clipboard.get()).strip()
        result["solari_clipboard"] = {
            "result": "pass" if solari_value != SENTINEL else "fail",
            "sentinel_changed": solari_value != SENTINEL,
            "observed": solari_value if solari_value != SENTINEL else None,
        }

        # Attempt 2: read the X11 CLIPBOARD selection directly, if a tool exists.
        if tools["xclip"] or tools["xsel"]:
            read_command = (
                "timeout 5 xclip -selection clipboard -o"
                if tools["xclip"]
                else "timeout 5 xsel --clipboard --output"
            )
            x11 = await desktop.exec("sh", args=["-lc", read_command], timeout_ms=10_000)
            x11_value = x11.stdout.strip() if x11.exitCode == 0 else ""
            result["x11_clipboard"] = {
                "available": "xclip" if tools["xclip"] else "xsel",
                "result": "pass" if x11.exitCode == 0 and bool(x11_value) else "fail",
                "observed": x11_value or None,
                "error": x11.stderr.strip() or None,
            }
        else:
            result["x11_clipboard"] = {
                "available": None,
                "result": "not-available",
                "observed": None,
            }

        # Attempt 3: inspect A2 in the live GUI-opened Calc document via UNO.
        if tools["python_uno"]:
            uno_result = await desktop.exec(
                "python3", args=["-c", UNO_READ], timeout_ms=20_000
            )
            if uno_result.exitCode == 0:
                uno_data = json.loads(uno_result.stdout)
                selected = uno_data["selection"] == {
                    "start_column": 0,
                    "start_row": 1,
                    "end_column": 0,
                    "end_row": 1,
                }
                result["uno"] = {
                    "available": True,
                    "result": "pass" if selected else "fail",
                    "connection": "localhost UNO socket to running GUI LibreOffice",
                    **uno_data,
                }
            else:
                result["uno"] = {
                    "available": True,
                    "result": "fail",
                    "error": uno_result.stderr.strip() or uno_result.stdout.strip(),
                }
        else:
            result["uno"] = {"available": False, "result": "not-available"}

        (run_dir / "03-a2-selected.png").write_bytes(
            await desktop.screenshot(format="png")
        )

        uno_ok = result["uno"].get("result") == "pass"  # type: ignore[union-attr]
        clip_ok = result["solari_clipboard"].get("result") == "pass"  # type: ignore[union-attr]
        x11_ok = result["x11_clipboard"].get("result") == "pass"  # type: ignore[union-attr]
        if uno_ok or clip_ok or x11_ok:
            result["status"] = "pass"
            result["recommended_oracle"] = (
                "uno" if uno_ok else "solari_clipboard" if clip_ok else "x11_clipboard"
            )
            exit_code = 0
        else:
            result["status"] = "blocked"
            result["blocker"] = "LIBREOFFICE MACHINE OBSERVATION"
    except Exception as exc:
        result["status"] = "blocked"
        result["blocker"] = f"{type(exc).__name__}: {exc}"
    finally:
        if desktop is not None and client is not None:
            try:
                await client.destroy(desktop.sessionId)
                result["desktop"]["cleanup"] = "destroyed"  # type: ignore[index]
            except Exception as exc:
                result["desktop"]["cleanup"] = f"failed: {type(exc).__name__}: {exc}"  # type: ignore[index]
                try:
                    await desktop.kill()
                    result["desktop"]["cleanup"] += "; fallback kill succeeded"  # type: ignore[index,operator]
                except Exception:
                    pass
            try:
                await desktop.close()
            except Exception:
                pass
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass
        result_path = run_dir / "result.json"
        result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        print(f"result: {result_path}")
        print(result.get("status", "blocked").upper())

    return exit_code


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
