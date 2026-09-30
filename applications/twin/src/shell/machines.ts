import { type Backend, type Machine, type MachineInfo, TWIN_LABELS } from '../backend/types.ts';
import { TwinError } from '../errors.ts';
import { SHELL_SCRIPT } from './guest.ts';

/** Solari ids run to ~200 characters; people and agents pass a prefix. */
export function shortMachineId(id: string): string {
  return id.slice(0, 12);
}

/** The running twin machine whose id starts with `prefix`, or the only one when no prefix. */
export async function resolveMachine(
  backend: Backend,
  prefix: string | undefined,
): Promise<MachineInfo> {
  const running = await backend.list({ ...TWIN_LABELS });
  const matches = prefix ? running.filter((m) => m.id.startsWith(prefix)) : running;
  if (matches.length === 1) return matches[0] as MachineInfo;
  const known = running
    .map((m) => `  ${shortMachineId(m.id)}  run ${m.labels.run ?? '?'}`)
    .join('\n');
  if (matches.length === 0) {
    throw new TwinError(
      running.length === 0
        ? 'no twin machine is running; keep one with: twin replay <capsule> --keep'
        : `no running twin machine starts with "${prefix}". Running:\n${known}`,
    );
  }
  throw new TwinError(`several twin machines match; pass more of the id:\n${known}`, {
    exitCode: 2,
  });
}

/** Fails unless `replay --keep` prepared this machine (its entry point `script` exists). */
export async function ensureKept(machine: Machine, script: string = SHELL_SCRIPT): Promise<void> {
  const ready = await machine.run({ argv: ['test', '-x', script], timeoutMs: 30_000 });
  if (ready.exitCode !== 0) {
    throw new TwinError(
      `machine ${shortMachineId(machine.id)} was not kept by \`twin replay --keep\` (no ${script})`,
    );
  }
}
