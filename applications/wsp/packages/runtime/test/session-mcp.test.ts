// SPDX-License-Identifier: AGPL-3.0-only
// What MCP servers named on a start come to: the adapter that declares it
// renders them gets them, and the one that declares nothing is refused in that
// agent's name before its machine is asked for anything. A launch that dropped
// them would open a thread whose tools are missing and whose agent looks like
// it ignored the ones its message named.
import { describe, expect, it } from "vitest";
import { noMcpServersLine, type AdapterEvent, type McpServerSpec, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const WSP: McpServerSpec = { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"] };

/** An adapter that records its starts, declaring the MCP road or not as the case is about. */
function recording(takes: boolean): { factory: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    ...(takes ? { mcpServers: true as const } : {}),
    start: (options: HarnessStartOptions) => {
      starts.push(options);
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId: SESSION_ID },
          { type: "turn.done", sessionId: SESSION_ID, result },
          { type: "session.end", sessionId: SESSION_ID, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) options.onEvent(e);
        return result;
      })();
      return { localId: SESSION_ID, finished, interrupt: async () => {} };
    },
  });
  return { factory, starts };
}

async function workspaceOn(adapters: Record<string, HarnessAdapterFactory>) {
  const backend = stubBackend();
  const rt = createRuntime({ backend, store: memoryStore(), adapters });
  const ws = await createOn(rt, { golden: "snap_g", name: "tools" });
  const mark = backend.machines[0]!.execLog.length;
  return { rt, ws, execs: () => backend.machines[0]!.execLog.slice(mark) };
}

describe("MCP servers named on a start", () => {
  it("reach the adapter that declares it renders them", async () => {
    const claude = recording(true);
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { harness: "claude", prompt: "write the recipe", mcpServers: { wsp: WSP } })).finished;
    expect(claude.starts[0]!.mcpServers).toEqual({ wsp: WSP });
  });

  it("are refused in the agent's name on an adapter that declares nothing, before the machine is asked, and no thread opens", async () => {
    const codex = recording(false);
    const { rt, ws, execs } = await workspaceOn({ codex: codex.factory });
    await expect(rt.sessions.start(ws.id, { harness: "codex", prompt: "write the recipe", mcpServers: { wsp: WSP } })).rejects.toThrow(noMcpServersLine("codex"));
    expect(codex.starts).toHaveLength(0);
    expect(execs()).toEqual([]);
    expect(await rt.sessions.list(ws.id)).toEqual([]);
  });

  it("takes the same message without them, since only the servers were the trouble", async () => {
    const codex = recording(false);
    const { rt, ws } = await workspaceOn({ codex: codex.factory });
    await (await rt.sessions.start(ws.id, { harness: "codex", prompt: "write the recipe" })).finished;
    expect(codex.starts).toHaveLength(1);
    expect(codex.starts[0]!.mcpServers).toBeUndefined();
  });

  it("an empty set is no servers at all, so it is not refused", async () => {
    const codex = recording(false);
    const { rt, ws } = await workspaceOn({ codex: codex.factory });
    await (await rt.sessions.start(ws.id, { harness: "codex", prompt: "hello", mcpServers: {} })).finished;
    expect(codex.starts).toHaveLength(1);
  });
});
