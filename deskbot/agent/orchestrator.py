"""Top-level agent loop: a Mistral model (via AWS Bedrock) plans and drives
a real desktop GUI task - with NO vision. See deskbot/README.md for why:
no Mistral model in this account's Bedrock access supports image input, so
rather than fake a screenshot loop, this agent is designed around that
constraint - it acts blind (known coordinates + keyboard) and checks its
own work the only way it can: reading real files back with `shell`, never
by looking at the screen.
"""

from __future__ import annotations

from .bedrock_client import BedrockClient
from .solari_tools import DesktopToolkit

MAIN_TOOLS = [
    {
        "name": "open_app",
        "description": "Launch a GUI app by name. The 'default' template ships mousepad, thunar, Chrome, VS Code and LibreOffice.",
        "inputSchema": {
            "json": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}
        },
    },
    {
        "name": "click",
        "description": (
            "Click at pixel coordinates (x, y) on a 1280x720 screen. You cannot "
            "see the screen - only use coordinates you've been told are correct "
            "for the app you opened, or ones you already verified worked earlier "
            "in this same run."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
                "required": ["x", "y"],
            }
        },
    },
    {
        "name": "type_text",
        "description": "Type text at the current keyboard focus.",
        "inputSchema": {
            "json": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
        },
    },
    {
        "name": "hotkey",
        "description": "Press a key combination, e.g. keys=['ctrl','shift','s'] for Ctrl+Shift+S.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"keys": {"type": "array", "items": {"type": "string"}}},
                "required": ["keys"],
            }
        },
    },
    {
        "name": "key_press",
        "description": "Press a single named key, e.g. 'Return', 'Tab', 'Escape'.",
        "inputSchema": {
            "json": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}
        },
    },
    {
        "name": "shell",
        "description": (
            "Run a real command inside the desktop VM (not via a shell - for "
            "pipes/&&, use cmd='sh', args=['-c', '...']) and get back its real "
            "stdout/stderr/exit code. This is your ONLY way to check whether a "
            "GUI action actually worked, since you have no vision - use it to "
            "read files back (cat), list directories (ls), or check a process "
            "is running, rather than assuming a click or save succeeded."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "cmd": {"type": "string"},
                    "args": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["cmd"],
            }
        },
    },
    {
        "name": "finish",
        "description": "End the run and record the final outcome.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "success": {"type": "boolean"},
                    "proof": {
                        "type": "string",
                        "description": "The exact shell command you ran and its exact output that proves the task's end state - not what you expect it to say.",
                    },
                    "file_path": {
                        "type": "string",
                        "description": "If the task produced a file, its path. This run will independently `cat` it after you finish and compare to expected_content. Leave empty if not applicable.",
                    },
                    "expected_content": {
                        "type": "string",
                        "description": "The exact content the file should contain if the task genuinely succeeded. Leave empty if file_path is empty.",
                    },
                },
                "required": ["summary", "success", "proof"],
            }
        },
    },
]

SYSTEM_PROMPT = """You are Deskbot, an autonomous GUI automation agent driving a real Linux \
desktop (X11, 1280x720) - with NO vision. No available model can see a \
screenshot here, so you must plan and act blind: open apps by name, click \
known coordinates, type, and press keys - and verify your own work with \
`shell`, which is the only ground truth you have. Never claim a GUI action \
worked just because no error was thrown; a click can silently land on the \
wrong element. Check with `shell` (e.g. `cat` the file you expect to exist, \
`ls` a directory) before believing anything happened.

Known-good facts about this environment (from prior verified testing - trust \
these, don't rediscover them):
- mousepad opens in the top-left quadrant of the screen; its text editing \
  area is reliably clickable at (320, 300). Screen-center (640, 360) is \
  already past mousepad's right edge and will focus whatever is behind it \
  instead - always click (320, 300), not the center.
- After open_app, wait for the window to map before clicking (already \
  handled by the tool - it sleeps briefly after opening).
- type_text does NOT turn a "\\n" in the string into a newline in mousepad - \
  it's silently dropped, concatenating your lines onto one. For multi-line \
  text, call type_text once per line and key_press("Return") between lines.
- hotkey(["ctrl","shift","s"]) correctly triggers Mousepad's Save As dialog \
  (confirmed live: the active window becomes "Save As"). Its Name field is \
  already focused when the dialog opens - type_text an absolute path \
  directly into it (e.g. "/root/foo.txt"), then key_press("Return") to \
  confirm. No need to navigate folders by clicking.

Everything else about this environment - the save dialog's exact key \
sequence, whether a keystroke landed - is NOT already known. Figure it out \
empirically: try a keyboard sequence, then use `shell` to check whether it \
had the effect you expected (e.g. did the file actually appear?). If it \
didn't, that's real information - adjust and try again, the same way you'd \
debug anything else. Don't guess repeatedly without checking.

Call `finish` with `proof` that cites the exact shell command and exact \
output you saw - not what you expect it to say. If you never got it fully \
working, set success=false and say honestly what's still broken."""


class Orchestrator:
    def __init__(self, solari_key: str, bedrock_model_id: str, aws_region: str):
        self.toolkit = DesktopToolkit(api_key=solari_key)
        self.client = BedrockClient(model_id=bedrock_model_id, region=aws_region)
        self.transcript: list[dict] = []

    async def run(self, task: str, max_steps: int = 30) -> dict:
        # NOTE: does not close/destroy the desktop itself - the caller needs
        # it still alive to independently verify file_path AFTER this
        # returns. Caller is responsible for calling self.toolkit.close()
        # once verification is done.
        messages: list[dict] = [
            {"role": "user", "content": [{"text": f"Your task:\n\n{task}"}]}
        ]
        result = {"summary": None, "success": False, "proof": None, "file_path": "", "expected_content": ""}

        for _ in range(max_steps):
            response = await self.client.converse(
                system=SYSTEM_PROMPT, messages=messages, tools=MAIN_TOOLS, max_tokens=2048
            )
            content = response["output"]["message"]["content"]
            messages.append({"role": "assistant", "content": content})

            for block in content:
                if "text" in block:
                    self.transcript.append({"role": "assistant", "text": block["text"]})

            tool_uses = [b["toolUse"] for b in content if "toolUse" in b]
            if not tool_uses:
                messages.append(
                    {"role": "user", "content": [{"text": "Continue - call a tool, or `finish` if you're done."}]}
                )
                continue

            # Bedrock (like Claude) can return several tool calls in one
            # turn. Every toolUse block MUST get a matching toolResult in
            # the next message, or the following API call 400s - so
            # resolve all of them, not just the first, before moving on.
            finished = False
            tool_result_blocks = []
            for tool_use in tool_uses:
                name, tool_input, tool_use_id = tool_use["name"], tool_use["input"], tool_use["toolUseId"]
                self.transcript.append({"role": "tool_call", "name": name, "input": tool_input})

                if name == "finish":
                    result.update(tool_input)
                    finished = True
                    break

                tool_result = await self._dispatch(name, tool_input)
                self.transcript.append({"role": "tool_result", "content": tool_result})
                tool_result_blocks.append(
                    {
                        "toolResult": {
                            "toolUseId": tool_use_id,
                            "content": [{"text": tool_result}],
                            "status": "success",
                        }
                    }
                )

            if finished:
                break

            messages.append({"role": "user", "content": tool_result_blocks})
        else:
            result["summary"] = result["summary"] or "Max steps reached without a `finish` call."

        return result

    async def _dispatch(self, name: str, args: dict) -> str:
        # The model occasionally emits a tool call missing a required
        # argument. That's a malformed tool call, not a process-fatal error -
        # report it back as a tool result (same shape every other tool
        # failure uses) so the model sees the mistake and retries, instead
        # of crashing the whole run.
        try:
            if name == "open_app":
                return await self.toolkit.open_app(args["name"])
            if name == "click":
                return await self.toolkit.click(args["x"], args["y"])
            if name == "type_text":
                return await self.toolkit.type_text(args["text"])
            if name == "hotkey":
                return await self.toolkit.hotkey(args["keys"])
            if name == "key_press":
                return await self.toolkit.key_press(args["key"])
            if name == "shell":
                return await self.toolkit.shell(args["cmd"], args.get("args"))
            return f"unknown tool {name!r}"
        except KeyError as e:
            return f"ERROR: {name} call missing required argument {e}"
