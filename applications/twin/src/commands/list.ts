import { parseArgs } from 'node:util';
import { TWIN_LABELS } from '../backend/types.ts';
import { shortMachineId } from '../shell/machines.ts';
import { type Command, type CommandContext, stdoutStyle } from './context.ts';

const USAGE = `Usage: twin list [--json]

Lists machines twin started that are still running (and billing): machines
kept with \`twin replay --keep\`, or leftovers from an interrupted run.

Needs SOLARI_API_KEY.

Options:
      --json   machine-readable output
  -h, --help   show this help`;

async function run(args: string[], context: CommandContext): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const { stdout } = context.io;
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const backend = await context.getBackend();
  const machines = await backend.list({ ...TWIN_LABELS });
  if (values.json) {
    stdout.write(`${JSON.stringify(machines, null, 2)}\n`);
    return 0;
  }
  if (machines.length === 0) {
    stdout.write('No twin machines running.\n');
    return 0;
  }

  const style = stdoutStyle(context);
  const rows = machines.map((m) => [shortMachineId(m.id), m.labels.run ?? '-', m.state]);
  const widths = [0, 1].map((column) =>
    Math.max(...[['MACHINE', 'RUN'], ...rows].map((row) => (row[column] as string).length)),
  ) as [number, number];
  const line = (cells: string[]) =>
    `${(cells[0] as string).padEnd(widths[0])}  ${(cells[1] as string).padEnd(widths[1])}  ${cells[2]}`;
  stdout.write(`${style.dim(line(['MACHINE', 'RUN', 'STATE']))}\n`);
  for (const row of rows) stdout.write(`${line(row)}\n`);
  stdout.write(style.dim('\nOpen a terminal: twin shell <machine>   Stop: twin stop [machine]\n'));
  return 0;
}

export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  group: 'machines',
  summary: 'show machines twin has running',
  usage: USAGE,
  run,
};
