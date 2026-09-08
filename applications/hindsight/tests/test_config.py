"""Key loading and redaction. Nothing here may ever print a secret."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from hindsight.config import load_key, redact


class LoadKeyTests(unittest.TestCase):
    def test_prefers_the_environment_over_the_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text("SOLARI_API_KEY=from_file\n", encoding="utf-8")

            key = load_key("SOLARI_API_KEY", env_file, environ={"SOLARI_API_KEY": "from_env"})

        self.assertEqual(key, "from_env")

    def test_reads_a_quoted_value_from_the_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text('SOLARI_API_KEY="slr_live_abc"\n', encoding="utf-8")

            key = load_key("SOLARI_API_KEY", env_file, environ={})

        self.assertEqual(key, "slr_live_abc")

    def test_tolerates_a_utf8_bom(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            # Windows editors write a BOM; utf-8 decoding leaves it on the
            # first key name and the lookup silently misses.
            env_file.write_text("﻿SOLARI_API_KEY=slr_live_bom\n", encoding="utf-8")

            key = load_key("SOLARI_API_KEY", env_file, environ={})

        self.assertEqual(key, "slr_live_bom")

    def test_missing_key_fails_with_a_message_that_does_not_echo_a_value(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text("OTHER=x\n", encoding="utf-8")

            with self.assertRaises(SystemExit) as caught:
                load_key("SOLARI_API_KEY", env_file, environ={})

        message = str(caught.exception)
        self.assertIn("SOLARI_API_KEY", message)
        self.assertNotIn("OTHER", message)


class RedactTests(unittest.TestCase):
    def test_keeps_enough_of_an_id_to_correlate_but_not_to_reuse(self) -> None:
        redacted = redact("snap_dl9xebcfobc2wxyz")

        self.assertNotEqual(redacted, "snap_dl9xebcfobc2wxyz")
        self.assertTrue(redacted.startswith("snap_"))
        self.assertIn("…", redacted)

    def test_short_ids_are_left_alone(self) -> None:
        self.assertEqual(redact("cp_1"), "cp_1")


if __name__ == "__main__":
    unittest.main()
