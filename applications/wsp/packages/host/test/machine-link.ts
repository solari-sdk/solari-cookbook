// SPDX-License-Identifier: AGPL-3.0-only
// The socket a place proved, driven as the host's engine drives it: one request and one answer per frame. Shared
// by the round trip tests, whichever backend stands on the far side.
import type WebSocket from "ws";
import type { MachineLink } from "@wsp/engine";

/** One request and its answer on the socket a place proved, which is the road the host's engine drives. */
export function linkOver(ws: WebSocket): MachineLink {
  let next = 1;
  const pending = new Map<number, { done: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const id = frame["id"];
    if (typeof id !== "number") return;
    const held = pending.get(id);
    if (held === undefined) return;
    pending.delete(id);
    if (frame["ok"] === true) held.done(frame);
    else held.fail(Object.assign(new Error(String(frame["error"])), { kind: frame["kind"], status: frame["status"] }));
  });
  return {
    request: (op, params) =>
      new Promise((done, fail) => {
        const id = next++;
        pending.set(id, { done, fail });
        ws.send(JSON.stringify({ id, op, ...params }));
      }),
    forward: async placePort => ({ localPort: placePort }),
  };
}
