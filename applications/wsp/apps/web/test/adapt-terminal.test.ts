// SPDX-License-Identifier: AGPL-3.0-only
// Daemon pty events into the terminal attach-stream shape.
import { describe, expect, it } from "vitest";
import type { DaemonEvent } from "@wsp/protocol";
import { isPtyEvent, toTerminalAttachEvent } from "../src/adapt/index.js";

const RED = "\u001b[31mhi\r\n";

describe("toTerminalAttachEvent", () => {
  it.each<[string, DaemonEvent, unknown]>([
    ["pty.data is output, bytes untouched", { type: "pty.data", ptyId: "p1", data: RED }, { type: "output", threadId: "ws", terminalId: "p1", data: RED }],
    ["pty.exit with a signal", { type: "pty.exit", ptyId: "p1", exitCode: 130, signal: 2 }, { type: "exited", threadId: "ws", terminalId: "p1", exitCode: 130, exitSignal: 2 }],
    ["pty.exit without a signal", { type: "pty.exit", ptyId: "p1", exitCode: 0 }, { type: "exited", threadId: "ws", terminalId: "p1", exitCode: 0, exitSignal: null }],
    ["raw mode means a foreground program owns the tty", { type: "pty.mode", ptyId: "p1", mode: "raw", echo: false, foreground: "vim" }, { type: "activity", threadId: "ws", terminalId: "p1", hasRunningSubprocess: true, label: "vim" }],
    ["line mode is the shell prompt", { type: "pty.mode", ptyId: "p1", mode: "line", echo: true, foreground: "bash" }, { type: "activity", threadId: "ws", terminalId: "p1", hasRunningSubprocess: false, label: "bash" }],
  ])("%s", (_name, event, expected) => {
    expect(isPtyEvent(event)).toBe(true);
    if (isPtyEvent(event)) expect(toTerminalAttachEvent("ws", event)).toEqual(expected);
  });

  it("port and inbox events are not pty events", () => {
    expect(isPtyEvent({ type: "port.open", port: 80 })).toBe(false);
    expect(isPtyEvent({ type: "inbox.file", path: "/x", bytes: 1 })).toBe(false);
  });
});
