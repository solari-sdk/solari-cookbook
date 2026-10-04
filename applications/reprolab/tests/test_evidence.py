import tempfile
import unittest
from pathlib import Path

from test_spec import valid_spec

from reprolab.evidence import write_evidence_bundle
from reprolab.models import (
    CleanupRecord,
    RunSpec,
    RunStage,
    RunState,
    StageStatus,
    Verdict,
    VerdictStatus,
)


class EvidenceTests(unittest.TestCase):
    def test_secrets_are_redacted_and_cleanup_warning_is_explicit(self) -> None:
        value = valid_spec()
        value["target_url"] = "https://user:password@example.com/report?token=SECRET_QUERY"
        value["profile_id"] = "profile_SUPER_SECRET_IDENTIFIER_123456"
        spec = RunSpec.from_dict(value)
        state = RunState(run_id="rr_test")
        state.record(RunStage.CREATED, StageStatus.SUCCEEDED)
        cleanup = CleanupRecord(
            resource_type="desktop",
            resource_id="desktop_…123456",
            cleanup_attempted=True,
            cleanup_succeeded=False,
            cleanup_error="capacity cleanup failure",
        )
        verdict = Verdict(
            status=VerdictStatus.INCONCLUSIVE,
            reason="test",
            gates={},
            raw_value=None,
            desktop_value=None,
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_evidence_bundle(
                root,
                spec=spec,
                state=state,
                browser=None,
                artifact=None,
                sandbox=None,
                desktop=None,
                verdict=verdict,
                cleanup=[cleanup],
            )
            combined = b"\n".join(path.read_bytes() for path in root.rglob("*") if path.is_file())
            self.assertNotIn(b"SECRET_QUERY", combined)
            self.assertNotIn(b"password", combined)
            self.assertNotIn(b"profile_SUPER_SECRET_IDENTIFIER_123456", combined)
            self.assertIn(b'"operational_clean": false', combined)
            self.assertIn(b"capacity cleanup failure", combined)
            for required in (
                "report.md",
                "report.json",
                "manifest.json",
                "run-spec.json",
                "verdict.json",
                "cleanup.json",
                "browser/assertions.json",
                "browser/download.json",
                "artifacts/hashes.json",
            ):
                self.assertTrue((root / required).exists(), required)


if __name__ == "__main__":
    unittest.main()
