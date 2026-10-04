import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from test_spec import valid_spec

from reprolab.models import (
    ArtifactRecord,
    BrowserResult,
    DesktopObservation,
    RunSpec,
    SandboxAnalysis,
    VerdictStatus,
)
from reprolab.verdict import decide_verdict


class VerdictTests(unittest.TestCase):
    def setUp(self) -> None:
        self.spec = RunSpec.from_dict(valid_spec())
        self.temp = tempfile.TemporaryDirectory()
        content = b"account_code,customer,amount\n001234,Northstar Labs,250.00\n"
        path = Path(self.temp.name) / "export.csv"
        path.write_bytes(content)
        digest = "80b676903be6c0bace27f2afa02585e28107b12d5ac2ee84ead46adce874066d"
        self.artifact = ArtifactRecord.create("export.csv", path, content, digest)
        self.browser = BrowserResult(
            correct_page=True,
            download_completed=True,
            http_status=200,
            title="Report",
            matched_text="September",
            filename="export.csv",
            mime_type="text/csv",
            byte_length=len(content),
            sha256=digest,
            timestamp="2026-10-04T00:00:00+00:00",
        )
        self.sandbox = SandboxAnalysis(
            hash=digest,
            hash_matches=True,
            schema_valid=True,
            row_found=True,
            raw_value="001234",
            expected_value="001234",
            raw_matches_expected=True,
            environment={},
        )
        self.desktop = DesktopObservation(
            artifact_hash=digest,
            hash_matches=True,
            libreoffice_version="LibreOffice 7.3.7.2",
            active_window_verified=True,
            target_cell="A2",
            selection_verified=True,
            clipboard_sentinel_changed=True,
            solari_clipboard_value="1234",
            x11_available=True,
            x11_clipboard_value="1234",
            observations_agree=True,
            screenshot="desktop/selected-cell.png",
            environment={},
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def verdict(self, *, browser=None, artifact=None, sandbox=None, desktop=None):
        return decide_verdict(
            self.spec,
            self.browser if browser is None else browser,
            self.artifact if artifact is None else artifact,
            self.sandbox if sandbox is None else sandbox,
            self.desktop if desktop is None else desktop,
        )

    def test_confirmed(self) -> None:
        self.assertEqual(self.verdict().status, VerdictStatus.CONFIRMED)

    def test_not_reproduced(self) -> None:
        desktop = replace(
            self.desktop, solari_clipboard_value="001234", x11_clipboard_value="001234"
        )
        self.assertEqual(self.verdict(desktop=desktop).status, VerdictStatus.NOT_REPRODUCED)

    def test_browser_failure_is_inconclusive(self) -> None:
        browser = replace(self.browser, correct_page=False)
        self.assertEqual(self.verdict(browser=browser).status, VerdictStatus.INCONCLUSIVE)

    def test_hash_mismatch_is_inconclusive(self) -> None:
        sandbox = replace(self.sandbox, hash_matches=False)
        self.assertEqual(self.verdict(sandbox=sandbox).status, VerdictStatus.INCONCLUSIVE)

    def test_raw_value_mismatch_is_inconclusive(self) -> None:
        sandbox = replace(self.sandbox, raw_value="991234", raw_matches_expected=False)
        self.assertEqual(self.verdict(sandbox=sandbox).status, VerdictStatus.INCONCLUSIVE)

    def test_missing_target_row_is_inconclusive(self) -> None:
        sandbox = replace(self.sandbox, row_found=False, raw_value=None, raw_matches_expected=False)
        self.assertEqual(self.verdict(sandbox=sandbox).status, VerdictStatus.INCONCLUSIVE)

    def test_desktop_unavailable_is_inconclusive(self) -> None:
        verdict = decide_verdict(self.spec, self.browser, self.artifact, self.sandbox, None)
        self.assertEqual(verdict.status, VerdictStatus.INCONCLUSIVE)

    def test_wrong_active_window_is_inconclusive(self) -> None:
        desktop = replace(self.desktop, active_window_verified=False)
        self.assertEqual(self.verdict(desktop=desktop).status, VerdictStatus.INCONCLUSIVE)

    def test_unchanged_sentinel_is_inconclusive(self) -> None:
        desktop = replace(
            self.desktop, clipboard_sentinel_changed=False, solari_clipboard_value=None
        )
        self.assertEqual(self.verdict(desktop=desktop).status, VerdictStatus.INCONCLUSIVE)

    def test_empty_clipboard_is_inconclusive(self) -> None:
        desktop = replace(self.desktop, solari_clipboard_value="")
        self.assertEqual(self.verdict(desktop=desktop).status, VerdictStatus.INCONCLUSIVE)

    def test_clipboard_disagreement_is_inconclusive(self) -> None:
        desktop = replace(self.desktop, x11_clipboard_value="001234", observations_agree=False)
        self.assertEqual(self.verdict(desktop=desktop).status, VerdictStatus.INCONCLUSIVE)

    def test_unexpected_desktop_value_is_inconclusive(self) -> None:
        desktop = replace(self.desktop, solari_clipboard_value="00123", x11_clipboard_value="00123")
        self.assertEqual(self.verdict(desktop=desktop).status, VerdictStatus.INCONCLUSIVE)


if __name__ == "__main__":
    unittest.main()
