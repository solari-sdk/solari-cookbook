// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  closeTerminal,
  DEFAULT_TERMINAL_UI_STATE,
  MAX_TERMINALS_PER_GROUP,
  newTerminal,
  reconcileTerminalIds,
  setActiveTerminal,
  splitTerminal,
  type TerminalUiState,
} from "../src/terminal/groups.js";

describe("terminal groups", () => {
  it("a new terminal gets its own group and becomes active", () => {
    const s = newTerminal(newTerminal(DEFAULT_TERMINAL_UI_STATE, "p1"), "p2");
    expect(s.terminalIds).toEqual(["p1", "p2"]);
    expect(s.activeTerminalId).toBe("p2");
    expect(s.terminalGroups.map(g => g.terminalIds)).toEqual([["p1"], ["p2"]]);
    expect(s.terminalOpen).toBe(true);
  });

  it("a split joins the active group after the active terminal and records the direction", () => {
    let s = newTerminal(newTerminal(DEFAULT_TERMINAL_UI_STATE, "p1"), "p2");
    s = setActiveTerminal(s, "p1");
    s = splitTerminal(s, "p3", "vertical");
    expect(s.terminalGroups[0]).toEqual({ id: "group-p1", terminalIds: ["p1", "p3"], splitDirection: "vertical" });
    expect(s.activeTerminalGroupId).toBe("group-p1");
    expect(s.activeTerminalId).toBe("p3");
  });

  it("a group refuses more than the split limit", () => {
    let s: TerminalUiState = newTerminal(DEFAULT_TERMINAL_UI_STATE, "p1");
    for (let i = 2; i <= MAX_TERMINALS_PER_GROUP + 1; i++) s = splitTerminal(s, `p${i}`);
    expect(s.terminalGroups[0]!.terminalIds).toHaveLength(MAX_TERMINALS_PER_GROUP);
    expect(s.terminalIds).not.toContain(`p${MAX_TERMINALS_PER_GROUP + 1}`);
  });

  it("closing the active terminal activates its neighbour and drops empty groups", () => {
    let s = splitTerminal(newTerminal(DEFAULT_TERMINAL_UI_STATE, "p1"), "p2");
    s = newTerminal(s, "p3");
    s = closeTerminal(s, "p3");
    expect(s.terminalIds).toEqual(["p1", "p2"]);
    expect(s.activeTerminalId).toBe("p2");
    expect(s.terminalGroups).toHaveLength(1);
    const empty = closeTerminal(closeTerminal(s, "p1"), "p2");
    expect(empty.terminalIds).toEqual([]);
    expect(empty.terminalOpen).toBe(false);
  });

  it("reconcile follows the daemon's pty list: gone ids leave, unknown ids get singleton groups", () => {
    const s = reconcileTerminalIds(splitTerminal(newTerminal(DEFAULT_TERMINAL_UI_STATE, "p1"), "p2"), ["p2", "p9"]);
    expect(s.terminalIds).toEqual(["p2", "p9"]);
    expect(s.activeTerminalId).toBe("p2");
    expect(s.terminalGroups.map(g => g.terminalIds)).toEqual([["p2"], ["p9"]]);
  });
});
