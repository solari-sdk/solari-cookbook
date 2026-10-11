"""Top-level agent loop: a Mistral model (via AWS Bedrock) decides which
Solari product to reach for at each step while hunting a real, demonstrable
bug in the target app.

Two products: browser for recon/interaction, sandbox for fast repeatable
HTTP probing. (Desktop/computer-use was dropped — no Mistral model in this
account's Bedrock access supports image input; see qa-agent/README.md.)
"""

from __future__ import annotations

from .bedrock_client import BedrockClient
from .challenges import is_solved
from .solari_tools import SolariToolkit

MAIN_TOOLS = [
    {
        "name": "browser_open",
        "description": "Navigate the cloud browser to a URL. Returns the page title and visible body text.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            }
        },
    },
    {
        "name": "browser_fill",
        "description": (
            "Fill a form field (CSS selector) on the currently open page. The "
            "selector must match exactly one element - if the page has several "
            "identical elements (e.g. one 'Add to Basket' button per product), "
            "scope the selector to a specific one (e.g. via :nth-of-type, a "
            "surrounding container's text, or an id) rather than a bare class/label."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "text": {"type": "string"},
                },
                "required": ["selector", "text"],
            }
        },
    },
    {
        "name": "browser_click",
        "description": (
            "Click an element (CSS selector) on the currently open page. Returns "
            "the resulting page's visible text. Same rule as browser_fill: the "
            "selector must resolve to exactly one element, or it errors."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            }
        },
    },
    {
        "name": "sandbox_exec",
        "description": (
            "Run Python in a persistent stateful kernel (variables/imports survive "
            "between calls). Use this to script raw HTTP requests (stdlib "
            "urllib/http.client - no guaranteed third-party packages) against the "
            "target's API for fast, repeatable probing without driving a full browser."
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
        "name": "finish",
        "description": "End the investigation and record final findings.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "severity": {"type": "string", "enum": ["none", "low", "medium", "high", "critical"]},
                    "proof": {
                        "type": "string",
                        "description": (
                            "The exact request you sent and the exact response you got back "
                            "for each finding (literal credentials/payload submitted; literal "
                            "status code/body received). Do not cite UI state you didn't "
                            "directly cause, or facts you weren't the one to confirm."
                        ),
                    },
                },
                "required": ["summary", "severity", "proof"],
            }
        },
    },
]

SYSTEM_PROMPT = """You are Sentinel, an autonomous QA agent testing {target} - \
a deliberately vulnerable practice application (OWASP Juice Shop), explicitly \
designed and hosted for exactly this kind of security testing. You have two \
tools, corresponding to two of Solari's products:

- browser_open / browser_fill / browser_click: a real cloud browser (Playwright-compatible)
- sandbox_exec: a persistent Python kernel for scripting fast, repeatable HTTP probes

Work like a real tester: recon first (browser_open), form hypotheses about likely
bug classes (injection, broken access control, XSS, business-logic flaws), and
confirm them cheaply and repeatably with sandbox_exec - script raw requests
against the endpoints the browser reveals rather than clicking through the UI
for every test.

This is a SHARED PUBLIC demo instance other people are using concurrently.
UI state you did not directly cause - "challenge solved" banners, pre-filled
data, anything already present when a page loads - may be leftover from other
users' sessions, not something you triggered. Never credit yourself with a
finding based on UI state alone. A finding is only real if you can point to
the exact request you sent and the exact response that proves it (the literal
credentials/payload you submitted and the literal status code/body you got
back) - if you cannot name that specific request/response pair, you have not
confirmed it, no matter how plausible it sounds.

Call `finish` with a concrete, evidence-backed summary - if you found nothing
after a thorough pass, say so honestly rather than inventing a finding."""

CHALLENGE_ADDENDUM = """

Your objective for this run is a SPECIFIC, checkable goal - not open-ended
recon. OWASP Juice Shop's own challenge tracker (the same one behind its
public scoreboard) has this unsolved challenge:

  [{difficulty}★] {name} ({category})
  {description}

Solve this specific challenge. The app exposes a `solved` boolean per
challenge at GET /api/Challenges/ (public, unauthenticated) - after you call
`finish`, this run will independently re-check that endpoint for whether
this challenge's `solved` flag actually flipped to true. That is a
cross-check on top of your proof, not a replacement for it: this is a
SHARED public instance, so another concurrent user solving the same
challenge would also flip the flag. Your `finish` proof (the exact
request/response that solved it) is still the primary evidence."""


class Orchestrator:
    def __init__(self, solari_key: str, bedrock_model_id: str, aws_region: str):
        self.toolkit = SolariToolkit(api_key=solari_key)
        self.client = BedrockClient(model_id=bedrock_model_id, region=aws_region)
        self.transcript: list[dict] = []

    async def run(self, target_url: str, max_steps: int = 20, challenge: dict | None = None) -> dict:
        messages: list[dict] = [
            {"role": "user", "content": [{"text": f"Begin your investigation of {target_url}."}]}
        ]
        system = SYSTEM_PROMPT.format(target=target_url)
        if challenge:
            system += CHALLENGE_ADDENDUM.format(**challenge)
        result = {"summary": None, "severity": "none", "proof": None}

        try:
            for _ in range(max_steps):
                response = await self.client.converse(
                    system=system, messages=messages, tools=MAIN_TOOLS, max_tokens=2048
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
        finally:
            await self.toolkit.close()

        if challenge:
            result["challenge"] = challenge
            try:
                result["challenge_verified"] = is_solved(target_url, challenge["id"])
            except Exception as e:
                result["challenge_verified"] = None
                result["challenge_verify_error"] = str(e)

        return result

    async def _dispatch(self, name: str, args: dict) -> str:
        # The model occasionally emits a tool call missing a required
        # argument (e.g. sandbox_exec with no `code`). That's a malformed
        # tool call, not a process-fatal error - report it back as a tool
        # result (same shape every other tool failure uses) so the model
        # sees the mistake and retries, instead of crashing the whole run.
        try:
            if name == "browser_open":
                return await self.toolkit.browser_open(args["url"])
            if name == "browser_fill":
                return await self.toolkit.browser_fill(args["selector"], args["text"])
            if name == "browser_click":
                return await self.toolkit.browser_click(args["selector"])
            if name == "sandbox_exec":
                return await self.toolkit.sandbox_exec(args["code"])
            return f"unknown tool {name!r}"
        except KeyError as e:
            return f"ERROR: {name} call missing required argument {e}"
