"""Turns a run's transcript + findings into a single markdown report."""

from __future__ import annotations

import datetime
import pathlib


def write_report(
    out_dir: pathlib.Path,
    target_url: str,
    result: dict,
    transcript: list[dict],
) -> pathlib.Path:
    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = out_dir / f"report-{timestamp}.md"

    lines: list[str] = []
    lines.append(f"# Sentinel report - {target_url}")
    lines.append("")
    lines.append(f"- **Generated:** {datetime.datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"- **Severity:** {result.get('severity', 'none')}")

    challenge = result.get("challenge")
    if challenge:
        verified = result.get("challenge_verified")
        verified_str = (
            "ERROR - " + result.get("challenge_verify_error", "")
            if verified is None
            else ("YES" if verified else "NO")
        )
        lines.append(
            f"- **Objective:** [{challenge['difficulty']}★] {challenge['name']} "
            f"({challenge['category']})"
        )
        lines.append(
            f"- **Independently verified solved (fresh GET /api/Challenges, not "
            f"self-reported):** {verified_str}"
        )

    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(result.get("summary") or "(no summary provided)")
    lines.append("")
    lines.append("## Proof")
    lines.append("")
    lines.append(result.get("proof") or "(none)")
    lines.append("")

    lines.append("## Investigation transcript")
    lines.append("")
    for entry in transcript:
        role = entry.get("role")
        if role == "assistant":
            lines.append(f"**Sentinel:** {entry['text']}")
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
