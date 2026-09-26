// SPDX-License-Identifier: AGPL-3.0-only
// The chat tab's fixture stream (mirrors FIXTURE in test/chat.test.tsx): the
// hello-world server run in @wsp/protocol vocabulary, one turn end to end,
// stamped with at, turnId and harness the way the runtime emits them. One
// difference from the chat test's copy: tool_use.text is the JSON input the
// adapter really sends, not the bare command string.
import type { SessionEvent } from "@wsp/protocol";

export const CHAT_WS = "ws_chat0001";
export const CHAT_TURN = "turn_0001";
const scope = { workspaceId: CHAT_WS, sessionId: "sess_0001", turnId: CHAT_TURN };
export const CHAT_T0 = Date.parse("2026-09-01T01:31:29.412Z");
const at = (ms: number) => ({ at: CHAT_T0 + ms });
export const CHAT_HARNESS = { slashCommands: ["compact", "context", "cost", "init", "review"], permissionMode: "bypassPermissions", agents: ["general-purpose"] };

export const CHAT_STREAM: ReadonlyArray<SessionEvent> = [
  { type: "session.start", ...scope, ...at(0), model: "claude-sonnet-4-5", cwd: "/root", tools: ["Bash", "Read"], harness: CHAT_HARNESS },
  { type: "session.delta", ...scope, ...at(1_200), kind: "text", text: "Creating the server file, " },
  { type: "session.delta", ...scope, ...at(1_450), kind: "text", text: "then starting it." },
  {
    type: "session.delta", ...scope, ...at(4_495), kind: "tool_use", toolName: "Bash", toolUseId: "toolu_01WspFixBash1",
    text: JSON.stringify({ command: "node /root/server.js >/dev/null 2>&1 & sleep 0.3 && curl -s http://localhost:3000" }),
  },
  { type: "session.delta", ...scope, ...at(5_708), kind: "tool_result", toolUseId: "toolu_01WspFixBash1", text: "Hello, World!", isError: false },
  { type: "session.delta", ...scope, ...at(7_900), kind: "thinking", text: "curl returned the greeting, so the server is live." },
  { type: "session.delta", ...scope, ...at(9_300), kind: "text", text: "Server is live at :3000." },
  { type: "session.done", ...scope, ...at(10_458), result: { status: "completed", durationMs: 10458, costUsd: 0.0187, text: "Server is live at :3000." } },
  { type: "session.end", ...scope, ...at(10_600), exitCode: 0, sawResult: true },
];
