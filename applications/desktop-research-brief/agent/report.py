"""Report: findings -> cited Markdown brief -> written in a desktop editor -> saved on the VM -> verified.

Composition is a text-only model call (synthesis, not perception). Writing goes through the GUI as
the use-case demands (Mousepad, clipboard paste, Ctrl+S, GTK save dialog), and is verified
model-free at both ends: editor contents read back via clipboard, saved file read back via
desktop.files. If the GUI save is not verified, the file is written via the SDK and the log says so.

Security: the output path is /root/reports/<slug>-<timestamp>.md where slug is [a-z0-9-] only.
Nothing derived from web content ever becomes a path.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from .actuator import Actuator
from .brain import Brain
from .memory import Memory
from .session import log

VM_REPORT_DIR = "/root/reports"

REPORT_TOOL: dict[str, Any] = {
    "name": "write_brief",
    "description": "Return the finished research brief as Markdown.",
    "input_schema": {
        "type": "object",
        "properties": {"markdown": {"type": "string", "description": "The complete brief in Markdown."}},
        "required": ["markdown"],
    },
}

REPORT_TEMPLATE = """Write a research brief on {target} for engineers who build computer-use agents. Date: {today}.

Use ONLY the numbered findings below. Do not add outside knowledge. Every factual sentence ends with one or
more citations like [3] referring to the numbered sources. Where findings are low-confidence or conflict, say so.
Plain, specific prose. No marketing tone. 600-900 words.

Structure (Markdown):
# {target} - Research Brief
## Summary
## Problem they are solving
## Approach and thesis
## Products and technical signals
## Team and hiring signals
## Funding and news
## Open questions
(3-6 bullets: what the sources do NOT answer)
## Implications for computer-use agent builders
(3-5 bullets grounded in the findings)
## Sources
(numbered list, one exact URL per line, same numbering as the citations)

End with this exact line:
_Generated autonomously by a Solari Desktop computer-use agent on {today}: {n_findings} findings from {n_sources} sources, screenshot-driven browsing, no DOM access._

Findings (source number in brackets):
{findings}

Sources:
{sources}"""


@dataclass
class WriteResult:
    vm_path: str
    local_path: Path
    pasted_verified: bool
    gui_save_verified: bool
    download_url: str | None


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "target"


def _norm(text: str) -> str:
    return "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").strip().splitlines())


async def compose_brief(brain: Brain, mem: Memory) -> str:
    sources = mem.sources()
    findings = "\n".join(
        f"- [{sources.index(f.source_url) + 1}] ({f.category}, {f.confidence}) {f.fact}" for f in mem.findings
    )
    prompt = REPORT_TEMPLATE.format(
        target=mem.target, today=date.today().isoformat(), findings=findings,
        sources="\n".join(f"[{i + 1}] {u}" for i, u in enumerate(sources)),
        n_findings=len(mem.findings), n_sources=len(sources),
    )
    resp = await brain.call(
        max_tokens=4000,
        tools=[REPORT_TOOL],
        tool_choice={"type": "tool", "name": "write_brief"},
        messages=[{"role": "user", "content": prompt}],
    )
    md = str(brain.tool_input(resp, "write_brief").get("markdown", "")).strip()
    if len(md) < 800:
        raise RuntimeError(f"brief suspiciously short ({len(md)} chars)")
    return md + "\n"


async def write_on_desktop(desktop, act: Actuator, mem: Memory, markdown: str) -> WriteResult:
    filename = f"{slug(mem.target)}-{datetime.now().strftime('%Y%m%d-%H%M')}.md"
    vm_path = f"{VM_REPORT_DIR}/{filename}"
    local_path = mem.run_dir / "brief.md"
    local_path.write_text(markdown, encoding="utf-8")  # local copy first: the deliverable exists before any GUI step

    await desktop.exec("mkdir", args=["-p", VM_REPORT_DIR])

    # 1. Editor up, maximised, focused in the text area (the root-account warning banner sits at the top).
    pid = await desktop.open("mousepad")
    log(f"opened mousepad pid={pid}")
    await asyncio.sleep(4)
    await act.maximize_active()
    await act.click(act.width // 2, act.height // 2)
    await asyncio.sleep(0.5)

    # 2. Paste the whole brief in one keystroke, then verify the editor holds exactly that text.
    await act.paste(markdown)
    await asyncio.sleep(1.5)
    obs = await act.observe()
    mem.log_step("write", "paste(brief)", frame=act.last_frame, digest=obs.digest, note=f"{len(markdown)} chars")
    editor_text = await act.read_focused_text()
    pasted_ok = _norm(editor_text) == _norm(markdown)
    log(f"editor contents verified: {pasted_ok} ({len(editor_text)} chars read back)")
    await act.key("ctrl+End")  # deselect, cursor to end

    # 3. Save via the GUI: Ctrl+S opens GTK's dialog with the name field focused; an absolute path is accepted.
    await act.key("ctrl+s")
    await act.wait_settled(timeout_s=8)
    await act.type(vm_path)
    await asyncio.sleep(0.5)
    await act.key("Return")
    obs = await act.wait_settled(timeout_s=8)
    mem.log_step("write", f"save({vm_path})", frame=act.last_frame, digest=obs.digest)

    # 4. Verify the file on the VM, model-free. Fall back to a direct write and say so.
    saved: str | None = None
    try:
        saved = await desktop.files.read_text(vm_path)
    except Exception as e:  # noqa: BLE001
        log(f"read-back failed: {type(e).__name__}: {e}")
    gui_ok = saved is not None and _norm(saved) == _norm(markdown)
    log(f"GUI save verified: {gui_ok}")
    if not gui_ok:
        log("writing the file directly via desktop.files as a fallback (GUI save did not verify)")
        await desktop.files.write(vm_path, markdown)
        mem.log_step("write", f"files.write({vm_path})", note="fallback")

    url: str | None = None
    try:
        url = (await desktop.download_url(vm_path)).get("url")
    except Exception as e:  # noqa: BLE001
        log(f"download_url unavailable: {type(e).__name__}: {e}")

    return WriteResult(vm_path, local_path, pasted_ok, gui_ok, url)