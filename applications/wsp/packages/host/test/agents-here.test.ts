// SPDX-License-Identifier: AGPL-3.0-only
// The agents the desktop's first run lists: the catalog's, each found or not
// by the recipe scan's own detector, and whether its config already names the
// wsp server.
import { CATALOG_AGENTS } from "@wsp/catalog";
import { describe, expect, it } from "vitest";
import { fakeHost } from "../../collect/test/fake-host.js";
import { agentsHere } from "../src/agents-here.js";

describe("agentsHere", () => {
  it("lists every catalog agent in catalog order, found by the recipe scan's presence rule, configured when its MCP config names wsp", async () => {
    const host = fakeHost({
      files: {
        "~/.claude/settings.json": "{}",
        "~/.claude.json": JSON.stringify({ mcpServers: { wsp: { command: "/Users/dev/.wsp/bin/wsp", args: ["mcp"] } } }),
        "~/.codex/config.toml": "[mcp_servers.other]\ncommand = \"x\"\n",
      },
      which: ["pi", "codex"],
      exec: { "codex --version": "codex-cli 0.153.0\n", "pi --version": "not a version" },
    });
    const rows = await agentsHere(host);
    expect(rows.map(r => r.id)).toEqual(CATALOG_AGENTS.map(a => a.id));
    expect(rows.map(r => [r.id, r.found, r.configured])).toEqual([
      ["claude", true, true],
      ["codex", true, false],
      ["gemini", false, false],
      ["opencode", false, false],
      ["pi", true, false],
      ["hermes", false, false],
      ["crush", false, false],
      ["qwen", false, false],
      ["goose", false, false],
      ["amp", false, false],
    ]);
    // The version is read off the command when it is on PATH, the number alone; a command that answers without one
    // or that is not on PATH gives none.
    expect(rows[0]).toEqual({ id: "claude", name: "Claude Code", found: true, configured: true });
    expect(rows[1]).toEqual({ id: "codex", name: "Codex", found: true, configured: false, version: "0.153.0" });
    expect(rows[4]).toEqual({ id: "pi", name: "Pi", found: true, configured: false });
  });

  it("reads a config that is not its format as naming nothing", async () => {
    const host = fakeHost({ files: { "~/.claude.json": "not json" } });
    const rows = await agentsHere(host);
    expect(rows.find(r => r.id === "claude")).toEqual({ id: "claude", name: "Claude Code", found: true, configured: false });
  });
});
