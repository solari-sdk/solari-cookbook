"""Prove the ReproLab Browser -> Sandbox -> Desktop byte pipeline."""

from __future__ import annotations

import asyncio
import csv
import hashlib
import importlib.metadata
import io
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from solari_browser import Solari
from solari_desktop import DesktopClient
from solari_sandbox import SandboxClient


HERE = Path(__file__).resolve().parent
EXPECTED_VALUE = "001234"
REMOTE_PATH = "/work/input/export.csv"
BASE_URL = "https://api.getsolari.com"


class GateBlocked(RuntimeError):
    def __init__(self, gate: str, detail: str) -> None:
        super().__init__(detail)
        self.gate = gate


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for package in ("solari-browser", "solari-sandbox", "solari-desktop"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "not-installed"
    return versions


async def run() -> int:
    api_key = os.environ.get("SOLARI_API_KEY")
    if not api_key:
        print("BLOCKED — SOLARI REMOTE BROWSER DOWNLOAD")
        print("SOLARI_API_KEY is not set; no mocked or local-browser fallback was used.")
        print(json.dumps({"sdk_versions": package_versions()}, indent=2))
        return 2

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = HERE / "artifacts" / f"run-{stamp}"
    browser_dir = run_dir / "browser"
    sandbox_dir = run_dir / "sandbox"
    desktop_dir = run_dir / "desktop"
    for directory in (browser_dir, sandbox_dir, desktop_dir):
        directory.mkdir(parents=True, exist_ok=False)

    result: dict[str, object] = {
        "run_dir": str(run_dir),
        "sdk_versions": package_versions(),
        "controller": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
        },
        "browser": {"used": False, "cleanup": "not-created"},
        "sandbox": {"used": False, "cleanup": "not-created"},
        "desktop": {"used": False, "cleanup": "not-created"},
    }

    solari: Solari | None = None
    browser = None
    sandbox_client: SandboxClient | None = None
    sandbox = None
    desktop_client: DesktopClient | None = None
    desktop = None
    blocked: GateBlocked | None = None

    try:
        # Gate 1: the download must come through a real Solari Browser.
        try:
            solari = Solari(api_key=api_key)
            browser = await solari.launch()
            result["browser"] = {
                "used": True,
                "session_id": browser.id,
                "cleanup": "pending",
            }
            page = await browser.new_page()
            fixture_html = (HERE / "fixture.html").read_text(encoding="utf-8")
            await page.goto("data:text/html;charset=utf-8," + quote(fixture_html))
            await page.locator("text=001234").wait_for()

            async with page.expect_download(timeout=30_000) as download_info:
                await page.locator("#export").click()
            download = await download_info.value
            filename = download.suggested_filename or "export.csv"
            artifact_path = browser_dir / filename
            await download.save_as(artifact_path)
            await page.screenshot(path=str(browser_dir / "browser.png"), full_page=True)

            artifact = artifact_path.read_bytes()
            h1 = sha256(artifact)
            rows = list(csv.DictReader(io.StringIO(artifact.decode("utf-8"))))
            if EXPECTED_VALUE.encode() not in artifact:
                raise GateBlocked(
                    "SOLARI REMOTE BROWSER DOWNLOAD",
                    "download.save_as() returned bytes without literal 001234",
                )
            result["browser"].update(  # type: ignore[union-attr]
                {
                    "download_save_as": "pass",
                    "filename": filename,
                    "bytes": len(artifact),
                    "sha256": h1,
                    "debug_rows": rows,
                    "screenshot": str(browser_dir / "browser.png"),
                }
            )
        except GateBlocked:
            raise
        except Exception as exc:
            raise GateBlocked(
                "SOLARI REMOTE BROWSER DOWNLOAD",
                f"{type(exc).__name__}: {exc}",
            ) from exc
        finally:
            if browser is not None:
                try:
                    await browser.close()
                    result["browser"]["cleanup"] = "released"  # type: ignore[index]
                except Exception as exc:
                    result["browser"]["cleanup"] = f"failed: {type(exc).__name__}: {exc}"  # type: ignore[index]
            if solari is not None:
                try:
                    await solari.close()
                except Exception:
                    pass

        # Gate 2: upload the canonical browser bytes and inspect them remotely.
        try:
            sandbox_client = SandboxClient(api_key=api_key, base_url=BASE_URL)
            sandbox = await sandbox_client.create(
                template="base",
                timeout_ms=5 * 60_000,
                lifecycle={"onTimeout": "kill"},
            )
            result["sandbox"] = {
                "used": True,
                "session_id": sandbox.sandboxId,
                "cleanup": "pending",
            }
            await sandbox.connect()
            await sandbox.commands.run("mkdir", args=["-p", "/work/input"])
            await sandbox.files.write(REMOTE_PATH, artifact)

            analyzer = r'''import csv, hashlib, json
from pathlib import Path
p = Path("/work/input/export.csv")
data = p.read_bytes()
with p.open("r", encoding="utf-8", newline="") as f:
    row = next((r for r in csv.DictReader(f) if r["customer"] == "Northstar Labs"), None)
raw = row["account_code"] if row else None
analysis = {
    "hash": hashlib.sha256(data).hexdigest(),
    "row_found": row is not None,
    "raw_value": raw,
    "expected_value": "001234",
    "matches": raw == "001234",
}
Path("/work/input/analysis.json").write_text(json.dumps(analysis, indent=2) + "\n")
print(json.dumps(analysis))
'''
            command = await sandbox.commands.run(
                "python3", args=["-c", analyzer], timeout_ms=30_000
            )
            if command.exitCode != 0:
                raise RuntimeError(command.stderr.strip() or "sandbox analyzer failed")
            analysis_bytes = await sandbox.files.read("/work/input/analysis.json")
            (sandbox_dir / "analysis.json").write_bytes(analysis_bytes)
            analysis = json.loads(analysis_bytes)
            h2 = analysis["hash"]
            result["sandbox"].update(  # type: ignore[union-attr]
                {"transfer": "pass", "sha256": h2, "analysis": analysis}
            )
            if h2 != h1 or not analysis["matches"]:
                raise GateBlocked(
                    "SANDBOX ARTIFACT TRANSFER",
                    f"expected hash {h1}, received {h2}; analysis={analysis}",
                )
        except GateBlocked:
            raise
        except Exception as exc:
            raise GateBlocked(
                "SANDBOX ARTIFACT TRANSFER", f"{type(exc).__name__}: {exc}"
            ) from exc
        finally:
            if sandbox is not None:
                try:
                    await sandbox.kill()
                    result["sandbox"]["cleanup"] = "killed"  # type: ignore[index]
                except Exception as exc:
                    result["sandbox"]["cleanup"] = f"failed: {type(exc).__name__}: {exc}"  # type: ignore[index]
                try:
                    await sandbox.close()
                except Exception:
                    pass
            if sandbox_client is not None:
                try:
                    await sandbox_client.aclose()
                except Exception:
                    pass

        # Gate 3: Desktop readiness, LibreOffice, and byte identity.
        try:
            desktop_client = DesktopClient(api_key=api_key, base_url=BASE_URL)
            desktop = await desktop_client.create(
                template="default",
                resolution="1280x720",
                timeout_ms=10 * 60_000,
                lifecycle={"onTimeout": "kill"},
            )
            result["desktop"] = {
                "used": True,
                "session_id": desktop.sessionId,
                "cleanup": "pending",
            }
            await desktop.connect()
            ready = False
            health_data: dict[str, object] = {}
            for _ in range(60):
                health = await desktop.health()
                health_data = {
                    "ready": bool(getattr(health, "ready", False)),
                    "display": bool(getattr(health, "display", False)),
                    "vnc": bool(getattr(health, "vnc", False)),
                }
                if health_data["ready"] and health_data["display"]:
                    ready = True
                    break
                await asyncio.sleep(1)
            if not ready:
                raise RuntimeError(f"desktop did not become ready: {health_data}")

            probe = await desktop.exec(
                "sh",
                args=[
                    "-lc",
                    "command -v libreoffice && libreoffice --version && uname -a && printf '\\nLANG=%s\\n' \"$LANG\"",
                ],
                timeout_ms=30_000,
            )
            if probe.exitCode != 0:
                raise RuntimeError(probe.stderr.strip() or "LibreOffice probe failed")
            (desktop_dir / "environment.txt").write_text(
                probe.stdout, encoding="utf-8"
            )
            version_line = next(
                (line for line in probe.stdout.splitlines() if "LibreOffice" in line),
                "unknown",
            )
            await desktop.exec("mkdir", args=["-p", "/work/input"])
            await desktop.fs.write(REMOTE_PATH, artifact)
            remote_hash = await desktop.exec("sha256sum", args=[REMOTE_PATH])
            if remote_hash.exitCode != 0:
                raise RuntimeError(remote_hash.stderr.strip() or "desktop sha256sum failed")
            h3 = remote_hash.stdout.split()[0]
            result["desktop"].update(  # type: ignore[union-attr]
                {
                    "ready": True,
                    "health": health_data,
                    "libreoffice": version_line,
                    "environment": probe.stdout,
                    "transfer": "pass",
                    "sha256": h3,
                }
            )
            if not (h1 == h2 == h3):
                raise GateBlocked(
                    "DESKTOP PREFLIGHT", f"hash mismatch: H1={h1}, H2={h2}, H3={h3}"
                )
        except GateBlocked:
            raise
        except Exception as exc:
            raise GateBlocked(
                "DESKTOP PREFLIGHT", f"{type(exc).__name__}: {exc}"
            ) from exc

        # Gate 4: default CSV import, keyboard-only cell selection, clipboard read.
        try:
            await desktop.clipboard.set("REPROLAB_CLIPBOARD_SENTINEL")
            await desktop.open("libreoffice", ["--calc", REMOTE_PATH])
            await asyncio.sleep(8)
            # CSV files open the Text Import dialog. Enter accepts its defaults.
            await desktop.keyboard.press("Return")
            await asyncio.sleep(6)
            # A1 is the header; Ctrl+Home then Down deterministically selects A2.
            await desktop.keyboard.hotkey("ctrl", "home")
            await desktop.keyboard.press("ArrowDown")
            await desktop.keyboard.hotkey("ctrl", "c")
            await asyncio.sleep(2)
            clipboard_raw = await desktop.clipboard.get()
            desktop_value = clipboard_raw.strip()
            screenshot = desktop_dir / "selected-cell.png"
            screenshot.write_bytes(await desktop.screenshot(format="png"))
            if not desktop_value or desktop_value == "REPROLAB_CLIPBOARD_SENTINEL":
                raise RuntimeError(f"clipboard did not receive selected cell: {clipboard_raw!r}")
            result["desktop"].update(  # type: ignore[union-attr]
                {
                    "csv_opened": True,
                    "target_cell": "A2",
                    "clipboard_raw": clipboard_raw,
                    "desktop_value": desktop_value,
                    "expected_value": EXPECTED_VALUE,
                    "screenshot": str(screenshot),
                }
            )
        except Exception as exc:
            raise GateBlocked(
                "DESKTOP OBSERVATION", f"{type(exc).__name__}: {exc}"
            ) from exc

    except GateBlocked as exc:
        blocked = exc
        result["blocked"] = {"gate": exc.gate, "detail": str(exc)}
    finally:
        if desktop is not None and desktop_client is not None:
            try:
                await desktop_client.destroy(desktop.sessionId)
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
        if desktop_client is not None:
            try:
                await desktop_client.aclose()
            except Exception:
                pass

        result_path = run_dir / "result.json"
        result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        print(f"result: {result_path}")

    if blocked is not None:
        print(f"BLOCKED — {blocked.gate}")
        print(str(blocked))
        return 2

    print("PASS")
    print(f"H1: {h1}")
    print(f"H2: {h2}")
    print(f"H3: {h3}")
    print(f"MATCH: {h1 == h2 == h3}")
    print(f"Observed transformation: {EXPECTED_VALUE} -> {desktop_value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
