from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from forklift.gui_worker import _route_preview_only
from scripts.bootstrap_solari_canonical import _safe_diagnostic
from scripts.setup_local_lab import GENERATED_SECRETS, ensure_local_secrets


class FakeRequest:
    def __init__(self, url: str) -> None:
        self.url = url
        self.headers = {"accept": "text/html"}


class FakeRoute:
    def __init__(self, url: str) -> None:
        self.request = FakeRequest(url)
        self.aborted = False
        self.continued_headers: dict[str, str] | None = None

    def abort(self, _reason: str) -> None:
        self.aborted = True

    def continue_(self, *, headers: dict[str, str]) -> None:
        self.continued_headers = headers


class FakeContext:
    handler = None

    def route(self, _pattern: str, handler) -> None:
        self.handler = handler


class SecurityHardeningTests(unittest.TestCase):
    def test_blank_secret_placeholders_are_replaced_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "SOLARI_API_KEY=\nFORKLIFT_ADMIN_PASSWORD=\n"
                "FORKLIFT_AUDITOR_DB_PASSWORD=\nFORKLIFT_ADMIN_PASSWORD=\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {name: "" for name in GENERATED_SECRETS}):
                ensure_local_secrets(path)
                for name in GENERATED_SECRETS:
                    self.assertGreaterEqual(len(os.environ[name]), 20)
            rewritten = path.read_text(encoding="utf-8")
            for name in GENERATED_SECRETS:
                self.assertEqual(rewritten.count(f"{name}="), 1)

    def test_preview_bearer_is_scoped_to_exact_tls_origin(self) -> None:
        context = FakeContext()
        _route_preview_only(context, "https://preview.example/app", "secret-token")

        same_origin = FakeRoute("https://preview.example/web/login")
        context.handler(same_origin)
        self.assertEqual(
            same_origin.continued_headers["authorization"],
            "Bearer secret-token",
        )

        cross_origin = FakeRoute("https://attacker.example/collect")
        context.handler(cross_origin)
        self.assertTrue(cross_origin.aborted)
        self.assertIsNone(cross_origin.continued_headers)

        plaintext = FakeRoute("http://preview.example/collect")
        context.handler(plaintext)
        self.assertTrue(plaintext.aborted)

    def test_diagnostics_remove_bearers_keys_and_passwords(self) -> None:
        fake_key = "slr_" + "live_" + "identifier_secret"
        diagnostic = _safe_diagnostic(
            RuntimeError(
                "Authorization: Bearer ey.secret token=abc "
                f"SOLARI_API_KEY={fake_key} password=hunter2"
            )
        )
        self.assertNotIn("ey.secret", diagnostic)
        self.assertNotIn(fake_key, diagnostic)
        self.assertNotIn("hunter2", diagnostic)
        self.assertIn("[REDACTED]", diagnostic)

    def test_diagnostics_remove_quoted_structured_secrets(self) -> None:
        for payload in (
            '{"password": "hunter2"}',
            "{'password': 'hunter2'}",
            '{"FORKLIFT_ADMIN_PASSWORD":"hunter2"}',
            "api_key='hunter2'",
        ):
            with self.subTest(payload=payload):
                diagnostic = _safe_diagnostic(RuntimeError(payload))
                self.assertNotIn("hunter2", diagnostic)
                self.assertIn("[REDACTED]", diagnostic)


if __name__ == "__main__":
    unittest.main()
