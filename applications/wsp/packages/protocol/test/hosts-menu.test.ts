// SPDX-License-Identifier: AGPL-3.0-only
// The Hosts menu as both halves of the desktop draw it from one list: the
// app's own computer first, then every host on the account with the current
// one marked.
import { describe, expect, it } from "vitest";
import { absentComputer, awayMsOf, hereWord, hostMenuAction, hostsMenuItems, placeForksNowhereLine, placeSpendLine, placeWorkspacesCell, placeWorkspacesParts, placesSpendFoot, shellVersionNotice, type HostsView, type PlaceView } from "../src/index.js";

const VIEW: HostsView = {
  here: "This Mac",
  current: "box",
  hosts: [
    { alias: "attic", url: "https://hattic.boxes.example" },
    { alias: "box", url: "https://hbox1.boxes.example" },
  ],
};

describe("hostsMenuItems", () => {
  it("puts this computer first and marks the current host alone, in one group", () => {
    const rows = hostsMenuItems(VIEW);
    expect(rows.map(r => [r.label, r.checked ?? null, r.enabled])).toEqual([
      ["This Mac", false, true],
      ["attic", false, true],
      ["box", true, true],
    ]);
    expect(new Set(rows.map(r => r.group)).size).toBe(1);
    const home = hostsMenuItems({ ...VIEW, current: null });
    expect(home[0]).toMatchObject({ checked: true });
    expect(home.filter(r => r.checked === true)).toHaveLength(1);
  });

  it("names the host each row moves to back from its id, and nothing for an id it never minted", () => {
    const rows = hostsMenuItems(VIEW);
    expect(rows.map(r => hostMenuAction(r.id))).toEqual([{ alias: null }, { alias: "attic" }, { alias: "box" }]);
    expect(hostMenuAction("open-terminal")).toBeUndefined();
    expect(hostMenuAction("disconnect:box")).toBeUndefined();
    expect(hostMenuAction("connect")).toBeUndefined();
  });
});

describe("what the Computers table says about a computer", () => {
  const view = (over: Partial<PlaceView> = {}): PlaceView => ({ id: "p_1", kind: "computer", name: "old-macbook", default: false, present: true, engine: "none", takesForks: true, ...over });
  const now = Date.parse("2026-09-12T12:00:00.000Z");

  it("holds one word for the silence in the table's own slot, and dates it only where there is room", () => {
    const reading = (over: Partial<PlaceView>) => absentComputer("old-macbook", awayMsOf(view(over), now));
    // The slot stands beside three fact columns, so it takes the word alone; the figure is on the row's title,
    // in the detail's Answered row, and on the sidebar row's third line, which has room for it.
    for (const over of [{ lastSeenAt: "2026-09-12T10:00:00.000Z" }, { lastSeenAt: "2026-09-12T11:48:00.000Z" }, {}]) {
      expect(reading(over).away).toBe("no answer");
    }
    expect(reading({ lastSeenAt: "2026-09-12T10:00:00.000Z" }).line).toBe("no answer 2 h, is it on?");
    expect(reading({ lastSeenAt: "2026-09-12T11:48:00.000Z" }).line).toBe("no answer 12 min, is it on?");
    expect(reading({}).line).toBe("no answer, is it on?");
  });

  it("says the count it is given and nothing else about a computer of the person's own, whether or not it answers", () => {
    // Every computer on this list forks: a box whose kernel cannot is turned down at the join, so there is no
    // second kind of computer row and no clause behind the count for one.
    expect(placeWorkspacesCell(view(), 1)).toBe("1");
    expect(placeWorkspacesCell(view({ present: false }), 1)).toBe("1");
    expect(placeWorkspacesCell(view(), 0)).toBe("0");
  });

  it("puts the month behind a row beside its count, where the host has metered anything on it", () => {
    const provider = { id: "box", kind: "provider" as const, name: "box", default: false };
    expect(placeWorkspacesCell(provider, 2, 0.41)).toBe("2, $0.41 this month");
    // Money is spelled the one way the protocol spells it, which is cents whatever the size.
    expect(placeWorkspacesCell(provider, 1, 0.0042)).toBe("1, $0.00 this month");
    // A computer of the person's own is charged by nobody, so a month never lands on its row.
    expect(placeWorkspacesCell(view(), 1, 0.41)).toBe("1");
    expect(placeWorkspacesCell(provider, 2)).toBe("2");
  });

  it("hands the cell to a table in two parts, the count and the note behind it, and reads as one line anywhere else", () => {
    const provider = { id: "box", kind: "provider" as const, name: "box", default: false };
    expect(placeWorkspacesParts(provider, 2, 0.41)).toEqual({ count: "2", note: "$0.41 this month" });
    expect(placeWorkspacesParts(provider, 2)).toEqual({ count: "2" });
    expect(placeWorkspacesParts(view(), 1)).toEqual({ count: "1" });
    // The one line is the two parts joined, so a table and a row of words cannot say different things.
    for (const [row, count, usd] of [[provider, 2, 0.41], [view(), 1, undefined]] as const) {
      const parts = placeWorkspacesParts(row, count, usd);
      expect(placeWorkspacesCell(row, count, usd)).toBe(parts.note === undefined ? parts.count : `${parts.count}, ${parts.note}`);
    }
  });

  it("says what one place took this month and what it burns now, and what every provider took together", () => {
    expect(placeSpendLine({ monthUsd: 4.12, rateUsdPerHour: 0.16 }, 2)).toBe("$4.12 this month, $0.16/hr now across 2 workspaces");
    expect(placeSpendLine({ monthUsd: 0, rateUsdPerHour: 0 }, 1)).toBe("$0.00 this month, $0.00/hr now across 1 workspace");
    expect(placesSpendFoot(4.53, 2)).toBe("$4.53 this month across 2 providers");
    expect(placesSpendFoot(0.41, 1)).toBe("$0.41 this month across 1 provider");
  });

  it("reads the count off the list it is handed, never off the workspace a join recorded on the row", () => {
    // This computer's own workspace and a provider's forks are on no row, so a cell read off the row said 0 for
    // both: the count is the caller's and the row only says what kind of place it is about.
    expect(placeWorkspacesCell({ id: "here", kind: "computer", name: "here", default: true, takesForks: false }, 1)).toBe("1");
    expect(placeWorkspacesCell({ id: "box", kind: "provider", name: "box", default: false }, 2)).toBe("2");
  });

  it("names the place in the forks-nowhere line, which is a record that went and never a kernel that cannot", () => {
    // Every computer on the list forks: a box whose kernel cannot is turned down at the join and again at every
    // link, so the only way to reach this line is a place the host stopped holding.
    expect(placeForksNowhereLine("laptop")).toBe("laptop is no longer a place in this wsp, so nothing forks there");
  });
});

describe("hereWord", () => {
  it("says This Mac on a Mac and this computer anywhere else", () => {
    expect(hereWord(true)).toBe("This Mac");
    expect(hereWord(false)).toBe("This computer");
  });
});

describe("the version notice across hosts", () => {
  it("names the host by its label when the window is on one somewhere else, and as today on this computer", () => {
    expect(shellVersionNotice("0.2.0", "0.3.0", "maya@box")?.line).toBe("this app is 0.2.0, the host maya@box is 0.3.0: get the new app");
    expect(shellVersionNotice("0.3.0", "0.2.0", "maya@box")?.line).toBe("this app is 0.3.0, the host maya@box is 0.2.0: run the app's own host");
    expect(shellVersionNotice("0.2.0", "0.3.0")?.line).toBe("this app is 0.2.0, the host is 0.3.0: get the new app");
    expect(shellVersionNotice("0.2.0", "0.2.0", "maya@box")).toBeUndefined();
  });
});
