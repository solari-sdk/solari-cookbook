"""The three tools the model is given, and the dispatch that runs them."""

from __future__ import annotations

from typing import Any

from hindsight.session import Session

TOOLS: list[dict[str, Any]] = [
    {
        "name": "run",
        "description": (
            "Run a shell command in the workspace and return its exit code, "
            "stdout and stderr."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run."}
            },
            "required": ["command"],
        },
    },
    {
        "name": "checkpoint",
        "description": (
            "Save the current state of the workspace so you can come back to it. "
            "Take one before anything destructive or hard to undo: installing "
            "packages, deleting files, running migrations, large refactors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "label": {
                    "type": "string",
                    "description": "Short name for this state, e.g. 'deps-clean'.",
                }
            },
            "required": ["label"],
        },
    },
    {
        "name": "rewind",
        "description": (
            "Abandon the current approach and restore the workspace to an earlier "
            "checkpoint. The files and installed packages go back; your memory of "
            "what went wrong does not. Use this instead of trying to repair a "
            "workspace you have broken."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "checkpoint_id": {
                    "type": "string",
                    "description": "Which checkpoint to return to, e.g. 'cp_1'.",
                },
                "reason": {
                    "type": "string",
                    "description": (
                        "Why this branch failed. You will still be able to read "
                        "this after the rewind, so write what you would need to "
                        "avoid repeating the mistake."
                    ),
                },
            },
            "required": ["checkpoint_id", "reason"],
        },
    },
]


async def dispatch(session: Session, name: str, args: dict[str, Any]) -> str:
    """Run one tool call and return the text that goes back as a tool result.

    Failures are returned, never raised: an exception here would end the agent
    loop, when the model could have recovered from being told what went wrong.
    """
    try:
        if name == "run":
            result = await session.exec(args["command"])
            return (
                f"exit {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )
        if name == "reset":
            result = await session.reset()
            return (
                f"workspace rebuilt from scratch (exit {result.exit_code}). "
                "Everything you did since the start is gone."
            )
        if name == "checkpoint":
            checkpoint = await session.checkpoint(args["label"])
            return f"saved checkpoint {checkpoint.id} ({checkpoint.label})"
        if name == "rewind":
            checkpoint = await session.rewind(
                args["checkpoint_id"], reason=args["reason"]
            )
            return f"workspace restored to {checkpoint.id} ({checkpoint.label})"
        return f"error: unknown tool {name!r}"
    except Exception as exc:  # noqa: BLE001 - the model handles its own failures
        return f"error: {type(exc).__name__}: {exc}"


RESET_TOOL: dict[str, Any] = {
    "name": "reset",
    "description": (
        "Rebuild the workspace from scratch, discarding every change made since "
        "the run began. Use this when you have damaged the workspace and cannot "
        "repair it. You keep your memory of what happened."
    ),
    "input_schema": {"type": "object", "properties": {}, "required": []},
}

_BY_NAME = {tool["name"]: tool for tool in [*TOOLS, RESET_TOOL]}

#: Benchmark arms, in increasing order of what the agent is given.
ARMS: dict[str, tuple[str, ...]] = {
    "none": ("run",),
    "rebuild": ("run", "reset"),
    "hindsight": ("run", "checkpoint", "rewind"),
}


def tools_for(arm: str) -> list[dict[str, Any]]:
    if arm not in ARMS:
        raise KeyError(f"no such arm: {arm}")
    return [_BY_NAME[name] for name in ARMS[arm]]
