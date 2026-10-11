"""Deskbot - an autonomous, vision-free GUI automation agent. Drives a real
Linux desktop (mousepad, thunar, Chrome, VS Code, LibreOffice - whatever the
'default' template ships) blind: known coordinates + keyboard, no
screenshots. Verifies its own work the only way it can without vision -
reading real files back with `shell`.

Driven by a Mistral model via AWS Bedrock (same setup as qa-agent/code-agent
- see deskbot/README.md for why not Claude, and why no vision here at all).

Usage:
    python main.py
    python main.py --task "Open mousepad, write 'hello world', save it as /root/hello.txt"
"""

from __future__ import annotations

import argparse
import asyncio
import os
import pathlib
import sys

from dotenv import load_dotenv

# Windows consoles default to cp1252; keep output encoding-safe like qa-agent.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from agent.orchestrator import Orchestrator
from agent.report import write_report
from agent.verify import verify_file

load_dotenv()

DEFAULT_TASK = (
    "Open mousepad. Click into its text area and type this exact three-line "
    "changelog note:\nAdded: dark mode toggle\nFixed: crash on empty search\n"
    "Improved: startup time by 40%\nSave the file as /root/changelog.txt using "
    "mousepad's own Save dialog (Ctrl+Shift+S), not by writing the file "
    "directly with shell - the point is to prove the GUI save worked. Then "
    "use `shell` to `cat /root/changelog.txt` and confirm it contains exactly "
    "what you typed before calling finish. Set file_path to /root/changelog.txt "
    "and expected_content to the exact three lines above."
)


async def run(task: str, max_steps: int) -> None:
    solari_key = os.environ["SOLARI_API_KEY"]
    aws_region = os.environ["AWS_REGION"]
    bedrock_model_id = os.environ.get("BEDROCK_MODEL_ID", "mistral.mistral-large-3-675b-instruct")

    out_dir = pathlib.Path(__file__).parent / "reports"
    out_dir.mkdir(exist_ok=True)

    orchestrator = Orchestrator(solari_key, bedrock_model_id, aws_region)

    print("Deskbot working on:")
    print(f"  {task}")
    print()
    try:
        result = await orchestrator.run(task, max_steps=max_steps)

        # Verify BEFORE tearing down the desktop - the file (if any) lives
        # on that same VM's disk, and destroying it first would make the
        # independent check fail regardless of whether the save worked.
        file_path = result.get("file_path") or ""
        if file_path:
            print(f"Independently reading {file_path} back (outside the model's own tool calls) ...")
            result["verification"] = await verify_file(
                orchestrator.toolkit, file_path, result.get("expected_content") or ""
            )
    finally:
        await orchestrator.toolkit.close()

    report_path = write_report(out_dir, task, result, orchestrator.transcript)

    print()
    print(f"success (self-reported) : {result.get('success')}")
    print(f"summary                 : {result.get('summary')}")
    if result.get("verification"):
        print(f"independently verified  : {result['verification']}")
    print(f"report                  : {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--task",
        default=DEFAULT_TASK,
        help="The GUI task to give Deskbot, in plain English.",
    )
    parser.add_argument("--max-steps", type=int, default=30)
    args = parser.parse_args()

    asyncio.run(run(args.task, args.max_steps))


if __name__ == "__main__":
    main()
