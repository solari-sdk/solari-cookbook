from __future__ import annotations

import unittest

from forklift.solari_adapter import stream_url_from_control_url


class SolariAdapterTests(unittest.TestCase):
    def test_derives_stream_url_without_changing_signed_id(self) -> None:
        control = (
            "wss://api.getsolari.com/control/"
            "pool%3Avm_1%3Aorg.sig?capability=opaque"
        )
        self.assertEqual(
            stream_url_from_control_url(control),
            "wss://api.getsolari.com/stream/"
            "pool%3Avm_1%3Aorg.sig?capability=opaque",
        )

    def test_rejects_unexpected_route(self) -> None:
        with self.assertRaises(ValueError):
            stream_url_from_control_url("wss://api.getsolari.com/not-control/id")


if __name__ == "__main__":
    unittest.main()
