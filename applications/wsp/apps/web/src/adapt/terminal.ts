// SPDX-License-Identifier: AGPL-3.0-only
// Daemon pty events into the attach-stream shape the copied terminal viewport
// consumes (t3code contracts/terminal.ts TerminalAttachStreamEvent, commit
// 57a66608). Bytes take the direct path: the viewport hands `output.data`
// to the surface's write, so this stays a rename, not a buffer;
// the daemon's pty.mode report becomes the activity event (foreground comm as
// the label). Writes and resizes go the other way as pty.write and pty.resize
// requests and need no adapter.
import type { DaemonEvent } from "@wsp/protocol";
import type { TerminalAttachStreamEvent } from "./view-model.js";

type PtyEvent = Extract<DaemonEvent, { type: "pty.data" | "pty.exit" | "pty.mode" }>;

export function isPtyEvent(event: DaemonEvent): event is PtyEvent {
  return event.type === "pty.data" || event.type === "pty.exit" || event.type === "pty.mode";
}

/** threadId is the workspace: one daemon link per workspace, ptys scoped under it. */
export function toTerminalAttachEvent(workspaceId: string, event: PtyEvent): TerminalAttachStreamEvent {
  const base = { threadId: workspaceId, terminalId: event.ptyId };
  switch (event.type) {
    case "pty.data":
      return { ...base, type: "output", data: event.data };
    case "pty.exit":
      return { ...base, type: "exited", exitCode: event.exitCode, exitSignal: event.signal ?? null };
    case "pty.mode":
      return { ...base, type: "activity", hasRunningSubprocess: event.mode === "raw", label: event.foreground };
    default: {
      const _exhaustive: never = event;
      throw new Error(`not a pty event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
