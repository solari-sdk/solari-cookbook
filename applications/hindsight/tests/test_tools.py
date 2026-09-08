"""The tools the model is given, and what calling them does to the session."""

from __future__ import annotations

import asyncio
import unittest

from hindsight.fake import FakeRunner
from hindsight.session import Session
from hindsight.tools import ARMS, TOOLS, dispatch, tools_for


class ToolSchemaTests(unittest.TestCase):
    def test_every_tool_is_a_well_formed_anthropic_definition(self) -> None:
        for tool in TOOLS:
            with self.subTest(tool=tool.get("name")):
                self.assertIn("name", tool)
                self.assertIn("description", tool)
                self.assertEqual(tool["input_schema"]["type"], "object")
                self.assertIn("required", tool["input_schema"])

    def test_the_agent_can_checkpoint_rewind_and_run_commands(self) -> None:
        self.assertEqual(
            {tool["name"] for tool in TOOLS}, {"run", "checkpoint", "rewind"}
        )


class DispatchTests(unittest.TestCase):
    def test_checkpoint_tool_records_a_checkpoint_on_the_session(self) -> None:
        async def scenario() -> tuple[Session, str]:
            session = Session(runner=FakeRunner())
            output = await dispatch(session, "checkpoint", {"label": "deps-clean"})
            return session, output

        session, output = asyncio.run(scenario())

        self.assertEqual(len(session.tree.checkpoints), 1)
        self.assertEqual(session.tree.checkpoints[0].label, "deps-clean")
        self.assertIn("cp_1", output)

    def test_rewind_tool_restores_and_leaves_the_lesson_behind(self) -> None:
        async def scenario() -> Session:
            session = Session(runner=FakeRunner())
            await dispatch(session, "checkpoint", {"label": "clean"})
            session.append({"role": "assistant", "content": "broke everything"})
            await dispatch(
                session,
                "rewind",
                {"checkpoint_id": "cp_1", "reason": "the build never linked"},
            )
            return session

        session = asyncio.run(scenario())

        self.assertNotIn(
            "broke everything", [m["content"] for m in session.transcript]
        )
        self.assertIn("never linked", session.transcript[-1]["content"])

    def test_unknown_tool_reports_an_error_instead_of_raising(self) -> None:
        async def scenario() -> str:
            session = Session(runner=FakeRunner())
            return await dispatch(session, "not_a_tool", {})

        output = asyncio.run(scenario())

        # A raise here would kill the agent loop mid-run; the model should get
        # the failure back as a tool result and choose what to do about it.
        self.assertIn("not_a_tool", output)


class ArmTests(unittest.TestCase):
    def test_the_bare_arm_can_only_run_commands(self) -> None:
        self.assertEqual({t["name"] for t in tools_for("none")}, {"run"})

    def test_the_rebuild_arm_can_rebuild_but_not_rewind(self) -> None:
        names = {t["name"] for t in tools_for("rebuild")}

        self.assertEqual(names, {"run", "reset"})

    def test_the_hindsight_arm_can_checkpoint_and_rewind(self) -> None:
        names = {t["name"] for t in tools_for("hindsight")}

        self.assertEqual(names, {"run", "checkpoint", "rewind"})

    def test_every_arm_is_named_in_ARMS(self) -> None:
        for arm in ARMS:
            with self.subTest(arm=arm):
                self.assertTrue(tools_for(arm))

    def test_unknown_arm_is_rejected(self) -> None:
        with self.assertRaises(KeyError):
            tools_for("teleport")


class ResetTests(unittest.TestCase):
    def test_reset_reruns_setup_but_leaves_the_transcript_intact(self) -> None:
        async def scenario() -> Session:
            runner = FakeRunner()
            session = Session(runner=runner, reset_command="provision.sh")
            session.append({"role": "assistant", "content": "I broke it"})
            await dispatch(session, "reset", {})
            return session

        session = asyncio.run(scenario())

        # Rebuilding restores the world but not the memory - that is exactly
        # what separates this arm from a rewind.
        self.assertIn("I broke it", [m["content"] for m in session.transcript])


if __name__ == "__main__":
    unittest.main()
