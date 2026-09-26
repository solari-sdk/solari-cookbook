// SPDX-License-Identifier: AGPL-3.0-only
// The preferences record every client reads off the host: what a stored record
// parses to, how a patch lands on it, and the wire shapes that carry both.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, EventUnion, LABS_ENV, Preferences, PreferencesPatch, RuntimeRequest, applyPreferencesPatch, fmtPx, labsFromEnv, preferencesFrom } from "../src/index.js";

describe("the preferences record", () => {
  it("nothing stored, a record from an older host and a corrupt one all read as the defaults", () => {
    expect(preferencesFrom(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom({})).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom({ theme: "sepia" })).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom("nonsense")).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({ theme: "system", lightTheme: "paper", darkTheme: "graphite", sidebarMode: "list", terminalSize: "app", terminalZoom: {}, access: {}, projectLook: {}, computerLook: {}, serverIcons: true, agentVersions: true, labs: false });
  });

  it("a stored record keeps what it has and takes the defaults for the rest", () => {
    expect(preferencesFrom({ theme: "light", sidebarWidth: 312 })).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", sidebarWidth: 312 });
  });

  it("a patch lands field by field, a null width clears the width, and the zoom lands per workspace, a null entry dropping that workspace's", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { theme: "dark", sidebarWidth: 300, terminalZoom: { ws_a: 2 } });
    expect(one).toEqual({ theme: "dark", lightTheme: "paper", darkTheme: "graphite", sidebarMode: "list", sidebarWidth: 300, terminalSize: "app", terminalZoom: { ws_a: 2 }, access: {}, projectLook: {}, computerLook: {}, serverIcons: true, agentVersions: true, labs: false });
    const two = applyPreferencesPatch(one, { terminalZoom: { ws_b: -1 } });
    expect(two.terminalZoom).toEqual({ ws_a: 2, ws_b: -1 });
    const three = applyPreferencesPatch(two, { sidebarWidth: null, terminalZoom: { ws_a: null } });
    expect(three).toEqual({ theme: "dark", lightTheme: "paper", darkTheme: "graphite", sidebarMode: "list", terminalSize: "app", terminalZoom: { ws_b: -1 }, access: {}, projectLook: {}, computerLook: {}, serverIcons: true, agentVersions: true, labs: false });
    expect(applyPreferencesPatch(one, {})).toEqual(one);
    expect(PreferencesPatch.safeParse({ terminalZoom: { ws_a: null } }).success).toBe(true);
  });

  it("each side keeps its own theme pick: a patch lands either, an old record reads with the side defaults, and an empty id is refused", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { darkTheme: "denim" });
    expect(one).toEqual({ ...DEFAULT_PREFERENCES, darkTheme: "denim" });
    const two = applyPreferencesPatch(one, { lightTheme: "linen", theme: "light" });
    expect(two).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", lightTheme: "linen", darkTheme: "denim" });
    expect(applyPreferencesPatch(two, { sidebarWidth: 280 })).toEqual({ ...two, sidebarWidth: 280 });
    // A record from a host older than the picks reads with each side on its default.
    expect(preferencesFrom({ theme: "dark", sidebarWidth: 300 })).toEqual({ ...DEFAULT_PREFERENCES, theme: "dark", sidebarWidth: 300 });
    expect(preferencesFrom({ darkTheme: "denim" }).darkTheme).toBe("denim");
    // On the wire too: a record an older host sends parses with the side defaults rather than failing whole.
    const { lightTheme: _l, darkTheme: _d, ...older } = DEFAULT_PREFERENCES;
    expect(Preferences.parse({ ...older, theme: "dark" })).toEqual({ ...DEFAULT_PREFERENCES, theme: "dark" });
    // The shape is the protocol's; which ids exist is the app's, so an id this build does not know still parses.
    expect(PreferencesPatch.safeParse({ lightTheme: "linen", darkTheme: "some-later-theme" }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ lightTheme: "" }).success).toBe(false);
    // The record's defaults never ride in on a patch that names neither pick: they would put a side back unasked.
    expect(PreferencesPatch.parse({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(PreferencesPatch.safeParse({ darkTheme: 3 }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ lightTheme: "linen", accentTheme: "x" }).success).toBe(false);
  });

  it("the access pick lands per workspace and stands beside the rest, a null entry dropping that workspace's", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { access: { ws_a: "bypassPermissions" } });
    expect(one.access).toEqual({ ws_a: "bypassPermissions" });
    // A pick in one workspace leaves another's alone, and a patch that names none leaves every pick standing.
    const two = applyPreferencesPatch(one, { access: { ws_b: "plan" } });
    expect(two.access).toEqual({ ws_a: "bypassPermissions", ws_b: "plan" });
    expect(applyPreferencesPatch(two, { theme: "dark" }).access).toEqual(two.access);
    expect(applyPreferencesPatch(two, { access: { ws_a: null } }).access).toEqual({ ws_b: "plan" });
    // A record from a host that kept no picks reads as none, not as undefined a caller has to guard.
    expect(preferencesFrom({ theme: "light" }).access).toEqual({});
  });

  it("a project's look lands per project, a null entry dropping that project's, and a stored record without looks reads as none", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { projectLook: { pr_1: { icon: "rocket", hue: "teal" } } });
    expect(one.projectLook).toEqual({ pr_1: { icon: "rocket", hue: "teal" } });
    const two = applyPreferencesPatch(one, { projectLook: { pr_2: { hue: "blue" } } });
    expect(two.projectLook).toEqual({ pr_1: { icon: "rocket", hue: "teal" }, pr_2: { hue: "blue" } });
    expect(applyPreferencesPatch(two, { projectLook: { pr_1: null } }).projectLook).toEqual({ pr_2: { hue: "blue" } });
    expect(preferencesFrom({ theme: "light" }).projectLook).toEqual({});
    expect(PreferencesPatch.safeParse({ projectLook: { pr_1: { icon: "rocket" } } }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ projectLook: { pr_1: { icon: "unicorn" } } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ projectLook: { pr_1: { hue: "blue", size: 3 } } }).success).toBe(false);
  });

  it("a computer's icon lands per computer, a null entry dropping that computer's, and a stored record without icons reads as none", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { computerLook: { pl_1: { icon: "server" } } });
    expect(one.computerLook).toEqual({ pl_1: { icon: "server" } });
    const two = applyPreferencesPatch(one, { computerLook: { pl_2: { icon: "laptop" } }, theme: "dark" });
    expect(two.computerLook).toEqual({ pl_1: { icon: "server" }, pl_2: { icon: "laptop" } });
    expect(applyPreferencesPatch(two, { projectLook: { pr_1: { hue: "blue" } } }).computerLook).toEqual(two.computerLook);
    expect(applyPreferencesPatch(two, { computerLook: { pl_1: null } }).computerLook).toEqual({ pl_2: { icon: "laptop" } });
    expect(preferencesFrom({ theme: "light", projectLook: { pr_1: { icon: "rocket" } } })).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", projectLook: { pr_1: { icon: "rocket" } }, computerLook: {} });
    expect(preferencesFrom({ computerLook: { pl_1: { icon: "home" } } }).computerLook).toEqual({ pl_1: { icon: "home" } });
    expect(PreferencesPatch.safeParse({ computerLook: { pl_1: null } }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ computerLook: { pl_1: { icon: "toaster" } } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ computerLook: { pl_1: {} } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ computerLook: { pl_1: { icon: "cloud", hue: "blue" } } }).success).toBe(false);
  });

  it("server icons are on until the person turns them off, a stored record without the switch reading as on", () => {
    expect(preferencesFrom({ theme: "light" }).serverIcons).toBe(true);
    const off = applyPreferencesPatch(DEFAULT_PREFERENCES, { serverIcons: false });
    expect(off.serverIcons).toBe(false);
    expect(applyPreferencesPatch(off, { theme: "dark" }).serverIcons).toBe(false);
    expect(preferencesFrom({ serverIcons: false }).serverIcons).toBe(false);
    expect(applyPreferencesPatch(off, { serverIcons: true }).serverIcons).toBe(true);
    expect(PreferencesPatch.safeParse({ serverIcons: "no" }).success).toBe(false);
  });

  it("labs comes from the host's environment alone, and no patch carries it", () => {
    expect(labsFromEnv({})).toBe(false);
    expect(labsFromEnv({ [LABS_ENV]: "0" })).toBe(false);
    expect(labsFromEnv({ [LABS_ENV]: "1" })).toBe(true);
    expect(PreferencesPatch.safeParse({ labs: true }).success).toBe(false);
    expect(applyPreferencesPatch({ ...DEFAULT_PREFERENCES, labs: true }, { theme: "dark" }).labs).toBe(true);
  });

  it("the patch shape refuses a value outside the record's own", () => {
    expect(PreferencesPatch.safeParse({ theme: "light" }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ theme: "sepia" }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ sidebarWidth: -4 }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ terminalZoom: { ws_a: 1.5 } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ access: { ws_a: "plan" } }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ access: { ws_a: null } }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ access: { ws_a: 3 } }).success).toBe(false);
  });

  it("the runtime takes preferences.get and preferences.set with a patch, and the changed event carries the whole record", () => {
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.get" }).success).toBe(true);
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.set", patch: { sidebarMode: "spaces" } }).success).toBe(true);
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.set", patch: { sidebarMode: "grid" } }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.set" }).success).toBe(false);
    expect(EventUnion.safeParse({ type: "preferences.changed", preferences: DEFAULT_PREFERENCES, seq: 4 }).success).toBe(true);
  });

  it("a size in css pixels reads as a number and the unit", () => {
    expect(fmtPx(14)).toBe("14 px");
    expect(fmtPx(312)).toBe("312 px");
  });
});

describe("the last target on the preferences record", () => {
  it("the last target, the workspace a thread was started on, lands whole and a null clears it; a workspace holds one project, so the workspace is the whole of it", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { target: { workspace: "ws_a" } });
    expect(one.target).toEqual({ workspace: "ws_a" });
    const two = applyPreferencesPatch(one, { target: { workspace: "ws_b" } });
    expect(two.target).toEqual({ workspace: "ws_b" });
    expect(applyPreferencesPatch(two, { theme: "dark" }).target).toEqual({ workspace: "ws_b" });
    expect("target" in applyPreferencesPatch(two, { target: null })).toBe(false);
    expect("target" in DEFAULT_PREFERENCES).toBe(false);
    expect(PreferencesPatch.safeParse({ target: null }).success).toBe(true);
    // The per-workspace project pick left with the list: a patch naming it is refused rather than written into a
    // state file nothing reads.
    expect(PreferencesPatch.safeParse({ project: { ws_a: "spoo" } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ target: { workspace: "ws_a", project: "spoo" } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ target: { project: "spoo" } }).success).toBe(false);
  });
});
