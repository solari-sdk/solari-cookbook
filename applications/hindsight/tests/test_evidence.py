"""Evidence hygiene: committed results must never carry a credential."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from hindsight.bench import RunResult, write_jsonl


def _run() -> RunResult:
    return RunResult(
        task="env-repair",
        arm="hindsight",
        solved=True,
        turns=6,
        tool_calls=8,
        input_tokens=1000,
        output_tokens=200,
        cost=0.01,
        rewinds=1,
        seconds=42.0,
        error=None,
    )


class EvidenceTests(unittest.TestCase):
    def test_written_results_contain_no_credentials_or_session_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "runs.jsonl"
            write_jsonl([_run()], out)
            text = out.read_text(encoding="utf-8")

        self.assertNotIn("SOLARI_API_KEY", text)
        self.assertNotIn("ANTHROPIC_API_KEY", text)
        self.assertNotIn("slr_live_", text)
        self.assertNotIn("sk-ant-", text)

    def test_each_line_is_independently_parseable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "runs.jsonl"
            write_jsonl([_run(), _run()], out)
            lines = out.read_text(encoding="utf-8").strip().splitlines()

        # JSONL so a reader can recompute every number without our code.
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertEqual(json.loads(line)["task"], "env-repair")


if __name__ == "__main__":
    unittest.main()
