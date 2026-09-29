"""Top-level agent loop: a Mistral model (via AWS Bedrock) writes code, runs
it inside a Solari sandbox, reads the real stdout/stderr/exit code, and
self-debugs until the task actually works - a "write, run, fix" loop, not a
single code-generation call.

Sandbox only, deliberately - this is the sandbox-focused submission split
out from qa-agent's browser+sandbox one. See code-agent/README.md.
"""

from __future__ import annotations

from .bedrock_client import BedrockClient
from .solari_tools import SandboxToolkit

MAIN_TOOLS = [
    {
        "name": "write_file",
        "description": "Write a file inside the sandbox, creating parent directories as needed.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            }
        },
    },
    {
        "name": "run_command",
        "description": (
            "Run a command to completion inside the sandbox (not via a shell - "
            "for shell syntax like pipes/&&, run cmd='sh', args=['-c', '...']). "
            "Returns the real exit code, stdout, and stderr. Set background=true "
            "for a long-lived process (e.g. a server you'll then expose with "
            "expose_port) so this call returns immediately instead of blocking "
            "until the idle timeout."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "cmd": {"type": "string"},
                    "args": {"type": "array", "items": {"type": "string"}},
                    "background": {"type": "boolean"},
                },
                "required": ["cmd"],
            }
        },
    },
    {
        "name": "run_code",
        "description": (
            "Run Python in a persistent stateful kernel (variables/imports survive "
            "between calls). Useful for quick checks and computations without "
            "writing a whole file."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"code": {"type": "string"}},
                "required": ["code"],
            }
        },
    },
    {
        "name": "expose_port",
        "description": (
            "Expose a port your background process is listening on as a public "
            "*.preview.getsolari.com URL, reachable from the open internet."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"port": {"type": "integer"}},
                "required": ["port"],
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
                        "description": (
                            "The exact command you ran and the exact output you got back "
                            "(literal stdout/stderr/exit code). Do not claim something "
                            "works based on the code merely existing or 'looking right' - "
                            "cite the specific run that proves it."
                        ),
                    },
                    "service_url": {
                        "type": "string",
                        "description": (
                            "If the task produced a running service, the full URL "
                            "(from expose_port, plus any path/query needed) to fetch "
                            "to see it working. Leave empty if not applicable. This "
                            "run will independently re-fetch this URL AFTER you finish "
                            "- only set it if you're confident it's live right now."
                        ),
                    },
                    "verify_contains": {
                        "type": "string",
                        "description": (
                            "A substring you expect in service_url's response body if "
                            "it's genuinely working. Leave empty if service_url is empty."
                        ),
                    },
                },
                "required": ["summary", "success", "proof"],
            }
        },
    },
]

SYSTEM_PROMPT = """You are Forge, an autonomous coding agent. You are given a task in \
plain English. You have a Solari sandbox (an isolated microVM) to work in, via \
four tools:

- write_file: write source files
- run_command: run a command to completion, or in the background for a long-lived process
- run_code: a persistent Python kernel, for quick checks
- expose_port: turn a background process's listening port into a public URL

Work like a real engineer, not a one-shot code generator: write the code, RUN \
it, read the actual stdout/stderr/exit code, and fix whatever's actually wrong \
- don't just re-read your own code and assume it's correct. Iterate until you \
have a real passing run, not a plausible-looking one.

If the task involves a running service: start it with run_command \
(background=true), expose it with expose_port, then make a real request to \
the exposed URL yourself (run_command or run_code, e.g. curl or urllib) \
BEFORE calling finish, so you know it actually works from outside the sandbox \
- not just that the process started without crashing.

Call `finish` with `proof` that cites the exact command and exact output that \
demonstrates success - not what you expect the output to be, what you actually \
saw. If you never got it fully working, set success=false and say honestly \
what's still broken; don't claim a partial or untested result works."""


class Orchestrator:
    def __init__(self, solari_key: str, bedrock_model_id: str, aws_region: str):
        self.toolkit = SandboxToolkit(api_key=solari_key)
        self.client = BedrockClient(model_id=bedrock_model_id, region=aws_region)
        self.transcript: list[dict] = []

    async def run(self, task: str, max_steps: int = 25) -> dict:
        # NOTE: does not close/kill the sandbox itself - if the task exposes a
        # service, that service lives inside this same sandbox, and the
        # caller needs it still running to independently verify service_url
        # AFTER this returns. Caller is responsible for calling
        # self.toolkit.close() once verification is done.
        messages: list[dict] = [
            {"role": "user", "content": [{"text": f"Your task:\n\n{task}"}]}
        ]
        result = {"summary": None, "success": False, "proof": None, "service_url": "", "verify_contains": ""}

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
            if name == "write_file":
                return await self.toolkit.write_file(args["path"], args["content"])
            if name == "run_command":
                return await self.toolkit.run_command(
                    args["cmd"], args.get("args"), args.get("background", False)
                )
            if name == "run_code":
                return await self.toolkit.run_code(args["code"])
            if name == "expose_port":
                return await self.toolkit.expose_port(args["port"])
            return f"unknown tool {name!r}"
        except KeyError as e:
            return f"ERROR: {name} call missing required argument {e}"
