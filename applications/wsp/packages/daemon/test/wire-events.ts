// SPDX-License-Identifier: AGPL-3.0-only
import { DaemonEvent } from "@wsp/protocol";

/** The event frames a client received that the protocol's DaemonEvent rejects, each with the reason. */
export function rejectedEvents(events: ReadonlyArray<Record<string, unknown>>): Array<{ event: Record<string, unknown>; error: string }> {
  const out: Array<{ event: Record<string, unknown>; error: string }> = [];
  for (const event of events) {
    const parsed = DaemonEvent.safeParse(event);
    if (!parsed.success) out.push({ event, error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  return out;
}
