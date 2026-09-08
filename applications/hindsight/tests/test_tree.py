"""Checkpoint tree: lineage, lookup, and the branch record a rewind leaves behind."""

from __future__ import annotations

import unittest

from hindsight.tree import CheckpointTree


class CheckpointTreeTests(unittest.TestCase):
    def test_first_checkpoint_has_no_parent(self) -> None:
        tree = CheckpointTree()

        checkpoint = tree.add(snapshot_id="snap_a", label="clean", transcript_offset=0)

        self.assertIsNone(checkpoint.parent)
        self.assertEqual(checkpoint.snapshot_id, "snap_a")
        self.assertEqual(checkpoint.label, "clean")
        self.assertEqual(checkpoint.transcript_offset, 0)

    def test_second_checkpoint_descends_from_the_first(self) -> None:
        tree = CheckpointTree()

        first = tree.add(snapshot_id="snap_a", label="clean", transcript_offset=0)
        second = tree.add(snapshot_id="snap_b", label="deps", transcript_offset=12)

        self.assertEqual(second.parent, first.id)

    def test_checkpoint_after_rewind_branches_from_the_rewind_target(self) -> None:
        tree = CheckpointTree()
        first = tree.add(snapshot_id="snap_a", label="clean", transcript_offset=0)
        abandoned = tree.add(snapshot_id="snap_b", label="bad-deps", transcript_offset=12)

        tree.rewind_to(first.id)
        retry = tree.add(snapshot_id="snap_c", label="retry", transcript_offset=12)

        self.assertEqual(retry.parent, first.id)
        self.assertNotEqual(retry.parent, abandoned.id)


if __name__ == "__main__":
    unittest.main()
