"""The agent loop, driven by canned model responses instead of the real API."""

from __future__ import annotations

import asyncio
import unittest

from hindsight.agent import Agent, system_for
from hindsight.fake import FakeRunner
from hindsight.session import Session
from hindsight.tools import tools_for


class _Text:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class _ToolUse:
    type = "tool_use"

    def __init__(self, tool_id: str, name: str, tool_input: dict) -> None:
        self.id = tool_id
        self.name = name
        self.input = tool_input


class _Response:
    def __init__(self, content: list, stop_reason: str = "end_turn") -> None:
        self.content = content
        self.stop_reason = stop_reason
        self.usage = _Usage()


class _Usage:
    input_tokens = 10
    output_tokens = 5


class StubMessages:
    def __init__(self, responses: list[_Response]) -> None:
        self._responses = list(responses)
        self.requests: list[dict] = []

    async def create(self, **kwargs):
        self.requests.append(kwargs)
        return self._responses.pop(0)


class StubClient:
    def __init__(self, responses: list[_Response]) -> None:
        self.messages = StubMessages(responses)


class AgentLoopTests(unittest.TestCase):
    def test_returns_the_final_text_when_the_model_stops(self) -> None:
        client = StubClient([_Response([_Text("all done")])])
        agent = Agent(session=Session(runner=FakeRunner()), client=client)

        answer = asyncio.run(agent.run("do the thing"))

        self.assertEqual(answer, "all done")

    def test_runs_a_tool_call_and_feeds_the_result_back(self) -> None:
        client = StubClient(
            [
                _Response(
                    [_ToolUse("t1", "run", {"command": "echo hi"})],
                    stop_reason="tool_use",
                ),
                _Response([_Text("finished")]),
            ]
        )
        runner = FakeRunner()
        agent = Agent(session=Session(runner=runner), client=client)

        answer = asyncio.run(agent.run("do the thing"))

        self.assertEqual(runner.commands, ["echo hi"])
        self.assertEqual(answer, "finished")

    def test_after_a_rewind_the_next_request_uses_the_truncated_transcript(self) -> None:
        client = StubClient(
            [
                _Response(
                    [_ToolUse("t1", "checkpoint", {"label": "clean"})],
                    stop_reason="tool_use",
                ),
                _Response(
                    [_ToolUse("t2", "run", {"command": "rm -rf /important"})],
                    stop_reason="tool_use",
                ),
                _Response(
                    [
                        _ToolUse(
                            "t3",
                            "rewind",
                            {"checkpoint_id": "cp_1", "reason": "deleted the wrong tree"},
                        )
                    ],
                    stop_reason="tool_use",
                ),
                _Response([_Text("recovered")]),
            ]
        )
        agent = Agent(session=Session(runner=FakeRunner()), client=client)

        asyncio.run(agent.run("do the thing"))

        # This is why the loop is hand-written: the SDK tool runner keeps its
        # own copy of the history, and a rewind has to rewrite it.
        final = client.messages.requests[-1]["messages"]
        serialized = str(final)
        self.assertNotIn("rm -rf /important", serialized)
        self.assertIn("deleted the wrong tree", serialized)

    def test_a_refusal_ends_the_run_instead_of_being_read_as_an_answer(self) -> None:
        client = StubClient([_Response([], stop_reason="refusal")])
        agent = Agent(session=Session(runner=FakeRunner()), client=client)

        with self.assertRaises(RuntimeError) as caught:
            asyncio.run(agent.run("do the thing"))

        self.assertIn("refus", str(caught.exception).lower())

    def test_the_arm_decides_which_tools_the_model_is_offered(self) -> None:
        client = StubClient([_Response([_Text("done")])])
        agent = Agent(
            session=Session(runner=FakeRunner()),
            client=client,
            tools=tools_for("none"),
        )

        asyncio.run(agent.run("do the thing"))

        offered = {t["name"] for t in client.messages.requests[0]["tools"]}
        self.assertEqual(offered, {"run"})

class SystemPromptTests(unittest.TestCase):
    def test_a_prompt_never_names_a_tool_that_arm_does_not_have(self) -> None:
        # Telling the bare arm to "call checkpoint" makes the comparison
        # meaningless: it is being graded on following an impossible
        # instruction.
        for arm, absent in [
            ("none", ("checkpoint", "rewind", "reset")),
            ("rebuild", ("checkpoint", "rewind")),
            ("hindsight", ("reset",)),
        ]:
            with self.subTest(arm=arm):
                prompt = system_for(arm)
                for name in absent:
                    self.assertNotIn(name, prompt)

    def test_each_arm_is_told_about_the_tools_it_does_have(self) -> None:
        self.assertIn("rewind", system_for("hindsight"))
        self.assertIn("reset", system_for("rebuild"))


if __name__ == "__main__":
    unittest.main()
