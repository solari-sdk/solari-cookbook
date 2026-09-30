import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMcpServer } from '../mcp/server.ts';
import { closeWhenAnswered } from '../mcp/transport.ts';
import { type Command, type CommandContext, capsuleSource } from './context.ts';

const USAGE = `Usage: twin mcp

Serves twin's tools to AI coding agents over MCP (stdio): inspect, replay, run,
write_file, verify, bisect and release. An agent can rebuild the reporter's
environment, debug inside it and check its fix there.

Needs SOLARI_API_KEY in the server's environment. For example, in Claude Code:

  claude mcp add twin -e SOLARI_API_KEY=slr_live_... -- npx -y @crypticsaiyan/twincli mcp

Machines kept during the session are released when it ends.`;

/**
 * stdout carries the protocol, so stray console output (from dependencies) goes to stderr. The
 * session ends when the client closes stdin (once calls already made are answered) or stops the
 * process.
 */
function stdioTransport(): Transport {
  console.log = console.info = console.debug = console.error;
  const transport = closeWhenAnswered(new StdioServerTransport(), process.stdin);
  const stop = () => void transport.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return transport;
}

export function mcpCommandWith(openTransport: () => Transport): Command {
  async function run(args: string[], context: CommandContext): Promise<number> {
    const { values } = parseArgs({
      args,
      options: { help: { type: 'boolean', short: 'h', default: false } },
    });
    if (values.help) {
      context.io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const { server, close } = createMcpServer({
      version: context.version,
      capsules: capsuleSource(context),
      getBackend: context.getBackend,
    });
    const closed = new Promise<void>((resolve) => {
      server.server.onclose = resolve;
    });
    await server.connect(openTransport());
    await closed;
    await close();
    return 0;
  }
  return {
    name: 'mcp',
    group: 'agents',
    summary: 'serve twin to AI coding agents over MCP',
    usage: USAGE,
    run,
  };
}

export const mcpCommand = mcpCommandWith(stdioTransport);
