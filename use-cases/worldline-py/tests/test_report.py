import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from worldline.engine import WorldlineEngine
from worldline.fixture import FixtureRunner
from worldline.ledger import TASK, TASK_DETAIL, candidates
from worldline.report import write_report


class ReportTests(unittest.TestCase):
    def test_report_is_self_contained_except_run_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = asyncio.run(
                WorldlineEngine(FixtureRunner(root), TASK, TASK_DETAIL).run(
                    candidates()
                )
            )
            index = write_report(run, root)
            payload = json.loads((root / "run.json").read_text(encoding="utf-8"))

            self.assertTrue(index.exists())
            self.assertTrue((root / "app.js").exists())
            self.assertTrue((root / "styles.css").exists())
            self.assertEqual(payload["winner_id"], "surgical-update")
            self.assertNotIn("SOLARI_API_KEY", json.dumps(payload))
            commit = payload["commit"]
            artifact_bytes = (root / commit["artifact"]).read_bytes()
            self.assertEqual(
                hashlib.sha256(artifact_bytes).hexdigest(), commit["artifact_sha256"]
            )


if __name__ == "__main__":
    unittest.main()
