"""The rewind mechanic: restore the world, keep what the failure taught."""

from __future__ import annotations

import asyncio
import unittest

from hindsight.fake import FakeRunner
from hindsight.session import Session


class RewindTests(unittest.TestCase):
    def test_rewind_drops_the_messages_written_after_the_checkpoint(self) -> None:
        async def scenario() -> list[dict]:
            session = Session(runner=FakeRunner())
            session.append({"role": "user", "content": "set up the project"})
            checkpoint = await session.checkpoint("clean")

            session.append({"role": "assistant", "content": "installing lxml==4.9.0"})
            session.append({"role": "user", "content": "build failed"})

            await session.rewind(checkpoint.id, reason="lxml needs libxml2 headers")
            return session.transcript

        transcript = asyncio.run(scenario())

        self.assertNotIn(
            "installing lxml==4.9.0", [m["content"] for m in transcript]
        )
        self.assertEqual(transcript[0]["content"], "set up the project")

    def test_rewind_keeps_a_note_explaining_why_the_branch_was_abandoned(self) -> None:
        async def scenario() -> list[dict]:
            session = Session(runner=FakeRunner())
            session.append({"role": "user", "content": "set up the project"})
            checkpoint = await session.checkpoint("clean")
            session.append({"role": "assistant", "content": "installing lxml==4.9.0"})

            await session.rewind(checkpoint.id, reason="lxml needs libxml2 headers")
            return session.transcript

        transcript = asyncio.run(scenario())

        # The whole point: the environment goes back, the knowledge does not.
        self.assertIn("libxml2", transcript[-1]["content"])
        self.assertIn("clean", transcript[-1]["content"])

    def test_rewind_asks_the_runner_to_restore_that_checkpoints_snapshot(self) -> None:
        async def scenario() -> FakeRunner:
            runner = FakeRunner()
            session = Session(runner=runner)
            checkpoint = await session.checkpoint("clean")
            await session.rewind(checkpoint.id, reason="did not work")
            return runner

        runner = asyncio.run(scenario())

        self.assertEqual(runner.restored, ["snap_fake_1"])

    def test_the_lesson_never_lands_as_a_second_user_message_in_a_row(self) -> None:
        async def scenario() -> list[dict]:
            session = Session(runner=FakeRunner())
            session.append({"role": "user", "content": "set up the project"})
            checkpoint = await session.checkpoint("clean")
            session.append({"role": "assistant", "content": "broke it"})
            await session.rewind(checkpoint.id, reason="it did not link")
            return session.transcript

        transcript = asyncio.run(scenario())

        # Rather than rely on the API tolerating consecutive same-role turns,
        # the lesson goes in as an operator message, which is what that channel
        # is for on this model.
        roles = [m["role"] for m in transcript]
        self.assertNotIn(["user", "user"], [roles[i : i + 2] for i in range(len(roles))])
        self.assertEqual(transcript[-1]["role"], "system")

    def test_a_rewind_to_the_very_start_still_produces_a_valid_opening(self) -> None:
        async def scenario() -> list[dict]:
            session = Session(runner=FakeRunner())
            checkpoint = await session.checkpoint("empty")
            session.append({"role": "user", "content": "go"})
            await session.rewind(checkpoint.id, reason="nothing worked")
            return session.transcript

        transcript = asyncio.run(scenario())

        # A system message cannot be messages[0]; there is nothing for it to
        # follow.
        self.assertEqual(transcript[0]["role"], "user")


if __name__ == "__main__":
    unittest.main()
