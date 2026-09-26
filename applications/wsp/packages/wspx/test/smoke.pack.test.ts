// SPDX-License-Identifier: AGPL-3.0-only
// Packs the package and installs the tarball into an empty folder on a clean
// environment, the way a stranger's `npm i -g @zingzy/wsp` does, then runs the three
// commands that need no key. Gated on WSP_PACK_SMOKE=1 (pnpm --filter @zingzy/wsp
// smoke) so the unit suite never runs an npm install.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_KINDS, SECTION_BEGIN, assetDir, assetProof, stagedAsset } from "@wsp/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SMOKE = process.env["WSP_PACK_SMOKE"] === "1";
const pkg = fileURLToPath(new URL("..", import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string }).version;

/** No key, no agent config, no npm noise from the developer's own environment: only what a fresh shell has. */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: home, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
}

function ran(what: string, result: SpawnSyncReturns<string>): string {
  if (result.status !== 0) throw new Error(`${what} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

let dir = "";
let home = "";
let installed = "";

beforeAll(() => {
  if (!SMOKE) return;
  const built: [string, string][] = [
    ["command bundle", join(pkg, "dist", "bin.js")],
    ...ASSET_KINDS.map((kind): [string, string] => [`staged ${kind} asset`, join(stagedAsset(pkg, kind), assetProof(kind))]),
  ];
  for (const [what, path] of built) {
    if (!existsSync(path)) throw new Error(`${what} missing: run pnpm -r --filter '!@wsp/desktop' build first (${path})`);
  }
  dir = mkdtempSync(join(tmpdir(), "wsp-pack-smoke-"));
  home = join(dir, "home");
  installed = join(dir, "empty");
  mkdirSync(home);
  mkdirSync(installed);
  ran("npm pack", spawnSync("npm", ["pack", "--pack-destination", dir], { cwd: pkg, encoding: "utf8", env: cleanEnv(home) }));
  const tarball = join(dir, readdirSync(dir).find(f => f.endsWith(".tgz")) ?? "");
  ran("npm install", spawnSync("npm", ["install", "--no-package-lock", tarball], { cwd: installed, encoding: "utf8", env: cleanEnv(home) }));
}, 600_000);

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function wsp(...args: string[]): string {
  return ran(`wsp ${args.join(" ")}`, spawnSync(join(installed, "node_modules", ".bin", "wsp"), args, { cwd: installed, encoding: "utf8", env: cleanEnv(home) }));
}

describe.runIf(SMOKE)("the packed command, installed from its tarball", () => {
  it("carries no dependency tree of its own", () => {
    expect(readdirSync(join(installed, "node_modules")).filter(n => !n.startsWith("."))).toEqual(["@zingzy"]);
  });

  it("prints its version", () => {
    expect(wsp("--version").trim()).toBe(`wsp ${VERSION}`);
  });

  it("writes a recipe", () => {
    const out = join(installed, "recipe.json");
    wsp("recipe", "--out", out);
    const recipe = JSON.parse(readFileSync(out, "utf8")) as { version: number; rows: { id: string; kind: string }[] };
    expect(recipe.version).toBe(1);
    expect(recipe.rows.filter(r => r.kind === "agent").map(r => r.id)).toContain("claude");
  });

  it("installs the MCP server and the skill under this home, and its own section in the folder it ran in", () => {
    const lines = wsp("mcp", "install", "--agent", "claude");
    expect(lines).toContain("~/.claude.json");
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers: Record<string, { args: string[] }> };
    expect(config.mcpServers["wsp"]?.args).toContain("mcp");
    expect(readFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "utf8")).toMatch(/^---\nname: wsp\n/);
    expect(readFileSync(join(installed, "AGENTS.md"), "utf8")).toContain(SECTION_BEGIN);
    expect(lines.trimEnd().split("\n").at(-1)).toBe("Next: run claude in this folder and say: /wsp set up wsp for me");
  });

  // assetDir falls back to this checkout when the packed road misses, so the resolved directory is named
  // before it is read: without that, the case passes on an install that staged nothing.
  it("reads the web app and the daemon out of the tarball, not out of this checkout", () => {
    const root = join(installed, "node_modules", "@zingzy", "wsp");
    const dist = join(root, "dist");
    for (const kind of ASSET_KINDS) {
      expect(assetDir(kind, dist)).toBe(stagedAsset(root, kind));
      expect(existsSync(join(assetDir(kind, dist), assetProof(kind)))).toBe(true);
    }
  });
});
