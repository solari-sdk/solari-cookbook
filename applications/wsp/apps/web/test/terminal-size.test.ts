// SPDX-License-Identifier: AGPL-3.0-only
// A new pty starts at the size a view last measured, kept in localStorage so
// a reload starts the shell at that size too. The model is loaded fresh per
// case, since it reads the kept size once when the module loads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalWire } from "../src/terminal/link.js";

const SIZE_KEY = "wsp.terminal.size";

/** A wire that answers every op and keeps the params of each pty.create. */
function fakeWire(): { wire: TerminalWire; created: Record<string, unknown>[] } {
  const created: Record<string, unknown>[] = [];
  let next = 1;
  return {
    created,
    wire: {
      request: async (op, params = {}) => {
        if (op === "pty.create") {
          created.push(params);
          return { ok: true, ptyId: `p${next++}` };
        }
        return { ok: true };
      },
    },
  };
}

async function freshModel(): Promise<typeof import("../src/terminal/link.js")> {
  vi.resetModules();
  return import("../src/terminal/link.js");
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("the size a new pty starts at", () => {
  it("is 80 by 24 with nothing kept, and with a kept value that is not a size", async () => {
    const { WorkspaceTerminals } = await freshModel();
    const { wire, created } = fakeWire();
    await new WorkspaceTerminals(wire).open();
    expect(created[0]).toMatchObject({ cols: 80, rows: 24 });
    localStorage.setItem(SIZE_KEY, "{not json");
    const again = await freshModel();
    const second = fakeWire();
    await new again.WorkspaceTerminals(second.wire).open();
    expect(second.created[0]).toMatchObject({ cols: 80, rows: 24 });
  });

  it("is the last size a view measured, on this load and after a reload", async () => {
    const { WorkspaceTerminals } = await freshModel();
    const { wire, created } = fakeWire();
    const terminals = new WorkspaceTerminals(wire);
    const tab = await terminals.open();
    terminals.resize(tab.ptyId, 132, 41);
    expect(JSON.parse(localStorage.getItem(SIZE_KEY)!)).toEqual({ cols: 132, rows: 41 });
    await terminals.open({ shell: "/bin/zsh" });
    expect(created[1]).toMatchObject({ cols: 132, rows: 41, shell: "/bin/zsh" });
    const reloaded = await freshModel();
    const after = fakeWire();
    await new reloaded.WorkspaceTerminals(after.wire).open();
    expect(after.created[0]).toMatchObject({ cols: 132, rows: 41 });
  });
});
