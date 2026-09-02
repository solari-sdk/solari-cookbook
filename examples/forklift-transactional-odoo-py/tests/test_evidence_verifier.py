from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.verify_development_evidence import verify_ledger


def record(previous_hash: str, event_id: str) -> dict[str, object]:
    value: dict[str, object] = {
        "actor": "test",
        "data": {},
        "event_id": event_id,
        "event_type": "test",
        "parents": [],
        "previous_hash": previous_hash,
        "project_id": "forklift-solari",
        "recorded_at_utc": "2026-09-01T00:00:00Z",
        "schema_version": 1,
    }
    value["event_hash"] = hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return value


class EvidenceVerifierTests(unittest.TestCase):
    def test_verifies_hash_chained_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.jsonl"
            first = record("0" * 64, "first")
            second = record(first["event_hash"], "second")
            path.write_text(
                "\n".join(json.dumps(item) for item in (first, second)) + "\n",
                encoding="utf-8",
            )
            self.assertEqual(verify_ledger(path), (2, second["event_hash"]))

    def test_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.jsonl"
            item = record("0" * 64, "first")
            item["actor"] = "tampered"
            path.write_text(json.dumps(item) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "event-hash mismatch"):
                verify_ledger(path)


if __name__ == "__main__":
    unittest.main()
