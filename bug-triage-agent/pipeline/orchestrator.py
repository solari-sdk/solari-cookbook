"""
pipeline/orchestrator.py — wires desktop_repro -> sandbox_diagnose ->
browser_check into one triage run, and prints the final report.

Run: python orchestrator.py --bug-report "..." --source target_app/broken_dashboard.py
"""

import argparse
import asyncio
import json
import sys
import time
from dataclasses import asdict

sys.path.append("..")
from desktop_repro import reproduce
from sandbox_diagnose import diagnose
from browser_check import check_prior_art


async def run_triage(bug_report: str, source_path: str) -> dict:
    t0 = time.time()

    print(f"\n[1/3] Reproducing on Solari Desktop: \"{bug_report}\"")
    repro = await reproduce(bug_report)

    print("\n[2/3] Diagnosing + patching in Solari Sandbox")
    diagnosis = await diagnose(source_path, repro)

    print("\n[3/3] Checking prior art via Solari Browser")
    prior_art = await check_prior_art(diagnosis.root_cause)

    elapsed = time.time() - t0

    report = {
        "bug_report": bug_report,
        "reproduced": repro.reproduced,
        "severity": diagnosis.severity,
        "root_cause": diagnosis.root_cause,
        "patch_diff": diagnosis.patch_diff,
        "tests_pass": diagnosis.tests_pass,
        "tests_pass_detail": diagnosis.tests_pass_detail,
        "known_issue_elsewhere": prior_art.known_issue,
        "prior_art_matches": prior_art.matches,
        "replay_url": repro.replay_url,
        "pipeline_seconds": round(elapsed, 2),
    }
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bug-report", required=True)
    parser.add_argument("--source", default="../target_app/broken_dashboard.py")
    args = parser.parse_args()

    report = asyncio.run(run_triage(args.bug_report, args.source))

    print("\n--- TRIAGE REPORT ---")
    print(json.dumps(report, indent=2))

    if report.get("replay_url"):
        import webbrowser
        print("\nOpening replay in your default browser...")
        webbrowser.open(report["replay_url"])