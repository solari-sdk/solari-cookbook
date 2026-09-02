from __future__ import annotations

import json
import unittest

from forklift.remote_oracle import VERDICT_PREFIX, parse_remote_verdict


class RemoteOracleTests(unittest.TestCase):
    def test_parses_one_complete_verdict(self) -> None:
        payload = {
            "accepted": True,
            "oracle_version": "forklift-oracle-v1",
            "checks": [{"code": "all", "passed": True, "detail": "ok"}],
        }
        verdict = parse_remote_verdict(
            "noise\n" + VERDICT_PREFIX + json.dumps(payload) + "\n"
        )
        self.assertTrue(verdict.accepted)
        self.assertEqual(verdict.checks[0].code, "all")

    def test_missing_or_duplicate_marker_fails_closed(self) -> None:
        with self.assertRaises(ValueError):
            parse_remote_verdict("ordinary stdout")
        marker = VERDICT_PREFIX + json.dumps({"accepted": False, "checks": []})
        with self.assertRaises(ValueError):
            parse_remote_verdict(marker + "\n" + marker)

    def test_malformed_payload_fails_closed(self) -> None:
        with self.assertRaises((ValueError, json.JSONDecodeError)):
            parse_remote_verdict(VERDICT_PREFIX + "not-json")
        with self.assertRaises(ValueError):
            parse_remote_verdict(VERDICT_PREFIX + json.dumps({"accepted": True}))

    def test_non_boolean_pass_value_cannot_become_true(self) -> None:
        payload = {
            "accepted": True,
            "oracle_version": "forklift-oracle-v1",
            "checks": [{"code": "all", "passed": "true", "detail": "forged"}],
        }
        verdict = parse_remote_verdict(VERDICT_PREFIX + json.dumps(payload))
        self.assertFalse(verdict.checks[0].passed)


if __name__ == "__main__":
    unittest.main()
