from __future__ import annotations

import hashlib
import json
import unittest

from forklift.remote_oracle import VERDICT_PREFIX, parse_remote_verdict


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def payload() -> dict[str, object]:
    return {
        "accepted": True,
        "auditor_bundle_digest": digest("bundle"),
        "auditor_runtime_digest": digest("runtime"),
        "oracle_version": "forklift-oracle-v2",
        "checks": [{"code": "all", "passed": True, "detail": "ok"}],
    }


class RemoteOracleTests(unittest.TestCase):
    def test_parses_one_complete_verdict(self) -> None:
        verdict = parse_remote_verdict(
            "noise\n" + VERDICT_PREFIX + json.dumps(payload()) + "\n"
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
        forged = payload()
        forged["checks"] = [{"code": "all", "passed": "true", "detail": "forged"}]
        verdict = parse_remote_verdict(VERDICT_PREFIX + json.dumps(forged))
        self.assertFalse(verdict.checks[0].passed)

    def test_missing_or_malformed_fingerprints_fail_closed(self) -> None:
        missing = payload()
        del missing["auditor_bundle_digest"]
        with self.assertRaisesRegex(ValueError, "bundle digest"):
            parse_remote_verdict(VERDICT_PREFIX + json.dumps(missing))

        malformed = payload()
        malformed["auditor_runtime_digest"] = "not-a-digest"
        with self.assertRaisesRegex(ValueError, "runtime digest"):
            parse_remote_verdict(VERDICT_PREFIX + json.dumps(malformed))


if __name__ == "__main__":
    unittest.main()
