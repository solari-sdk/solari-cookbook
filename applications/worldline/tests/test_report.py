import asyncio
import hashlib
import json
import tempfile
import unittest
from functools import partial
from http.server import HTTPServer
from importlib.resources import files
from pathlib import Path
from threading import Thread
from urllib.request import Request, urlopen

from worldline.cli import ReportHandler
from worldline.engine import WorldlineEngine
from worldline.fixture import FixtureRunner
from worldline.ledger import TASK, TASK_DETAIL, candidates
from worldline.report import write_report


class ReportTests(unittest.TestCase):
    def test_committed_artifact_bytes_match_recorded_digests(self) -> None:
        root = Path(__file__).resolve().parents[1] / "proof" / "live"
        payload = json.loads((root / "run.json").read_text(encoding="utf-8"))
        for branch in [*payload["branches"], payload["commit"]]:
            with self.subTest(artifact=branch["artifact"]):
                self.assertEqual(
                    hashlib.sha256(
                        (root / branch["artifact"]).read_bytes()
                    ).hexdigest(),
                    branch["artifact_sha256"],
                )

    def test_committed_evidence_serves_without_duplicate_assets_or_writes(self) -> None:
        root = Path(__file__).resolve().parents[1] / "proof" / "live"
        before = {
            p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()
        }
        self.assertNotIn(Path("index.html"), before)
        with HTTPServer(
            ("127.0.0.1", 0), partial(ReportHandler, directory=str(root))
        ) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                for path, asset in (
                    ("/", "index.html"),
                    ("/index.html", "index.html"),
                    ("/app.js?v=1", "app.js"),
                    ("/styles.css", "styles.css"),
                ):
                    with urlopen(base + path) as response:
                        self.assertEqual(
                            response.read(),
                            files("worldline").joinpath("static", asset).read_bytes(),
                        )
                for path in (
                    "run.json",
                    "screens/base.svg",
                    "commit-surgical-update.csv",
                ):
                    with urlopen(base + "/" + path) as response:
                        self.assertEqual(response.read(), before[Path(path)])
                with urlopen(Request(base + "/app.js", method="HEAD")) as response:
                    self.assertEqual(response.read(), b"")
                    self.assertGreater(int(response.headers["Content-Length"]), 0)
            finally:
                server.shutdown()
                thread.join()
        after = {
            p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()
        }
        self.assertEqual(before, after)

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
