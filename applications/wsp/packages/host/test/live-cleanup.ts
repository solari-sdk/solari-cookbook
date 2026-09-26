// SPDX-License-Identifier: AGPL-3.0-only
// What a live test does with the machines and snapshots it made: kill and delete
// until the provider says gone, retrying through a network that drops out, inside
// a budget. What is still there when the budget is spent is returned so the test
// fails loud instead of reading green over a leaked machine.
import type { MachineBackend } from "@wsp/engine";

export interface CleanupOptions {
  /** How long the whole cleanup may take before what is left is given up on. */
  budgetMs?: number;
  /** First wait between attempts; doubles each retry, capped at a minute. */
  startMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One line per retry, naming the id and the reason. */
  log?: (line: string) => void;
}

export interface Leaked {
  machines: string[];
  snapshots: string[];
}

const isMissing = (e: unknown): boolean => (e as { kind?: unknown }).kind === "missing";
const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function cleanupUntilGone(backend: MachineBackend, machines: Iterable<string>, snapshots: Iterable<string>, opts: CleanupOptions = {}): Promise<Leaked> {
  const budgetMs = opts.budgetMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const deadline = now() + budgetMs;
  let wait = opts.startMs ?? 2_000;

  /** Runs one attempt of `step` per pending item until each answers done or the budget is spent. */
  const drain = async (what: string, ids: string[], step: (id: string) => Promise<boolean>): Promise<string[]> => {
    let pending = [...ids];
    while (pending.length > 0) {
      const left: string[] = [];
      for (const id of pending) {
        let done: boolean;
        let why = "";
        try {
          done = await step(id);
          if (!done) why = "still there";
        } catch (e) {
          done = false;
          why = reasonOf(e);
        }
        if (!done) left.push(id);
        if (!done && now() + wait < deadline) log(`${what} ${id}: ${why}; retrying in ${Math.round(wait / 1000)} s`);
      }
      pending = left;
      if (pending.length === 0 || now() + wait >= deadline) break;
      await sleep(wait);
      wait = Math.min(wait * 2, 60_000);
    }
    return pending;
  };

  const leakedMachines = await drain("kill", [...machines], async id => {
    let machine;
    try {
      machine = await backend.get(id);
    } catch (e) {
      if (isMissing(e)) return true;
      throw e;
    }
    await machine.kill();
    return (await machine.state()) === "gone";
  });
  const leakedSnapshots = await drain("delete snapshot", [...snapshots], async id => {
    try {
      await backend.deleteSnapshot(id);
    } catch (e) {
      if (isMissing(e)) return true;
      throw e;
    }
    return true;
  });
  return { machines: leakedMachines, snapshots: leakedSnapshots };
}

/** The line a test throws with when the budget is spent: every id still on the account. */
export function describeLeak(leaked: Leaked): string | undefined {
  if (leaked.machines.length + leaked.snapshots.length === 0) return undefined;
  const parts = [
    ...(leaked.machines.length > 0 ? [`machines still on the account: ${leaked.machines.join(", ")}`] : []),
    ...(leaked.snapshots.length > 0 ? [`snapshots still on the account: ${leaked.snapshots.join(", ")}`] : []),
  ];
  return `cleanup gave up after its budget; ${parts.join("; ")}. Kill and delete them by these ids.`;
}
