import { parseArgs } from 'node:util';
import { bisect } from '../bisect/bisect.ts';
import { loadCapsule } from '../capsule/source.ts';
import { TwinError } from '../errors.ts';
import { renderBisect } from '../report/bisect.ts';
import {
  type Command,
  type CommandContext,
  capsuleSource,
  stderrStyle,
  stdoutStyle,
} from './context.ts';
import { parseEnvAssignments, positiveInt } from './options.ts';

const USAGE = `Usage: twin bisect <failing-capsule> --good <passing-capsule> [options]

Finds the smallest set of environment differences (env values, time zone,
node version, npm dependency versions, working tree diff) that turns the
passing environment into the failing one. Both capsules must come from the
same commit. Runs on one Solari sandbox: the passing environment is built
once, and each trial applies a subset of differences on that machine.
Capsules can be file paths or https URLs, such as GitHub issue attachments.

Needs SOLARI_API_KEY in the environment.

Options:
      --good <capsule>     capsule of an environment where the command passes (required)
      --attempts <n>       runs per trial (default 1; raise for flaky commands)
      --env <NAME=value>   value for a variable the good capsule recorded by name (repeatable)
      --timeout <minutes>  maximum time per run (default 15)
  -v, --verbose            stream guest output
      --json               machine-readable report on stdout
  -h, --help               show this help

Exit status: 0 minimal difference found, 1 otherwise, 2 usage error.`;

async function run(args: string[], context: CommandContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      good: { type: 'string' },
      attempts: { type: 'string' },
      env: { type: 'string', multiple: true, default: [] },
      timeout: { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const { io } = context;
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1 || values.good === undefined) {
    throw new TwinError(`expected one failing capsule and --good <capsule>\n\n${USAGE}`, {
      exitCode: 2,
    });
  }

  const attempts = positiveInt(values.attempts, '--attempts', 1);
  const timeoutMinutes = positiveInt(values.timeout, '--timeout', 15);
  const env = parseEnvAssignments(values.env);
  const bad = await loadCapsule(positionals[0] as string, capsuleSource(context));
  const good = await loadCapsule(values.good, capsuleSource(context));
  const backend = await context.getBackend();
  const style = stderrStyle(context);
  const progress = (text: string) => io.stderr.write(style.dim(`twin: ${text}\n`));

  const report = await bisect(good, bad, backend, {
    attempts,
    env,
    commandTimeoutMs: timeoutMinutes * 60_000,
    onEvent: (event) => {
      if (event.type === 'machine') progress('machine ready');
      else if (event.type === 'step-start') progress(event.step.title);
      else if (event.type === 'trial-start') {
        progress(
          `trial ${event.index + 1}: ${event.atoms.length ? event.atoms.join(' + ') : 'good environment'}`,
        );
      } else if (event.type === 'trial-end') progress(`  -> ${event.trial.result}`);
      else if (event.type === 'output' && values.verbose) io.stderr.write(event.chunk);
    },
  });

  if (values.json) io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else io.stdout.write(`${renderBisect(report, stdoutStyle(context))}\n`);
  return report.verdict === 'found' ? 0 : 1;
}

export const bisectCommand: Command = {
  name: 'bisect',
  group: 'reproduce',
  summary: 'find which environment difference causes a failure',
  usage: USAGE,
  run,
};
