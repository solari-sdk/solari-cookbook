import { readFileSync } from 'node:fs';
import { solariEnv } from './backend/credentials.ts';
import { solariBackendFromEnv } from './backend/solari.ts';
import type { Backend } from './backend/types.ts';
import { main } from './cli.ts';
import { realHost } from './host.ts';
import { interruptible } from './interrupt.ts';
import { processIo } from './io.ts';

// Same relative location from src/ (dev) and dist/ (published).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const host = realHost();
const io = processIo();
const argv = process.argv.slice(2);
const solari = async () =>
  solariBackendFromEnv(await solariEnv(host.env, process.cwd(), host.readTextFile));

/** One backend per process; a failed setup (say, no key yet) is retried on the next call. */
function reuse(make: () => Promise<Backend>): () => Promise<Backend> {
  let pending: Promise<Backend> | undefined;
  return () => {
    pending ??= make().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
process.exitCode = await main(argv, {
  io,
  host,
  cwd: process.cwd(),
  version: pkg.version,
  // The MCP server releases its own machines when its session ends.
  getBackend:
    argv[0] === 'mcp'
      ? reuse(solari)
      : interruptible(solari, { signals: process, stderr: io.stderr }),
});
