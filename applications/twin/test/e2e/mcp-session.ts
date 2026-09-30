// Drives `twin mcp` over real stdio the way a coding agent would, on the echarts example:
// inspect, replay (kept), run the failing test, write and apply the fix, rerun, verify, release.
// Usage: SOLARI_API_KEY=... node test/e2e/mcp-session.ts
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const example = 'examples/echarts-21538';
const capsule = `${example}/new-york.json`;
const patch = readFileSync(`${example}/fix.patch`, 'utf8');
const jest =
  'npx jest --config test/ut/jest.config.cjs --coverage=false test/ut/spec/util/time.test.ts 2>&1 | grep -E "✓|✕|Tests:|Expected|Received"';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/bin.ts', 'mcp'],
  env: { ...process.env } as Record<string, string>,
  stderr: 'inherit',
});
const client = new Client({ name: 'twin-e2e', version: '1' });
await client.connect(transport);

const started = Date.now();
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const shown = Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      typeof v === 'string' && v.length > 60 ? `<${v.length} chars>` : v,
    ]),
  );
  console.log(`\n>>> ${name} ${JSON.stringify(shown)}`);
  const t = Date.now();
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 15 * 60_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => console.log(`  ... ${p.message}`),
  })) as CallToolResult;
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  console.log(
    `<<< ${result.isError ? 'error, ' : ''}${((Date.now() - t) / 1000).toFixed(0)} s\n${text}`,
  );
  return text;
}

try {
  await call('inspect', { capsule });
  const replayed = await call('replay', { capsule, attempts: 1 });
  const machine = replayed.match(/^ {2}machine (\S+)$/m)?.[1];
  if (!machine) throw new Error('replay did not keep a machine');
  await call('run', { machine, command: `echo "TZ=$TZ node $(node --version)"; pwd; ${jest}` });
  await call('write_file', { machine, path: 'fix.patch', content: patch });
  await call('run', { machine, command: `git apply fix.patch && ${jest}` });
  await call('verify', { capsule, patch, attempts: 1 });
  await call('release', { machine });
} finally {
  await client.close();
  console.log(`\nsession ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
