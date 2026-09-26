// SPDX-License-Identifier: AGPL-3.0-only
// The status a phase implies, for tests and the browser fixtures: one place spells the mapping the runtime's
// machineStateOf makes, which apps/web may not import.
import type { WorkspaceStatus, WorkspaceView } from "@wsp/protocol";

export function statusOf(w: WorkspaceView, over: Partial<WorkspaceStatus> = {}): WorkspaceStatus {
  const napping = w.phase === "napping";
  const gone = w.phase === "gone";
  return {
    ...w,
    machineState: napping ? "paused" : gone ? "gone" : "running",
    reach: { state: napping ? "napping" : gone ? "gone" : "reachable" },
    size: { cpu: 2, memMb: 4096 },
    rateUsdPerHour: 0.11,
    ...(w.gone !== undefined ? { reason: w.gone } : {}),
    ...over,
  };
}
