from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.materialize_held_out_cases import materialize


class HeldOutCaseTests(unittest.TestCase):
    def test_materializes_balanced_digest_bound_cases_without_seed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            manifest = materialize(
                seed="custody-only-test-seed",
                count=6,
                namespace="test-hidden",
                output_dir=output,
            )
            self.assertEqual(manifest["case_count"], 6)
            self.assertEqual(
                [row["receipt_mode"] for row in manifest["cases"]],
                ["zero", "partial", "full", "zero", "partial", "full"],
            )
            self.assertNotIn("custody-only-test-seed", json.dumps(manifest))
            for row in manifest["cases"]:
                payload = json.loads((output / row["file"]).read_text(encoding="utf-8"))
                self.assertNotIn("seed", payload)


if __name__ == "__main__":
    unittest.main()
