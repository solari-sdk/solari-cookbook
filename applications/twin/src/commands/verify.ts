import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCapsule } from '../capsule/source.ts';
import { TwinError } from '../errors.ts';
import { verifyFix } from '../replay/replay.ts';
import { renderVerifyMarkdown } from '../report/markdown.ts';
import { renderReplay } from '../report/replay.ts';
import {
  type Command,
  type CommandContext,
  capsuleSource,
  stderrStyle,
  stdoutStyle,
} from './context.ts';
import { parseEnvAssignments, positiveInt } from './options.ts';
import { replayProgress } from './replay.ts';

const USAGE = `Usage: twin verify <capsule> (--patch <file> | --ref <sha>) [options]

Checks a candidate fix in the reporter's environment: rebuilds it on a Solari
sandbox like replay, applies the fix, reruns the command and reports whether
the captured failure is gone. First it runs the command once without the fix,
so a failure that replay cannot reproduce is INCONCLUSIVE, never FIXED.
With --patch nothing has to be pushed first.
Capsules can be file paths or https URLs, such as GitHub issue attachments.

Needs SOLARI_API_KEY in the environment.

Options:
      --patch <file>       unified diff applied on top of the capsule's tree
      --ref <sha>          check out this commit instead (e.g. a fix branch)
      --repo <url>         clone from here (forks); use with --ref
      --attempts <n>       runs of the command (default 3)
      --no-pin             do not install the capsule's recorded package versions over the lockfile install
      --env <NAME=value>   value for a variable the capsule recorded by name (repeatable)
      --timeout <minutes>  maximum time per attempt (default 15)
  -v, --verbose            stream guest output
      --json               machine-readable report on stdout
      --comment <file>     also write a Markdown pull request comment to <file>
  -h, --help               show this help

Exit status: 0 fixed, 1 otherwise, 2 usage error.`;

async function run(args: string[], context: CommandContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      patch: { type: 'string' },
      ref: { type: 'string' },
      repo: { type: 'string' },
      attempts: { type: 'string' },
      'no-pin': { type: 'boolean', default: false },
      env: { type: 'string', multiple: true, default: [] },
      timeout: { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      json: { type: 'boolean', default: false },
      comment: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const { io } = context;
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1)
    throw new TwinError(`expected one capsule path\n\n${USAGE}`, { exitCode: 2 });
  if ((values.patch === undefined) === (values.ref === undefined)) {
    throw new TwinError(`pass exactly one of --patch or --ref\n\n${USAGE}`, { exitCode: 2 });
  }

  const attempts = positiveInt(values.attempts, '--attempts', 3);
  const timeoutMinutes = positiveInt(values.timeout, '--timeout', 15);
  const env = parseEnvAssignments(values.env);
  const capsule = await loadCapsule(positionals[0] as string, capsuleSource(context));
  if (capsule.command.outcome !== 'fail') {
    throw new TwinError(
      'the capsule recorded a passing run; there is no failure to verify a fix for',
      {
        exitCode: 2,
      },
    );
  }
  let patch: string | undefined;
  if (values.patch !== undefined) {
    const path = resolve(context.cwd, values.patch);
    try {
      patch = await readFile(path, 'utf8');
    } catch (error) {
      throw new TwinError(
        `cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? error}`,
        {
          cause: error,
        },
      );
    }
  }
  const backend = await context.getBackend();

  const report = await verifyFix(capsule, backend, {
    attempts,
    pin: !values['no-pin'],
    env,
    commandTimeoutMs: timeoutMinutes * 60_000,
    ...(patch === undefined ? {} : { patch }),
    ...(values.ref === undefined ? {} : { ref: values.ref }),
    ...(values.repo === undefined ? {} : { repoUrl: values.repo }),
    onEvent: replayProgress(io, stderrStyle(context), values.verbose),
  });

  if (values.comment !== undefined) {
    const markdown = renderVerifyMarkdown(report, capsule, {
      source: positionals[0] as string,
      ...(values.ref === undefined ? {} : { ref: values.ref }),
    });
    await writeFile(resolve(context.cwd, values.comment), markdown, 'utf8');
  }
  if (values.json) io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else io.stdout.write(`${renderReplay(report, stdoutStyle(context), { verify: true })}\n`);
  return report.verdict === 'not-reproduced' ? 0 : 1;
}

export const verifyCommand: Command = {
  name: 'verify',
  group: 'reproduce',
  summary: "check a candidate fix in the reporter's environment",
  usage: USAGE,
  run,
};
