"""Unit tests for state hashing and state diff engine."""

import unittest
from faultline.diff_engine import StateDiffEngine
from faultline.workload import CRMWorkloadStore


class TestStateAndDiff(unittest.TestCase):
    def test_canonical_state_hashing(self):
        store1 = CRMWorkloadStore(":memory:")
        store1.create_lead("Acme Lead", "a@acme.com", "Acme", "Alice", "new")
        digest1 = store1.compute_state_digest()

        store2 = CRMWorkloadStore(":memory:")
        store2.create_lead("Acme Lead", "a@acme.com", "Acme", "Alice", "new")
        digest2 = store2.compute_state_digest()

        self.assertEqual(digest1, digest2)

        # Mutate store2
        store2.assign_owner(1, "Bob")
        digest3 = store2.compute_state_digest()
        self.assertNotEqual(digest1, digest3)

    def test_state_diff_engine(self):
        store_good = CRMWorkloadStore(":memory:")
        store_good.create_lead("Acme Lead", "a@acme.com", "Acme Corp", "Alice", "qualified")

        store_bad = store_good.clone_to_memory()
        store_bad.assign_owner(1, "Bob")

        diff = StateDiffEngine.compare_stores("chk-1", "chk-2", store_good, store_bad)
        self.assertEqual(len(diff.changed_records), 1)
        self.assertEqual(diff.changed_records[0].record_type, "Lead")
        self.assertEqual(diff.changed_records[0].field_changes[0].field_name, "owner")
        self.assertEqual(diff.changed_records[0].field_changes[0].old_value, "Alice")
        self.assertEqual(diff.changed_records[0].field_changes[0].new_value, "Bob")


if __name__ == "__main__":
    unittest.main()
