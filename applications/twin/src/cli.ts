import { bisectCommand } from './commands/bisect.ts';
import { captureCommand } from './commands/capture.ts';
import {
  type Command,
  type CommandContext,
  type CommandGroup,
  stdoutStyle,
} from './commands/context.ts';
import { diffCommand, inspectCommand } from './commands/inspect.ts';
import { listCommand } from './commands/list.ts';
import { mcpCommand } from './commands/mcp.ts';
import { replayCommand } from './commands/replay.ts';
import { shellCommand } from './commands/shell.ts';
import { stopCommand } from './commands/stop.ts';
import { verifyCommand } from './commands/verify.ts';
import { TwinError } from './errors.ts';
import { logo } from './report/logo.ts';
import type { Style } from './report/style.ts';

export const COMMANDS: readonly Command[] = [
  captureCommand,
  replayCommand,
  bisectCommand,
  verifyCommand,
  inspectCommand,
  diffCommand,
  listCommand,
  shellCommand,
  stopCommand,
  mcpCommand,
];

const GROUPS: readonly [CommandGroup | undefined, string][] = [
  ['report', 'Report a bug'],
  ['reproduce', 'Reproduce and fix'],
  ['machines', 'Machines (kept replays)'],
  ['agents', 'AI coding agents'],
  [undefined, 'Commands'],
];

const EXAMPLES: readonly [string, string][] = [
  ['twin capture -- npm test', 'record a failing run as twin-capsule.json'],
  ['twin replay twin-capsule.json', 'reproduce it on a clean machine'],
  ['twin replay twin-capsule.json --keep', 'keep that machine, then: twin shell'],
  ['twin verify twin-capsule.json --patch fix.diff', 'check a fix where it failed'],
];

const TAGLINE = 'Turns "cannot reproduce" into a verified fix.';

function usage(commands: readonly Command[], style: Style, version: string, tty: boolean): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const sections = GROUPS.flatMap(([group, title]) => {
    const members = commands.filter((command) => command.group === group);
    if (members.length === 0) return [];
    const rows = members.map(
      (command) => `  ${style.bold(command.name.padEnd(width))}  ${command.summary}`,
    );
    return ['', style.dim(title), ...rows];
  });
  const exampleWidth = Math.max(...EXAMPLES.map(([example]) => example.length));
  const examples = EXAMPLES.map(
    ([example, note]) => `  ${example.padEnd(exampleWidth)}  ${style.dim(note)}`,
  );
  // The wordmark is for people at a terminal; piped help stays plain text.
  const header = tty
    ? [logo(style, [style.bold(`twin ${version}`), style.dim(TAGLINE)]), '']
    : [TAGLINE, ''];
  return [
    ...header,
    `${style.bold('Usage:')} twin <command> [options]`,
    ...sections,
    '',
    style.dim('Examples'),
    ...examples,
    '',
    'Replay, bisect, verify and the machine commands need SOLARI_API_KEY',
    '(exported, or in a .env file). Capture, inspect and diff work offline.',
    '',
    `Run ${style.bold('twin help <command>')} for its options.`,
  ].join('\n');
}

/** Edit distance counting a swap of neighbours as one edit, for "did you mean" on a typo. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number) => (rows[i] as number[])[j] as number;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let cost = Math.min(
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
        at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, at(i - 2, j - 2) + 1);
      }
      (rows[i] as number[])[j] = cost;
    }
  }
  return at(a.length, b.length);
}

function findCommand(commands: readonly Command[], name: string): Command | undefined {
  return commands.find((command) => command.name === name || command.aliases?.includes(name));
}

function suggest(commands: readonly Command[], name: string): string | undefined {
  const names = commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
  const [best] = names
    .map((candidate) => ({ candidate, cost: distance(name, candidate) }))
    .filter(({ candidate, cost }) => cost <= Math.max(1, Math.floor(candidate.length / 3)))
    .sort((x, y) => x.cost - y.cost);
  return best && findCommand(commands, best.candidate)?.name;
}

function isArgParseError(error: unknown): error is Error {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}

/**
 * Gateway errors about the account (key, plan, credit, capacity) are the user's to fix, not bugs,
 * so they get one line instead of a stack. Matched by name to avoid loading the SDK eagerly.
 */
const ACCOUNT_ERRORS = new Set([
  'AuthError',
  'PlanError',
  'ConcurrencyLimitError',
  'NoCapacityError',
]);

function isAccountError(error: unknown): error is Error {
  return error instanceof Error && ACCOUNT_ERRORS.has(error.name);
}

/** Dispatches argv to a command and maps failures to exit codes. Never throws. */
export async function main(
  argv: readonly string[],
  context: CommandContext,
  commands: readonly Command[] = COMMANDS,
): Promise<number> {
  const [name, ...rest] = argv;
  const { stdout, stderr } = context.io;
  const help = () => usage(commands, stdoutStyle(context), context.version, stdout.isTTY);

  if (name === 'help' && rest[0] !== undefined) {
    return main([rest[0], '--help'], context, commands);
  }
  if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
    stdout.write(`${help()}\n`);
    return name === undefined ? 2 : 0;
  }
  if (name === '-v' || name === '--version') {
    stdout.write(`${context.version}\n`);
    return 0;
  }
  const command = findCommand(commands, name);
  if (!command) {
    const guess = suggest(commands, name);
    stderr.write(
      guess
        ? `twin: unknown command "${name}". Did you mean: twin ${guess}?\n`
        : `twin: unknown command "${name}". See: twin --help\n`,
    );
    return 2;
  }

  try {
    return await command.run(rest, context);
  } catch (error) {
    if (error instanceof TwinError) {
      stderr.write(`twin: ${error.message}\n`);
      return error.exitCode;
    }
    if (isArgParseError(error)) {
      stderr.write(`twin ${command.name}: ${error.message}\n\n${command.usage}\n`);
      return 2;
    }
    if (isAccountError(error)) {
      stderr.write(`twin: Solari refused the request: ${error.message}\n`);
      return 1;
    }
    stderr.write(`twin: unexpected error\n${(error as Error)?.stack ?? String(error)}\n`);
    return 1;
  }
}
