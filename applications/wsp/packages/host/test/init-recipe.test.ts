// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Manifest, type ManifestEntry, parseManifest } from "@wsp/collect";
import { afterEach, describe, expect, it } from "vitest";
import type { GoldenImport } from "@wsp/runtime";
import { Recipe, type RecipeDigest } from "@wsp/protocol";
import {
  answeredRows,
  applyRecipe,
  goldenRecipeFor,
  hasChoices,
  initialChoice,
  loginShown,
  lockRefused,
  refusedNote,
  initialTicks,
  isTickable,
  loadRecipe,
  loginTool,
  recipeChanges,
  recipePath,
  saveRecipe,
  tickLoginTools,
  withoutAgentTools,
  withCatalogAgents,
  recipeWithAnswers,
  withOutsideRows,
  withTicksOf,
} from "../src/init-recipe.js";
import { MIB } from "@wsp/catalog";
import { toolInstallsFor, type BrewTable } from "@wsp/engine";
import { FIXTURE, byId } from "./init-fixture.js";

const ANTHROPIC = "sk-ant-x-fake-anthropic-key";
/** The saved manifest as the next run reads it. */
const loadManifest = (path: string) => parseManifest(JSON.parse(readFileSync(path, "utf8")));

describe("manifest ticks", () => {
  it("a skip with a reason cannot be ticked; a bare skip can", () => {
    expect(isTickable(byId("identity/ssh-key"))).toBe(false);
    expect(isTickable(byId("agents/codex"))).toBe(true);
    expect(isTickable(byId("identity/git-user"))).toBe(true);
  });

  it("initial ticks follow the default, then a saved bring flag, and required is always on", () => {
    expect(initialTicks(byId("identity/ssh-config"))).toBe(true);
    expect(initialTicks(byId("agents/codex"))).toBe(false);
    expect(initialTicks(byId("identity/ssh-key"))).toBe(false);
    expect(initialTicks({ ...byId("agents/codex"), bring: true })).toBe(true);
    expect(initialTicks({ ...byId("identity/git-user"), bring: false })).toBe(true);
    expect(initialTicks({ ...byId("identity/ssh-key"), bring: true })).toBe(false);
  });
});

describe("login choices", () => {
  it("copy when the default is bring, left to first use when it is skip or cannot be copied, and a saved choice wins", () => {
    // The collector's default carries the catalog's word: a browser or device sign-in (gh, codex, the Claude OAuth
    // credential) is skip, a key or a tool with no sign-in is bring. A row with nothing here to copy can only be
    // signed in through a browser, which waits on the person, so it starts left to the first time it is needed.
    expect(initialChoice(byId("logins/gh"))).toBe("later");
    expect(initialChoice(byId("logins/codex"))).toBe("later");
    expect(initialChoice({ ...byId("logins/gh"), default: "bring" })).toBe("copy");
    // Claude Code mints its token on this computer, so its unanswered row opens there rather than on a machine.
    expect(initialChoice(byId("logins/claude"))).toBe("token");
    expect(initialChoice({ ...byId("logins/gh"), default: "skip", reason: "expires in hours" })).toBe("later");
    expect(initialChoice({ ...byId("logins/gh"), choice: "skip" })).toBe("skip");
    expect(initialChoice({ ...byId("logins/gh"), bring: false })).toBe("later");
    expect(initialChoice({ ...byId("logins/claude"), choice: "skip" })).toBe("skip");
    // Signing in while the build runs is the opt-in, and a recipe that saved it is read back as that and not as the default.
    expect(initialChoice({ ...byId("logins/gh"), choice: "machine" })).toBe("machine");
    expect(initialChoice({ ...byId("logins/gh"), choice: "later" })).toBe("later");
  });

});

describe("the command a login needs", () => {
  const AWSCLI: ManifestEntry = { rung: "tools", id: "tools/brew/awscli", label: "awscli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" };
  const LOCKED_AWSCLI: ManifestEntry = { ...AWSCLI, default: "skip", reason: "no Linux bottle", linux: "no" };
  /** The bare row the recipe adds for a catalog tool this computer has no row for. */
  const catalogRow = (id: string, label: string): ManifestEntry => ({ rung: "tools", id: `tools/catalog/${id}`, label, group: "Catalog", paths: [], bytes: 0, default: "skip", linux: "yes" });
  const GCLOUD_ROW = catalogRow("gcloud", "Google Cloud CLI");
  const KUBECTL_ROW: ManifestEntry = { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "yes" };
  const login = (id: string, label: string): ManifestEntry => ({ rung: "logins", id: `logins/${id}`, label, group: "CLI logins", paths: [`~/.${id}`], bytes: 10, default: "bring" });
  const GCLOUD = login("gcloud", "Google Cloud login");
  const WRANGLER = login("wrangler", "Cloudflare Wrangler login");
  const KUBE = login("kube", "kubectl config");
  const AWS = login("aws", "AWS keys and profiles");

  it("a login's command is coming when its tools row is ticked, else the row is named as unticked, locked, or missing with the catalog entry that brings it", () => {
    const manifest = { entries: [GCLOUD_ROW, KUBECTL_ROW, AWSCLI, ...FIXTURE.entries, GCLOUD, WRANGLER, KUBE, AWS] };
    const none = new Set<string>();
    expect(loginTool(GCLOUD, manifest, none, new Map())).toEqual({ bin: "gcloud", row: GCLOUD_ROW, coming: false, why: "gcloud is not coming: its tool row is unticked; copy or sign in ticks it" });
    expect(loginTool(GCLOUD, manifest, new Set(["tools/catalog/gcloud"]), new Map())).toEqual({ bin: "gcloud", row: GCLOUD_ROW, coming: true });
    expect(loginTool(WRANGLER, manifest, none, new Map())).toEqual({ bin: "wrangler", coming: false, why: "wrangler is not coming: no row lists it; tick Cloudflare Wrangler under Tools to bring it" });
    expect(loginTool(KUBE, manifest, none, new Map())).toMatchObject({ bin: "kubectl", row: KUBECTL_ROW, coming: false, why: "kubectl is not coming: its tool row is unticked; copy or sign in ticks it" });
    expect(loginTool(KUBE, { entries: [KUBE] }, none, new Map())?.why).toBe("kubectl is not coming: no row lists it; tick kubectl under Tools to bring it");
    // A formula not named for its command still counts; a locked row says so.
    expect(loginTool(AWS, manifest, new Set(["tools/brew/awscli"]), new Map())).toEqual({ bin: "aws", row: AWSCLI, coming: true });
    expect(loginTool(AWS, { entries: [LOCKED_AWSCLI, AWS] }, none, new Map())).toMatchObject({ coming: false, why: "aws is not coming: its tool row cannot come (no Linux bottle)" });
    // A command the catalog does not know is named plainly.
    expect(loginTool({ ...KUBE, id: "logins/cloudflared" }, { entries: [] }, none, new Map())?.why).toBe("cloudflared is not coming: no row lists it; tick cloudflared under Tools to bring it");
    // gh's row is ticked in the fixture's defaults; an agent's login follows its agent, not a tools row.
    expect(loginTool(byId("logins/gh"), manifest, new Set(["tools/brew/gh"]), new Map())).toEqual({ bin: "gh", row: byId("tools/brew/gh"), coming: true });
    expect(loginTool(byId("logins/claude"), manifest, none, new Map())).toBeUndefined();
    // Any catalog tool's login names its command; a keys row beside an agent's login follows the agent.
    expect(loginTool(login("fly", "Fly login"), { entries: [] }, none, new Map())?.why).toBe("fly is not coming: no row lists it; tick flyctl under Tools to bring it");
    expect(loginTool(login("hermes-keys", "Hermes keys"), { entries: [] }, none, new Map())).toBeUndefined();
    expect(loginTool(byId("tools/brew/gh"), manifest, none, new Map())).toBeUndefined();
  });

  it("a wrangler row under any node package manager or Homebrew's own formula counts as the command", () => {
    for (const id of ["tools/npm/wrangler", "tools/pnpm/wrangler", "tools/bun/wrangler", "tools/brew/cloudflare-wrangler"]) {
      const row: ManifestEntry = { rung: "tools", id, label: "wrangler", paths: [], bytes: 0, default: "bring", linux: "yes" };
      expect(loginTool(WRANGLER, { entries: [row, WRANGLER] }, new Set([id]), new Map())).toEqual({ bin: "wrangler", row, coming: true });
    }
  });

  it("tickLoginTools ticks the row of every login answered copy or sign in; a skip, a coming row and a locked row leave the ticks alone", () => {
    const manifest = { entries: [GCLOUD_ROW, KUBECTL_ROW, GCLOUD, KUBE, WRANGLER, AWS, AWSCLI] };
    const ticks = new Set<string>(["tools/brew/awscli"]);
    const added = tickLoginTools(manifest, new Map([["logins/gcloud", "copy"], ["logins/kube", "machine"], ["logins/wrangler", "copy"], ["logins/aws", "copy"]]), ticks, new Map());
    expect(added).toEqual(["Google Cloud CLI", "kubernetes-cli"]);
    expect([...ticks]).toEqual(["tools/brew/awscli", "tools/catalog/gcloud", "tools/brew/kubernetes-cli"]);
    const untouched = new Set<string>();
    expect(tickLoginTools({ entries: [LOCKED_AWSCLI, AWS] }, new Map([["logins/aws", "copy"]]), untouched, new Map())).toEqual([]);
    expect(tickLoginTools(manifest, new Map([["logins/gcloud", "skip"]]), untouched, new Map())).toEqual([]);
    expect(untouched.size).toBe(0);
  });
});

describe("npm globals an agent installs itself", () => {
  const PI_NPM: ManifestEntry = { rung: "tools", id: "tools/npm/@earendil-works/pi-coding-agent", label: "@earendil-works/pi-coding-agent@0.84.1", group: "npm globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "0.84.1" };
  const WRANGLER_NPM: ManifestEntry = { ...PI_NPM, id: "tools/npm/wrangler", label: "wrangler@4.106.0", version: "4.106.0" };
  const PI_AGENT: ManifestEntry = { rung: "agents", id: "agents/pi", label: "Pi", paths: ["~/.pi/agent/settings.json"], bytes: 80, default: "bring" };

  it("the package's row goes when its agent is on the Agents screen, whatever the agent's tick; without the agent row it stays, as do other globals", () => {
    expect(withoutAgentTools([PI_NPM, WRANGLER_NPM, PI_AGENT, ...FIXTURE.entries])).toEqual([WRANGLER_NPM, PI_AGENT, ...FIXTURE.entries]);
    expect(withoutAgentTools([PI_NPM, WRANGLER_NPM])).toEqual([PI_NPM, WRANGLER_NPM]);
    expect(withoutAgentTools([{ ...PI_NPM, bring: true }, { ...PI_AGENT, bring: false }])).toEqual([{ ...PI_AGENT, bring: false }]);
  });
});

describe("rows the plan refuses by name", () => {
  const env: ManifestEntry = { rung: "shell", id: "shell/env", label: ".env", paths: ["~/.env"], bytes: 20, default: "skip" };
  const netrc: ManifestEntry = { rung: "shell", id: "shell/netrc", label: ".netrc", paths: ["~/.netrc"], bytes: 30, default: "skip", consent: true };

  const file = () => false;
  const dir = () => true;
  const missing = () => undefined;

  it("an unconsented .env or .netrc file gets the plan's note; a directory of that name, a consent row and a login's own .env do not", () => {
    expect(refusedNote(env, file)).toBe(".env files are never copied; set the values on the machine");
    expect(refusedNote(env, dir)).toBeUndefined();
    expect(refusedNote(env, missing)).toBeUndefined();
    expect(refusedNote(netrc, file)).toBeUndefined();
    expect(refusedNote({ ...env, rung: "logins", id: "logins/hermes", paths: ["~/.hermes/.env"] }, file)).toBeUndefined();
    expect(refusedNote({ ...env, paths: ["~/.env", "~/.app/config"] }, file)).toBeUndefined();
    expect(refusedNote(byId("tools/brew/gh"), file)).toBeUndefined();
    expect(refusedNote(byId("identity/ssh-key"), file)).toBe("private key, never copied");
  });

  it("lockRefused writes the plan's note onto the rows it would refuse whole and leaves every other row as it was", () => {
    const manifest = { entries: [env, netrc, byId("shell/zshrc")] };
    const locked = lockRefused(manifest, rel => (rel === ".env" ? false : undefined));
    expect(locked.entries[0]).toEqual({ ...env, default: "skip", reason: ".env files are never copied; set the values on the machine" });
    expect(isTickable(locked.entries[0]!)).toBe(false);
    expect(initialTicks({ ...locked.entries[0]!, bring: true })).toBe(false);
    expect(locked.entries.slice(1)).toEqual([netrc, byId("shell/zshrc")]);
    // A directory named .env is a Python environment more often than a secret: it stays a plain row.
    expect(lockRefused(manifest, dir).entries).toEqual(manifest.entries);
    expect(isTickable(env)).toBe(true);
  });

  it("a row carrying a detail still picks up the plan's refusal note; only a reason holds it off", () => {
    const config = byId("identity/ssh-config");
    expect(config.detail).toBeDefined();
    const locked = lockRefused({ entries: [config] }, dir).entries[0]!;
    expect(locked).toEqual({ ...config, default: "skip", reason: "a directory under .ssh is never copied whole" });
    expect(isTickable(locked)).toBe(false);
    // The same row with the line written as a reason instead would swallow the note and offer a tick the pack throws away.
    expect(lockRefused({ entries: [{ ...config, detail: undefined, reason: config.detail! }] }, dir).entries[0]!.default).toBe("bring");
  });
});

describe("consent rows", () => {
  const token: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", paths: [], bytes: 0, default: "bring", consent: true };
  const plain: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", paths: [], bytes: 0, default: "skip" };

  it("a login or a credential-shaped row is answered, not ticked; its answer starts at skip, a saved tick alone is not consent, and a saved choice wins", () => {
    expect(hasChoices(token)).toBe(true);
    expect(hasChoices(plain)).toBe(false);
    expect(hasChoices(byId("logins/gh"))).toBe(true);
    expect(initialChoice(token)).toBe("skip");
    expect(initialChoice({ ...token, bring: true })).toBe("skip");
    expect(initialChoice({ ...token, bring: true, choice: "copy" })).toBe("copy");
    // An answer a consent row never offered (saved as sign in by an older recipe) reads as skip.
    expect(initialChoice({ ...token, bring: true, choice: "machine" })).toBe("skip");
    expect(initialTicks(plain)).toBe(false);
    expect(initialTicks({ ...plain, bring: true })).toBe(true);
  });

  it("the schema takes a choice on a consent row and refuses one on a plain row", () => {
    expect(parseManifest({ entries: [{ ...token, choice: "copy" }] }).entries[0]).toMatchObject({ choice: "copy", consent: true });
    expect(() => parseManifest({ entries: [{ ...plain, choice: "copy" }] })).toThrow(/entries\.0\.choice: only a logins row or a consent row carries a choice/);
    expect(parseManifest({ entries: [{ ...byId("shell/zshrc"), excludes: ["~/.zshrc.d/secret"] }] }).entries[0]).toMatchObject({ excludes: ["~/.zshrc.d/secret"] });
  });

  it("answeredRows writes the screens' tick and answer on every row, so the MCP plan reads the copy a server was given and never the manifest's stale word", () => {
    const stale = { ...token, choice: "skip" as const };
    const rows = answeredRows({ entries: [byId("agents/claude"), stale, byId("shell/zshrc")] }, new Set(["agents/claude", "agents/mcp/claude/github"]), new Map([["agents/mcp/claude/github", "copy"], ["agents/claude", "nonsense"]]));
    expect(rows).toEqual([{ ...byId("agents/claude"), bring: true }, { ...token, bring: true, choice: "copy" }, { ...byId("shell/zshrc"), bring: false }]);
  });

  it("the saved recipe is this user's alone: the rows land in a file of their own and replace the one that stood wider, under a folder repaired to 0700", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    try {
      const path = join(dir, "golden-recipe.json");
      chmodSync(dir, 0o755);
      saveRecipe(path, FIXTURE, new Set(["shell/zshrc"]));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      writeFileSync(path, "{}\n", { mode: 0o644 });
      const wider = statSync(path).ino;
      saveRecipe(path, FIXTURE, new Set(["shell/zshrc"]));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // The rows never land in the file that stood at 0644: they are written to one of their own and the rename
      // puts it in its place, so no byte of them is ever readable through the wider file.
      expect(statSync(path).ino).not.toBe(wider);
      expect(loadManifest(path).entries.length).toBe(FIXTURE.entries.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the recipe round-trips a consent row and an excludes list: tick, answer and excludes come back as saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    try {
      const path = join(dir, "golden-recipe.json");
      const withExcludes = { ...byId("shell/zshrc"), excludes: ["~/.zshrc.d/secret"] };
      saveRecipe(path, { entries: [...FIXTURE.entries.filter(e => e.id !== "shell/zshrc"), withExcludes, token] }, new Set(["shell/zshrc", "agents/mcp/claude/github"]), new Map([["agents/mcp/claude/github", "copy"]]));
      const back = loadManifest(path);
      expect(back.entries.find(e => e.id === "shell/zshrc")).toEqual({ ...withExcludes, bring: true });
      expect(back.entries.find(e => e.id === "agents/mcp/claude/github")).toEqual({ ...token, bring: true, choice: "copy" });
      expect(initialChoice(back.entries.find(e => e.id === "agents/mcp/claude/github")!)).toBe("copy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseManifest", () => {
  it("accepts the collector shape and a saved recipe with bring flags", () => {
    expect(parseManifest(JSON.parse(JSON.stringify(FIXTURE)))).toEqual(FIXTURE);
    const saved = { entries: [{ ...byId("shell/zshrc"), bring: false }] };
    expect(parseManifest(saved).entries[0]).toMatchObject({ id: "shell/zshrc", bring: false });
  });

  it("names the row and field that is wrong, in the collector's words", () => {
    expect(() => parseManifest({ entries: [{ rung: "kitchen", id: "kitchen/x", label: "x", paths: [], bytes: 0, default: "bring" }] })).toThrow(/invalid manifest: entries\.0\.rung/);
    expect(() => parseManifest({ entries: [{ rung: "shell", id: "shell/x", label: "x", paths: [], bytes: "big", default: "bring" }] })).toThrow(/entries\.0\.bytes/);
    expect(() => parseManifest({ entries: [{ ...byId("logins/gh"), choice: "maybe" }] })).toThrow(/entries\.0\.choice/);
    expect(() => parseManifest({ entries: [{ ...byId("shell/zshrc"), id: "zshrc" }] })).toThrow(/entries\.0\.id: id must start with shell\//);
    expect(() => parseManifest({ entries: [byId("shell/zshrc"), byId("shell/zshrc")] })).toThrow(/entries\.1\.id: duplicate id shell\/zshrc/);
    expect(() => parseManifest({ items: [] })).toThrow(/entries/);
    expect(() => parseManifest("nope")).toThrow(/object/);
  });
});

describe("goldenRecipeFor", () => {
  const bring = (...ids: string[]): ManifestEntry[] => ids.map(byId);
  const imp: GoldenImport = { recipeHash: "h", tools: [], agents: [] };

  it("runs a bare harness and smoke; the import carries files, tools and agents; envs name no agent when none is ticked", () => {
    const none = goldenRecipeFor(bring("identity/git-user", "shell/zshrc"), { import: imp });
    expect(none.setup).toBe("true");
    expect(none.smoke).toBe("true");
    expect(none.import).toBe(imp);
    expect(none.envs).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(none.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(none.envs?.["PATH"]).toContain("/root/.local/bin");
    expect(none.envs?.["PATH"]).toContain("/home/linuxbrew/.linuxbrew/bin");
    expect(JSON.stringify(none)).not.toMatch(/claude/i);
  });

  it("a ticked Claude Code sets its config dir and no sign-in of any kind", () => {
    const claude = goldenRecipeFor(bring("agents/claude", "shell/zshrc"));
    expect(claude.envs).toMatchObject({ CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });
    expect(claude.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(claude.envs).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("no agent's key rides onto the image: the vault sets each in the environment of every turn instead", () => {
    const codex = goldenRecipeFor(bring("agents/codex", "shell/zshrc"));
    expect(codex.envs).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(codex.envs).not.toHaveProperty("OPENAI_API_KEY");
    expect(codex.envs).toEqual(goldenRecipeFor(bring("shell/zshrc")).envs);
  });

  it("names no size, so the wizard's builder is minted at the size the backend calls default", () => {
    const recipe = goldenRecipeFor(bring("agents/claude", "shell/zshrc"));
    expect([recipe.cpu, recipe.memMb]).toEqual([undefined, undefined]);
  });

  it("threads the daemon deploy hook through", () => {
    const hook = async () => "node v22";
    expect(goldenRecipeFor([], { deployDaemon: hook }).deployDaemon).toBe(hook);
  });
});

describe("recipe file", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lives next to the state file and round-trips the ticks as bring flags", () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    const statePath = join(dir, "sub", "state.json");
    const path = recipePath(statePath);
    expect(path).toBe(join(dir, "sub", "golden-recipe.json"));

    const choices = new Map([["logins/gh", "machine"], ["logins/claude", "copy"]] as const);
    saveRecipe(path, FIXTURE, new Set(["identity/git-user", "shell/zshrc", "agents/claude", "logins/claude"]), choices);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const back = loadManifest(path);
    expect(back.entries).toHaveLength(FIXTURE.entries.length);
    expect(back.entries.map(e => [e.id, e.bring])).toEqual(
      FIXTURE.entries.map(e => [e.id, ["identity/git-user", "shell/zshrc", "agents/claude", "logins/claude"].includes(e.id)]),
    );
    expect(back.entries.find(e => e.id === "logins/gh")?.choice).toBe("machine");
    expect(back.entries.find(e => e.id === "logins/claude")?.choice).toBe("copy");
    expect(back.entries.find(e => e.id === "shell/zshrc")).not.toHaveProperty("choice");
    // A re-run of the saved file preselects exactly what was ticked and chosen.
    expect(back.entries.filter(initialTicks).map(e => e.id)).toEqual(["identity/git-user", "shell/zshrc", "agents/claude", "logins/claude"]);
    expect(back.entries.filter(e => e.rung === "logins").map(initialChoice)).toEqual(["machine", "copy", "later"]);
  });
});

describe("the small recipe", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const RECIPE: Recipe = {
    version: 1,
    at: "2026-09-06T03:00:00.000Z",
    histories: [{ agent: "claude", state: "read", sessions: 149, calls: 87593 }],
    rows: [
      { id: "claude", kind: "agent", on: false, source: { kind: "popular", sessions: 149, images: 1 } },
      { id: "codex", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.codex/config.toml"], bin: true }, size: 1 },
      { id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 }, signIn: "copy" },
      { id: "yq", kind: "tool", on: false, source: { kind: "popular", sessions: 0, images: 3 } },
      { id: "agent-browser", kind: "tool", on: true, source: { kind: "used", sessions: 45, calls: 2591 } },
      { id: "git", kind: "tool", on: true, source: { kind: "popular", sessions: 118, images: 5 } },
      { id: "kubectl", kind: "tool", on: false, source: { kind: "popular", sessions: 1, images: 1 }, signIn: "machine" },
    ],
  };

  it("loadRecipe names the path on a missing or malformed file and checks the protocol's shape", () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    expect(() => loadRecipe(join(dir, "missing.json"))).toThrow(/no recipe at .*missing\.json/);
    const path = join(dir, "recipe.json");
    writeFileSync(path, "{");
    expect(() => loadRecipe(path)).toThrow(/recipe\.json: /);
    writeFileSync(path, JSON.stringify({ ...RECIPE, rows: [{ id: "gh", kind: "tool", on: true, source: { kind: "guess" } }] }));
    expect(() => loadRecipe(path)).toThrow(/recipe\.json: invalid recipe: rows\.0\.source/);
    writeFileSync(path, JSON.stringify(RECIPE));
    expect(loadRecipe(path)).toEqual(RECIPE);
  });

  it("applyRecipe ticks the agents and tools rows from the catalog ids and leaves the other rungs to their defaults", () => {
    const applied = applyRecipe({ ...FIXTURE, entries: [...FIXTURE.entries, { rung: "agents", id: "agents/mcp/claude/spoo-ops", label: "spoo-ops", paths: [], bytes: 0, default: "bring" }, { rung: "agents", id: "agents/mcp/codex/axiom", label: "axiom", paths: [], bytes: 0, default: "bring" }, { rung: "agents", id: "agents/mcp/mcp-remote", label: "mcp-remote", paths: [], bytes: 0, default: "bring" }, { rung: "tools", id: "tools/brew/openjdk@21", label: "openjdk@21", paths: [], bytes: 0, default: "skip", reason: "no Linux bottle" }] }, RECIPE);
    const bring = new Map(applied.entries.map(e => [e.id, e.bring]));
    expect(bring.get("agents/claude")).toBe(false);
    expect(bring.get("agents/codex")).toBe(true);
    // An MCP server follows its agent; the mcp-remote row is no agent's and keeps its default.
    expect(bring.get("agents/mcp/claude/spoo-ops")).toBe(false);
    expect(bring.get("agents/mcp/codex/axiom")).toBe(true);
    expect(bring.get("agents/mcp/mcp-remote")).toBe(true);
    // gh is the catalog's gh; yq is off in the recipe; tsx stands for no catalog tool; a locked row stays locked whatever the recipe says.
    expect(bring.get("tools/brew/gh")).toBe(true);
    expect(bring.get("tools/brew/yq")).toBe(false);
    expect(bring.get("tools/npm/tsx")).toBe(false);
    expect(bring.get("tools/brew/rectangle")).toBe(false);
    expect(bring.get("tools/brew/openjdk@21")).toBe(false);
    // The ticked tools rows are gh's and the bare row the recipe added for agent-browser, which this Mac has no row for.
    expect(applied.entries.filter(e => e.rung === "tools" && initialTicks(e)).map(e => e.id)).toEqual(["tools/brew/gh", "tools/catalog/agent-browser"]);
    for (const id of ["identity/git-user", "identity/ssh-key", "shell/zshrc", "toolchains/mise"]) expect(bring.has(id) && bring.get(id) === undefined, id).toBe(true);
    // The saved sign-in answer lands on the login row; a login the recipe did not answer keeps its own default.
    expect(applied.entries.find(e => e.id === "logins/gh")).toMatchObject({ choice: "copy" });
    expect(applied.entries.find(e => e.id === "logins/gh")?.bring).toBeUndefined();
    expect(applied.entries.find(e => e.id === "logins/claude")).not.toHaveProperty("choice");
    expect(applied.entries.find(e => e.id === "logins/codex")).not.toHaveProperty("choice");
    expect(initialChoice(applied.entries.find(e => e.id === "logins/gh")!)).toBe("copy");
  });

  it("applyRecipe adds a bare ticked row for a catalog tool this computer has no row for, the floor's aside, and makes them anew on the next pass", () => {
    const applied = applyRecipe(FIXTURE, RECIPE);
    // gh is here as a formula, git is the floor's, codex is an agent and kubectl is off: agent-browser alone gets a row, one a manifest accepts.
    const bare = applied.entries.filter(e => e.id.startsWith("tools/catalog/"));
    expect(bare).toEqual([{ rung: "tools", id: "tools/catalog/agent-browser", label: "agent-browser", group: "Catalog", paths: [], bytes: 0, default: "skip", linux: "yes", bring: true }]);
    expect(initialTicks(bare[0]!)).toBe(true);
    expect(parseManifest(applied)).toEqual(applied);
    const empty = applyRecipe({ entries: [] }, RECIPE);
    expect(empty.entries.map(e => e.id)).toEqual(["tools/catalog/gh", "tools/catalog/agent-browser"]);
    const again = applyRecipe(empty, { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "gh" ? { ...r, on: false } : r)) });
    expect(again.entries.map(e => e.id)).toEqual(["tools/catalog/agent-browser"]);
  });

  it("a row whose manager the build reads no road off would swallow a ticked catalog tool, which is why the collector files none: with one, nothing installs the tool; with none, the bare row installs it by the catalog's road", () => {
    const tmux: Recipe = { version: 1, at: "2026-09-11T00:00:00Z", histories: [], rows: [{ id: "tmux", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } }] };
    const plan = (m: Manifest) => toolInstallsFor(applyRecipe(m, tmux).entries.filter(e => e.bring === true), new Map(), []);
    // What the collector files on Linux: no apt row for tmux, so the tick lands on the catalog's own row and its
    // apt road installs it, the index read once ahead of it.
    expect(plan({ entries: [] }).installs.map(t => t.id)).toEqual(["tools/apt-index", "tools/catalog/tmux"]);
    // What an apt row would do instead: the row counts as tmux being here, so no bare row is added, and no road
    // reads off an apt row, so the plan installs nothing at all and says nothing about it.
    const apt: ManifestEntry = { rung: "tools", id: "tools/apt/tmux", label: "tmux", group: "apt packages", paths: [], bytes: 0, default: "bring", linux: "yes" };
    const swallowed = plan({ entries: [apt] });
    expect(swallowed.installs).toEqual([]);
    expect(swallowed.skipped).toEqual([]);
  });

  it("a pin on the small recipe is what the last seal got and lands on no row: the image's own cut reads latest again; the file keeps it for wsp recipe, and a saved recipe's ticks come across without it", () => {
    const pin = { tag: "v2.86.0", sha256: "b".repeat(64) };
    const pinned: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "gh" ? { ...r, pin, signIn: "copy" as const } : r)) };
    expect(applyRecipe(FIXTURE, pinned).entries.find(e => e.id === "tools/brew/gh")).toMatchObject({ bring: true });
    expect(applyRecipe(FIXTURE, pinned).entries.find(e => e.id === "tools/brew/gh")).not.toHaveProperty("pin");
    const bare = applyRecipe({ entries: [] }, pinned);
    expect(bare.entries.find(e => e.id === "tools/catalog/gh")).toMatchObject({ bring: true });
    expect(bare.entries.find(e => e.id === "tools/catalog/gh")).not.toHaveProperty("pin");
    expect(parseManifest(bare)).toEqual(bare);
    const here: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => { const { pin: _pin, signIn: _signIn, ...rest } = r; return { ...rest, on: false }; }) };
    expect(withTicksOf(here, pinned).rows.find(r => r.id === "gh")).toMatchObject({ on: true, signIn: "copy" });
    expect(withTicksOf(here, pinned).rows.find(r => r.id === "gh")).not.toHaveProperty("pin");
    // A saved catalog row this computer has no row for follows as it was saved, its pin left behind too.
    const saved: Recipe = { ...pinned, rows: [...pinned.rows, { id: "wrangler", kind: "tool", on: true, source: { kind: "popular", sessions: 1, images: 1 }, pin: { tag: "4.1.0" } }] };
    expect(withTicksOf(here, saved).rows.find(r => r.id === "wrangler")).toEqual({ id: "wrangler", kind: "tool", on: true, source: { kind: "popular", sessions: 1, images: 1 } });
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify(pinned));
    expect(loadRecipe(path).rows.find(r => r.id === "gh")?.pin).toEqual(pin);
  });

  it("recipeChanges says why a tool installs differently when more than its version moved: the road in the roads' words, the lines otherwise; a pin alone and a tick sealed without a road say nothing", () => {
    const manifest: Manifest = { entries: [{ rung: "tools", id: "tools/catalog/rust", label: "Rust", paths: [], bytes: 0, default: "skip" }] };
    const at = (t: Partial<RecipeDigest["ticks"][number]>): RecipeDigest => ({ ticks: [{ id: "tools/catalog/rust", ...t }], files: [] });
    expect(recipeChanges(at({ road: "brew", installer: "a" }), at({ road: "script", installer: "b" }), manifest)).toEqual(["Rust: now by its own installer, was with Homebrew"]);
    expect(recipeChanges(at({ road: "release", installer: "a", pin: { tag: "v1", sha256: "x" } }), at({ road: "release", installer: "a", pin: { tag: "v2", sha256: "y" } }), manifest)).toEqual([]);
    expect(recipeChanges(at({ road: "release", installer: "a", pin: { tag: "v1", sha256: "x" } }), at({ road: "release", installer: "a" }), manifest)).toEqual([]);
    expect(recipeChanges(at({ road: "release", installer: "a" }), at({ road: "release", installer: "b" }), manifest)).toEqual(["Rust: its install lines changed"]);
    expect(recipeChanges(at({ version: "1", road: "release", installer: "a" }), at({ version: "2", road: "release", installer: "b" }), manifest)).toEqual(["Rust now 2"]);
    expect(recipeChanges(at({}), at({ road: "script", installer: "b" }), manifest)).toEqual([]);
    expect(recipeChanges(at({ road: "script", installer: "b" }), at({ road: "script", installer: "b" }), manifest)).toEqual([]);
  });

  it("a Mac's rustup formula is the rust row the recipe ticks, so no bare catalog row lands beside it", () => {
    const rustup: ManifestEntry = { rung: "tools", id: "tools/brew/rustup", label: "rustup", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "yes" };
    const recipe: Recipe = { ...RECIPE, rows: [...RECIPE.rows, { id: "rust", kind: "tool", on: true, source: { kind: "used", sessions: 4, calls: 100 } }] };
    const applied = applyRecipe({ ...FIXTURE, entries: [...FIXTURE.entries, rustup] }, recipe);
    expect(applied.entries.find(e => e.id === "tools/brew/rustup")?.bring).toBe(true);
    expect(applied.entries.filter(e => e.id === "tools/catalog/rust")).toEqual([]);
  });

  it("a login's command counts as coming when the catalog's bare row brings it", () => {
    const gh: ManifestEntry = { rung: "tools", id: "tools/catalog/gh", label: "GitHub CLI", group: "Catalog", paths: [], bytes: 0, default: "skip", linux: "yes", bring: true };
    expect(loginTool(byId("logins/gh"), { entries: [byId("logins/gh"), gh] }, new Set(["tools/catalog/gh"]), new Map())).toEqual({ bin: "gh", row: gh, coming: true });
  });

  it("withCatalogAgents adds a bare agents row and a bare login row for every catalog agent this computer has none for, and leaves the found ones alone", () => {
    const rows = withCatalogAgents(FIXTURE).entries;
    const added = rows.slice(FIXTURE.entries.length);
    expect(added.map(e => e.id)).toEqual(["agents/gemini", "logins/gemini", "agents/opencode", "logins/opencode", "agents/pi", "logins/pi", "agents/hermes", "logins/hermes", "agents/crush", "agents/qwen", "agents/goose", "agents/amp"]);
    // An agent the catalog has no sign-in for gets no login row: there is nothing to sign in to or copy.
    expect(added.find(e => e.id === "agents/gemini")).toEqual({ rung: "agents", id: "agents/gemini", label: "Gemini CLI", paths: [], bytes: 0, default: "skip" });
    expect(added.find(e => e.id === "logins/hermes")).toEqual({ rung: "logins", id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: [], bytes: 0, default: "skip" });
    // A bare row starts off and unticked; the recipe decides.
    expect(added.every(e => !initialTicks(e))).toBe(true);
    expect(added.filter(e => e.rung === "logins").every(e => initialChoice(e) === "later")).toBe(true);
    // The found rows keep their place and their fields; a manifest with every agent gains nothing.
    expect(rows.slice(0, FIXTURE.entries.length)).toEqual(FIXTURE.entries);
    const full = withCatalogAgents({ entries: [...FIXTURE.entries, ...added] });
    expect(full.entries).toHaveLength(FIXTURE.entries.length + added.length);
    // The keys row beside Hermes follows the Hermes agent row like the login does.
    const keys: ManifestEntry = { rung: "logins", id: "logins/hermes-keys", label: "Hermes Agent API keys", group: "Agent logins", paths: ["~/.hermes/.env"], bytes: 100, default: "bring" };
    const withKeys = { entries: [...rows, keys] };
    expect(loginShown(keys, withKeys, new Set(["agents/hermes"]))).toBe(true);
    expect(loginShown(keys, withKeys, new Set())).toBe(false);
    expect(loginShown(keys, { entries: [keys] }, new Set())).toBe(true);
  });

  it("an API key answer round-trips through the small recipe, and the screens read it back", () => {
    const out = recipeWithAnswers(RECIPE, new Map([["logins/claude", "key"]]));
    const parsed = Recipe.parse(JSON.parse(JSON.stringify(out)));
    expect(parsed.rows.find(r => r.id === "claude")).toMatchObject({ signIn: "key" });
    // The saved answer is what the sign-ins screen opens that row on.
    expect(initialChoice({ rung: "logins", id: "logins/claude", label: "Claude Code login", paths: ["Keychain: Claude Code-credentials"], bytes: 0, default: "skip", choice: "key" })).toBe("key");
  });

  it("recipeWithAnswers writes the login answers onto the small recipe and leaves the ticks as they are; a row nobody answered carries none", () => {
    const out = recipeWithAnswers(RECIPE, new Map([["logins/gh", "machine"], ["logins/claude", "copy"], ["logins/kube", "copy"], ["logins/codex", "skip"]]));
    const by = new Map(out.rows.map(r => [r.id, r]));
    expect(by.get("claude")).toMatchObject({ on: false, signIn: "copy" });
    expect(by.get("codex")).toMatchObject({ on: true, signIn: "skip" });
    // gh's saved copy gives way to the screens' answer.
    expect(by.get("gh")).toMatchObject({ on: true, signIn: "machine" });
    expect(by.get("yq")).toMatchObject({ on: false });
    expect(by.get("yq")).not.toHaveProperty("signIn");
    // kubectl's login row is filed as kube; the answer lands on the kubectl row over the saved one.
    expect(by.get("kubectl")).toMatchObject({ on: false, signIn: "copy" });
    expect(out.at).toBe(RECIPE.at);
    expect(Recipe.parse(out)).toEqual(out);
    // A saved answer the screens did not repeat is gone rather than stale.
    expect(recipeWithAnswers(RECIPE, new Map()).rows.find(r => r.id === "kubectl")).not.toHaveProperty("signIn");
  });

  it("withTicksOf writes a saved recipe's ticks and answers onto this computer's rows: a row the saved one lacks is off and unanswered, a saved row this computer has no row for comes after them as saved", () => {
    const here: Recipe = {
      ...RECIPE,
      at: "2026-09-06T09:00:00.000Z",
      histories: [],
      rows: [
        { id: "claude", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.claude/settings.json"], bin: true }, signIn: "machine" },
        { id: "codex", kind: "agent", on: false, source: { kind: "popular", sessions: 5, images: 1 }, size: 2 },
        { id: "gh", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } },
        { id: "gemini", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.gemini/settings.json"], bin: true } },
      ],
    };
    const out = withTicksOf(here, RECIPE);
    expect(out.rows).toEqual([
      { id: "claude", kind: "agent", on: false, source: { kind: "installed", paths: ["~/.claude/settings.json"], bin: true } },
      { id: "codex", kind: "agent", on: true, source: { kind: "popular", sessions: 5, images: 1 }, size: 2 },
      { id: "gh", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true }, signIn: "copy" },
      { id: "gemini", kind: "agent", on: false, source: { kind: "installed", paths: ["~/.gemini/settings.json"], bin: true } },
      ...RECIPE.rows.filter(r => !["claude", "codex", "gh"].includes(r.id)),
    ]);
    expect(out.at).toBe(here.at);
    expect(out.histories).toEqual([]);
    expect(Recipe.parse(out)).toEqual(out);
  });

  const TAP: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" };
  const TABLE: BrewTable = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * MIB, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
  const here = { kind: "installed" as const, paths: [], bin: true };

  it("withOutsideRows adds a row per tools row the catalog does not carry, off and found here; a catalog row, a tap, a locked row and a row no road installs get none", () => {
    const tapItself: ManifestEntry = { rung: "tools", id: "tools/brew-tap/zingzy/tap", label: "zingzy/tap", group: "Homebrew taps", paths: [], bytes: 0, default: "bring", linux: "yes" };
    const nix: ManifestEntry = { rung: "tools", id: "tools/nix-home-manager", label: "Nix home-manager config", paths: ["~/.config/home-manager"], bytes: 10, default: "bring", linux: "yes" };
    const manifest: Manifest = { entries: [...FIXTURE.entries, TAP, tapItself, nix] };
    const out = withOutsideRows(RECIPE, manifest, TABLE);
    // gh and yq are the catalog's rows, rectangle is locked off with its reason, the tap and the nix row install nothing.
    expect(out.rows.slice(RECIPE.rows.length)).toEqual([
      { id: "tools/npm/tsx", kind: "tool", on: false, source: here },
      { id: TAP.id, kind: "tool", on: false, source: here },
    ]);
    expect(Recipe.parse(out)).toEqual(out);
    // A row the recipe already carries is left as it is; nothing to add gives the recipe back.
    expect(withOutsideRows(out, manifest, TABLE)).toEqual(out);
    expect(withOutsideRows(RECIPE, { entries: [] }, TABLE)).toBe(RECIPE);
    // Without the table the tap formula still has a row: the brew road plans it, and the plan says what it does with it.
    expect(withOutsideRows(RECIPE, { entries: [TAP] }, new Map()).rows.at(-1)).toEqual({ id: TAP.id, kind: "tool", on: false, source: here });
  });

  it("applyRecipe ticks such a row from the recipe's row under its own id and carries no pin onto it; a recipe without the row leaves it off", () => {
    const pin = { tag: "v0.1.0", sha256: "a".repeat(64) };
    const manifest: Manifest = { entries: [...FIXTURE.entries, TAP] };
    const on: Recipe = { ...RECIPE, rows: [...RECIPE.rows, { id: TAP.id, kind: "tool", on: true, source: here, pin }, { id: "tools/npm/tsx", kind: "tool", on: true, source: here }] };
    const applied = applyRecipe(manifest, on);
    expect(applied.entries.find(e => e.id === TAP.id)).toEqual({ ...TAP, bring: true });
    expect(applied.entries.find(e => e.id === "tools/npm/tsx")).toMatchObject({ bring: true });
    expect(applied.entries.filter(e => e.rung === "tools" && initialTicks(e)).map(e => e.id)).toEqual(["tools/brew/gh", "tools/npm/tsx", TAP.id, "tools/catalog/agent-browser"]);
    expect(parseManifest(applied)).toEqual(applied);
    const off = applyRecipe(manifest, RECIPE);
    expect(off.entries.find(e => e.id === TAP.id)).toEqual({ ...TAP, bring: false });
    expect(off.entries.find(e => e.id === "tools/npm/tsx")).toMatchObject({ bring: false });
    // A row the recipe ticks off stays off, whatever its default says.
    expect(applyRecipe(manifest, { ...on, rows: on.rows.map(r => (r.id === TAP.id ? { ...r, on: false } : r)) }).entries.find(e => e.id === TAP.id)).toEqual({ ...TAP, bring: false });
  });

  it("withTicksOf writes a saved tick onto this computer's row outside the catalog without the saved pin, and drops a saved row outside the catalog this computer has no row for, where a catalog row is kept", () => {
    const pin = { tag: "v0.1.0", sha256: "a".repeat(64) };
    const mine: Recipe = { ...RECIPE, rows: [{ id: TAP.id, kind: "tool", on: false, source: here }] };
    const saved: Recipe = { ...RECIPE, rows: [{ id: TAP.id, kind: "tool", on: true, source: here, pin }, { id: "tools/brew/elsewhere", kind: "tool", on: true, source: here }, { id: "gh", kind: "tool", on: true, source: here }] };
    const out = withTicksOf(mine, saved);
    expect(out.rows).toEqual([{ id: TAP.id, kind: "tool", on: true, source: here }, { id: "gh", kind: "tool", on: true, source: here }]);
  });
});
