// SPDX-License-Identifier: AGPL-3.0-only
// The creation screen's layout: everything centred on one column, the stage
// log in a box of fixed height that keeps its size from two lines to twenty,
// and the newest line last. Geometry that needs a layout engine is measured in
// creation-layout.browser.test.ts; this file checks the structure jsdom can see.
// Under the log, the view's own last line: the word table's reading of the
// record the create answered with, in the words the row it becomes carries.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTNAME_KEPT, type WorkspaceView } from "@wsp/protocol";
import { localZoneLabel } from "../src/lib/timestampFormat.js";
import { useStore, type Creation, type CreationLine } from "../src/protocol/store.js";
import { WorkspaceCreation } from "../src/shell/WorkspaceCreation.js";

afterEach(cleanup);

// The runtime's own refusal at the machine cap: the failing log line and the explanation's detail are one sentence.
const CAP_LINE = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";

function lines(count: number): CreationLine[] {
  return Array.from({ length: count }, (_, i) => ({
    stage: i === count - 1 ? "failed" : "daemon-answering",
    message: i === count - 1 ? CAP_LINE : `Stage ${i + 1} of the create ran and reported its progress here.`,
    at: new Date(Date.UTC(2026, 8, 5, 12, 31, i)).toISOString(),
    elapsedMs: 800 * (i + 1),
  }));
}

function failed(count: number): Creation {
  return {
    key: "creating:beta",
    name: "beta",
    askedAt: Date.now(),
    workspaceId: "ws_beta",
    lines: lines(count),
    failed: { title: "The provider refused: no more workspaces can run there now", detail: CAP_LINE },
  };
}

// Base UI's scroll area measures itself after mount; the act lets that settle.
const mount = async (creation: Creation) => {
  await act(async () => { render(<WorkspaceCreation creation={creation} />); });
  return screen.getByTestId("workspace-creation");
};

describe("workspace creation layout", () => {
  it("centres the eyebrow, the name, the refusal sentence and the buttons on one column", async () => {
    const view = await mount(failed(2));
    const column = view.firstElementChild!;
    expect(column.className).toContain("text-center");
    expect(within(view).getByRole("heading", { level: 1 }).textContent).toBe("beta");
    const buttons = within(view).getByRole("button", { name: "Retry" }).parentElement!;
    expect(buttons.className).toContain("justify-center");
    expect(within(buttons).getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("keeps the refusal's lead red, says the failing line's words once, Retry tactile and Dismiss as text", async () => {
    const view = await mount(failed(2));
    const lead = within(view).getByText("The provider refused: no more workspaces can run there now");
    expect(lead.className).toContain("text-destructive-foreground");
    expect(lead.nextElementSibling).toBeNull();
    expect(view.textContent!.split(CAP_LINE)).toHaveLength(2);
    expect(within(view).getByRole("button", { name: "Retry" }).className).toContain("bg-popover");
    expect(within(view).getByRole("button", { name: "Dismiss" }).className).toContain("border-transparent");
  });

  it("a detail the failing line does not already say is kept, muted, under the lead", async () => {
    const view = await mount({ ...failed(2), failed: { title: "Not connected to the runtime", detail: "runtime connection lost" } });
    const lead = within(view).getByText("Not connected to the runtime");
    expect(lead.nextElementSibling!.className).toContain("text-muted-foreground");
    expect(lead.nextElementSibling!.textContent).toContain("runtime connection lost");
  });

  it("puts the log in a box whose classes, and so its height, are the same with two lines and with twenty", async () => {
    const two = await mount(failed(2));
    const twoBox = within(two).getByTestId("creation-log");
    expect(twoBox.className).toMatch(/\bh-\d+\b/);
    expect(twoBox.className).not.toMatch(/\b(?:max|min)-h-/);
    expect(within(twoBox).getAllByRole("listitem")).toHaveLength(2);
    const twoClasses = twoBox.className;
    cleanup();

    const twenty = await mount(failed(20));
    const twentyBox = within(twenty).getByTestId("creation-log");
    expect(twentyBox.className).toBe(twoClasses);
    const items = within(twentyBox).getAllByRole("listitem");
    expect(items).toHaveLength(20);
    expect(items[19]!.textContent).toContain(CAP_LINE);
    expect(items[19]!.className).toContain("text-destructive-foreground");
  });

  it("keeps the timestamp and the duration in mono and lets the message wrap between them", async () => {
    const view = await mount(failed(2));
    const list = within(view).getByRole("list", { name: "Creation log" });
    expect(list.className).toContain("font-mono");
    expect(list.className).toContain("tabular-nums");
    const [first] = within(list).getAllByRole("listitem");
    const time = first!.querySelector("time")!;
    expect(time.className).toContain("shrink-0");
    const duration = first!.lastElementChild!;
    expect(duration.textContent).toBe("0.8s");
    expect(duration.className).toContain("shrink-0");
    const message = time.nextElementSibling!;
    expect(message.textContent).toContain("Stage 1 of the create");
    expect(message.className).toContain("break-words");
  });

  it("the wave rule spans the same column as the log box", async () => {
    const view = await mount(failed(2));
    const wave = within(view).getByRole("progressbar", { name: "Creation stopped" });
    const box = within(view).getByTestId("creation-log");
    expect(wave.parentElement).toBe(box.parentElement);
    expect(wave.className).toContain("w-full");
    expect(box.className).toContain("w-full");
  });

  it("draws the image build's lines and the create's own as one log, in the order they arrived", async () => {
    useStore.setState({ creations: [] });
    const at = (second: number): string => new Date(Date.UTC(2026, 8, 12, 9, 27, second)).toISOString();
    const view = await mount({
      key: "creating:spoo-fix",
      name: "spoo-fix",
      askedAt: Date.now(),
      where: "p_1",
      workspaceId: "ws_fix",
      failed: null,
      lines: [
        { stage: "image", message: "building your image on hetzner: installing agents", at: at(6), elapsedMs: 108_000 },
        { stage: "image", message: "building your image on hetzner: taking the snapshot", notice: "about 4.2 GB", at: at(54), elapsedMs: 130_000 },
        { stage: "fork-requested", message: "starting spoo-fix on hetzner", at: at(58), elapsedMs: 190_000 },
        { stage: "ready", message: "ready", at: at(59), elapsedMs: 210_000 },
      ],
    });
    const rows = within(within(view).getByRole("list", { name: "Creation log" })).getAllByRole("listitem");
    expect(rows.map(row => row.querySelector("span")!.firstChild!.textContent)).toEqual([
      "building your image on hetzner: installing agents",
      "building your image on hetzner: taking the snapshot",
      "starting spoo-fix on hetzner",
      "ready",
    ]);
    // What a step answered rides under its own line, muted, and moves nothing beside it.
    const notice = rows[1]!.querySelector("span span")!;
    expect([notice.textContent, notice.className]).toEqual(["about 4.2 GB", "block text-muted-foreground"]);
    // The last line is the one being waited on, so it alone wears the foreground ink.
    expect(rows.map(row => row.className.includes("text-foreground"))).toEqual([false, false, false, true]);
    expect(rows.map(row => row.lastElementChild!.textContent)).toEqual(["1m 48s", "2m 10s", "3m 10s", "3m 30s"]);
  });

  it("a guest's own words ride the line's title, never a line of their own, and the log says which clock it is on", async () => {
    useStore.setState({ creations: [] });
    const refusal = "hostname clone-test on fk_c839037a632d failed: hostname: sethostname: Operation not permitted";
    const view = await mount({
      key: "creating:clone-test",
      name: "clone-test",
      askedAt: Date.now(),
      workspaceId: "ws_clone",
      failed: null,
      lines: [
        { stage: "fork-requested", message: "starting clone-test on ascii", at: new Date(Date.UTC(2026, 8, 12, 19, 34, 1)).toISOString(), elapsedMs: 400 },
        { stage: "hostname-set", message: HOSTNAME_KEPT, detail: refusal, at: new Date(Date.UTC(2026, 8, 12, 19, 34, 7)).toISOString(), elapsedMs: 6_400 },
      ],
    });
    const rows = within(within(view).getByRole("list", { name: "Creation log" })).getAllByRole("listitem");
    expect(rows.map(row => row.querySelector("span")!.firstChild!.textContent)).toEqual(["starting clone-test on ascii", HOSTNAME_KEPT]);
    expect(rows[1]!.querySelector("span")!.getAttribute("title")).toBe(refusal);
    // Nowhere on the screen does the shell's own text stand as a sentence.
    expect(view.textContent).not.toContain("sethostname");
    expect(rows[1]!.querySelector("span span")).toBeNull();
    // The clock is this window's own, and the log says which zone that is, once.
    const zone = within(view).getByTestId("creation-clock");
    expect(zone.textContent).toBe(`clock in ${localZoneLabel()}`);
    expect(zone.className).toContain("font-mono");
  });

  it("while creating, the same layout holds with the wave moving and no buttons", async () => {
    useStore.setState({ creations: [] });
    const view = await mount({ key: "k", name: "beta", askedAt: Date.now(), workspaceId: null, lines: [], failed: null });
    expect(view.getAttribute("aria-busy")).toBe("true");
    expect(view.firstElementChild!.className).toContain("text-center");
    expect(within(view).getByTestId("creation-log").textContent).toContain("Asking wsp to start it.");
    expect(within(view).getByRole("progressbar", { name: "Creating" })).toBeDefined();
    expect(within(view).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("the view's own last line", () => {
  /** A create that has been answered: the record the runtime handed back is in the store under the id the
   * creation row already carried. */
  const answered = (over: Partial<WorkspaceView> = {}): Creation => {
    const workspace: WorkspaceView = {
      id: "ws_new",
      name: "add a LICENSE file",
      kind: "local",
      machineId: "local",
      project: { id: "pr_1", name: "spoo", path: "/Users/dev/spoo", computer: "here" },
      phase: "running",
      golden: "",
      createdAt: "2026-09-18T00:00:00.000Z",
      copy: { road: "clonefile", path: "/Users/dev/spoo-ws_new", source: "/Users/dev/spoo", base: "abc", branch: "", carried: "deps-and-config" },
      portBase: 3100,
      ...over,
    };
    useStore.setState({
      places: [{ id: "here", kind: "computer", name: "zingzy-mbp", default: false, present: true, takesForks: false }] as never,
      workspaces: [workspace],
      landings: { pr_1: { name: "here", capabilities: { copies: true, ownNetwork: false } as never } },
    } as never);
    return { key: "creating:1", name: workspace.name, askedAt: Date.now(), project: "pr_1", workspaceId: workspace.id, lines: [], failed: null };
  };

  it("reads what the workspace is made of and what its copy has for a network off the record, in the row's own words", async () => {
    const view = await mount(answered());
    // The protocol's word table, the same one the row it becomes reads: this screen writes no road of its own and
    // the runtime's stage words end on ready with nothing about the copy.
    expect(view.querySelector("[data-k=made-of]")?.textContent).toBe("a copy shares this Mac's ports, PORT 3100");
  });

  it("says a copy by either road as that, and names the computer only where the work did not land here", async () => {
    const view = await mount(answered({ copy: { road: "worktree", path: "/Users/dev/spoo-qr-codes", source: "/Users/dev/spoo", base: "", branch: "main", carried: "config-only" }, portBase: undefined }));
    expect(view.querySelector("[data-k=made-of]")?.textContent).toBe("a copy shares this Mac's ports");
    expect(view.textContent).not.toContain("zingzy-mbp");
  });

  it("asks for the landing of the project the create is on, since on a first run no other screen has", async () => {
    const asked: string[] = [];
    useStore.setState({
      places: [],
      workspaces: [],
      landings: {},
      api: { subscribe: () => () => {}, workspacesLanding: async (project: string) => { asked.push(project); return { name: "here", capabilities: { copies: true, ownNetwork: false } }; } },
    } as never);
    await mount({ key: "creating:1", name: "add a LICENSE file", askedAt: Date.now(), project: "pr_1", workspaceId: null, lines: [], failed: null });
    await waitFor(() => expect(asked).toEqual(["pr_1"]));
  });

  it("holds the slot empty until the record lands, so nothing under it moves when it does", async () => {
    useStore.setState({ places: [], workspaces: [], landings: {} } as never);
    const view = await mount({ key: "creating:1", name: "add a LICENSE file", askedAt: Date.now(), project: "pr_1", workspaceId: null, lines: [], failed: null });
    const slot = view.querySelector("[data-k='made-of']")!;
    expect(slot.textContent).toBe("");
    // The height is a line's whatever it holds: a slot that grew when the word arrived moved the log above it.
    expect(slot.className).toContain("min-h-4");
  });
});
