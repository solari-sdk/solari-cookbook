import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeMachine, type FakeResponder } from '../../src/backend/fake.ts';
import { serializeCapsule } from '../../src/capsule/file.ts';
import type { Capsule } from '../../src/capsule/schema.ts';
import { main } from '../../src/cli.ts';
import { mcpCommandWith } from '../../src/commands/mcp.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { FIX_PATCH_PATH } from '../../src/replay/runtimes.ts';
import { RUN_SCRIPT } from '../../src/shell/guest.ts';
import { failureIdentity } from '../../src/signature/signature.ts';
import { makeCapsule } from '../helpers/capsule.ts';
import { fakeHost, fakeIo, useTempDirs, writeTree } from '../helpers/fakes.ts';

const FAILURE = 'AssertionError: expected 1 to be 2';
const FIX = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-bug\n+fix\n';

function failingCapsule(): Capsule {
  const base = makeCapsule();
  return makeCapsule({
    command: {
      ...base.command,
      failure: { ...failureIdentity({ exitCode: 1, signal: null }, FAILURE), outputTail: FAILURE },
    },
  });
}

const isCommand = (argv: readonly string[]) => argv.includes('exec "$@"');

/** Fails like the capsule until a fix is applied; kept machines answer run.sh commands. */
function agentBackend(extra: FakeResponder = () => undefined) {
  const patched = new Set<FakeMachine>();
  return new FakeBackend((spec, machine) => {
    const own = extra(spec, machine);
    if (own) return own;
    if (spec.argv.join(' ') === `git apply --whitespace=nowarn ${FIX_PATCH_PATH}`) {
      patched.add(machine);
    }
    if (spec.argv[0] === RUN_SCRIPT && spec.argv[1] === 'pwd') {
      return { exitCode: 0, output: '/tmp/twin/repo\n' };
    }
    if (isCommand(spec.argv)) {
      return patched.has(machine) ? { exitCode: 0 } : { exitCode: 1, output: FAILURE };
    }
    return undefined;
  });
}

const sessions: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function connect(backend: FakeBackend, options: { cwd?: string; fetch?: typeof fetch } = {}) {
  const twin = createMcpServer({
    version: '9.9.9',
    capsules: { cwd: options.cwd ?? '/', fetch: options.fetch ?? fakeHost().fetch },
    getBackend: async () => backend,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await twin.server.connect(serverSide);
  await client.connect(clientSide);
  const session = {
    client,
    close: async () => {
      await client.close();
      await twin.close();
    },
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const first = result.content[0];
      return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
    },
    closeServer: () => twin.close(),
  };
  sessions.push(session);
  return session;
}

async function capsuleFiles(tempDir: () => Promise<string>) {
  const dir = await tempDir();
  const base = makeCapsule();
  const good = makeCapsule({
    command: { ...base.command, outcome: 'pass', failure: null },
    env: { ...base.env, NODE_ENV: { state: 'set', value: 'production' } },
  });
  await writeTree(dir, {
    'bad.json': serializeCapsule(failingCapsule()),
    'good.json': serializeCapsule(good),
  });
  return dir;
}

describe('twin MCP server', () => {
  const tempDir = useTempDirs();

  it('describes itself and its tools to the agent', async () => {
    const { client } = await connect(agentBackend());
    expect(client.getServerVersion()).toMatchObject({ name: 'twin', version: '9.9.9' });
    expect(client.getInstructions()).toContain('replay it. If the failure reproduces');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'inspect',
      'replay',
      'run',
      'write_file',
      'verify',
      'bisect',
      'release',
    ]);
    expect(tools.find((t) => t.name === 'release')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'run')?.inputSchema.required).toEqual(['command']);
  });

  it('inspects a capsule from a URL, and diffs two local capsules', async () => {
    const dir = await capsuleFiles(tempDir);
    const fetch: typeof globalThis.fetch = async () =>
      new Response(serializeCapsule(failingCapsule()));
    const { call } = await connect(agentBackend(), { cwd: dir, fetch });
    const summary = await call('inspect', { capsule: 'https://example.com/twin-capsule.json' });
    expect(summary.isError).toBe(false);
    expect(summary.text).toContain('npm test');
    const diff = await call('inspect', { capsule: 'bad.json', compare_to: 'good.json' });
    expect(diff.text).toContain('bad.json');
    const missing = await call('inspect', { capsule: 'nope.json' });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toMatch(/^twin: cannot read .*nope\.json: ENOENT/);
  });

  it('replays, keeps the reproduced failure and reports progress', async () => {
    const dir = await capsuleFiles(tempDir);
    const backend = agentBackend();
    const { client, call } = await connect(backend, { cwd: dir });
    const progress: string[] = [];
    const result = (await client.callTool(
      { name: 'replay', arguments: { capsule: 'bad.json', attempts: 1 } },
      undefined,
      { onprogress: (p) => progress.push(p.message ?? '') },
    )) as CallToolResult;
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('REPRODUCED');
    expect(text).toContain('machine sbx_fake0');
    expect(text).toContain('run and write_file');
    expect(text).not.toContain('twin shell');
    expect(progress).toContain('machine sbx_fake0 ready');
    expect(progress).toContain('attempt 1/1');
    expect(backend.machines[0]?.killed).toBe(false);

    const quiet = await call('replay', { capsule: 'bad.json', attempts: 1, keep: false });
    expect(quiet.text).toContain('REPRODUCED');
    expect(backend.machines[1]?.killed).toBe(true);
  });

  it('runs commands and writes files in the kept machine, by id prefix', async () => {
    const dir = await capsuleFiles(tempDir);
    const backend = agentBackend((spec) => {
      if (spec.argv[0] !== RUN_SCRIPT) return undefined;
      if (spec.argv[1] === 'npm test')
        return { exitCode: 1, output: `${FAILURE}\n`, durationMs: 2500 };
      if (spec.argv[1] === 'sleep 999') return { exitCode: null, timedOut: true };
      return undefined;
    });
    const { call } = await connect(backend, { cwd: dir });
    await call('replay', { capsule: 'bad.json', attempts: 1 });
    const machine = backend.machines[0] as FakeMachine;

    expect(await call('run', { command: 'npm test' })).toEqual({
      text: `exit 1 (2.5s)\n${FAILURE}`,
      isError: false,
    });
    const run = machine.runs.find((spec) => spec.argv[1] === 'npm test');
    expect(run).toMatchObject({ argv: [RUN_SCRIPT, 'npm test'], timeoutMs: 300_000 });
    expect(
      (await call('run', { machine: 'sbx_fake', command: 'sleep 999', timeout_seconds: 2 })).text,
    ).toBe('timed out after 2s (0.0s)');

    const wrote = await call('write_file', { path: 'src/a.ts', content: 'fix\n' });
    expect(wrote.text).toBe('wrote 4 bytes to /tmp/twin/repo/src/a.ts');
    expect(machine.files.get('/tmp/twin/repo/src/a.ts')).toBe('fix\n');
    expect(machine.runs.some((spec) => spec.argv.join(' ') === 'mkdir -p /tmp/twin/repo/src')).toBe(
      true,
    );
    await call('write_file', { path: '/etc/x.conf', content: '' });
    expect(machine.files.has('/etc/x.conf')).toBe(true);
    // The working directory is looked up once per machine.
    expect(machine.runs.filter((spec) => spec.argv[1] === 'pwd')).toHaveLength(1);
  });

  it('refuses machines that replay did not keep and explains missing ones', async () => {
    const backend = new FakeBackend((spec) =>
      spec.argv.join(' ') === `test -x ${RUN_SCRIPT}` ? { exitCode: 1 } : undefined,
    );
    await backend.create({ labels: { app: 'twin' }, idleTimeoutMs: 1 });
    const { call } = await connect(backend);
    const refused = await call('run', { command: 'ls' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('was not kept by `twin replay --keep`');
    expect(backend.machines[0]?.detached).toBe(true);
    const none = await call('run', { machine: 'zzz', command: 'ls' });
    expect(none.text).toContain('no running twin machine starts with "zzz"');
  });

  it('verifies a patch on a fresh machine and checks its arguments', async () => {
    const dir = await capsuleFiles(tempDir);
    const backend = agentBackend();
    const { call } = await connect(backend, { cwd: dir });
    const fixed = await call('verify', { capsule: 'bad.json', patch: FIX, attempts: 1 });
    expect(fixed.text).toContain('FIXED');
    // The first machine runs the command without the fix, the second with it.
    expect(backend.machines[0]?.files.has(FIX_PATCH_PATH)).toBe(false);
    expect(backend.machines[1]?.files.get(FIX_PATCH_PATH)).toBe(FIX);
    expect(backend.machines.every((machine) => machine.killed)).toBe(true);

    const both = await call('verify', { capsule: 'bad.json', patch: FIX, ref: 'abc' });
    expect(both).toEqual({ text: 'twin: pass exactly one of patch or ref', isError: true });
    const passing = await call('verify', { capsule: 'good.json', ref: 'abc' });
    expect(passing.text).toContain('recorded a passing run');
  });

  it('bisects two capsules', async () => {
    const dir = await capsuleFiles(tempDir);
    // Only the reporter's NODE_ENV makes the command fail.
    const backend = agentBackend((spec) =>
      isCommand(spec.argv) && spec.env?.NODE_ENV !== 'test' ? { exitCode: 0 } : undefined,
    );
    const { call } = await connect(backend, { cwd: dir });
    const result = await call('bisect', { bad: 'bad.json', good: 'good.json' });
    expect(result.text).toContain('NODE_ENV');
    expect(result.text).toContain('Minimal failing difference:\n  NODE_ENV=test');
  });

  it('releases one machine, every machine, and what the session kept when it ends', async () => {
    const dir = await capsuleFiles(tempDir);
    const backend = agentBackend();
    const other = await backend.create({ labels: { app: 'twin', run: 'cli' }, idleTimeoutMs: 1 });
    const session = await connect(backend, { cwd: dir });
    await session.call('replay', { capsule: 'bad.json', attempts: 1 });
    await session.call('replay', { capsule: 'bad.json', attempts: 1 });
    const [, first, second] = backend.machines as FakeMachine[];

    expect((await session.call('release', { machine: 'sbx_fake1' })).text).toBe(
      'released sbx_fake1',
    );
    expect(first?.killed).toBe(true);
    // Opened here but kept by someone else: let go of, not killed.
    await session.call('run', { machine: other.id, command: 'ls' });
    await session.closeServer();
    expect(second?.killed).toBe(true);
    expect((other as FakeMachine).killed).toBe(false);
    expect((other as FakeMachine).detached).toBe(true);

    expect((await session.call('release')).text).toBe(`released ${other.id}`);
    expect((await session.call('release')).text).toBe('no twin machines running');
  });
});

describe('twin mcp', () => {
  const tempDir = useTempDirs();

  it('serves until the client disconnects, then releases what it kept', async () => {
    const dir = await capsuleFiles(tempDir);
    const backend = agentBackend();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const { io } = fakeIo();
    const command = mcpCommandWith(() => serverSide);
    const exit = main(
      ['mcp'],
      {
        io,
        host: fakeHost(),
        cwd: dir,
        version: '1.2.3',
        getBackend: async () => backend,
      },
      [command],
    );
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    expect(client.getServerVersion()?.version).toBe('1.2.3');
    await client.callTool({ name: 'replay', arguments: { capsule: 'bad.json', attempts: 1 } });
    expect(backend.machines[0]?.killed).toBe(false);
    await client.close();
    expect(await exit).toBe(0);
    expect(backend.machines[0]?.killed).toBe(true);
  });

  it('prints help', async () => {
    const { io, stdout } = fakeIo();
    const context = {
      io,
      host: fakeHost(),
      cwd: '/',
      version: 't',
      getBackend: async () => agentBackend(),
    };
    expect(await main(['mcp', '--help'], context)).toBe(0);
    expect(stdout.text).toContain('claude mcp add twin');
  });
});
