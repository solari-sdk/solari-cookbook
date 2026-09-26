// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLAUDE_MCP_CHECK, MCP_AGENTS } from "../src/index.js";

// `claude mcp get <name>` as Claude Code 2.1.281 printed it; the first is this computer's own answer for a server.
const transcript = (status: string): string => `notion:\n  Scope: User config (available in all your projects)\n  Status: ${status}\n\nTo remove this server, run: claude mcp remove notion -s user\n`;

describe("the harness's own word on one server's sign-in", () => {
  it("reads Claude Code's status line as the sign-in it stands for, and nothing where the words are not the measured ones", () => {
    expect(CLAUDE_MCP_CHECK.line("notion")).toBe("claude mcp get 'notion'");
    expect(CLAUDE_MCP_CHECK.auth(transcript("✔ Connected"))).toBe("signed-in");
    expect(CLAUDE_MCP_CHECK.auth(transcript("⚠ Needs authentication"))).toBe("needs-sign-in");
    expect(CLAUDE_MCP_CHECK.auth(transcript("✘ Failed to connect"))).toBe("failed");
    expect(CLAUDE_MCP_CHECK.auth(transcript("⏸ Pending approval"))).toBeUndefined();
    expect(CLAUDE_MCP_CHECK.auth("No MCP server found with name: notion\n")).toBeUndefined();
  });

  it("is registered on the agents whose check was measured, and no other agent guesses one", () => {
    expect(Object.fromEntries(MCP_AGENTS.map(a => [a.id, a.mcp.check]))).toEqual({ claude: CLAUDE_MCP_CHECK, codex: undefined, gemini: undefined, opencode: undefined });
  });
});
