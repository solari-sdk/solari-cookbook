import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { diffCapsules } from '../capsule/diff.ts';
import { loadCapsule } from '../capsule/source.ts';
import { TwinError } from '../errors.ts';
import { renderDifferences } from '../report/differences.ts';
import { renderSummary } from '../report/summary.ts';
import { type Command, type CommandContext, capsuleSource, stdoutStyle } from './context.ts';

const USAGE = `Usage: twin inspect <capsule> [options]

Prints a summary of what a capsule recorded: system, runtimes, package
manager, commit and diff, environment and the failing command.
Capsules can be file paths or https URLs, such as GitHub issue attachments.

Options:
      --json   machine-readable output
  -h, --help   show this help`;

const DIFF_USAGE = `Usage: twin diff <capsule> <other-capsule> [options]

Lists every environment fact that differs between two capsules, such as a
failing and a passing run. To find which differences cause the failure,
use \`twin bisect\`.
Capsules can be file paths or https URLs, such as GitHub issue attachments.

Options:
      --json   machine-readable output
  -h, --help   show this help`;

/** inspect also takes two capsules, as it did before diff existed. */
const inspect = (args: string[], context: CommandContext) => run(args, context, USAGE, [1, 2]);
const diff = (args: string[], context: CommandContext) => run(args, context, DIFF_USAGE, [2, 2]);

async function run(
  args: string[],
  context: CommandContext,
  usage: string,
  [min, max]: [number, number],
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const { io } = context;
  if (values.help) {
    io.stdout.write(`${usage}\n`);
    return 0;
  }
  if (positionals.length < min || positionals.length > max) {
    const expected = min === max ? 'two capsules' : 'one capsule (or two to compare)';
    throw new TwinError(`expected ${expected}\n\n${usage}`, { exitCode: 2 });
  }

  const style = stdoutStyle(context);
  const [pathA, pathB] = positionals as [string, string?];
  const a = await loadCapsule(pathA, capsuleSource(context));

  if (pathB === undefined) {
    io.stdout.write(
      values.json ? `${JSON.stringify(a, null, 2)}\n` : `${renderSummary(a, style)}\n`,
    );
    return 0;
  }

  const differences = diffCapsules(a, await loadCapsule(pathB, capsuleSource(context)));
  if (values.json) {
    io.stdout.write(`${JSON.stringify(differences, null, 2)}\n`);
  } else {
    const labels = { a: basename(pathA), b: basename(pathB) };
    io.stdout.write(`${renderDifferences(differences, labels, style)}\n`);
  }
  return 0;
}

export const inspectCommand: Command = {
  name: 'inspect',
  aliases: ['show'],
  group: 'reproduce',
  summary: 'summarize what a capsule recorded',
  usage: USAGE,
  run: inspect,
};

export const diffCommand: Command = {
  name: 'diff',
  group: 'reproduce',
  summary: 'list environment differences between two capsules',
  usage: DIFF_USAGE,
  run: diff,
};
