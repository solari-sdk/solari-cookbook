import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { Machine } from '../backend/types.ts';
import { TwinError } from '../errors.ts';
import { script } from '../replay/shell.ts';
import { SHELL_SCRIPT, WEB_TERMINAL_PORT, webTerminalScript } from '../shell/guest.ts';
import { ensureKept, resolveMachine, shortMachineId } from '../shell/machines.ts';
import { attach } from '../shell/session.ts';
import { type Command, type CommandContext, stderrStyle } from './context.ts';

const USAGE = `Usage: twin shell [machine] [--web]

Opens a terminal on a machine kept by \`twin replay --keep\`, in the reporter's
environment (same env, PATH and working directory as the failing command).
[machine] is the start of its id; it can be left out when only one twin machine
is running.

Options:
      --web    start a browser terminal and print a link plus a password,
               to share with the reporter. Anyone with both gets a root shell
               on that machine until it is released.
  -h, --help   show this help

Ctrl-] detaches without stopping the machine. It keeps running (and billing)
until 15 minutes idle, or until \`twin stop\`.`;

export const WEB_USER = 'twin';

async function shareWeb(machine: Machine, short: string, context: CommandContext): Promise<number> {
  const { io } = context;
  const style = stderrStyle(context);
  const password = randomBytes(12).toString('base64url');
  const started = await machine.run({
    argv: script(webTerminalScript({ port: WEB_TERMINAL_PORT, user: WEB_USER, password })),
    timeoutMs: 120_000,
  });
  if (started.exitCode !== 0) {
    throw new TwinError(`could not start the browser terminal:\n${started.output}`);
  }
  const url = await machine.previewUrl(WEB_TERMINAL_PORT);
  io.stdout.write(`${url}\n`);
  io.stderr.write(
    [
      style.bold(`Browser terminal on ${short}`),
      `  user      ${WEB_USER}`,
      `  password  ${password}`,
      style.dim('The link and password together give a root shell on this machine. Share them'),
      style.dim(
        'only with the reporter. The machine stops after 15 minutes idle or with: twin stop',
      ),
      '',
    ].join('\n'),
  );
  return 0;
}

async function attachLocal(
  machine: Machine,
  short: string,
  context: CommandContext,
): Promise<number> {
  const { io } = context;
  const style = stderrStyle(context);
  const local = io.terminal as NonNullable<typeof io.terminal>;
  const { cols, rows } = local.size();
  const terminal = await machine.openTerminal({ cols, rows, command: SHELL_SCRIPT });
  io.stderr.write(style.dim(`twin: connected to ${short}. Ctrl-] detaches.\n`));
  const end = await attach(terminal, local);
  io.stderr.write(
    style.dim(
      `\ntwin: ${end === 'exited' ? 'shell exited' : 'detached'}. ${short} keeps running until 15 minutes idle or twin stop.\n`,
    ),
  );
  return 0;
}

async function run(args: string[], context: CommandContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      web: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const { io } = context;
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    throw new TwinError(`expected at most one machine\n\n${USAGE}`, { exitCode: 2 });
  }
  if (!values.web && !io.terminal) {
    throw new TwinError(
      'twin shell needs an interactive terminal; use --web for a browser terminal',
      {
        exitCode: 2,
      },
    );
  }

  const backend = await context.getBackend();
  const info = await resolveMachine(backend, positionals[0]);
  const machine = await backend.connect(info.id);
  const short = shortMachineId(info.id);
  try {
    await ensureKept(machine);
    return await (values.web ? shareWeb : attachLocal)(machine, short, context);
  } finally {
    // The machine stays up for the next session; only the local connection is dropped.
    await machine.detach();
  }
}

export const shellCommand: Command = {
  name: 'shell',
  group: 'machines',
  summary: 'open a terminal on a kept machine',
  usage: USAGE,
  run,
};
