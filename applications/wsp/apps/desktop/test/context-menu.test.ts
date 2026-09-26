// SPDX-License-Identifier: AGPL-3.0-only
// The native context menu from the page's items: one row each in the page's
// order, a separator where the group changes, disabled rows dimmed with their
// refusal as hover text and the chord in Electron's spelling, and the answer
// the popup gives back: the row clicked, or null when the menu closed on
// nothing. Only the page's own shape is accepted off the wire. The workspace
// menu the smoke expects is derived from the page's registry through that same
// builder, so it is checked here that the derivation is the registry's order.
import type { ContextMenuItem, WorkspaceView } from "@wsp/protocol";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { chooseFrom, contextMenuTemplate, parseContextMenuItems } from "../src/context-menu.js";
import { WORKSPACE_WORDS } from "../../web/src/actions/format.js";
import { workspaceActions, workspaceTarget } from "../../web/src/actions/workspaceActions.js";
import { SEPARATOR, workspaceMenuShape } from "./workspace-menu.js";

const ITEMS: ContextMenuItem[] = [
  { id: "phase", label: "Pause task", group: "state", enabled: true },
  { id: "rebuild", label: "Rebuild machine", group: "state", enabled: false, refusal: "Rebuild replaces a gone or zombie machine; this one answers" },
  { id: "open-terminal", label: "Open terminal", group: "open", enabled: true, shortcut: "⌘J", accelerator: "CommandOrControl+J" },
  { id: "forget", label: "Forget task", group: "remove", enabled: false, refusal: "Only a workspace whose machine is gone can be forgotten; this one is running", destructive: true },
];

const clickOf = (template: MenuItemConstructorOptions[], label: string) => template.find(row => row.label === label)!.click!;
const fakeClick = (): [MenuItem: import("electron").MenuItem, window: undefined, event: import("electron").KeyboardEvent] => [{} as import("electron").MenuItem, undefined, {} as import("electron").KeyboardEvent];

describe("contextMenuTemplate", () => {
  it("gives a row that can run its hint as the hover text, and a dimmed row's reason still wins the slot", () => {
    const rows: ContextMenuItem[] = [
      { id: "nap", label: "Pause task", group: "state", enabled: true, checked: false, hint: "a nap keeps the memory and bills nothing" },
      { id: "rebuild", label: "Rebuild machine", group: "state", enabled: false, refusal: "this one answers", hint: "never read" },
    ];
    const template = contextMenuTemplate(rows, vi.fn());
    expect(template[0]).toMatchObject({ enabled: true, toolTip: "a nap keeps the memory and bills nothing" });
    expect(template[1]).toMatchObject({ enabled: false, toolTip: "this one answers" });
    expect(parseContextMenuItems(rows)).toEqual(rows);
    expect(() => parseContextMenuItems([{ id: "x", label: "x", group: "g", enabled: true, hint: 3 }])).toThrow("menu:context: not a list of items");
  });

  it("keeps the page's order, parts the groups with separators, dims a refused row with its refusal as hover text and carries the accelerator", () => {
    const choose = vi.fn();
    const template = contextMenuTemplate(ITEMS, choose);
    expect(template.map(row => row.type === "separator" ? "---" : `${row.label}${row.enabled === false ? " (off)" : ""}`)).toEqual([
      "Pause task",
      "Rebuild machine (off)",
      "---",
      "Open terminal",
      "---",
      "Forget task (off)",
    ]);
    expect(template[1]).toMatchObject({ enabled: false, toolTip: "Rebuild replaces a gone or zombie machine; this one answers" });
    expect(template[0]).not.toHaveProperty("toolTip");
    expect(template[0]).not.toHaveProperty("accelerator");
    expect(template[3]).toMatchObject({ accelerator: "CommandOrControl+J" });
    clickOf(template, "Open terminal")(...fakeClick());
    expect(choose).toHaveBeenCalledWith("open-terminal");
  });
});

describe("chooseFrom", () => {
  it("answers with the row clicked", async () => {
    const chosen = chooseFrom(ITEMS, (template, _onClose) => {
      clickOf(template, "Pause task")(...fakeClick());
    });
    await expect(chosen).resolves.toBe("phase");
  });

  it("answers null when the menu closed on nothing", async () => {
    await expect(chooseFrom(ITEMS, (_template, onClose) => onClose())).resolves.toBeNull();
  });

  it("a click that lands after the close still wins: the close waits a turn for it", async () => {
    const chosen = chooseFrom(ITEMS, (template, onClose) => {
      onClose();
      clickOf(template, "Open terminal")(...fakeClick());
    });
    await expect(chosen).resolves.toBe("open-terminal");
  });
});

describe("parseContextMenuItems", () => {
  it("accepts the page's items and refuses anything else off the wire", () => {
    expect(parseContextMenuItems(ITEMS)).toEqual(ITEMS);
    expect(() => parseContextMenuItems("nope")).toThrow("menu:context: not a list of items");
    expect(() => parseContextMenuItems([{ id: 1, label: "x", group: "g", enabled: true }])).toThrow("menu:context: not a list of items");
    expect(() => parseContextMenuItems([{ id: "x", label: "x", group: "g", enabled: true, refusal: 3 }])).toThrow("menu:context: not a list of items");
  });
});

describe("the workspace menu the smoke expects", () => {
  const RUNNING: WorkspaceView = {
    id: "ws_a",
    name: "first",
    machineId: "m_ws_a",
    project: { id: "pr_1", name: "api", path: "/root/api", computer: "default" },
    phase: "running",
    golden: "snap_g",
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  it("is the workspace registry's own words in its own order, with a separator wherever the group changes", () => {
    const target = workspaceTarget(RUNNING, null, []);
    const shape = workspaceMenuShape(RUNNING);
    // The rows a running workspace of this kind takes; the registry's own rule leaves out the roads out of a state
    // it is not in, and the shape the smoke expects is the shape a person sees.
    const shown = workspaceActions.filter(entry => entry.applies?.(target) ?? true);
    expect(shape.filter(row => row !== SEPARATOR)).toEqual(shown.map(entry => entry.title(target)));
    const groups = shown.map(entry => entry.group);
    expect(shape.filter(row => row === SEPARATOR)).toHaveLength(groups.filter((group, i) => i > 0 && groups[i - 1] !== group).length);
    // Read straight through, so a separator in the wrong place is a failure and not only a wrong count. The words
    // are named by key from the one table that holds them, never spelled again here.
    expect(shape).toEqual([
      WORKSPACE_WORDS.pause,
      SEPARATOR,
      WORKSPACE_WORDS.newThread,
      WORKSPACE_WORDS.openTerminal,
      WORKSPACE_WORDS.openBrowser,
      SEPARATOR,
      WORKSPACE_WORDS.bringBack,
      WORKSPACE_WORDS.exportProject,
      SEPARATOR,
      WORKSPACE_WORDS.rename,
      WORKSPACE_WORDS.fork,
      SEPARATOR,
      WORKSPACE_WORDS.copyId,
      SEPARATOR,
      WORKSPACE_WORDS.delete,
    ]);
  });

  it("follows the registry: an action added to it lands in the shape without this file or the smoke changing", () => {
    const target = workspaceTarget(RUNNING, null, []);
    const before = workspaceMenuShape(RUNNING);
    const shown = workspaceActions.filter(entry => entry.applies?.(target) ?? true);
    const added = [...shown, { ...shown[0]!, id: "invented", group: "invented", applies: undefined, title: () => "Invented" }];
    const shape = contextMenuTemplate(
      added.map(entry => ({ id: entry.id, label: entry.title(target), group: entry.group, enabled: true })),
      () => {},
    ).map(row => (row.type === "separator" ? SEPARATOR : String(row.label)));
    expect(shape).toEqual([...before, SEPARATOR, "Invented"]);
  });
});

describe("a checked row", () => {
  it("is a checkbox row with its mark, and an unchecked one carries no type at all", () => {
    const items = parseContextMenuItems([
      { id: "switch:", label: "This Mac", group: "hosts", enabled: true, checked: false },
      { id: "switch:box", label: "box", group: "hosts", enabled: true, checked: true },
      { id: "connect", label: "Connect to a host…", group: "add", enabled: true },
    ]);
    const template = contextMenuTemplate(items, () => {});
    expect(template[0]).toMatchObject({ type: "checkbox", checked: false });
    expect(template[1]).toMatchObject({ type: "checkbox", checked: true });
    expect(template[3]).not.toHaveProperty("type");
    expect(() => parseContextMenuItems([{ id: "x", label: "x", group: "g", enabled: true, checked: "yes" }])).toThrow(/not a list of items/);
  });
});
