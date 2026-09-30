import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serializeCapsule, writeCapsule } from '../capsule/file.ts';
import type { Capsule } from '../capsule/schema.ts';
import { capture } from '../capture/capture.ts';
import { TwinError } from '../errors.ts';
import type { Io } from '../io.ts';
import { formatBytes } from '../report/style.ts';
import { renderSummary } from '../report/summary.ts';
import { type Command, type CommandContext, stderrStyle } from './context.ts';

const USAGE = `Usage: twin capture [options] -- <command> [args...]

Runs <command>, records the environment it ran in, and writes a capsule a
maintainer can replay. Nothing is uploaded. You review the capsule before it
is written.

Options:
  -o, --out <file>         capsule path (default: twin-capsule.json)
      --include-env <name> also record this variable's value (repeatable)
      --salt <text>        record salted hashes of other variables' values,
                           so a maintainer can compare them without seeing them
  -y, --yes                write without the review prompt
  -h, --help               show this help`;

type Decision = 'write' | 'abort';

async function review(io: Io, capsule: Capsule, out: string): Promise<Decision> {
  for (;;) {
    const answer = await io.prompt(`Write ${out}? [y]es / [n]o / [v]iew full JSON: `);
    const choice = answer?.trim().toLowerCase();
    if (choice === 'y' || choice === 'yes') return 'write';
    if (choice === 'v' || choice === 'view') {
      io.stderr.write(serializeCapsule(capsule));
      continue;
    }
    return 'abort';
  }
}

async function run(args: string[], context: CommandContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: 'twin-capsule.json' },
      'include-env': { type: 'string', multiple: true, default: [] },
      salt: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const { io } = context;
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length === 0)
    throw new TwinError(`missing command to run\n\n${USAGE}`, { exitCode: 2 });
  if (!values.yes && !io.interactive) {
    throw new TwinError(
      'not running in a terminal; pass --yes to write the capsule without review',
      {
        exitCode: 2,
      },
    );
  }

  const style = stderrStyle(context);
  const out = values.out;
  const { capsule, run } = await capture(
    {
      argv: positionals,
      cwd: context.cwd,
      includeEnv: values['include-env'],
      salt: values.salt ?? null,
      generator: `twin ${context.version}`,
    },
    context.host,
    {
      stdout: io.stdout,
      stderr: io.stderr,
      onProgress: (message) => io.stderr.write(style.dim(`twin: ${message}\n`)),
    },
  );
  if (run.signal === 'SIGINT' || run.exitCode === 130) {
    throw new TwinError('interrupted; no capsule written', { exitCode: 130 });
  }

  io.stderr.write(`\n${renderSummary(capsule, style)}\n\n`);
  if (capsule.command.outcome === 'pass') {
    io.stderr.write(
      style.yellow(
        'The command passed. This capsule records a working environment, useful as a known-good baseline.\n',
      ),
    );
  }
  if (!values.yes && (await review(io, capsule, out)) === 'abort') {
    io.stderr.write('No capsule written.\n');
    return 1;
  }

  const path = resolve(context.cwd, out);
  const bytes = await writeCapsule(path, capsule);
  io.stderr.write(
    `${style.green('Wrote')} ${out} (${formatBytes(bytes)}). Attach it to the issue.\n`,
  );
  io.stderr.write(style.dim(`Review it any time with: twin inspect ${out}\n`));
  return 0;
}

export const captureCommand: Command = {
  name: 'capture',
  group: 'report',
  summary: 'run a command and record the environment it ran in',
  usage: USAGE,
  run,
};
