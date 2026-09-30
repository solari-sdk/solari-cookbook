import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Backend } from '../backend/types.ts';
import { bisect } from '../bisect/bisect.ts';
import { diffCapsules } from '../capsule/diff.ts';
import { type CapsuleSourceOptions, loadCapsule } from '../capsule/source.ts';
import { TwinError } from '../errors.ts';
import { replay, verifyFix } from '../replay/replay.ts';
import { renderBisect } from '../report/bisect.ts';
import { renderDifferences } from '../report/differences.ts';
import { renderReplay } from '../report/replay.ts';
import { createStyle } from '../report/style.ts';
import { renderSummary } from '../report/summary.ts';
import { KeptMachines } from './kept.ts';
import { describeEvent, progressReporter, type ToolExtra } from './progress.ts';

export interface McpDeps {
  version: string;
  /** Local capsule paths resolve against this; URLs are downloaded with its fetch. */
  capsules: CapsuleSourceOptions;
  getBackend: () => Promise<Backend>;
}

const INSTRUCTIONS = `twin rebuilds the environment a bug was reported from (a "capsule" JSON the reporter \
attached to the issue) on a clean Solari cloud machine, so you can debug a failure that does not \
happen on your machine.

Typical loop:
1. inspect the capsule (offline) to see the reporter's runtimes, dependencies, env and failure.
2. replay it. If the failure reproduces, the machine is kept and its id returned.
3. run commands on that machine (same env, PATH, time zone and directory as the failing command) \
and write_file to try changes. Rerun the failing command to check.
4. verify the final unified diff on a fresh machine (FIXED means the failure is gone).
5. release the machine. Kept machines are billed until released or 15 minutes idle.
With a passing capsule from another machine, bisect finds the environment difference that causes \
the failure. Capsule arguments are file paths or https URLs (such as GitHub issue attachments).`;

const plain = createStyle(false);
const OUTPUT_LINES = 200;
const OUTPUT_CHARS = 16_000;

const capsuleArg = z
  .string()
  .min(1)
  .describe('Capsule file path (relative to the server working directory) or https URL');
const envArg = z
  .record(z.string(), z.string())
  .optional()
  .describe('Values for variables the capsule recorded by name only, e.g. {"API_URL": "..."}');
const pinArg = z
  .boolean()
  .optional()
  .describe(
    "Install the capsule's recorded npm package versions over the lockfile install where they differ (default true)",
  );

const attemptsArg = (fallback: number) =>
  z.number().int().min(1).max(10).optional().describe(`Runs of the command (default ${fallback})`);
const machineArg = z
  .string()
  .optional()
  .describe('Kept machine id, or a unique prefix of it; optional when only one is running');

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) };
}

function tail(output: string): string {
  const lines = output.slice(-OUTPUT_CHARS).split('\n');
  return lines.slice(-OUTPUT_LINES).join('\n').trimEnd();
}

/** Failures become tool errors the agent can read and act on, never a dropped session. */
async function guarded(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof TwinError || !(error instanceof Error) ? '' : ` (${error.name})`;
    return text(`twin${kind}: ${message}`, true);
  }
}

/**
 * The MCP face of twin: the same replay, bisect and verify as the CLI, plus command execution in a
 * kept machine so a coding agent can debug inside the reporter's environment.
 */
export interface TwinMcpServer {
  server: McpServer;
  /** Releases the machines this session kept. */
  close: () => Promise<void>;
}

export function createMcpServer(deps: McpDeps): TwinMcpServer {
  const server = new McpServer(
    { name: 'twin', version: deps.version },
    { instructions: INSTRUCTIONS },
  );
  const kept = new KeptMachines(deps.getBackend);
  const load = (source: string) => loadCapsule(source, deps.capsules);

  server.registerTool(
    'inspect',
    {
      title: 'Inspect capsule',
      description:
        "Summarize a capsule (the reporter's OS, runtimes, package managers, dependencies, repo, env and failure), or list every difference between two capsules. Offline.",
      inputSchema: {
        capsule: capsuleArg,
        compare_to: capsuleArg.optional().describe('A second capsule to diff against'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ capsule, compare_to }) =>
      guarded(async () => {
        const a = await load(capsule);
        if (compare_to === undefined) return text(renderSummary(a, plain));
        const differences = diffCapsules(a, await load(compare_to));
        const labels = { a: basename(capsule), b: basename(compare_to) };
        return text(renderDifferences(differences, labels, plain));
      }),
  );

  server.registerTool(
    'replay',
    {
      title: 'Replay capsule',
      description:
        "Rebuild the capsule's environment on a fresh cloud machine and rerun the failing command. Returns REPRODUCED, DIFFERENT FAILURE, NOT REPRODUCED, FLAKY or INCONCLUSIVE. When the failure reproduces and keep is true, the machine stays running for run and write_file. Takes about a minute or more.",
      inputSchema: {
        capsule: capsuleArg,
        keep: z.boolean().optional().describe('Keep a reproduced failure running (default true)'),
        attempts: attemptsArg(3),
        env: envArg,
        ref: z.string().optional().describe('Check out this commit instead of the capsule one'),
        repo: z.string().optional().describe('Clone from this URL instead (forks)'),
        pin: pinArg,
      },
      annotations: { openWorldHint: true },
    },
    ({ capsule, keep, attempts, env, ref, repo, pin }, extra: ToolExtra) =>
      guarded(async () => {
        const loaded = await load(capsule);
        const report = await replay(loaded, await deps.getBackend(), {
          attempts: attempts ?? 3,
          keep: keep ?? true,
          pin: pin ?? true,
          env: env ?? {},
          ...(ref === undefined ? {} : { ref }),
          ...(repo === undefined ? {} : { repoUrl: repo }),
          onEvent: describeEvent(progressReporter(extra)),
        });
        if (report.kept && report.machineId) kept.adopt(report.machineId);
        return text(renderReplay(report, plain, { agent: true }));
      }),
  );

  server.registerTool(
    'run',
    {
      title: 'Run on kept machine',
      description:
        "Run a shell command line (bash) on a kept machine, in the reporter's environment: same env values, PATH, runtimes, time zone and working directory as the failing command. Returns the exit code and the end of the output.",
      inputSchema: {
        machine: machineArg,
        command: z.string().min(1).describe('Shell command line, e.g. "npm test -- -t locale"'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .optional()
          .describe('Kill the command after this long (default 300)'),
      },
      annotations: { openWorldHint: true },
    },
    ({ machine, command, timeout_seconds }) =>
      guarded(async () => {
        const seconds = timeout_seconds ?? 300;
        const outcome = await kept.run(machine, command, seconds * 1000);
        const status = outcome.timedOut
          ? `timed out after ${seconds}s`
          : `exit ${outcome.exitCode}`;
        const header = `${status} (${(outcome.durationMs / 1000).toFixed(1)}s)`;
        const output = tail(outcome.output);
        return text(output ? `${header}\n${output}` : header);
      }),
  );

  server.registerTool(
    'write_file',
    {
      title: 'Write file on kept machine',
      description:
        "Create or overwrite a file on a kept machine. Relative paths resolve against the failing command's working directory (inside the reporter's checkout).",
      inputSchema: {
        machine: machineArg,
        path: z.string().min(1).describe('File path, relative to the failing command directory'),
        content: z.string().describe('Full new file content'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ machine, path, content }) =>
      guarded(async () => {
        const target = await kept.writeFile(machine, path, content);
        return text(`wrote ${Buffer.byteLength(content)} bytes to ${target}`);
      }),
  );

  server.registerTool(
    'verify',
    {
      title: 'Verify fix',
      description:
        "Check a candidate fix in the reporter's environment on a fresh machine: apply a unified diff (or check out a ref) and rerun the failing command. The command first runs once without the fix; if it does not fail the captured way there, the result is INCONCLUSIVE. FIXED means the captured failure is gone; STILL FAILING, DIFFERENT FAILURE, FLAKY or INCONCLUSIVE otherwise.",
      inputSchema: {
        capsule: capsuleArg,
        patch: z
          .string()
          .optional()
          .describe('Unified diff (git diff output) applied on top of the capsule tree'),
        ref: z.string().optional().describe('Commit to check out instead, e.g. a pushed fix'),
        repo: z.string().optional().describe('Clone from this URL (forks); use with ref'),
        attempts: attemptsArg(3),
        env: envArg,
        pin: pinArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ capsule, patch, ref, repo, attempts, env, pin }, extra: ToolExtra) =>
      guarded(async () => {
        if ((patch === undefined) === (ref === undefined)) {
          throw new TwinError('pass exactly one of patch or ref');
        }
        const loaded = await load(capsule);
        if (loaded.command.outcome !== 'fail') {
          throw new TwinError('the capsule recorded a passing run; there is no failure to fix');
        }
        const report = await verifyFix(loaded, await deps.getBackend(), {
          attempts: attempts ?? 3,
          pin: pin ?? true,
          env: env ?? {},
          ...(patch === undefined ? {} : { patch }),
          ...(ref === undefined ? {} : { ref }),
          ...(repo === undefined ? {} : { repoUrl: repo }),
          onEvent: describeEvent(progressReporter(extra)),
        });
        return text(renderReplay(report, plain, { verify: true }));
      }),
  );

  server.registerTool(
    'bisect',
    {
      title: 'Bisect environments',
      description:
        'Given a failing capsule and a passing one from the same commit, find the smallest set of environment differences (env values, time zone, node version, npm dependency versions, working tree diff) that causes the failure. Takes a few minutes.',
      inputSchema: {
        bad: capsuleArg.describe('Capsule of the failing environment'),
        good: capsuleArg.describe('Capsule of an environment where the command passes'),
        attempts: attemptsArg(1),
        env: envArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ bad, good, attempts, env }, extra: ToolExtra) =>
      guarded(async () => {
        const [badCapsule, goodCapsule] = await Promise.all([load(bad), load(good)]);
        const report = await bisect(goodCapsule, badCapsule, await deps.getBackend(), {
          attempts: attempts ?? 1,
          env: env ?? {},
          onEvent: describeEvent(progressReporter(extra)),
        });
        return text(renderBisect(report, plain));
      }),
  );

  server.registerTool(
    'release',
    {
      title: 'Release machines',
      description:
        'Stop a kept machine, or every twin machine when no id is given. Each kill is confirmed. Do this when done: kept machines are billed while running.',
      inputSchema: { machine: machineArg.describe('Kept machine id or prefix; omit for all') },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ machine }) =>
      guarded(async () => {
        const killed = await kept.release(machine);
        return text(killed.length ? `released ${killed.join(', ')}` : 'no twin machines running');
      }),
  );

  return { server, close: () => kept.close() };
}
