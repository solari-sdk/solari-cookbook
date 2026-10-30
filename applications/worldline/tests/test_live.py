import tempfile
import unittest
from pathlib import Path

from worldline.cli import load_key
from worldline.live import redact_identifier
from worldline.sandbox_live import strategy_script


class LiveRunnerUnitTests(unittest.TestCase):
    def test_identifier_redaction_preserves_debuggable_edges(self) -> None:
        value = "session_abcdefghijklmnopqrstuvwxyz_123456"
        redacted = redact_identifier(value)
        self.assertEqual(redacted, "session_…123456")
        self.assertNotIn("bcdefghijklmnopqrstuvwxyz", redacted)

    def test_key_loader_reads_ignored_env_without_logging_value(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                "# local only\nSOLARI_API_KEY='slr_live_example'\n", encoding="utf-8"
            )
            self.assertEqual(load_key(env_file), "slr_live_example")

    def test_every_candidate_has_a_remote_strategy(self) -> None:
        for candidate_id in ("global-replace", "collateral-edit", "surgical-update"):
            script = strategy_script(candidate_id)
            self.assertIn("expense-ledger.csv", script)
            self.assertNotIn("SOLARI_API_KEY", script)


if __name__ == "__main__":
    unittest.main()
