import { parseArgs } from 'node:util';
import { TWIN_LABELS } from '../backend/types.ts';
import { TwinError } from '../errors.ts';
import { resolveMachine, shortMachineId } from '../shell/machines.ts';
import { type Command, type CommandContext, stdoutStyle } from './context.ts';

const USAGE = `Usage: twin stop [machine]

Stops machines twin started that are still running: kept replays, or leftovers
from an interrupted run. Without [machine], stops all of them. [machine] is the
start of an id from \`twin list\`. Each stop is confirmed with Solari, so
nothing keeps billing.

Needs SOLARI_API_KEY.

Options:
  -h, --help   show this help`;

async function run(args: string[], context: CommandContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h', default: false } },
  });
  const { stdout } = context.io;
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    throw new TwinError(`expected at most one machine\n\n${USAGE}`, { exitCode: 2 });
  }
  const backend = await context.getBackend();
  const style = stdoutStyle(context);

  let stopped: string[];
  if (positionals[0] === undefined) {
    stopped = await backend.reap({ ...TWIN_LABELS });
  } else {
    const info = await resolveMachine(backend, positionals[0]);
    const runId = info.labels.run;
    // Every twin run starts one machine, so its run label names exactly this one.
    if (runId === undefined) {
      await (await backend.connect(info.id)).kill();
      stopped = [info.id];
    } else {
      stopped = await backend.reap({ ...TWIN_LABELS, run: runId });
    }
  }

  if (stopped.length === 0) {
    stdout.write('No twin machines running.\n');
  } else {
    const noun = stopped.length === 1 ? 'machine' : 'machines';
    stdout.write(`${style.green('Stopped')} ${stopped.length} ${noun}\n`);
    for (const id of stopped) stdout.write(`  ${shortMachineId(id)}\n`);
  }
  return 0;
}

export const stopCommand: Command = {
  name: 'stop',
  aliases: ['gc'],
  group: 'machines',
  summary: 'stop machines twin left running',
  usage: USAGE,
  run,
};
