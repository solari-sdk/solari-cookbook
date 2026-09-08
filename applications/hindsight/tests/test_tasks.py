"""Benchmark tasks. A task only proves anything if it cannot be reasoned past."""

from __future__ import annotations

import unittest

from hindsight.tasks import TASKS, get_task


class TaskRegistryTests(unittest.TestCase):
    def test_task_names_are_unique(self) -> None:
        names = [task.name for task in TASKS]

        self.assertEqual(len(names), len(set(names)))

    def test_every_task_can_provision_and_check_itself(self) -> None:
        for task in TASKS:
            with self.subTest(task=task.name):
                self.assertTrue(task.setup.strip())
                self.assertTrue(task.verify.strip())
                self.assertTrue(task.prompt.strip())

    def test_the_prompt_mentions_every_candidate_symmetrically(self) -> None:
        # The agent must not be able to tell which choice is right from the
        # wording. Naming all candidates is fine; naming one more often, or at
        # all differently, is a hint and the measurement stops meaning anything.
        for task in TASKS:
            with self.subTest(task=task.name):
                counts = {c: task.prompt.count(c) for c in task.candidates}
                self.assertTrue(counts, f"{task.name} declares no candidates")
                self.assertEqual(len(set(counts.values())), 1, counts)

    def test_unknown_task_name_is_rejected(self) -> None:
        with self.assertRaises(KeyError):
            get_task("no-such-task")


if __name__ == "__main__":
    unittest.main()
