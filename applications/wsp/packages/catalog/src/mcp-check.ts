// SPDX-License-Identifier: AGPL-3.0-only
// How an agent's own harness answers for one MCP server's sign-in: the line
// that asks it and how its words about that server read. A server
// behind a sign-in keeps its token where the harness put it, which wsp never
// reads, so the harness's word is the only one there is. One module per
// harness, registered on its catalog entry, each read against the version
// named on it; words that are not the measured ones answer nothing.
import { shellQuote, type McpAuth } from "@wsp/protocol";

export interface McpCheck {
  /** The harness and version the words were read off. */
  measured: string;
  /** The line that asks the harness for one server's sign-in, and starts no command server. */
  line(name: string): string;
  /** The server's sign-in off what the line printed; nothing where the words are not the measured ones. */
  auth(output: string): McpAuth | undefined;
}

/** `claude mcp get <name>` health-checks the one server and prints a `Status:` line. */
export const CLAUDE_MCP_CHECK: McpCheck = {
  measured: "claude 2.1.281",
  line: name => `claude mcp get ${shellQuote(name)}`,
  auth: output => {
    const status = /^\s*Status:\s*(.*)$/m.exec(output)?.[1] ?? "";
    if (status.includes("Needs authentication")) return "needs-sign-in";
    if (status.includes("Failed to connect")) return "failed";
    if (status.includes("Connected")) return "signed-in";
    return undefined;
  },
};
