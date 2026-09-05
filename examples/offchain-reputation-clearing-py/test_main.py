import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import main


class LedgerTests(unittest.TestCase):
    def test_pass_releases_budget_and_increments_reputation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = main.Ledger(Path(directory) / "ledger.db")
            try:
                ledger.hold("run-pass", "2026-09-01T00:00:00+00:00")
                self.assertEqual(ledger.settle("run-pass", True), "released")
                snapshot = ledger.snapshot("run-pass")
            finally:
                ledger.close()

        self.assertEqual(snapshot["balances_cents"][main.BUYER_ID], 900)
        self.assertEqual(snapshot["balances_cents"][main.SELLER_ID], 100)
        self.assertEqual(snapshot["reputation"]["score"], 1.0)

    def test_fail_refunds_budget_and_increments_failed_runs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = main.Ledger(Path(directory) / "ledger.db")
            try:
                ledger.hold("run-fail", "2026-09-01T00:00:00+00:00")
                self.assertEqual(ledger.settle("run-fail", False), "refunded")
                snapshot = ledger.snapshot("run-fail")
            finally:
                ledger.close()

        self.assertEqual(snapshot["balances_cents"][main.BUYER_ID], 1_000)
        self.assertEqual(snapshot["balances_cents"][main.SELLER_ID], 0)
        self.assertEqual(snapshot["reputation"]["failed_runs"], 1)


class ReceiptTests(unittest.TestCase):
    def test_verifier_detects_swapped_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            evidence = run_dir / "screenshot.png"
            evidence.write_bytes(b"original")
            receipt = {
                "verifier": {
                    "evidence": {"screenshot.png": main.sha256_file(evidence)}
                }
            }
            receipt["receipt_sha256"] = main.sha256_bytes(main.canonical_json(receipt))
            receipt_path = run_dir / "receipt.json"
            receipt_path.write_text(json.dumps(receipt))

            self.assertEqual(main.verify_receipt(receipt_path), [])
            evidence.write_bytes(b"replacement")
            self.assertEqual(
                main.verify_receipt(receipt_path),
                ["evidence hash mismatch: screenshot.png"],
            )


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_failure_refunds_and_writes_failed_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            with patch.object(
                main, "seller_run", AsyncMock(side_effect=RuntimeError("secret detail"))
            ):
                result = await main.run(runs_dir, main.TASKS["homepage"])

            receipt_path = next(runs_dir.glob("*/receipt.json"))
            receipt_text = receipt_path.read_text()
            receipt = json.loads(receipt_text)

        self.assertEqual(result, 2)
        self.assertEqual(receipt["buyer"]["status"], "refunded")
        self.assertEqual(receipt["seller"]["error"], "RuntimeError")
        self.assertNotIn("secret detail", receipt_text)

    async def test_delivered_but_wrong_page_refunds(self) -> None:
        """The Seller finishes and returns real evidence, but for the wrong page.

        Nothing raised, the screenshot and replay are non-empty, and a
        completion-based check would release the budget. The Evaluator reads the
        page against the task contract and refuses.
        """
        task = main.TASKS["pricing"]
        delivered = (
            {
                "provider": "solari-browser",
                "session_id": "session-123",
                "url": task.url,
                "title": "Example Domain",
                "heading": "Example Domain",
            },
            {"screenshot.png": b"x" * 2_000, "replay.ndjson": b'{"type":4}\n'},
        )
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            with patch.object(main, "seller_run", AsyncMock(return_value=delivered)):
                result = await main.run(runs_dir, task)
            receipt = json.loads(next(runs_dir.glob("*/receipt.json")).read_text())

        self.assertEqual(result, 2)
        self.assertEqual(receipt["buyer"]["status"], "refunded")
        self.assertEqual(receipt["reputation"]["failed_runs"], 1)
        # The run produced real evidence; only the page contract failed.
        self.assertTrue(receipt["evaluator"]["checks"]["screenshot_nonempty"])
        self.assertTrue(receipt["evaluator"]["checks"]["replay_nonempty"])
        self.assertFalse(receipt["evaluator"]["checks"]["title"])
        self.assertFalse(receipt["evaluator"]["checks"]["heading"])


if __name__ == "__main__":
    unittest.main()
