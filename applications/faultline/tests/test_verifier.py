"""Unit tests for independent verifier."""

import unittest
from faultline.verifier import IndependentVerifier
from faultline.workload import CRMWorkloadStore


class TestVerifier(unittest.TestCase):
    def test_verifier_pass(self):
        store = CRMWorkloadStore(":memory:")
        store.create_lead("Acme", "contact@acme.com", "Acme Corp", "Alice", "qualified")
        store.create_outbound_message(1, "contact@acme.com", "Subject", "Body")

        verifier = IndependentVerifier()
        result = verifier.verify_store(store)
        self.assertTrue(result.passed)
        self.assertEqual(len(result.failed_invariants), 0)

    def test_verifier_fail_wrong_owner(self):
        store = CRMWorkloadStore(":memory:")
        store.create_lead("Acme", "contact@acme.com", "Acme Corp", "Bob", "qualified")
        store.create_outbound_message(1, "contact@acme.com", "Subject", "Body")

        verifier = IndependentVerifier()
        result = verifier.verify_store(store)
        self.assertFalse(result.passed)
        failed_names = [f.name for f in result.failed_invariants]
        self.assertIn("lead_1_owner_matches_expected", failed_names)


if __name__ == "__main__":
    unittest.main()
