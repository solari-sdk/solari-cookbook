// SPDX-License-Identifier: AGPL-3.0-only
// The screens as pure rows and as a fake terminal: what the agents screen
// says about each agent, what the tools screen makes of the table, what every
// sign-in row's choice is and where its default comes from, which agents here
// are offered the wsp tools, and the screens drawn whole.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { CATALOG, CATALOG_AGENTS, CATALOG_TOOLS, THREAD_AGENTS, type CatalogEntry } from "@wsp/catalog";
import { computeRecipe, type ManifestEntry } from "@wsp/collect";
import { SIGN_IN_LATER, type Recipe } from "@wsp/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  AGENT_LOGINS,
  AGENTS_TITLE,
  AGENTS_TOP,
  CLI_LOGINS,
  MCP_LOGINS,
  SIGN_INS_TOP,
  TOOLS_TOP,
  pickEstimate,
  pickScreens,
  signInGroupLine,
  PROJECT_QUESTION,
  noFolderNote,
  projectNote,
  signInItems,
  tableItems,
  tableScreen,
  withAgents,
  withPicked,
  withTools,
  wspToolsItems,
} from "../src/init-pick.js";
import { applyRecipe, withCatalogAgents } from "../src/init-recipe.js";
import { LATER_LINE, answerOf } from "../src/init-select.js";
import { ADDED_GROUP, BASE_GROUP, CATALOG_GROUP, FLOOR_LINE, HERE_GROUP, PROJECT_GROUP, USED_GROUP, agentRows, groupTotal, recipeTable, totalsLine } from "../src/init-table.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";
import { HOME, claudeLine, fakeHost } from "./recipe-fixture.js";

/** The screens read this computer for whose login a copy would carry; a home with nothing in it names none. */
const HOME_HERE = "/home/nobody";

const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", space: " ", enter: "\r", esc: "\x1b", ctrlC: "\x03" };
const row = (r: Partial<Recipe["rows"][number]> & { id: string }): Recipe["rows"][number] => ({ kind: "tool", on: true, source: { kind: "popular", sessions: 0, images: 0 }, ...r });
/** A few catalog entries, in the catalog's own order. */
const slice = (...ids: string[]): CatalogEntry[] => CATALOG.filter(e => ids.includes(e.id));
const text = (i: { text: string } | string | undefined): string => (typeof i === "string" ? i : (i?.text ?? ""));

describe("the agents screen", () => {
  it("one flat row per agent: what this computer did with it, its size, and the note when wsp cannot drive it", () => {
    const histories = [{ agent: "claude", state: "read" as const, sessions: 151, calls: 4000 }];
    const items = tableItems(recipeTable({ ...RECIPE, histories }, CATALOG_AGENTS), RECIPE, FIXTURE, 4, false, "darwin");
    expect(items.map(i => [i.label, text(i.why), text(i.hint)])).toEqual([
      ["Claude Code", "used       used here, 151 sessions", "208 MB"],
      ["Codex", "catalog    not installed here", "455 MB"],
      ["OpenCode", "catalog    not installed here", "673 MB"],
      ["Hermes Agent", "catalog    not installed here", "484 MB"],
      ["Gemini CLI", "catalog    not installed here", "189 MB"],
      ["Pi", "catalog    not installed here", "165 MB"],
      ["Crush", "catalog    not installed here", "83 MB"],
      ["Qwen Code", "catalog    not installed here", "size unknown"],
      ["Goose", "catalog    not installed here", "287 MB"],
      ["Amp", "catalog    not installed here", "size unknown"],
    ]);
    // No groups on this screen, and nothing locked: the agents are one list.
    expect(items.every(i => i.group === undefined && i.lock === undefined)).toBe(true);
    expect(items.find(i => i.label === "Codex")!.detail[0]).not.toBe("installs, but wsp cannot run its threads yet");
    expect(items.find(i => i.label === "OpenCode")!.detail[0]).toBe("installs, but wsp cannot run its threads yet");
    expect(items.find(i => i.label === "Claude Code")!.detail).toEqual(["on this Mac; its config (39 KB) comes along", "about 208 MB installed on the machine (measured 2026-09-05)"]);
  });

  it("puts the ticked agents first, then the most used, then the rest as the table has them, so the cursor starts on the one wsp drives", () => {
    // Codex is heavier and ran more sessions than Claude Code, but it is off; OpenCode is here and never ran.
    const here = { kind: "installed" as const, paths: [], bin: true };
    const recipe: Recipe = {
      ...RECIPE,
      histories: [{ agent: "claude", state: "read", sessions: 3, calls: 40 }, { agent: "codex", state: "read", sessions: 5, calls: 90 }],
      rows: [...RECIPE.rows.filter(r => r.kind !== "agent"), { id: "claude", kind: "agent", on: true, source: here }, { id: "codex", kind: "agent", on: false, source: here }, { id: "opencode", kind: "agent", on: false, source: here }],
    };
    expect(agentRows(recipe).map(r => [r.name, r.on])).toEqual([["Claude Code", true], ["Codex", false], ["OpenCode", false], ["Hermes Agent", false], ["Gemini CLI", false], ["Pi", false], ["Crush", false], ["Qwen Code", false], ["Goose", false], ["Amp", false]]);
    // The tools table keeps heavy rows first inside a group: this order is the agents screen's alone.
    expect(recipeTable(recipe, CATALOG_AGENTS).map(r => r.name)).toEqual(["Codex", "Claude Code", "OpenCode", "Hermes Agent", "Gemini CLI", "Pi", "Crush", "Qwen Code", "Goose", "Amp"]);
  });
});

describe("the tools screen", () => {
  it("leaves this computer's tools rows outside the catalog alone: they are the Also on this Mac screen's, so a tick or an untick here never turns one off", () => {
    const outside = (id: string, on: boolean): Recipe["rows"][number] => ({ id, kind: "tool", on, source: { kind: "installed", paths: [], bin: true } });
    const recipe = { ...RECIPE, rows: [...RECIPE.rows, outside("tools/brew/zingzy/tap/diskbloom", true), outside("tools/npm/tsx", false)] };
    const left = withTools(recipe, new Set(["gh"]));
    expect(left.rows.find(r => r.id === "tools/brew/zingzy/tap/diskbloom")?.on).toBe(true);
    expect(left.rows.find(r => r.id === "tools/npm/tsx")?.on).toBe(false);
    expect(left.rows.find(r => r.id === "yq")?.on).toBe(false);
    // Nor does the table draw them: the catalog is the Tools screen.
    expect(recipeTable(recipe, CATALOG_TOOLS).some(r => r.id.startsWith("tools/"))).toBe(false);
  });

  it("the base as bullets under the title, the rest grouped by why it is here, the why column and the size beside each", () => {
    const recipe = { ...RECIPE, rows: [...RECIPE.rows, row({ id: "wrangler", source: { kind: "used", sessions: 3, calls: 40 } }), row({ id: "go", on: false, source: { kind: "used", sessions: 1, calls: 2 } })] };
    const items = tableItems(recipeTable(recipe, CATALOG_TOOLS), recipe, FIXTURE, 4, true, "darwin");
    expect(items.filter(i => i.lock === "on").map(i => i.label)).toEqual(["C toolchain with cmake and ninja", "curl", "uv", "Python 3.12", "git", "jq", "ripgrep", "fd", "sqlite3", "wget", "zip and unzip", "xz", "rsync"]);
    expect([...new Set(items.map(i => i.group))]).toEqual([undefined, USED_GROUP, HERE_GROUP, CATALOG_GROUP]);
    expect(items.filter(i => i.group === HERE_GROUP).map(i => i.label)).toEqual(["GitHub CLI", "yq"]);
    expect(items.filter(i => i.group === USED_GROUP).map(i => i.label)).toEqual(["Go", "Cloudflare Wrangler"]);
    const by = (id: string) => items.find(i => i.id === id)!;
    // Every row in the used group carries its own count, so a wrong claim about what was run is visible.
    expect(text(by("go").why)).toBe("used       below the floor, 2 commands in 1 session");
    expect(text(by("wrangler").why)).toBe("used       40 commands in 3 sessions");
    expect(text(by("gh").hint)).toBe("40 MB");
    expect(text(by("op").hint)).toBe("41 MB");
    expect(by("curl").detail).toEqual(["ships in 5 lab images; on by default in the catalog; on every machine", "part of the base on every machine"]);
    // Node is a row like any other now: nothing locks it on, and its detail reads as the catalog's evidence.
    expect(by("node").lock).toBeUndefined();
    expect(by("go").detail).toEqual(["your agents used it in 1 session (2 calls)", "about 239 MB installed on the machine (measured 2026-09-07); no row here; installed by its brew road"]);
    expect(by("java").detail[0]).toBe("ships in 4 lab images; on request");
  });

  it("a row the project asked for says so in its detail pane too, not only in its group and its why column", () => {
    const recipe = { ...RECIPE, rows: [...RECIPE.rows, row({ id: "go", source: { kind: "project", why: "go.mod needs Go" } })] };
    const items = tableItems(recipeTable(recipe, CATALOG_TOOLS), recipe, FIXTURE, 4, true, "darwin");
    const go = items.find(i => i.id === "go")!;
    expect(go.group).toBe(PROJECT_GROUP);
    expect(text(go.why)).toBe("project    go.mod needs Go");
    expect(go.detail).toEqual(["go.mod needs Go", "about 239 MB installed on the machine (measured 2026-09-07); no row here; installed by its brew road"]);
    // A floor row the project also named says so under the cursor, even though the base is what puts it on the machine.
    const based = { ...RECIPE, rows: [...RECIPE.rows.filter(r => r.id !== "git"), row({ id: "git", source: { kind: "project", why: "the project is a git repository" } })] };
    const git = tableItems(recipeTable(based, CATALOG_TOOLS), based, FIXTURE, 4, true, "darwin").find(i => i.id === "git")!;
    expect(git.detail[0]).toBe("the project is a git repository; on every machine");
  });

  it("ticks go back onto the recipe: a floor row stays on however the list left it, and an entry the recipe never named gets a row on the catalog's evidence", () => {
    const tools = withTools(RECIPE, new Set(["gh", "go"]));
    expect(tools.rows.filter(r => r.kind === "tool" && r.on).map(r => r.id)).toEqual(["curl", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync", "gh", "go"]);
    expect(tools.rows.find(r => r.id === "go")).toEqual({ id: "go", kind: "tool", on: true, source: { kind: "popular", sessions: 9, images: 4 }, size: 250752891 });
    expect(tools.rows.filter(r => r.kind === "agent")).toEqual(RECIPE.rows.filter(r => r.kind === "agent"));
    const agents = withAgents(RECIPE, new Set(["codex", "pi"]));
    expect(agents.rows.filter(r => r.kind === "agent").map(r => [r.id, r.on])).toEqual([["claude", false], ["codex", true], ["gemini", false], ["opencode", false], ["pi", true], ["hermes", false], ["crush", false], ["qwen", false], ["goose", false], ["amp", false]]);
    const both = withPicked(RECIPE, new Set(["codex", "gh"]));
    expect(both.rows.filter(r => r.on).map(r => r.id)).toEqual(["codex", "curl", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync", "gh"]);
  });
});

describe("the sign-ins screen", () => {
  const hermesKeys: ManifestEntry = { rung: "logins", id: "logins/hermes-keys", label: "Hermes Agent API keys", group: "Agent logins", paths: ["~/.hermes/.env"], bytes: 25_000, default: "bring", detail: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" };
  const hermesLogin: ManifestEntry = { rung: "logins", id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: ["~/.hermes/auth.json"], bytes: 400, default: "skip" };
  const kube: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "bring" };
  const kubectl: ManifestEntry = { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" };
  const op: ManifestEntry = { rung: "logins", id: "logins/op", label: "1Password CLI", group: "CLI logins", paths: [], bytes: 0, default: "skip", reason: "needs the 1Password desktop app; the machine uses a service account token" };
  const laptop = { entries: [...FIXTURE.entries, hermesLogin, hermesKeys, kube, kubectl, op] };
  const recipe: Recipe = { ...RECIPE, rows: [...RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true } : r)), { id: "hermes", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.hermes/config.yaml"], bin: true } }, row({ id: "kubectl", source: { kind: "installed", paths: [], bin: true } })] };
  const words = (s: { items: { id: string; choices?: readonly { value: string }[] }[] }, id: string): string[] => s.items.find(i => i.id === id)!.choices!.map(c => c.value);

  it("the agents first, then the developer CLIs, then the MCP servers; every row has its choice and nothing has a bare tick", () => {
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), recipe), new Map(), "darwin", HOME_HERE);
    expect([...new Set(s.items.map(i => i.group))]).toEqual([AGENT_LOGINS, CLI_LOGINS]);
    expect(s.items.filter(i => i.group === AGENT_LOGINS).map(i => i.label)).toEqual(["Claude Code login", "Codex login", "Hermes Agent login", "Hermes Agent API keys"]);
    expect(s.items.filter(i => i.group === CLI_LOGINS).map(i => i.label)).toEqual(["GitHub CLI login", "kubectl config", "1Password CLI"]);
    expect(s.items.every(i => i.choices !== undefined && i.choices.length > 0)).toBe(true);
    // Copy where there is something here to copy, the two sign-in answers where the catalog has a flow (during the
    // build, or left to first use), the key where the tool reads one.
    // Claude signs in with a token minted here, so its own word leads and no copy is offered; Codex signs in once
    // on the computer that runs the workspaces, so neither is a copy or a sign-in during the build.
    expect(words(s, "logins/claude")).toEqual(["token", "key", "skip"]);
    expect(words(s, "logins/codex")).toEqual(["later", "key", "skip"]);
    // hermes stops on a menu only the person can work through, so the machine is no road for it: copy or skip.
    expect(words(s, "logins/hermes")).toEqual(["copy", "skip"]);
    expect(s.items.find(i => i.id === "logins/hermes")!.detail).toContain("asks questions only you can answer");
    expect(words(s, "logins/kube")).toEqual(["copy", "skip"]);
    // A row the catalog locked out is here with its reason and skip as its only answer.
    expect(words(s, "logins/op")).toEqual(["skip"]);
    expect(s.items.find(i => i.id === "logins/op")).toMatchObject({ why: "nothing to copy here", detail: ["needs the 1Password desktop app; the machine uses a service account token", "this one is left alone"] });
    // A row with a file here to copy starts on the copy; every browser-only row starts left to first use, since
    // running it during the build would wait on the person and the build waits on nobody.
    expect([...s.initial].sort()).toEqual([
      ["logins/claude", "token"], ["logins/codex", "later"], ["logins/gh", "later"], ["logins/hermes", "copy"], ["logins/hermes-keys", "copy"], ["logins/kube", "copy"], ["logins/op", "skip"],
    ]);
    // The words the row shows for those two answers, which are the protocol's and nobody else's.
    const gh = s.items.find(i => i.id === "logins/gh")!;
    expect(gh.choices!.filter(c => c.value === "machine" || c.value === "later").map(c => c.label)).toEqual(["sign in during the build", SIGN_IN_LATER]);
    // No row on this screen is about this computer's own config, and no sentence explains one choice against another.
    expect(s.items.some(i => i.id.startsWith("wsp-tools/"))).toBe(false);
    expect(s.items.flatMap(i => i.detail).join(" ")).not.toMatch(/API key|instead of|rather than/);
  });

  it("a saved answer is where the row starts, and an answer the row cannot take falls back to its first", () => {
    const saved: Recipe = { ...recipe, rows: recipe.rows.map(r => (r.id === "gh" ? { ...r, signIn: "copy" as const } : r)) };
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), saved), new Map(), "darwin", HOME_HERE);
    expect(s.initial.get("logins/gh")).toBe("copy");
    const key: Recipe = { ...recipe, rows: recipe.rows.map(r => (r.id === "hermes" ? { ...r, signIn: "key" as const } : r)) };
    // Hermes takes no API key, so the row opens on the first word it does take.
    expect(signInItems(applyRecipe(withCatalogAgents(laptop), key), new Map(), "darwin", HOME_HERE).initial.get("logins/hermes")).toBe("copy");
  });

  it("an MCP server with auth is a row under its own group, named by the config it sits in, copy or skip", () => {
    const github: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", consent: true, detail: "stdio: npx server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)" };
    const notes: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", detail: "stdio: npx notes-mcp; carries no secret" };
    const remote: ManifestEntry = { rung: "agents", id: "agents/mcp/mcp-remote", label: "mcp-remote sign-ins", group: "MCP sign-ins", paths: ["~/.mcp-auth"], bytes: 1800, default: "bring", consent: true, detail: "browser sign-ins saved by mcp-remote for remote servers: 1 token (1 KB)" };
    const locked: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/mac", label: "mac", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "skip", reason: "command is macOS-only, will not run", consent: true, detail: "stdio: /Applications/x; carries a secret: env A (4 B)" };
    const s = signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, github, notes, remote, locked] }), recipe), new Map(), "darwin", HOME_HERE);
    expect(s.items.filter(i => i.group === MCP_LOGINS).map(i => [i.label, i.why])).toEqual([
      ["github", "in Claude Code's config"],
      ["mcp-remote sign-ins", "sign-ins mcp-remote saved for Claude Code"],
      ["mac", "in Claude Code's config"],
    ]);
    expect(s.items.map(i => i.id)).not.toContain("agents/mcp/claude/notes");
    expect(words(s, github.id)).toEqual(["copy", "skip"]);
    // A server carrying a secret stays off the machine until the person says copy; one the catalog locked out cannot move at all.
    expect(s.initial.get(github.id)).toBe("skip");
    expect(words(s, locked.id)).toEqual(["skip"]);
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, { ...github, choice: "copy" }] }), recipe), new Map(), "darwin", HOME_HERE).initial.get(github.id)).toBe("copy");
    const off = { ...recipe, rows: recipe.rows.map(r => (r.id === "claude" ? { ...r, on: false } : r)) };
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, github, remote] }), off), new Map(), "darwin", HOME_HERE).items.map(i => i.id)).not.toContain(github.id);
  });

  it("a login whose command is not coming is listed with the reason and skip alone", () => {
    const off = { ...recipe, rows: recipe.rows.filter(r => r.id !== "kubectl") };
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), off), new Map(), "darwin", HOME_HERE);
    expect(s.items.find(i => i.id === "logins/kube")).toMatchObject({ why: "kubectl is not coming", detail: ["kubectl is not coming: its tool row is unticked; copy or sign in ticks it", "~/.kube/config"] });
    expect(s.initial.get("logins/kube")).toBe("skip");
  });

  it("the gh row names the login a copy would carry, so two logins on this computer are not a guess at the screen", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-pick-gh-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".config", "gh"), { recursive: true });
    writeFileSync(join(dir, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        other:\n        Zingzy:\n    user: Zingzy\n");
    const gh = signInItems(applyRecipe(withCatalogAgents(laptop), recipe), new Map(), "darwin", dir).items.find(i => i.id === "logins/gh")!;
    expect(gh.choices!.find(c => c.value === "copy")!.label).toBe("copy from this Mac (Zingzy)");
    expect(gh.detail).toContain("signed in here as Zingzy; other stays on this computer");
    // Nothing to pick between: the row says which login it is without naming anyone it leaves.
    writeFileSync(join(dir, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        Zingzy:\n    user: Zingzy\n");
    const one = signInItems(applyRecipe(withCatalogAgents(laptop), recipe), new Map(), "darwin", dir).items.find(i => i.id === "logins/gh")!;
    expect(one.detail).toContain("signed in here as Zingzy");
    // Two logins and none marked in use: there is nothing to pick between, so the copy is not offered at all and
    // the row says why. A saved copy answer has no choice to land on and falls to the row's own default.
    writeFileSync(join(dir, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        other:\n        Zingzy:\n");
    const screen = signInItems(applyRecipe(withCatalogAgents(laptop), recipe), new Map(), "darwin", dir);
    const neither = screen.items.find(i => i.id === "logins/gh")!;
    expect(neither.choices!.map(c => c.value)).toEqual(["machine", "later", "skip"]);
    expect(neither.detail).toContain("the file names no login in use here; sign in on the machine");
    expect(screen.initial.get("logins/gh")).toBe("later");
    // A row with no per-account item answers as it always did: the copy names the computer and nothing else.
    const kube = signInItems(applyRecipe(withCatalogAgents(laptop), recipe), new Map(), "darwin", dir).items.find(i => i.id === "logins/kube")!;
    expect(kube.choices!.find(c => c.value === "copy")!.label).toBe("copy from this Mac");
  });

  it("a group header counts how its rows answered, in the choice order", () => {
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), recipe), new Map(), "darwin", HOME_HERE);
    const agents = s.items.filter(i => i.group === AGENT_LOGINS);
    expect(signInGroupLine(agents, { ticks: new Set(), answers: new Map(s.initial) })).toBe("2 copy  1 when you need it  0 API key  0 skip  1 token");
  });

  it("the disk estimate counts what the build takes before anyone answers", () => {
    const off = { ...recipe, rows: recipe.rows.flatMap(r => (r.id === "kubectl" ? [] : r.id === "hermes" ? [{ ...r, on: false }] : [r])) };
    expect(pickEstimate(withCatalogAgents(laptop), off, new Map()).files).toBe(53_912);
    expect(pickEstimate(withCatalogAgents(laptop), recipe, new Map()).files).toBe(53_912 + 900 + 25_000);
  });
});

describe("the wsp tools screen", () => {
  const here: Recipe["rows"][number]["source"] = { kind: "installed", paths: [], bin: true };
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-pick-home-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  it("one row per agent here whose config the catalog can write, the file under the row, on for the agents this computer has run", () => {
    const w = wspToolsItems({ ...RECIPE, histories: [{ agent: "claude", state: "read", sessions: 12, calls: 90 }] }, home());
    expect(w.items).toEqual([{ id: "wsp-tools/claude", label: "Claude Code", detail: ["writes ~/.claude.json"] }]);
    expect([...w.initial]).toEqual(["wsp-tools/claude"]);
    // An agent here that has run nothing starts off; one that is not here at all is not a row.
    const quiet = wspToolsItems(RECIPE, home());
    expect(quiet.items.map(i => i.id)).toEqual(["wsp-tools/claude"]);
    expect([...quiet.initial]).toEqual([]);
    const more: Recipe = {
      ...RECIPE,
      rows: [...RECIPE.rows.map(r => (r.id === "codex" ? { ...r, source: here } : r)), { id: "opencode", kind: "agent", on: false, source: here }, { id: "pi", kind: "agent", on: true, source: here }],
    };
    // Catalog order, whatever the agent's tick for the machine; Pi is here but the catalog knows no MCP config for it.
    expect(wspToolsItems(more, home()).items.map(i => i.label)).toEqual(["Claude Code", "Codex", "OpenCode"]);
    expect(wspToolsItems({ ...RECIPE, rows: [] }, home()).items).toEqual([]);
  });

  it("the file under the row is the one the install writes: of two candidates, the one that exists here", () => {
    const h = home();
    mkdirSync(join(h, ".config", "opencode"), { recursive: true });
    writeFileSync(join(h, ".config", "opencode", "opencode.jsonc"), "{}\n");
    const items = wspToolsItems({ ...RECIPE, rows: [{ id: "opencode", kind: "agent", on: false, source: here }] }, h).items;
    expect(items.map(i => i.detail[0])).toEqual(["writes ~/.config/opencode/opencode.jsonc"]);
  });
});

function streams(columns = 100, rows = 40) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns, rows });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return { input, output, text: () => stripVTControlCharacters(chunks.join("")), raw: () => chunks.join("") };
}
const settle = (ms = 10) => new Promise(r => setTimeout(r, ms));

describe("the agents screen drawn", () => {
  it("ticks only an agent used here that wsp can run threads with, says why under every other, and counts the ticks", async () => {
    // Claude Code used here, Codex used here without an adapter, OpenCode installed and never run: this Mac's own recipe.
    const codexRollout = [JSON.stringify({ type: "session_meta", payload: { id: "t1", cwd: `${HOME}/proj` } }), JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cargo build" }) } })].join("\n");
    const host = fakeHost({
      which: ["claude", "codex", "opencode"],
      files: {
        "~/.claude/settings.json": "{}",
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", `${HOME}/proj`, ["gh pr list"]),
        "~/.codex/config.toml": "",
        "~/.codex/sessions/2026/06/01/rollout-2026-06-01T10-00-00-t1.jsonl": codexRollout,
      },
    });
    const recipe = await computeRecipe(host, { threadAgents: THREAD_AGENTS, now: () => new Date("2026-09-06T03:00:00Z") });
    const rows = agentRows(recipe);
    const o = streams();
    const p = tableScreen({
      title: AGENTS_TITLE,
      top: AGENTS_TOP,
      counter: "1/6",
      rows,
      recipe,
      platform: "darwin",
      manifest: FIXTURE,
      grouped: false,
      footer: ticks => [totalsLine(recipeTable(withAgents(recipe, ticks), CATALOG_AGENTS), "agents")],
      input: o.input,
      output: o.output,
    });
    await settle(20);
    const t = o.text();
    expect(t).toContain("◆  Agents  1/6");
    expect(t).toContain(`┃  ${AGENTS_TOP}`);
    expect(t).toContain(`┃  ${LATER_LINE}`);
    expect(t).toMatch(/● Claude Code\s+used\s+used here, 1 session\s+208 MB\n/);
    expect(t).toMatch(/● Codex\s+used\s+used here, 1 session\s+455 MB\n/);
    expect(t).toMatch(/○ OpenCode\s+installed\s+installed here, never used\s+673 MB\n/);
    expect(t).toMatch(/○ Hermes Agent\s+catalog\s+not installed here/);
    expect(t).toContain("On: 2 agents, 663 MB");
    // The ticked two come first, the heavy one on top as the table orders them, and the cursor starts there, so no
    // frame carries a note yet.
    expect(t.indexOf("● Codex")).toBeLessThan(t.indexOf("● Claude Code"));
    expect(t.indexOf("● Claude Code")).toBeLessThan(t.indexOf("○ OpenCode"));
    expect(t).not.toContain("installs, but wsp cannot run its threads yet");
    // Down twice lands on OpenCode, and only the frame drawn after that keypress carries its note.
    o.input.write(KEY.down);
    await settle();
    const before = o.raw().length;
    o.input.write(KEY.down);
    await settle();
    expect(stripVTControlCharacters(o.raw().slice(before))).toContain("installs, but wsp cannot run its threads yet");
    o.input.write(KEY.enter);
    const r = await p;
    expect(r.kind === "next" && [...r.ticks].sort()).toEqual(["claude", "codex"]);
  });
});

describe("the tools screen drawn", () => {
  const recipe = { ...RECIPE, rows: [...RECIPE.rows, row({ id: "go", source: { kind: "used", sessions: 3, calls: 40 } })] };
  const three = slice("ripgrep", "gh", "go");
  const open = (o: ReturnType<typeof streams>) => {
    const rows = recipeTable(recipe, three);
    return tableScreen({
      title: "Tools",
      top: TOOLS_TOP,
      counter: "2/6",
      rows,
      recipe,
      platform: "darwin",
      manifest: FIXTURE,
      grouped: true,
      footer: ticks => [totalsLine(recipeTable(withTools(recipe, ticks), three), "tools"), { text: "Disk: 1.4 GB of 15.2 GB on the 20 GB builder" }],
      input: o.input,
      output: o.output,
    });
  };

  it("says what it decides, lists every row with its size, counts each group, and offers keys and nothing else", async () => {
    const o = streams();
    const p = open(o);
    await settle(20);
    const t = o.text();
    expect(t).toContain("◆  Tools  2/6");
    expect(t).toContain(`┃  ${TOOLS_TOP}`);
    expect(t).toContain(`┃  ${LATER_LINE}`);
    expect(t).toMatch(/▾ Always on the image\s+1\s+4 MB\n┃\s+• ripgrep\s+base\s+always on the image\s+4 MB\n/);
    expect(t).toMatch(/▾ You use these\s+1 of 1\s+239 MB\n┃\s+● Go\s+used\s+40 commands in 3 sessions\s+239 MB\n/);
    expect(t).toMatch(/▾ Installed here, never used\s+1 of 1\s+40 MB\n┃\s+● GitHub CLI\s+installed\s+installed here, never used\s+40 MB\n/);
    expect(t).toContain("On: 3 tools, 284 MB");
    expect(t).toContain("Disk: 1.4 GB of 15.2 GB on the 20 GB builder");
    expect(t).toContain("┗  space on or off • ← → fold • enter next • esc back");
    // The two lines he struck out are gone with the all row.
    expect(t).not.toContain("every row on this screen that can be ticked");
    expect(t).not.toContain("left as it is");
    expect(t).not.toMatch(/[●○] all/);
    expect(t).not.toContain("Selected:");
    // Space on a group header turns the whole group off, and the totals follow.
    o.input.write(KEY.down);
    await settle();
    o.input.write(KEY.space);
    await settle();
    expect(o.text()).toMatch(/○ Go/);
    expect(o.text()).toContain("On: 2 tools, 45 MB");
    o.input.write(KEY.enter);
    const r = await p;
    expect(r.kind === "next" && [...r.ticks].sort()).toEqual(["gh", "ripgrep"]);
  });

  it("a row the agent added sits in its own group, on, and leaving it unticked takes it off the recipe", () => {
    const custom = [{ kind: "custom" as const, id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" }];
    const recipe = { ...RECIPE, custom };
    const items = tableItems(recipeTable(recipe, CATALOG_TOOLS), recipe, FIXTURE, 4, true, "darwin");
    const just = items.find(i => i.id === "just")!;
    expect(just).toMatchObject({ label: "just", group: ADDED_GROUP });
    expect(text(just.why)).toBe("added      brew install just");
    expect(text(just.hint)).toBe("size unknown");
    expect(just.detail).toEqual(["installs with brew install just", "checked with command -v just"]);
    const groups = items.map(i => i.group);
    expect(groups.indexOf(ADDED_GROUP)).toBeGreaterThan(groups.lastIndexOf(HERE_GROUP));
    expect(groups.indexOf(ADDED_GROUP)).toBeLessThan(groups.indexOf(CATALOG_GROUP));
    expect(tableItems(recipeTable(RECIPE, CATALOG_TOOLS), RECIPE, FIXTURE, 4, true, "darwin").some(i => i.group === ADDED_GROUP)).toBe(false);
    expect(withTools(recipe, new Set(["just"])).custom).toEqual(custom);
    expect(withTools(recipe, new Set()).custom).toEqual([]);
  });

  it("enter takes the defaults as they stand, esc goes back with them, ctrl-c cancels", async () => {
    const o = streams();
    const p = open(o);
    await settle(20);
    o.input.write(KEY.enter);
    const r = await p;
    expect(r.kind === "next" && [...r.ticks].sort()).toEqual(["gh", "go", "ripgrep"]);

    const b = streams();
    const back = open(b);
    await settle(20);
    b.input.write(KEY.esc);
    await settle(70);
    expect((await back).kind).toBe("back");

    const c = streams();
    const cancelled = open(c);
    await settle(20);
    c.input.write(KEY.ctrlC);
    expect((await cancelled).kind).toBe("cancel");
  });
});

describe("the whole flow", () => {
  const laptop = { entries: FIXTURE.entries };
  const NAMED_PROJECT = "/Users/dev/proj";
  const flow = (o: ReturnType<typeof streams>, over: Partial<Parameters<typeof pickScreens>[0]> = {}) =>
    // The folder is named on the command line, so the run does not ask for one; the tests that answer the question drop it.
    pickScreens({ manifest: withCatalogAgents(laptop), recipe: RECIPE, brew: new Map(), from: "agents", home: tmpdir(), platform: "darwin", project: NAMED_PROJECT, scanProject: async () => undefined, input: o.input, output: o.output, ...over });

  it("the screens with a row to pick, each numbered against those and the build: with no manager row the Also screen is not shown and the sign-ins follow the tools", async () => {
    const o = streams(100, 30);
    const p = flow(o);
    await settle(20);
    expect(o.text()).toContain("◆  Agents  1/5");
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  Tools  2/5");
    expect(o.text()).toContain(FLOOR_LINE);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).not.toContain("Also on this Mac");
    const signIns = o.text().slice(o.text().lastIndexOf("◆  Sign-ins"));
    expect(signIns).toContain("◆  Sign-ins  3/5");
    expect(signIns).toContain(SIGN_INS_TOP);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  wsp for your agents on this Mac  4/5");
    o.input.write(KEY.enter);
    const picked = await p;
    expect(picked).not.toBe("cancel");
    if (picked === "cancel") return;
    // Four keypresses, and every answer is the one each screen opened on.
    expect(picked.recipe.rows.filter(r => r.on).map(r => r.id)).toEqual(RECIPE.rows.filter(r => r.on).map(r => r.id));
    expect([...picked.logins].sort()).toEqual([["logins/claude", "token"], ["logins/gh", "later"]]);
    expect([...picked.wspTools]).toEqual([]);
  });

  it("with a manager row to offer the Also screen is the third of six, and the screens after it count against six", async () => {
    const o = streams(100, 30);
    const scan = [{ id: "brew/jq", name: "jq", manager: "brew" as const, group: "Homebrew formulae", install: "brew install jq", check: "command -v jq", size: 2 * 1024 * 1024 }];
    const p = flow(o, { scan });
    await settle(20);
    expect(o.text()).toContain("◆  Agents  1/6");
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  Tools  2/6");
    o.input.write(KEY.enter);
    await settle(20);
    const mac = o.text().slice(o.text().lastIndexOf("◆  Also on this Mac"));
    expect(mac).toContain("◆  Also on this Mac  3/6");
    expect(mac).toContain("What else this Mac brings");
    expect(mac).toMatch(/○ jq\s+2 MB/);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  Sign-ins  4/6");
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  wsp for your agents on this Mac  5/6");
    o.input.write(KEY.ctrlC);
    expect(await p).toBe("cancel");
  });

  it("esc from the screen after one that is not shown lands on the last screen shown, never on the empty one", async () => {
    const o = streams(100, 30);
    const p = flow(o);
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text().slice(o.text().lastIndexOf("◆  "))).toContain("Sign-ins  3/5");
    o.input.write(KEY.esc);
    await settle(90);
    const back = o.text().slice(o.text().lastIndexOf("◆  "));
    expect(back).toContain("Tools  2/5");
    expect(o.text()).not.toContain("Also on this Mac");
    o.input.write(KEY.ctrlC);
    expect(await p).toBe("cancel");
  });

  it("an answer stands when the screen is left and come back to, as a tick does", async () => {
    const o = streams(100, 30);
    const p = flow(o);
    await settle(20);
    for (let i = 0; i < 2; i += 1) {
      o.input.write(KEY.enter);
      await settle(20);
    }
    const at = () => o.text().slice(o.text().lastIndexOf("◆  Sign-ins"));
    // Down onto the Claude Code row and right once: the row moves from the machine to its API key.
    o.input.write(KEY.down);
    await settle();
    o.input.write(KEY.right);
    await settle();
    expect(at()).toMatch(/Claude Code login\s+[^\n]*API key/);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  wsp for your agents on this Mac  4/5");
    // A tick on the wsp tools screen, then esc back: the sign-in answer is still the one that was chosen.
    o.input.write(KEY.space);
    await settle();
    o.input.write(KEY.esc);
    await settle(90);
    expect(at()).toMatch(/Claude Code login\s+[^\n]*API key/);
    o.input.write(KEY.enter);
    await settle(20);
    // And the wsp tools screen is still as it was left.
    expect(o.text().slice(o.text().lastIndexOf("◆  wsp for your agents on this Mac"))).toMatch(/● Claude Code/);
    o.input.write(KEY.enter);
    const picked = await p;
    if (picked === "cancel") throw new Error("cancelled");
    expect(picked.logins.get("logins/claude")).toBe("key");
    expect([...picked.wspTools]).toEqual(["claude"]);
  });

  it("the sign-ins screen: a word per row, the arrows walk them, the header counts, and there is no all row", async () => {
    const o = streams(100, 30);
    const p = flow(o);
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    const at = () => o.text().slice(o.text().lastIndexOf("◆  Sign-ins"));
    expect(at()).toMatch(/▾ Agents\s+0 API key\s+0 skip\s+1 token\n┃\s+Claude Code login\s+Keychain: Claude Code-credentials\s+token from this computer\n/);
    expect(at()).toMatch(/▾ Developer CLIs\s+0 copy\s+0 during the build\s+1 when you need it\s+0 skip\n/);
    expect(at()).toContain("┗  ← → choose • enter next • esc back");
    expect(at()).not.toMatch(/[●○] all/);
    // A sign-in row carries no box: its answer is the word, and one of the words is skip.
    expect(at()).not.toMatch(/[●○] Claude Code login/);
    // Right on the Claude Code row walks to the next word it takes; left walks back.
    o.input.write(KEY.down);
    await settle();
    o.input.write(KEY.right);
    await settle();
    expect(at()).toMatch(/Claude Code login\s+Keychain: Claude Code-credentials\s+API key/);
    o.input.write(KEY.left);
    await settle();
    expect(at()).toMatch(/Claude Code login\s+Keychain: Claude Code-credentials\s+token from this computer/);
    // Left again reaches the last word the row takes; a copy is not among them, since nothing of this login is
    // ever on a machine to copy.
    o.input.write(KEY.left);
    await settle();
    expect(at()).toMatch(/Claude Code login\s+Keychain: Claude Code-credentials\s+skip/);
    o.input.write(KEY.enter);
    await settle(20);
    o.input.write(KEY.enter);
    const picked = await p;
    if (picked === "cancel") throw new Error("cancelled");
    expect(picked.logins.get("logins/claude")).toBe("skip");
  });
});

describe("the project the run is for", () => {
  it("with no folder named the run asks before the first screen, reads what it answers and cards it", async () => {
    const o = streams(100, 30);
    const asked: string[] = [];
    const p = pickScreens({
      manifest: withCatalogAgents({ entries: FIXTURE.entries }),
      recipe: RECIPE,
      brew: new Map(),
      from: "agents",
      home: tmpdir(),
      platform: "darwin",
      scanProject: async folder => {
        asked.push(folder);
        return { dir: folder, rows: [{ id: "go", name: "Go", why: "go.mod needs Go" }], candidates: [{ id: "ruby", name: "Ruby", why: "Gemfile needs Ruby" }] };
      },
      input: o.input,
      output: o.output,
    });
    await settle(20);
    expect(o.text()).toContain(PROJECT_QUESTION);
    o.input.write("~/proj");
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    expect(asked).toEqual(["~/proj"]);
    const card = o.text().slice(o.text().lastIndexOf("Your project needs"));
    expect(card).toContain("go.mod needs Go");
    expect(card).toContain("Not in the catalog: Ruby (Gemfile needs Ruby)");
    expect(o.text()).toContain("◆  Agents  1/5");
    o.input.write(KEY.ctrlC);
    expect(await p).toBe("cancel");
  });

  it("an answer that names no folder is said so, not read as a project that needs nothing", async () => {
    const o = streams(100, 30);
    const p = pickScreens({
      manifest: withCatalogAgents({ entries: FIXTURE.entries }),
      recipe: RECIPE,
      brew: new Map(),
      from: "agents",
      home: tmpdir(),
      platform: "darwin",
      scanProject: async () => undefined,
      input: o.input,
      output: o.output,
    });
    await settle(20);
    o.input.write("~/prj");
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain(noFolderNote("~/prj"));
    expect(o.text()).not.toContain("named a tool the catalog carries");
    o.input.write(KEY.ctrlC);
    expect(await p).toBe("cancel");
  });

  it("an empty answer asks for nothing and reads nothing: the folder is optional", async () => {
    const o = streams(100, 30);
    const asked: string[] = [];
    const p = pickScreens({
      manifest: withCatalogAgents({ entries: FIXTURE.entries }),
      recipe: RECIPE,
      brew: new Map(),
      from: "agents",
      home: tmpdir(),
      platform: "darwin",
      scanProject: async folder => {
        asked.push(folder);
        return undefined;
      },
      input: o.input,
      output: o.output,
    });
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    expect(asked).toEqual([]);
    expect(o.text()).toContain("◆  Agents  1/5");
    o.input.write(KEY.ctrlC);
    expect(await p).toBe("cancel");
  });

  it("the card names every row with the file that asked, and says plainly when a folder held nothing", () => {
    expect(projectNote({ dir: "/Users/dev/proj", rows: [{ id: "go", name: "Go", why: "go.mod needs Go" }, { id: "docker", name: "Docker engine and compose", why: "compose.yaml needs Docker" }], candidates: [{ id: "ruby", name: "Ruby", why: "Gemfile needs Ruby" }] })).toEqual([
      "Go                         go.mod needs Go",
      "Docker engine and compose  compose.yaml needs Docker",
      "Not in the catalog: Ruby (Gemfile needs Ruby)",
    ]);
    expect(projectNote({ dir: "/Users/dev/proj", rows: [], candidates: [] })).toEqual(["Nothing in /Users/dev/proj named a tool the catalog carries."]);
    expect(noFolderNote("~/prj")).toBe("There is no folder at ~/prj; nothing was read.");
  });
});
