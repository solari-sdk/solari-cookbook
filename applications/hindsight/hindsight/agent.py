"""The agent loop. Hand-written, because a rewind rewrites the history."""

from __future__ import annotations

from typing import Any

from hindsight.session import Session
from hindsight.tools import TOOLS, dispatch

MODEL = "claude-opus-5"
MAX_TOKENS = 16_000

BASE_SYSTEM = """You are working in a Linux sandbox. Solve the task you are given, and verify your own work before reporting success."""

_RECOVERY = {
    "none": "",
    "rebuild": """

If you damage the workspace beyond repair, call `reset` to rebuild it from scratch. That discards every change made since the run began, but you keep your memory of what happened.""",
    "hindsight": """

Before anything destructive or hard to undo - installing packages, deleting files, running migrations, large refactors - call `checkpoint` first.

When an approach fails, do not try to repair a workspace you have broken. Call `rewind` to restore the last good checkpoint and explain in `reason` what went wrong. You keep that explanation afterwards, so write what you would need in order not to repeat the mistake.""",
}


def system_for(arm: str) -> str:
    """The system prompt for one arm.

    Each arm is told about the tools it actually has and nothing else. A prompt
    that tells the bare arm to call `checkpoint` grades it on an instruction it
    cannot follow, and the comparison stops meaning anything.
    """
    if arm not in _RECOVERY:
        raise KeyError(f"no such arm: {arm}")
    return BASE_SYSTEM + _RECOVERY[arm]


SYSTEM = system_for("hindsight")


class Agent:
    def __init__(
        self,
        *,
        session: Session,
        client: Any,
        model: str = MODEL,
        max_turns: int = 40,
        tools: list[dict] | None = None,
        system: str | None = None,
        on_tool: object | None = None,
    ) -> None:
        self.session = session
        self._client = client
        self._model = model
        self._max_turns = max_turns
        self._tools = TOOLS if tools is None else tools
        self._system = SYSTEM if system is None else system
        self._on_tool = on_tool
        self.input_tokens = 0
        self.output_tokens = 0
        self.turns = 0
        self.tool_calls = 0

    async def run(self, task: str) -> str:
        self.session.append({"role": "user", "content": task})

        for turn in range(1, self._max_turns + 1):
            response = await self._client.messages.create(
                model=self._model,
                max_tokens=MAX_TOKENS,
                # Adaptive is the only on-mode on this family; budget_tokens is
                # rejected with a 400. xhigh is the level tuned for agentic work.
                thinking={"type": "adaptive"},
                output_config={"effort": "xhigh"},
                system=self._system,
                tools=self._tools,
                # Read the transcript fresh every turn. A rewind mutates it in
                # place, and the loop must see that rather than a stale copy.
                messages=self.session.transcript,
            )
            self.turns = turn
            self._account(response)

            if response.stop_reason == "refusal":
                # stop_details is populated only for refusals; it names the
                # category, which is the only way to tell a policy decline from
                # a malformed-history problem.
                details = getattr(response, "stop_details", None)
                raise RuntimeError(
                    f"model refused on turn {turn}: "
                    f"category={getattr(details, 'category', None)!r} "
                    f"explanation={getattr(details, 'explanation', None)!r}"
                )

            self.session.append({"role": "assistant", "content": response.content})

            tool_uses = [
                block
                for block in response.content
                if getattr(block, "type", None) == "tool_use"
            ]
            if not tool_uses:
                return _final_text(response)

            revision = self.session.revision
            results = []
            for block in tool_uses:
                self.tool_calls += 1
                if self._on_tool is not None:
                    self._on_tool(block.name, dict(block.input))
                output = await dispatch(self.session, block.name, dict(block.input))
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": output,
                    }
                )

            if self.session.revision != revision:
                # A rewind rewrote history, including the turn these results
                # belong to. Attaching them would resurrect the tool_use blocks
                # the rewind just discarded.
                continue

            self.session.append({"role": "user", "content": results})

        raise RuntimeError(f"gave up after {self._max_turns} turns")

    def _account(self, response: Any) -> None:
        usage = getattr(response, "usage", None)
        if usage is not None:
            self.input_tokens += getattr(usage, "input_tokens", 0)
            self.output_tokens += getattr(usage, "output_tokens", 0)


def _final_text(response: Any) -> str:
    return "\n".join(
        block.text
        for block in response.content
        if getattr(block, "type", None) == "text"
    )
