// SPDX-License-Identifier: AGPL-3.0-only
// How an agent's own harness signs one MCP server in: the command that runs
// the harness's sign-in for that server and how it finishes, or the line the
// person types inside the harness's own session where it has no command.
// One module per harness, registered on its catalog entry.
import { shellQuote, type PageReach } from "@wsp/protocol";

export type McpLogin =
  /** A command run in a pty on the computer the server is set up on, whose page returns to localhost on the computer the
   * browser is on. `pasted`: the same sign-in printing its page and taking back the address the browser landed on,
   * which finishes from any computer. */
  | { measured: string; command(name: string): string; pasted?(name: string): string }
  /** The harness signs a server in only inside its own session: the line typed there. */
  | { measured: string; inside(name: string): string };

/** Without `--no-browser` it opens the page through $BROWSER, or `open`, and its own listener takes the redirect. */
export const CLAUDE_MCP_LOGIN: McpLogin = {
  measured: "claude 2.1.282",
  command: name => `claude mcp login ${shellQuote(name)}`,
  pasted: name => `claude mcp login ${shellQuote(name)} --no-browser`,
};

/** No flag for a headless run: the page returns to a port the command listens on. */
export const CODEX_MCP_LOGIN: McpLogin = { measured: "codex-cli 0.155.1", command: name => `codex mcp login ${shellQuote(name)}` };

export const OPENCODE_MCP_LOGIN: McpLogin = { measured: "opencode 1.18.18", command: name => `opencode mcp auth ${shellQuote(name)}` };

/** Gemini CLI has no command for it: `/mcp auth` inside a session. */
export const GEMINI_MCP_LOGIN: McpLogin = { measured: "gemini docs", inside: name => `/mcp auth ${name}` };

/** Where one server's sign-in runs: in a watched pty on that computer, or as the line the person runs there
 * themselves, with why. */
export type ServerSignInRoad = { kind: "pty"; command: string; finish: "code" | "callback" } | { kind: "copy"; line: string; why: "inside" | "callback" };

/** The road for one server under this harness's module. */
export function loginRoad(login: McpLogin, name: string, reach: PageReach): ServerSignInRoad {
  if ("inside" in login) return { kind: "copy", line: login.inside(name), why: "inside" };
  if (reach !== "none") return { kind: "pty", command: login.command(name), finish: "callback" };
  return login.pasted !== undefined ? { kind: "pty", command: login.pasted(name), finish: "code" } : { kind: "copy", line: login.command(name), why: "callback" };
}
