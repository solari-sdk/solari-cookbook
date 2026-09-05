"""Settle a recorded Solari Browser task into portable off-chain reputation."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from solari_browser import Solari
from solari_browser.errors import SolariError


BUYER_ID = "buyer"
SELLER_ID = "solari-browser-seller"
BUDGET_CENTS = 100
STARTING_BALANCE_CENTS = 1_000


def canonical_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


@dataclass(frozen=True)
class Task:
    """What the Buyer is paying for, and what 'done' means."""

    name: str
    url: str
    expected_title: str
    expected_heading: str


TASKS = {
    # The page exists and matches the contract: the Evaluator passes.
    "homepage": Task(
        name="homepage",
        url="https://example.com/",
        expected_title="Example Domain",
        expected_heading="Example Domain",
    ),
    # The page does not exist. example.com serves a soft 404: the request still
    # renders, the Seller still returns a screenshot and a replay, and nothing
    # crashes — so a "did the agent finish?" check would pay for this. The
    # Evaluator reads the delivered page instead, and refuses.
    "pricing": Task(
        name="pricing",
        url="https://example.com/pricing",
        expected_title="Pricing",
        expected_heading="Pricing",
    ),
}


@dataclass(frozen=True)
class Evaluation:
    passed: bool
    checks: dict[str, bool]


class Ledger:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS accounts (
                agent_id TEXT PRIMARY KEY,
                balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0)
            );

            CREATE TABLE IF NOT EXISTS settlements (
                run_id TEXT PRIMARY KEY,
                buyer_id TEXT NOT NULL,
                seller_id TEXT NOT NULL,
                budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
                status TEXT NOT NULL CHECK (status IN ('held', 'released', 'refunded')),
                receipt_sha256 TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reputation (
                agent_id TEXT PRIMARY KEY,
                passed_runs INTEGER NOT NULL DEFAULT 0,
                failed_runs INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO accounts(agent_id, balance_cents) VALUES (?, ?)",
            (BUYER_ID, STARTING_BALANCE_CENTS),
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO accounts(agent_id, balance_cents) VALUES (?, 0)",
            (SELLER_ID,),
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO reputation(agent_id) VALUES (?)", (SELLER_ID,)
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def hold(self, run_id: str, created_at: str) -> None:
        with self.connection:
            cursor = self.connection.execute(
                """
                UPDATE accounts
                SET balance_cents = balance_cents - ?
                WHERE agent_id = ? AND balance_cents >= ?
                """,
                (BUDGET_CENTS, BUYER_ID, BUDGET_CENTS),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("buyer has insufficient SQLite balance")
            self.connection.execute(
                """
                INSERT INTO settlements(
                    run_id, buyer_id, seller_id, budget_cents, status, created_at
                ) VALUES (?, ?, ?, ?, 'held', ?)
                """,
                (run_id, BUYER_ID, SELLER_ID, BUDGET_CENTS, created_at),
            )

    def settle(self, run_id: str, passed: bool) -> str:
        status = "released" if passed else "refunded"
        recipient = SELLER_ID if passed else BUYER_ID
        reputation_column = "passed_runs" if passed else "failed_runs"
        with self.connection:
            cursor = self.connection.execute(
                """
                UPDATE settlements SET status = ?
                WHERE run_id = ? AND status = 'held'
                """,
                (status, run_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("settlement is not held")
            self.connection.execute(
                "UPDATE accounts SET balance_cents = balance_cents + ? WHERE agent_id = ?",
                (BUDGET_CENTS, recipient),
            )
            self.connection.execute(
                f"UPDATE reputation SET {reputation_column} = {reputation_column} + 1 "
                "WHERE agent_id = ?",
                (SELLER_ID,),
            )
        return status

    def attach_receipt(self, run_id: str, receipt_sha256: str) -> None:
        with self.connection:
            self.connection.execute(
                "UPDATE settlements SET receipt_sha256 = ? WHERE run_id = ?",
                (receipt_sha256, run_id),
            )

    def previous_receipt_sha256(self, run_id: str) -> str | None:
        row = self.connection.execute(
            """
            SELECT receipt_sha256 FROM settlements
            WHERE run_id != ? AND receipt_sha256 IS NOT NULL
            ORDER BY created_at DESC, rowid DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        return row["receipt_sha256"] if row else None

    def snapshot(self, run_id: str) -> dict[str, Any]:
        settlement = self.connection.execute(
            "SELECT budget_cents, status FROM settlements WHERE run_id = ?", (run_id,)
        ).fetchone()
        reputation = self.connection.execute(
            "SELECT passed_runs, failed_runs FROM reputation WHERE agent_id = ?",
            (SELLER_ID,),
        ).fetchone()
        accounts = {
            row["agent_id"]: row["balance_cents"]
            for row in self.connection.execute(
                "SELECT agent_id, balance_cents FROM accounts ORDER BY agent_id"
            )
        }
        passed_runs = reputation["passed_runs"]
        failed_runs = reputation["failed_runs"]
        total = passed_runs + failed_runs
        return {
            "settlement": {
                "budget_cents": settlement["budget_cents"],
                "status": settlement["status"],
            },
            "balances_cents": accounts,
            "reputation": {
                "agent_id": SELLER_ID,
                "passed_runs": passed_runs,
                "failed_runs": failed_runs,
                "score": passed_runs / total if total else 0.0,
            },
        }


async def download_replay(solari: Solari, session_id: str) -> bytes:
    for _ in range(10):
        await asyncio.sleep(3)
        try:
            return await solari.sessions.download_replay(session_id)
        except SolariError as error:
            if error.status != 404:
                raise
    return b""


async def seller_run(task: Task) -> tuple[dict[str, Any], dict[str, bytes]]:
    solari = Solari(api_key=os.environ["SOLARI_API_KEY"])
    browser = await solari.launch(recording=True)
    session_id = browser.id
    try:
        page = await browser.new_page()
        await page.goto(task.url)
        heading = page.locator("h1")
        observation = {
            "url": page.url,
            "title": await page.title(),
            "heading": await heading.inner_text() if await heading.count() else None,
        }
        screenshot = await page.screenshot(full_page=True)
        await asyncio.sleep(2)
    finally:
        await browser.close()

    replay = await download_replay(solari, session_id)
    return (
        {"provider": "solari-browser", "session_id": session_id, **observation},
        {"screenshot.png": screenshot, "replay.ndjson": replay},
    )


def evaluate(
    task: Task, observation: dict[str, Any], evidence: dict[str, bytes]
) -> Evaluation:
    checks = {
        "url": observation.get("url") == task.url,
        "title": observation.get("title") == task.expected_title,
        "heading": observation.get("heading") == task.expected_heading,
        "screenshot_nonempty": len(evidence["screenshot.png"]) > 1_000,
        "replay_nonempty": len(evidence["replay.ndjson"].splitlines()) > 0,
    }
    return Evaluation(passed=all(checks.values()), checks=checks)


def write_receipt(
    run_dir: Path,
    run_id: str,
    created_at: str,
    task: Task,
    observation: dict[str, Any],
    evidence: dict[str, bytes],
    evaluation: Evaluation,
    ledger: Ledger,
) -> tuple[Path, dict[str, Any]]:
    run_dir.mkdir(parents=True, exist_ok=False)
    for name, payload in evidence.items():
        (run_dir / name).write_bytes(payload)

    snapshot = ledger.snapshot(run_id)
    receipt: dict[str, Any] = {
        "version": 1,
        "run_id": run_id,
        "created_at": created_at,
        "task": {
            "name": task.name,
            "url": task.url,
            "expected_title": task.expected_title,
            "expected_heading": task.expected_heading,
        },
        "seller": observation,
        "evaluator": {"passed": evaluation.passed, "checks": evaluation.checks},
        "verifier": {
            "algorithm": "sha256",
            "evidence": {
                name: sha256_bytes(payload) for name, payload in sorted(evidence.items())
            },
        },
        "buyer": snapshot["settlement"],
        "reputation": snapshot["reputation"],
        "balances_cents": snapshot["balances_cents"],
        "previous_receipt_sha256": ledger.previous_receipt_sha256(run_id),
    }
    receipt["receipt_sha256"] = sha256_bytes(canonical_json(receipt))
    receipt_path = run_dir / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    ledger.attach_receipt(run_id, receipt["receipt_sha256"])
    return receipt_path, receipt


def verify_receipt(receipt_path: Path) -> list[str]:
    receipt = json.loads(receipt_path.read_text())
    expected_receipt_hash = receipt.pop("receipt_sha256")
    errors: list[str] = []
    if sha256_bytes(canonical_json(receipt)) != expected_receipt_hash:
        errors.append("receipt hash mismatch")
    for name, expected_hash in receipt["verifier"]["evidence"].items():
        evidence_path = receipt_path.parent / name
        if not evidence_path.is_file():
            errors.append(f"missing evidence: {name}")
        elif sha256_file(evidence_path) != expected_hash:
            errors.append(f"evidence hash mismatch: {name}")
    return errors


async def run(runs_dir: Path, task: Task) -> int:
    run_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    ledger = Ledger(runs_dir / "reputation.db")
    try:
        ledger.hold(run_id, created_at)
        try:
            observation, evidence = await seller_run(task)
        except Exception as error:
            observation = {
                "provider": "solari-browser",
                "session_id": None,
                "url": None,
                "title": None,
                "heading": None,
                "error": type(error).__name__,
            }
            evidence = {"screenshot.png": b"", "replay.ndjson": b""}
        evaluation = evaluate(task, observation, evidence)
        status = ledger.settle(run_id, evaluation.passed)
        receipt_path, receipt = write_receipt(
            runs_dir / run_id,
            run_id,
            created_at,
            task,
            observation,
            evidence,
            evaluation,
            ledger,
        )
    finally:
        ledger.close()

    errors = verify_receipt(receipt_path)
    if errors:
        print("receipt verification failed:", "; ".join(errors), file=sys.stderr)
        return 1
    failed = sorted(name for name, ok in evaluation.checks.items() if not ok)
    print(f"receipt: {receipt_path}")
    print(f"task: {task.name} ({task.url})")
    print(f"decision: {'pass' if evaluation.passed else 'fail'}")
    if failed:
        print(f"failed checks: {', '.join(failed)}")
    print(f"budget: {status}")
    print(f"reputation: {receipt['reputation']['score']:.3f}")
    return 0 if evaluation.passed else 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs-dir", type=Path, default=Path(__file__).parent / "runs")
    parser.add_argument("--verify", type=Path, metavar="RECEIPT")
    parser.add_argument(
        "--task",
        choices=sorted(TASKS),
        default="homepage",
        help="which job the Buyer is paying for (default: homepage)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.verify:
        errors = verify_receipt(args.verify)
        if errors:
            print("invalid:", "; ".join(errors), file=sys.stderr)
            return 1
        print("valid receipt and evidence")
        return 0
    if "SOLARI_API_KEY" not in os.environ:
        print("SOLARI_API_KEY is required for a live run", file=sys.stderr)
        return 1
    return asyncio.run(run(args.runs_dir, TASKS[args.task]))


if __name__ == "__main__":
    raise SystemExit(main())
