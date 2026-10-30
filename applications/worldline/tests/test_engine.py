import asyncio
import tempfile
import unittest
from pathlib import Path

from worldline.engine import WorldlineEngine, score_branch, select_winner
from worldline.fixture import FixtureRunner
from worldline.ledger import TASK, TASK_DETAIL, candidates


class ExplodingCandidateRunner(FixtureRunner):
    async def execute(self, candidate, *, phase):
        if candidate.id == "global-replace" and phase == "explore":
            raise RuntimeError("candidate process crashed")
        return await super().execute(candidate, phase=phase)


class DivergentCommitRunner(FixtureRunner):
    async def execute(self, candidate, *, phase):
        result = await super().execute(candidate, phase=phase)
        if phase == "commit":
            result.status = "fail"
            result.checks = [
                type(result.checks[0])(
                    id="commit-diverged",
                    label="Commit matches selected evidence",
                    expected="same artifact",
                    actual="different artifact",
                    passed=False,
                    weight=10,
                )
            ]
        return result


class EngineTests(unittest.TestCase):
    def test_fixture_selects_surgical_update_and_replays_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run = asyncio.run(
                WorldlineEngine(FixtureRunner(Path(directory)), TASK, TASK_DETAIL).run(
                    candidates()
                )
            )

        self.assertEqual(run.status, "committed")
        self.assertEqual(run.winner_id, "surgical-update")
        self.assertIsNotNone(run.commit)
        self.assertEqual(run.commit.candidate_id, "surgical-update")
        self.assertTrue(run.commit.required_checks_pass)
        self.assertTrue(run.cleanup.succeeded)

    def test_required_failure_is_ineligible_even_with_fewer_actions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run = asyncio.run(
                WorldlineEngine(FixtureRunner(Path(directory)), TASK, TASK_DETAIL).run(
                    candidates()
                )
            )

        global_branch = next(
            branch for branch in run.branches if branch.candidate_id == "global-replace"
        )
        winner = select_winner(run.branches)
        self.assertFalse(global_branch.required_checks_pass)
        self.assertEqual(score_branch(global_branch), 0.0)
        self.assertEqual(winner.candidate_id, "surgical-update")

    def test_every_candidate_starts_from_same_base_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run = asyncio.run(
                WorldlineEngine(FixtureRunner(Path(directory)), TASK, TASK_DETAIL).run(
                    candidates()
                )
            )

        self.assertEqual(len(run.environment.base_sha256), 64)
        self.assertEqual(run.metadata["candidate_count"], 3)

    def test_one_crashed_candidate_does_not_poison_other_worldlines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run = asyncio.run(
                WorldlineEngine(
                    ExplodingCandidateRunner(Path(directory)), TASK, TASK_DETAIL
                ).run(candidates())
            )

        crashed = next(
            branch for branch in run.branches if branch.candidate_id == "global-replace"
        )
        self.assertEqual(crashed.status, "error")
        self.assertIn("candidate process crashed", crashed.error)
        self.assertEqual(run.status, "committed")
        self.assertEqual(run.winner_id, "surgical-update")
        self.assertTrue(run.cleanup.succeeded)

    def test_no_eligible_branch_means_no_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run = asyncio.run(
                WorldlineEngine(FixtureRunner(Path(directory)), TASK, TASK_DETAIL).run(
                    candidates()[:2]
                )
            )

        self.assertEqual(run.status, "no-winner")
        self.assertIsNone(run.winner_id)
        self.assertIsNone(run.commit)
        self.assertTrue(run.cleanup.succeeded)

    def test_divergent_commit_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run = asyncio.run(
                WorldlineEngine(
                    DivergentCommitRunner(Path(directory)), TASK, TASK_DETAIL
                ).run(candidates())
            )

        self.assertEqual(run.winner_id, "surgical-update")
        self.assertEqual(run.status, "commit-failed")
        self.assertFalse(run.commit.required_checks_pass)
        self.assertTrue(run.cleanup.succeeded)


if __name__ == "__main__":
    unittest.main()
