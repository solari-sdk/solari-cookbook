"""Turns a run's transcript + outcome into a single markdown report."""

from __future__ import annotations

import datetime
import pathlib


def write_report(
    out_dir: pathlib.Path,
    task: str,
    result: dict,
    transcript: list[dict],
) -> pathlib.Path:
    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = out_dir / f"report-{timestamp}.md"

    lines: list[str] = []
    lines.append("# Forge report")
    lines.append("")
    lines.append(f"- **Generated:** {datetime.datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"- **Success (self-reported):** {result.get('success')}")

    verification = result.get("verification")
    if verification and verification.get("checked"):
        if verification.get("reachable"):
            contains = verification.get("contains_expected")
            contains_str = "n/a (no substring given)" if contains is None else ("YES" if contains else "NO")
            lines.append(
                f"- **Independently verified (fresh HTTP request from outside the "
                f"sandbox, not self-reported):** reachable=YES, "
                f"status={verification.get('status')}, contains_expected={contains_str}"
            )
        else:
            lines.append(
                f"- **Independently verified:** reachable=NO ({verification.get('error')})"
            )

    lines.append("")
    lines.append("## Task")
    lines.append("")
    lines.append(task)
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(result.get("summary") or "(no summary provided)")
    lines.append("")
    lines.append("## Proof")
    lines.append("")
    lines.append(result.get("proof") or "(none)")
    lines.append("")

    if verification and verification.get("checked") and verification.get("body_snippet"):
        lines.append("## Independent verification response snippet")
        lines.append("")
        lines.append("```")
        lines.append(verification["body_snippet"])
        lines.append("```")
        lines.append("")

    lines.append("## Run transcript")
    lines.append("")
    for entry in transcript:
        role = entry.get("role")
        if role == "assistant":
            lines.append(f"**Forge:** {entry['text']}")
        elif role == "tool_call":
            lines.append(f"- `{entry['name']}({entry['input']})`")
        elif role == "tool_result":
            content = str(entry["content"])
            if len(content) > 500:
                content = content[:500] + "... (truncated)"
            lines.append(f"  -> {content}")
        lines.append("")

    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path
