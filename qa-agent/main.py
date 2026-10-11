"""Sentinel - an autonomous QA agent that chains Solari's browser and sandbox
products to find and prove a real bug in a target web app.

Driven by a Mistral model via AWS Bedrock (not Claude) - see
qa-agent/README.md for why, and which model this was verified against.

Usage:
    python main.py --target https://demo.owasp-juice.shop
"""

from __future__ import annotations

import argparse
import asyncio
import os
import pathlib
import sys

from dotenv import load_dotenv

# Windows consoles default to cp1252, which can't print the ★ used below.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from agent.challenges import pick_challenge
from agent.orchestrator import Orchestrator
from agent.report import write_report

# Must run before argparse builds its defaults from os.environ below —
# loading it inside run() was too late and silently ignored .env's
# TARGET_URL, always falling back to the hardcoded default instead.
load_dotenv()


async def run(
    target_url: str,
    max_steps: int,
    challenge_mode: bool = False,
    max_difficulty: int = 2,
    category: str | None = None,
) -> None:
    solari_key = os.environ["SOLARI_API_KEY"]
    # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are picked up from the
    # environment by boto3's default credential chain - no need to pass
    # them explicitly once load_dotenv() has put them in os.environ.
    aws_region = os.environ["AWS_REGION"]
    bedrock_model_id = os.environ.get("BEDROCK_MODEL_ID", "mistral.mistral-large-3-675b-instruct")

    out_dir = pathlib.Path(__file__).parent / "reports"
    out_dir.mkdir(exist_ok=True)

    challenge = None
    if challenge_mode:
        try:
            challenge = pick_challenge(target_url, max_difficulty=max_difficulty, category=category)
        except Exception as e:
            print(f"Could not reach {target_url}/api/Challenges/ ({e}) - falling back to open-ended investigation.")
        else:
            if challenge is None:
                print(
                    f"No unsolved challenge <= difficulty {max_difficulty} found "
                    f"(everything matching may already be solved by other users on "
                    f"this shared instance) - falling back to open-ended investigation."
                )
            else:
                print(f"Objective: [{challenge['difficulty']}★] {challenge['name']} ({challenge['category']})")

    orchestrator = Orchestrator(solari_key, bedrock_model_id, aws_region)

    print(f"Sentinel investigating {target_url} ...")
    result = await orchestrator.run(target_url, max_steps=max_steps, challenge=challenge)

    report_path = write_report(out_dir, target_url, result, orchestrator.transcript)

    print()
    print(f"severity : {result.get('severity')}")
    print(f"summary  : {result.get('summary')}")
    if challenge:
        verified = result.get("challenge_verified")
        print(f"challenge: {challenge['name']} (id={challenge['id']})")
        print(f"verified : {verified if verified is not None else 'ERROR - ' + result.get('challenge_verify_error', '')}")
    print(f"report   : {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        default=os.environ.get("TARGET_URL", "https://demo.owasp-juice.shop"),
        help="Target URL. Defaults to the public OWASP Juice Shop practice instance.",
    )
    parser.add_argument("--max-steps", type=int, default=20)
    parser.add_argument(
        "--challenge",
        action="store_true",
        help=(
            "Target a specific, objectively-checkable Juice Shop challenge "
            "(via its own public /api/Challenges scoreboard state) instead of "
            "open-ended 'find any bug' recon."
        ),
    )
    parser.add_argument(
        "--max-difficulty",
        type=int,
        default=2,
        help="With --challenge, only consider challenges at or below this difficulty (1-6 stars). Default 2.",
    )
    parser.add_argument(
        "--category",
        default=None,
        help="With --challenge, restrict to a specific Juice Shop challenge category (e.g. 'Broken Access Control').",
    )
    args = parser.parse_args()

    asyncio.run(
        run(
            args.target,
            args.max_steps,
            challenge_mode=args.challenge,
            max_difficulty=args.max_difficulty,
            category=args.category,
        )
    )


if __name__ == "__main__":
    main()
