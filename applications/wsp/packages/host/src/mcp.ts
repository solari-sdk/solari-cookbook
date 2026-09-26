// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs as MCP tools for an agent on this computer, over stdio: every
// entry of the verb table registered under the one naming rule, through the
// same socket client the command line uses, one dial kept across calls and
// dialled again after the host went away. A thread opened here is the local
// agent's. Nothing here reads a key or imports the runtime.
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { INSTRUCTIONS } from "./skill.js";
import { VERBS, c1Escaped, dialHost, hasTool, toolFailure, toolName, type DialOpts, type HostClient, type Verb, type VerbDeps } from "./verbs.js";
import { VERSION } from "./version.js";

export interface Dialer {
  (): Promise<HostClient>;
  close(): Promise<void>;
}

/** One socket to the host across tool calls, dropped when it closes so the next call dials again. Which host that
 * is comes from the same reading the command line takes, so `wsp mcp --host <alias>` serves the tools against the
 * host on another computer that alias names. */
export function dialer(statePath: string, pick: DialOpts = {}): Dialer {
  let client: Promise<HostClient> | undefined;
  const dial = (): Promise<HostClient> =>
    (client ??= dialHost(statePath, pick).then(
      c => {
        void c.closed.then(() => {
          client = undefined;
        });
        return c;
      },
      (e: unknown) => {
        client = undefined;
        throw e;
      },
    ));
  return Object.assign(dial, {
    close: async () => {
      const open = client;
      client = undefined;
      if (open !== undefined) await open.then(c => c.close(), () => undefined);
    },
  });
}

/** Which host the tools go to, off the words the server was started with: the same reading the command line takes. */
const pickOf = (opts: { env: VerbDeps["env"]; host?: string; start?: VerbDeps["start"] }): DialOpts => ({
  env: opts.env,
  ...(opts.host !== undefined ? { host: opts.host } : {}),
  ...(opts.start !== undefined ? { start: opts.start } : {}),
});

export function mcpServer(statePath: string, opts: { dial?: Dialer; alsoHere?: VerbDeps["alsoHere"]; cwd?: string; env: VerbDeps["env"]; host?: string; start?: VerbDeps["start"]; skip?: (verb: Verb) => boolean; elsewhere?: boolean }): McpServer {
  const server = new McpServer({ name: "wsp", version: VERSION }, { instructions: INSTRUCTIONS });
  const deps: VerbDeps = { statePath, env: opts.env, client: opts.dial ?? dialer(statePath, pickOf(opts)), ...(opts.alsoHere !== undefined ? { alsoHere: opts.alsoHere } : {}), ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts.elsewhere === true ? { elsewhere: true } : {}) };
  for (const verb of VERBS) {
    if (!hasTool(verb) || opts.skip?.(verb) === true) continue;
    server.registerTool(toolName(verb.name), { description: verb.tool.description, inputSchema: verb.tool.input, outputSchema: verb.tool.output }, args => verb.tool.call(args, deps).catch((e: unknown) => toolFailure(e, "usage" in verb ? verb.usage : undefined)));
  }
  return server;
}

/** The server on stdio until the agent is done with it: its stdin ending closes the transport, and the host socket with it. */
export async function serveMcp(statePath: string, opts: { alsoHere?: VerbDeps["alsoHere"]; cwd?: string; env: VerbDeps["env"]; host?: string; start?: VerbDeps["start"] }, streams: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }): Promise<void> {
  const dial = dialer(statePath, pickOf(opts));
  const server = mcpServer(statePath, { dial, ...opts });
  const transport = new StdioServerTransport(streams.input, c1Escaped(streams.output));
  const closed = new Promise<void>(done => {
    server.server.onclose = () => done();
  });
  streams.input.once("end", () => void transport.close());
  await server.connect(transport);
  await closed;
  await dial.close();
}
