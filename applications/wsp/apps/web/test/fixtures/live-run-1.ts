// SPDX-License-Identifier: AGPL-3.0-only
// Live run 1 (2026-09-02, Solari sandbox golden v1) as the runtime's event
// stream saw it, copied from the live-run listener's events.log and events2.log.
// These events predate the wire's at and turnId fields, so they exercise the
// fallbacks. The listener kept golden.*, workspace.*, session.start,
// session.done and session.end only (no session.delta), dropped result.text,
// and cut every JSON payload at 140 characters. What that means for this copy:
// - `at` is the listener's relative stamp turned into an ISO time; t0 is fixed
//   by the golden's sealed timestamp in state.json (2026-09-02T17:18:49.268Z at
//   +614.5s).
// - Machine ids are redacted to machine-1 / machine-2, the golden snapshot id
//   to snap-golden-v1.
// - Fields cut off by the 140-char limit are omitted where the schema allows
//   (costUsd, tools, model) and filled from state.json and the cost events
//   where it does not (golden, size, rateUsdPerHour, reach); those are marked
//   "filled" inline. Nothing that survived the cut was altered.
// - The restart log had its own listener clock that was not recorded; its
//   events are placed right after the first log's close.
import type { EventUnion } from "@wsp/protocol";

export interface StampedEvent {
  readonly at: string;
  readonly event: EventUnion;
}

const T0_MS = Date.parse("2026-09-02T17:18:49.268Z") - 614_500;
const at = (seconds: number): string => new Date(T0_MS + Math.round(seconds * 1000)).toISOString();

export const LIVE_WS = "ws_f2cb42d4";
export const LIVE_WS_2 = "ws_d954eced";
export const LIVE_SID = "59094224-bb3d-43b6-b054-322aa849fa00";
const scope = { workspaceId: LIVE_WS, sessionId: LIVE_SID };
const GOLDEN = "snap-golden-v1"; // filled: state.json goldens.default.versions[0], redacted
const SIZE = { cpu: 2, memMb: 4096 }; // filled: the 0.11 USD/h rate in the cost events is this size's awake rate

export const LIVE_WORKSPACE_1 = {
  id: LIVE_WS,
  name: "first",
  machineId: "machine-1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: GOLDEN,
  createdAt: at(643.8),
} as const;

export const LIVE_WORKSPACE_2 = {
  id: LIVE_WS_2,
  name: "yolo",
  machineId: "machine-2", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: GOLDEN,
  createdAt: at(1098.5),
} as const;

export const LIVE_RUN_1: ReadonlyArray<StampedEvent> = [
  { at: at(563.0), event: { type: "golden.stage", name: "default", stage: "snapshotting", detail: "golden-v1" } },
  { at: at(585.6), event: { type: "golden.stage", name: "default", stage: "smoke-forking", detail: "claude --version" } },
  { at: at(614.5), event: { type: "golden.stage", name: "default", stage: "sealed", detail: "v1" } },
  { at: at(643.8), event: { type: "workspace.created", workspace: LIVE_WORKSPACE_1 } },
  {
    at: at(649.7),
    event: {
      type: "workspace.status",
      status: {
        ...LIVE_WORKSPACE_1,
        machineState: "running", // filled
        reach: { state: "reachable" }, // filled
        size: SIZE,
        rateUsdPerHour: 0.11,
      },
    },
  },
  { at: at(660.9), event: { type: "session.start", ...scope, prompt: "hello", model: "claude-opus-5[1m]", cwd: "/" } },
  { at: at(663.0), event: { type: "session.done", ...scope, result: { status: "completed", durationMs: 2772 } } },
  { at: at(665.1), event: { type: "session.end", ...scope, exitCode: 0, sawResult: true } },
  { at: at(678.3), event: { type: "session.start", ...scope, prompt: "build a simple chat app, run it locally, use npm" } },
  { at: at(780.2), event: { type: "session.done", ...scope, result: { status: "completed", durationMs: 101515 } } },
  { at: at(785.2), event: { type: "session.end", ...scope, exitCode: 0, sawResult: true } },
  { at: at(900.3), event: { type: "session.start", ...scope, prompt: "/model", model: "claude-opus-5", cwd: "/" } },
  { at: at(900.3), event: { type: "session.done", ...scope, result: { status: "completed", durationMs: 114, costUsd: 0 } } },
  { at: at(900.6), event: { type: "session.end", ...scope, exitCode: 0, sawResult: true } },
  { at: at(925.7), event: { type: "session.start", ...scope, prompt: "anyways can you make it more beautiful, use shadcn" } },
  { at: at(1098.5), event: { type: "workspace.created", workspace: LIVE_WORKSPACE_2 } },
  {
    at: at(1110.8),
    event: {
      type: "workspace.status",
      status: { ...LIVE_WORKSPACE_2, machineState: "running", reach: { state: "reachable" }, size: SIZE, rateUsdPerHour: 0.11 }, // filled: machineState, reach
    },
  },
  { at: at(1788.2), event: { type: "session.done", ...scope, result: { status: "completed", durationMs: 862399 } } },
  { at: at(1788.9), event: { type: "session.end", ...scope, exitCode: 0, sawResult: true } },
];

/** events2.log: the next runtime start, ws_f2cb42d4 napping until a wake at +512.7s. */
export const LIVE_RUN_1_RESTART: ReadonlyArray<StampedEvent> = [
  {
    at: at(2894.1 + 64.9),
    event: {
      type: "workspace.status",
      status: {
        ...LIVE_WORKSPACE_1,
        phase: "napping", // filled: the wake at +512.7s implies it
        machineState: "paused", // filled
        reach: { state: "napping" }, // filled
        size: SIZE,
        rateUsdPerHour: 0.11,
      },
    },
  },
  // machine-1 again: the woken event's id matched the first run's, so no resurrection
  { at: at(2894.1 + 512.7), event: { type: "workspace.woken", workspaceId: LIVE_WS, machineId: "machine-1", resurrected: false } },
];

export function sessionEventsOf(stream: ReadonlyArray<StampedEvent>) {
  return stream.flatMap(s =>
    s.event.type === "session.start" || s.event.type === "session.delta" || s.event.type === "session.done" || s.event.type === "session.end"
      ? [{ at: s.at, event: s.event }]
      : [],
  );
}
