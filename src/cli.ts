#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { readFile as readFileAsync, writeFile as writeFileAsync, mkdir as mkdirAsync, stat as statAsync } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parseManifest, digest, safeText, type Manifest, type Lane } from './domain.ts';
import { runExperiment, verifyReceipt, type Provider, type Event } from './runner.ts';
import { createSolariProvider } from './solari.ts';
import { generateReport } from './report.ts';

const VERSION = '0.1.0';

function die(message: string): never {
  throw new Error(message);
}

function usage(): void {
  process.stdout.write(`PatchProof v${VERSION} — two-sided regression evidence

Commands:
  plan <manifest.json>          Validate a manifest locally (no credits)
  simulate <manifest.json>      Run only the two shipped fixtures locally
  run <manifest.json>           Run with real Solari sandboxes
  verify <receipt.json>         Verify receipt integrity and verdict
  cleanup <session-id>          Kill a Solari session by ID

Options:
  --output <dir>    Output directory (default: auto-generated)
  --help            Show this help

Environment:
  SOLARI_API_KEY    Required for 'run' and 'cleanup' commands
  PATCHPROOF_PYTHON Optional local Python executable for simulation
`);
}

/* ── argument parsing ────────────────────────────────────── */

function parseArgs(argv: string[]): { command: string; file: string | undefined; output: string | undefined } {
  const command = argv[0] ?? '';
  let file: string | undefined;
  let output: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') {
      if (output !== undefined || !argv[i + 1] || argv[i + 1]!.startsWith('-')) die('--output requires one directory');
      output = argv[++i]; continue;
    }
    if (arg === '--patch' || arg === '--manifest' || arg === '--receipt') {
      if (file !== undefined || !argv[i + 1] || argv[i + 1]!.startsWith('-')) die(`${arg} requires one file path`);
      file = argv[++i]; continue;
    }
    if (!arg || arg.startsWith('-')) die(`Unknown argument: ${arg}`);
    if (file) die(`Unexpected argument: ${arg}`);
    file = arg;
  }
  if (output !== undefined && command !== 'simulate' && command !== 'run') die('--output is only supported for simulate and run');
  return { command, file, output };
}

/* ── simulation provider ─────────────────────────────────── */

function findPython(): string {
  return process.env['PATCHPROOF_PYTHON'] || (process.platform === 'win32' ? 'python' : 'python3');
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const file = resolve(path);
  const info = await statAsync(file);
  if (!info.isFile()) die('Input must be a regular file');
  if (info.size > maxBytes) die(`Input exceeds ${maxBytes} bytes`);
  const bytes = await readFileAsync(file);
  if (bytes.length > maxBytes) die(`Input exceeds ${maxBytes} bytes`);
  return JSON.parse(bytes.toString('utf8'));
}

async function requireShippedFixture(manifest: Manifest): Promise<void> {
  for (const name of ['cache-fix.json', 'cache-unfixed.json']) {
    for (const relative of ['../fixtures/', '../../fixtures/']) {
      const path = fileURLToPath(new URL(relative + name, import.meta.url));
      try {
        if (digest(parseManifest(await readJson(path, 256 * 1024))) === digest(manifest)) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  die('Local simulation accepts only the unchanged shipped fixtures cache-fix.json and cache-unfixed.json; use run for other manifests.');
}

async function findGuestScript(): Promise<string> {
  for (const relative of ['../guest/runner.py', '../../guest/runner.py']) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url));
    try { await statAsync(candidate); return candidate; } catch { /* try next */ }
  }
  throw new Error('Cannot locate guest/runner.py');
}

function createSimulationProvider(): Provider {
  return {
    kind: 'simulation',
    cleanup: async () => {},
    async create(context) {
      const sessionId = `sim-${context.lane}-${Date.now()}`;
      return {
        id: sessionId,
        async execute(manifest: Manifest, lane: Lane, signal: AbortSignal): Promise<unknown> {
          const scriptPath = await findGuestScript();
          const payload = Buffer.from(JSON.stringify({
            source: manifest.source, lane, setup: manifest.setup,
            probe: manifest.probe, commandSeconds: manifest.limits.commandSeconds,
          })).toString('base64');
          return new Promise<unknown>((resolve, reject) => {
            if (signal.aborted) return reject(new Error('Simulation cancelled'));
            // Only reviewed fixture payloads reach this local bootstrap. Keep the
            // receipt's portable command while using this interpreter for children.
            const bootstrap = `import runpy,sys
guest=runpy.run_path(sys.argv[1])
command=guest['command']
def local_command(argv,root,seconds):
    return command([sys.executable if argv[0]=='python3' else argv[0],*argv[1:]],root,seconds)
guest['main'].__globals__['command']=local_command
sys.argv=sys.argv[1:]
guest['main']()`;
            const environment: NodeJS.ProcessEnv = {};
            for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'LANG']) {
              if (process.env[name] !== undefined) environment[name] = process.env[name];
            }
            const child = execFile(findPython(), ['-c', bootstrap, scriptPath, payload], {
              timeout: manifest.limits.sessionSeconds * 1000,
              maxBuffer: 256 * 1024,
              env: environment,
            }, (error, stdout) => {
              signal.removeEventListener('abort', abort);
              if (signal.aborted) return reject(new Error('Simulation cancelled'));
              if (error) return reject(new Error(`Simulation guest failed: ${error.message}`));
              try { resolve(JSON.parse(stdout)); }
              catch { reject(new Error('Simulation guest returned malformed JSON')); }
            });
            const abort = () => { child.kill(); };
            signal.addEventListener('abort', abort, { once: true });
          });
        },
        async kill() { /* simulation: no remote resource */ },
      };
    },
  };
}

/* ── output directory ────────────────────────────────────── */

async function ensureOutputDir(requested?: string): Promise<string> {
  const dir = resolve(requested ?? join('runs', randomUUID()));
  await mkdirAsync(dirname(dir), { recursive: true });
  try {
    await mkdirAsync(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') die(`Output directory already exists: ${dir}\nUse a new directory to avoid overwriting evidence.`);
    throw e;
  }
  return dir;
}

/* ── commands ────────────────────────────────────────────── */

async function plan(manifestPath?: string): Promise<void> {
  if (!manifestPath) die('Usage: patchproof plan <manifest.json>');
  const raw = await readJson(manifestPath, 256 * 1024);
  const manifest = parseManifest(raw);
  const hash = digest(manifest);
  const out = process.stdout;
  out.write(`✓ Manifest valid: ${manifest.name}\n`);
  out.write(`  Source: ${manifest.source.kind}\n`);
  if (manifest.source.kind === 'git') {
    out.write(`  Repository: ${manifest.source.url}\n`);
    out.write(`  Baseline:   ${manifest.source.baseline}\n`);
    out.write(`  Candidate:  ${manifest.source.candidate}\n`);
  }
  out.write(`  Setup: ${manifest.setup.length} command(s)\n`);
  out.write(`  Probe: ${manifest.probe.argv.join(' ')}\n`);
  out.write(`  Expected failure: exit ${manifest.probe.expectedFailure.exitCode}, contains "${manifest.probe.expectedFailure.contains}"\n`);
  out.write(`  Expected success: contains "${manifest.probe.expectedSuccess.contains}"\n`);
  out.write(`  Limits: ${manifest.limits.sessionSeconds}s session, ${manifest.limits.commandSeconds}s command\n`);
  out.write(`  SHA-256: ${hash}\n`);
}

async function execute(manifestPath: string | undefined, provider: Provider, outputDir?: string): Promise<void> {
  if (!manifestPath) die(`Usage: patchproof ${provider.kind === 'solari' ? 'run' : 'simulate'} <manifest.json>`);
  const raw = await readJson(manifestPath, 256 * 1024);
  const manifest = parseManifest(raw);
  if (provider.kind === 'simulation') await requireShippedFixture(manifest);
  const dir = await ensureOutputDir(outputDir);
  const journalPath = join(dir, 'journal.jsonl');
  const secrets = provider.kind === 'solari' ? [process.env['SOLARI_API_KEY'] ?? ''] : [];
  const providerLabel = provider.kind === 'solari' ? 'SOLARI' : 'LOCAL SIMULATION';

  process.stdout.write(`PatchProof ${providerLabel}: ${manifest.name}\nOutput: ${dir}\n\n`);

  const onEvent = (event: Event) => {
    appendFileSync(journalPath, JSON.stringify(event) + '\n');
    const label = `[${event.lane}]`.padEnd(14);
    const detail = event.detail ? ` ${safeText(event.detail, secrets).slice(0, 120)}` : '';
    process.stdout.write(`  ${label}${event.state}${event.sessionId ? ` (${event.sessionId})` : ''}${detail}\n`);
  };

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let receipt;
  try {
    receipt = await runExperiment(manifest, provider, { onEvent, secrets, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }

  await writeFileAsync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await writeFileAsync(join(dir, 'report.html'), generateReport(receipt, secrets));

  const bar = '═'.repeat(50);
  const out = process.stdout;
  out.write(`\n${bar}\n`);
  out.write(`  Verdict:   ${receipt.verdict.toUpperCase()}\n`);
  out.write(`  Provider:  ${providerLabel}\n`);
  out.write(`  Sessions:  ${receipt.cost.sessionsCreated}\n`);
  out.write(`  Compute:   ${receipt.cost.computeSeconds.toFixed(1)}s\n`);
  if (receipt.provider === 'solari') out.write(`  Est. cost: $${receipt.cost.estimatedUsd.toFixed(4)}\n`);
  out.write(`  Cleanup:   ${receipt.lanes.every(l => l.state === 'released') ? 'all released' : receipt.lanes.map(l => `${l.lane}: ${l.state}`).join(', ')}\n`);
  out.write(`  Receipt:   ${join(dir, 'receipt.json')}\n`);
  out.write(`  Report:    ${join(dir, 'report.html')}\n`);
  out.write(`${bar}\n`);

  if (receipt.provider === 'simulation') {
    out.write(`\n⚠  LOCAL SIMULATION — reviewed fixtures execute on this computer, without remote isolation; not real Solari evidence.\n`);
  }

  process.exitCode = receipt.verdict === 'verified' ? 0 : receipt.verdict === 'inconclusive' ? 2 : 1;
}

async function verify(receiptPath?: string): Promise<void> {
  if (!receiptPath) die('Usage: patchproof verify <receipt.json>');
  const raw = await readJson(receiptPath, 1024 * 1024);
  const receipt = verifyReceipt(raw);
  const allReleased = receipt.lanes.every(l => l.state === 'released');
  const out = process.stdout;
  out.write(`✓ Receipt integrity verified\n`);
  out.write(`  Verdict:      ${receipt.verdict.toUpperCase()}\n`);
  out.write(`  Provider:     ${receipt.provider === 'solari' ? 'SOLARI' : 'SIMULATION'}\n`);
  out.write(`  Experiment:   ${receipt.manifest.name}\n`);
  out.write(`  Run ID:       ${receipt.id}\n`);
  out.write(`  Lanes:        ${receipt.lanes.length} (${receipt.lanes.map(l => `${l.lane}: ${l.state}`).join(', ')})\n`);
  out.write(`  Manifest:     ${receipt.manifestSha256}\n`);
  out.write(`  Receipt:      ${receipt.sha256}\n`);
  out.write(`  Cleanup:      ${allReleased ? 'all released' : 'incomplete'}\n`);
}

async function cleanup(sessionId?: string): Promise<void> {
  if (!sessionId) die('Usage: patchproof cleanup <session-id>');
  const apiKey = process.env['SOLARI_API_KEY'];
  if (!apiKey) die('SOLARI_API_KEY environment variable is required for cleanup');
  const provider = createSolariProvider(apiKey);
  await provider.cleanup(sessionId, AbortSignal.timeout(15000));
  process.stdout.write(`✓ Session ${sessionId} killed\n`);
}

/* ── main ────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--help') || (args.length === 2 && ['plan', 'simulate', 'run', 'verify', 'cleanup'].includes(args[0]!) && args[1] === '--help')) { usage(); return; }

  try {
    const { command, file, output } = parseArgs(args);
    switch (command) {
      case 'plan': await plan(file); break;
      case 'simulate': await execute(file, createSimulationProvider(), output); break;
      case 'run': {
        const apiKey = process.env['SOLARI_API_KEY'];
        if (!apiKey) die('SOLARI_API_KEY environment variable is required for run');
        await execute(file, createSolariProvider(apiKey), output);
        break;
      }
      case 'verify': await verify(file); break;
      case 'cleanup': await cleanup(file); break;
      default: die(`Unknown command: ${command}\nRun 'patchproof --help' for usage.`);
    }
  } catch (error) {
    const msg = error instanceof Error ? safeText(error.message, [process.env['SOLARI_API_KEY'] ?? '']) : 'unknown error';
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}

main();
