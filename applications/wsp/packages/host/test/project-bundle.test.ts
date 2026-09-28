// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { CACHE_DIRS } from "@wsp/collect";
import { PROJECT_STATE_RESOLVERS, agentHomes, folderExportScript } from "@wsp/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tarRead } from "../../engine/test/tar-read.js";
import { withRefused } from "../../runtime/test/fs-refusal.js";
import { CACHE_RULE, isCacheDir, packProject, planProject, projectBundler } from "../src/project-bundle.js";

vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BINARY = Buffer.concat([Buffer.from("#!/bin/sh\necho run\n"), randomBytes(2048), Buffer.from([0x00, 0xff, 0x0a])]);
const FAKE_TOKEN = "ghp_fake_token_000";
const BARE_URL = "https://github.com/example/proj.git";
const TOKEN_URL = `https://x-access-token:${FAKE_TOKEN}@github.com/example/proj.git`;
const USERNAME_TOKEN_URL = `https://${FAKE_TOKEN}@github.com/example/proj.git`;
const AUTH_HEADER = "AUTHORIZATION: basic ZmFrZTpnaHBfZmFrZQ==";
const REWRITE = { urls: [BARE_URL], drop: [] };

function put(root: string, rel: string, content: string | Buffer, mode?: number): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mode !== undefined) chmodSync(abs, mode);
}

// Maintenance and gc are off: either would run inside the fixture and leave a lock file of its own under .git.
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).toString();

/** A repository with tracked source, committed build output, untracked notes, ignored state and every cache shape. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-proj-"));
  dirs.push(root);
  git(root, "init", "-q");
  put(root, "src/index.ts", "export const a = 1;\n");
  put(root, "bin/run.sh", BINARY, 0o755);
  put(root, "dist/keep.js", "tracked output\n");
  put(root, "build/README.md", "tracked doc in a build dir\n");
  put(root, ".gitignore", "node_modules\ndist\nbuild\n.env\n*.sqlite\n.venv\nenv\n.cache\ntarget\n.mypy_cache\n.eslintcache\n");
  git(root, "add", "-f", "src", "bin", ".gitignore", "dist/keep.js", "build/README.md");
  git(root, "commit", "-q", "-m", "init");
  put(root, "notes.txt", "untracked, carried\n");
  put(root, ".env", "API_TOKEN=sk-ant-x\n");
  put(root, ".env.example", "API_TOKEN=\n");
  put(root, "config/secrets.json", JSON.stringify({ token: "sk-ant-x" }));
  put(root, "config/settings.json", JSON.stringify({ theme: "dark" }));
  put(root, "keys/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", 0o600);
  put(root, "keys/id_ed25519.pub", "ssh-ed25519 AAAA dev\n");
  put(root, "data.sqlite", randomBytes(600));
  put(root, "node_modules/left/index.js", "cache\n");
  put(root, "dist/output.js", "untracked output beside the tracked file\n");
  put(root, "build/app.js", "untracked output\n");
  put(root, ".venv/lib/python3/site-packages/x.py", "venv\n");
  put(root, "env/pyvenv.cfg", "home = /usr/bin\n");
  put(root, "env/bin/python", "venv by marker\n");
  put(root, ".cache/x", "cache\n");
  put(root, "target/debug/bin", "rust output\n");
  put(root, ".mypy_cache/3.12/x.json", "{}");
  put(root, ".eslintcache", "cache file\n");
  put(root, "src/lruCache.ts", "a tracked source file whose name holds the word\n");
  put(root, "src/cache-names.ts", "another\n");
  put(root, "src/dist", "a tracked file named like a cache directory\n");
  git(root, "add", "-f", "src");
  git(root, "commit", "-q", "-m", "named like caches");
  put(root, "notes/my-cache-service/README.md", "an untracked directory whose name holds the word\n");
  put(root, "notes/CacheNotes.md", "an untracked file whose name holds the word\n");
  put(root, ".claude/settings.json", "{}\n");
  put(root, ".claude/worktrees/wt/.git", "gitdir: /elsewhere/.git/worktrees/wt\n");
  put(root, ".claude/worktrees/wt/src/index.ts", "a nested checkout\n");
  put(root, "empty-dir/.keep", "");
  mkdirSync(join(root, "really-empty"));
  symlinkSync("src/index.ts", join(root, "inside-link"));
  symlinkSync("/etc/hosts", join(root, "outside-link"));
  symlinkSync("../elsewhere", join(root, "up-link"));
  return root;
}

const extract = (tgz: Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-proj-out-"));
  dirs.push(dir);
  tarRead(["-xzf", "-", "-C", dir], tgz);
  return dir;
};

const listed = (tgz: Buffer): string[] => tarRead(["-tzf", "-"], tgz).toString().trim().split("\n").filter(l => l !== "").sort();

describe("planProject", () => {
  it("carries the tracked tree, the untracked and ignored state and the repository, and leaves every cache shape behind", async () => {
    const root = fixture();
    const { plan, files } = await planProject(root, {});
    const rels = files.map(f => f.rel);
    expect(plan.repo).toBe(true);
    expect(plan.source).toBe(realpathSync(root));
    for (const kept of ["src/index.ts", "src/lruCache.ts", "src/cache-names.ts", "src/dist", "notes/my-cache-service/README.md", "notes/CacheNotes.md", ".eslintcache", "bin/run.sh", "notes.txt", ".env", "config/secrets.json", "data.sqlite", ".git/HEAD", ".git/config", "dist/keep.js", "build/README.md", "empty-dir/.keep", "really-empty", "inside-link"]) {
      expect(rels, kept).toContain(kept);
    }
    expect(rels.some(r => r.startsWith(".git/objects/"))).toBe(true);
    for (const gone of ["node_modules/left/index.js", "dist/output.js", "build/app.js", ".venv/lib/python3/site-packages/x.py", "env/bin/python", ".cache/x", "target/debug/bin", ".mypy_cache/3.12/x.json", ".claude/worktrees/wt/.git", ".claude/worktrees/wt/src/index.ts", "outside-link", "up-link"]) {
      expect(rels, gone).not.toContain(gone);
    }
    expect(plan.excluded).toEqual([".cache", ".claude/worktrees/wt", ".mypy_cache", ".venv", "build", "dist", "env", "node_modules", "target"]);
    expect(plan.skipped).toEqual([
      { path: "outside-link", note: "a link to /etc/hosts, outside the folder; not followed" },
      { path: "up-link", note: "a link to ../elsewhere, outside the folder; not followed" },
    ]);
    expect(files.find(f => f.rel === "bin/run.sh")).toMatchObject({ mode: 0o755, bytes: BINARY.length });
    expect(files.find(f => f.rel === "inside-link")).toMatchObject({ kind: "link", target: "src/index.ts" });
    const regular = files.filter(f => f.kind === "file");
    expect(plan.files).toBe(regular.length);
    expect(plan.bytes).toBe(regular.reduce((n, f) => n + (f.kind === "file" ? f.bytes : 0), 0));
  });

  it("names the secret-shaped files by the collector's rules and nothing else", async () => {
    const root = fixture();
    const { plan } = await planProject(root, {});
    expect(plan.secrets).toEqual([
      { path: ".env", bytes: Buffer.byteLength("API_TOKEN=sk-ant-x\n"), signals: ["name", "keys"] },
      { path: "config/secrets.json", bytes: Buffer.byteLength(JSON.stringify({ token: "sk-ant-x" })), signals: ["name", "keys"] },
      { path: "keys/id_ed25519", bytes: Buffer.byteLength("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n"), signals: ["name", "mode", "pem"] },
    ]);
  });

  it("a git-tracked file is never secret-shaped and never cut: its content is in the repository, which travels whole", async () => {
    const root = fixture();
    put(root, ".github/workflows/ci.yml", "jobs:\n  build:\n    steps:\n      - with:\n          token: ${{ secrets.GITHUB_TOKEN }}\n");
    put(root, "deploy/credentials.json", JSON.stringify({ token: "sk-ant-x" }));
    git(root, "add", "-f", ".github", "deploy");
    git(root, "commit", "-q", "-m", "ci");
    const listing = await planProject(root, {});
    expect(listing.plan.secrets.map(s => s.path)).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
    expect(listing.files.find(f => f.rel === "deploy/credentials.json")).toMatchObject({ kind: "file", secret: false });
    const packed = packProject(listing, new Set(), new Set());
    expect(packed.cut).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
    expect(listed(packed.tar)).toContain("deploy/credentials.json");
  });

  it("an untracked file whose keys and URL passwords are environment references raises nothing; one holding a value still does", async () => {
    const root = fixture();
    put(root, "docker-compose.yml", "services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${PW}\n      DATABASE_URL: postgres://u:${PW}@db:5432/app\n");
    put(root, "vector.toml", '[sinks.axiom]\napi_key = "${AXIOM_TOKEN}"\n');
    put(root, "live.toml", '[sinks.axiom]\napi_key = "xaat-000-fake"\n');
    const { plan } = await planProject(root, {});
    expect(plan.secrets.map(s => s.path)).toEqual([".env", "config/secrets.json", "keys/id_ed25519", "live.toml"]);
  });

  it("a token in a remote URL in .git/config is named by the url rule, with the bare URL offered as the rewrite", async () => {
    const root = fixture();
    git(root, "remote", "add", "origin", TOKEN_URL);
    const { plan } = await planProject(root, {});
    expect(plan.secrets.map(s => s.path)).toEqual([".env", ".git/config", "config/secrets.json", "keys/id_ed25519"]);
    expect(plan.secrets[1]).toEqual({ path: ".git/config", bytes: statSync(join(root, ".git/config")).size, signals: ["url"], rewrite: REWRITE });
    expect(JSON.stringify(plan)).not.toContain(FAKE_TOKEN);
  });

  it("in .git/config any userinfo on an http(s) URL is auth material: a token as the username is named and offered bare", async () => {
    const root = fixture();
    git(root, "remote", "add", "origin", USERNAME_TOKEN_URL);
    git(root, "remote", "add", "up", "https://dev@example.com/team/proj.git");
    const { plan } = await planProject(root, {});
    expect(plan.secrets[1]).toEqual({ path: ".git/config", bytes: statSync(join(root, ".git/config")).size, signals: ["url"], rewrite: { urls: [BARE_URL, "https://example.com/team/proj.git"], drop: [] } });
    expect(JSON.stringify(plan)).not.toContain(FAKE_TOKEN);
    const packed = packProject(await planProject(root, {}), new Set(), new Set([".git/config"]));
    expect(gunzipSync(packed.tar).includes(FAKE_TOKEN)).toBe(false);
    const out = extract(packed.tar);
    expect(git(out, "remote", "get-url", "origin").trim()).toBe(BARE_URL);
    expect(git(out, "remote", "get-url", "up").trim()).toBe("https://example.com/team/proj.git");
  });

  it("an Authorization header in http.extraheader is named by the key rule, and the offer is to drop the line", async () => {
    const root = fixture();
    git(root, "config", "http.extraheader", AUTH_HEADER);
    git(root, "config", "http.https://dev.azure.com/.extraheader", AUTH_HEADER);
    const { plan } = await planProject(root, {});
    expect(plan.secrets[1]).toEqual({ path: ".git/config", bytes: statSync(join(root, ".git/config")).size, signals: ["keys"], rewrite: { urls: [], drop: ["http.extraheader", "http.https://dev.azure.com/.extraheader"] } });
    expect(JSON.stringify(plan)).not.toContain("ZmFrZ");
    const packed = packProject(await planProject(root, {}), new Set(), new Set([".git/config"]));
    expect(packed.rewritten).toEqual([".git/config"]);
    expect(gunzipSync(packed.tar).includes("AUTHORIZATION")).toBe(false);
    const out = extract(packed.tar);
    expect(git(out, "config", "--list")).not.toMatch(/extraheader|AUTHORIZATION/i);
    expect(readFileSync(join(root, ".git/config"), "utf8")).toContain(AUTH_HEADER);
    git(root, "remote", "add", "origin", TOKEN_URL);
    const both = (await planProject(root, {})).plan.secrets[1];
    expect(both).toMatchObject({ signals: ["keys", "url"], rewrite: { urls: [BARE_URL], drop: ["http.extraheader", "http.https://dev.azure.com/.extraheader"] } });
  });

  it("every .git/config under the folder is judged: a nested repository's and a submodule's under .git/modules", async () => {
    const root = fixture();
    put(root, ".git/modules/lib/config", `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${TOKEN_URL}\n`);
    mkdirSync(join(root, "vendor/tool"), { recursive: true });
    git(join(root, "vendor/tool"), "init", "-q");
    git(join(root, "vendor/tool"), "remote", "add", "origin", USERNAME_TOKEN_URL);
    const { plan } = await planProject(root, {});
    expect(plan.secrets.map(s => s.path)).toEqual([".env", ".git/modules/lib/config", "config/secrets.json", "keys/id_ed25519", "vendor/tool/.git/config"]);
    expect(plan.secrets[1]).toMatchObject({ signals: ["url"], rewrite: REWRITE });
    expect(plan.secrets[4]).toMatchObject({ signals: ["url"], rewrite: REWRITE });
    expect(JSON.stringify(plan)).not.toContain(FAKE_TOKEN);
    const packed = packProject(await planProject(root, {}), new Set(), new Set([".git/modules/lib/config", "vendor/tool/.git/config"]));
    expect(packed.rewritten).toEqual([".git/modules/lib/config", "vendor/tool/.git/config"]);
    expect(gunzipSync(packed.tar).includes(FAKE_TOKEN)).toBe(false);
    const out = extract(packed.tar);
    expect(git(join(out, "vendor/tool"), "remote", "get-url", "origin").trim()).toBe(BARE_URL);
    expect(readFileSync(join(out, ".git/modules/lib/config"), "utf8")).toContain(`url = ${BARE_URL}`);
  });

  it("an inline credential helper is read by the key-name rule and gets no rewrite; nothing else under .git is judged", async () => {
    const root = fixture();
    git(root, "config", "credential.helper", "!f() { echo password=fakepw; }; f");
    put(root, ".git/info/secrets.json", JSON.stringify({ token: "sk-ant-x" }));
    const { plan } = await planProject(root, {});
    expect(plan.secrets.map(s => s.path)).toEqual([".env", ".git/config", "config/secrets.json", "keys/id_ed25519"]);
    expect(plan.secrets[1]).toEqual({ path: ".git/config", bytes: statSync(join(root, ".git/config")).size, signals: ["keys"] });
    git(root, "config", "credential.helper", `!/usr/local/bin/helper --token=${FAKE_TOKEN}`);
    git(root, "remote", "add", "origin", TOKEN_URL);
    const flagged = (await planProject(root, {})).plan.secrets[1];
    expect(flagged).toEqual({ path: ".git/config", bytes: statSync(join(root, ".git/config")).size, signals: ["keys", "url"] });
  });

  it("a .git/config with a bare remote and a helper by name is not a hit", async () => {
    const root = fixture();
    git(root, "remote", "add", "origin", BARE_URL);
    git(root, "remote", "add", "fork", "git@github.com:example/fork.git");
    git(root, "config", "credential.helper", "osxkeychain");
    const { plan } = await planProject(root, {});
    expect(plan.secrets.map(s => s.path)).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
  });

  it("a folder without a repository travels as files under the same cache rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-plain-"));
    dirs.push(root);
    put(root, "a.txt", "a\n");
    put(root, "dist/b.js", "b\n");
    put(root, "node_modules/c/index.js", "c\n");
    const { plan, files } = await planProject(root, {});
    expect(plan.repo).toBe(false);
    expect(files.map(f => f.rel)).toEqual(["a.txt"]);
    expect(plan.excluded).toEqual(["dist", "node_modules"]);
  });

  it("a .git file is named and left: the repository it points at does not travel", async () => {
    const root = fixture();
    const tree = mkdtempSync(join(tmpdir(), "wsp-wt-"));
    dirs.push(tree);
    rmSync(tree, { recursive: true });
    git(root, "worktree", "add", "-q", tree, "-b", "side");
    const { plan, files } = await planProject(tree, {});
    expect(plan.repo).toBe(true);
    expect(files.map(f => f.rel)).not.toContain(".git");
    expect(plan.skipped).toEqual([{ path: ".git", note: expect.stringMatching(/^a worktree or submodule checkout: its repository is at .*worktrees\/.* and does not travel$/) }]);
    expect(files.map(f => f.rel)).toContain("src/index.ts");
  });

  it("names each agent with sessions for the folder from its home on this computer; a home with none, or none on disk, gives no row", async () => {
    const root = fixture();
    const real = realpathSync(root);
    const homes = mkdtempSync(join(tmpdir(), "wsp-homes-"));
    dirs.push(homes);
    const claude = join(homes, "claude");
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    const line = (id: string): string => `{"type":"user","cwd":"${real}","sessionId":"${id}"}\n`;
    for (const id of ["S1", "S2"]) put(claude, `projects/${key}/${id}.jsonl`, line(id));
    put(claude, `projects/${key}-old/S3.jsonl`, `{"type":"user","cwd":"${real}-old","sessionId":"S3"}\n`);
    const pi = join(homes, "pi");
    mkdirSync(join(pi, "sessions"), { recursive: true });
    const { plan } = await planProject(root, { claude, pi, codex: join(homes, "none") });
    expect(plan.agents).toEqual([{ agent: "claude", name: "Claude Code", sessions: 2, bytes: Buffer.byteLength(line("S1")) + Buffer.byteLength(line("S2")), carry: "moves" }]);
    expect((await planProject(root, {})).plan.agents).toEqual([]);
  });

  it("the catalog homes under a home directory with nothing in it give no row, so a plan never needs the homes on this computer", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-home-"));
    dirs.push(home);
    const { plan } = await planProject(fixture(), agentHomes(home));
    expect(plan.agents).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses a relative path and a path that is not a folder", async () => {
    await expect(planProject("relative/dir", {})).rejects.toThrow(/absolute path/);
    const root = fixture();
    await expect(planProject(join(root, "notes.txt"), {})).rejects.toThrow(/not a folder/);
    await expect(planProject(join(root, "missing"), {})).rejects.toThrow(/not a folder/);
  });

  it("the cache rule is the collector's directory list by exact name: no file, no substring, and CACHE_RULE spells the same list for the guest", () => {
    for (const n of CACHE_DIRS) expect(isCacheDir(n), n).toBe(true);
    for (const n of ["node_modules", ".cache", "__pycache__", ".pytest_cache", ".ruff_cache", ".pnpm-store", "dist", "coverage"]) expect(isCacheDir(n), n).toBe(true);
    for (const n of ["src", "lib", "lruCache.ts", "cache-names.ts", "cached-results.md", "CacheStorage", "my-cache-service", ".eslintcache", ".DS_Store", "Cargo.lock", "yarn.lock", "data.sqlite-wal"]) expect(isCacheDir(n), n).toBe(false);
    expect(CACHE_RULE).toEqual({ dirs: [...CACHE_DIRS], files: [".DS_Store"], markers: ["pyvenv.cfg", ".git"] });
  });

  it("a submodule checkout stays behind on both trips: the local walk and the guest script agree", async () => {
    const root = fixture();
    const lib = mkdtempSync(join(tmpdir(), "wsp-sub-"));
    dirs.push(lib);
    git(lib, "init", "-q");
    put(lib, "lib.ts", "export const lib = 1;\n");
    git(lib, "add", "lib.ts");
    git(lib, "commit", "-q", "-m", "lib");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    git(root, "commit", "-q", "-m", "submodule");
    expect(statSync(join(root, "vendor/lib/.git")).isFile()).toBe(true);
    const { plan, files } = await planProject(root, {});
    expect(plan.excluded).toContain("vendor/lib");
    expect(files.map(f => f.rel)).toContain(".gitmodules");
    expect(files.some(f => f.rel.startsWith("vendor/lib/"))).toBe(false);
    const out = join(root, "..", `${basename(root)}.tgz`);
    dirs.push(out);
    const ran = spawnSync("bash", ["-c", folderExportScript(realpathSync(root), CACHE_RULE, out)], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim().split("\n").sort()).toEqual([...plan.excluded].sort());
  });

  it("the trip home leaves behind what the trip out left behind: the machine-side script under CACHE_RULE names the same cache roots as planProject, and its archive holds the plan's files, tracked files inside a cache root and the outside links being the two differences", async () => {
    const root = fixture();
    const { plan, files } = await planProject(root, {});
    const out = join(root, "..", `${basename(root)}.tgz`);
    dirs.push(out);
    const script = folderExportScript(realpathSync(root), CACHE_RULE, out);
    const ran = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim().split("\n").sort()).toEqual([...plan.excluded].sort());
    const archived = listed(readFileSync(out)).map(l => l.replace(/^\.\//, "").replace(/\/$/, "")).filter(l => l !== "." && l !== "");
    const planned = files.map(f => f.rel).filter(rel => !plan.excluded.some(root => rel === root || rel.startsWith(`${root}/`)));
    expect(archived.sort()).toEqual([...planned, "outside-link", "up-link"].sort());
    for (const name of ["node_modules", "dist", "build", ".cache", "__pycache__", ".mypy_cache"]) expect(isCacheDir(name), name).toBe(true);
    for (const name of ["src", "notes.txt", "data.sqlite-wal", "caching.md", "MyCache", ".eslintcache", ".DS_Store"]) expect(isCacheDir(name), name).toBe(false);
  });

  it("git's own lock files stay behind, named under excluded", async () => {
    const root = fixture();
    put(root, ".git/index.lock", "");
    put(root, ".git/objects/maintenance.lock", "");
    const { plan, files } = await planProject(root, {});
    const rels = files.map(f => f.rel);
    for (const lock of [".git/index.lock", ".git/objects/maintenance.lock"]) {
      expect(rels, lock).not.toContain(lock);
      expect(plan.excluded, lock).toContain(lock);
    }
  });

  it("Finder metadata stays behind at every level; sqlite journals travel", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-finder-"));
    dirs.push(root);
    put(root, ".DS_Store", "finder\n");
    put(root, "src/.DS_Store", "finder\n");
    put(root, "src/a.ts", "a\n");
    put(root, "data.sqlite-wal", "journal\n");
    const { plan, files } = await planProject(root, {});
    expect(files.map(f => f.rel)).toEqual(["data.sqlite-wal", "src", "src/a.ts"]);
    expect(plan.excluded).toEqual([".DS_Store", "src/.DS_Store"]);
  });

  it("a directory the process cannot read is named in skipped and the rest travels", async () => {
    // The plan walks the folder's real path, so the refusal has to name that one.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-locked-")));
    dirs.push(root);
    put(root, "a.txt", "a\n");
    put(root, "locked/hidden.txt", "hidden\n");
    put(root, "z.txt", "z\n");
    const { plan, files } = await withRefused(join(root, "locked"), () => planProject(root, {}));
    expect(files.map(f => f.rel)).toEqual(["a.txt", "locked", "z.txt"]);
    expect(plan.skipped).toEqual([{ path: "locked", note: "cannot be read (EACCES); what it holds does not travel" }]);
    expect(plan.files).toBe(2);
  });
});

describe("packProject", () => {
  it("round-trips every byte, the exec bit, the empty directory and the link; secret-shaped files travel only when named", async () => {
    const root = fixture();
    const listing = await planProject(root, {});
    const packed = packProject(listing, new Set([".env"]), new Set());
    expect(packed.cut).toEqual(["config/secrets.json", "keys/id_ed25519"]);
    expect(packed.rewritten).toEqual([]);
    expect(packed.files).toBe(listing.plan.files - 2);
    const names = listed(packed.tar);
    expect(names).toContain(".env");
    expect(names).not.toContain("config/secrets.json");
    expect(names).not.toContain("keys/id_ed25519");
    expect(names).toContain("keys/id_ed25519.pub");
    const out = extract(packed.tar);
    expect(readFileSync(join(out, "bin/run.sh")).equals(BINARY)).toBe(true);
    expect(statSync(join(out, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, "data.sqlite")).equals(readFileSync(join(root, "data.sqlite")))).toBe(true);
    expect(statSync(join(out, "really-empty")).isDirectory()).toBe(true);
    expect(lstatSync(join(out, "inside-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out, "inside-link"))).toBe("src/index.ts");
    expect(existsSync(join(out, "node_modules"))).toBe(false);
    const status = (dir: string): string[] => git(dir, "status", "--porcelain").split("\n").filter(l => l !== "").sort();
    expect(status(out)).toEqual(status(root).filter(l => !/outside-link|up-link/.test(l)));
    expect(status(out)).toContain("?? .env.example");
    expect(git(out, "log", "--format=%H")).toBe(git(root, "log", "--format=%H"));
  });

  it("with nothing named every secret-shaped file is cut", async () => {
    const listing = await planProject(fixture(), {});
    const packed = packProject(listing, new Set(), new Set());
    expect(packed.cut).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
    expect(listed(packed.tar)).not.toContain(".env");
  });

  it("an accepted rewrite lands .git/config with the bare URL and the token nowhere in the archive; the file on this computer is untouched", async () => {
    const root = fixture();
    git(root, "remote", "add", "origin", TOKEN_URL);
    const listing = await planProject(root, {});
    const rewritten = packProject(listing, new Set(), new Set([".git/config"]));
    expect(rewritten.rewritten).toEqual([".git/config"]);
    expect(rewritten.cut).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
    expect(rewritten.files).toBe(listing.plan.files - 3);
    expect(gunzipSync(rewritten.tar).includes(FAKE_TOKEN)).toBe(false);
    expect(git(extract(rewritten.tar), "remote", "get-url", "origin").trim()).toBe(BARE_URL);
    expect(readFileSync(join(root, ".git/config"), "utf8")).toContain(TOKEN_URL);
    const cut = packProject(listing, new Set(), new Set());
    expect(cut.cut).toEqual([".env", ".git/config", "config/secrets.json", "keys/id_ed25519"]);
    expect(listed(cut.tar)).not.toContain(".git/config");
    const carried = packProject(listing, new Set([".git/config"]), new Set());
    expect(carried.rewritten).toEqual([]);
    expect(git(extract(carried.tar), "remote", "get-url", "origin").trim()).toBe(TOKEN_URL);
    const both = packProject(listing, new Set([".git/config"]), new Set([".git/config"]));
    expect(both.rewritten).toEqual([".git/config"]);
    expect(gunzipSync(both.tar).includes(FAKE_TOKEN)).toBe(false);
    const noOffer = packProject(listing, new Set(), new Set([".env"]));
    expect(noOffer.rewritten).toEqual([]);
    expect(noOffer.cut).toContain(".env");
  });
});

describe("projectBundler", () => {
  it("plans once and packs from that plan with the consent given", async () => {
    const root = fixture();
    const b = projectBundler(root, {});
    const plan = await b.plan();
    expect(plan.secrets.map(s => s.path)).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
    expect(await b.plan()).toBe(plan);
    const packed = await b.pack(new Set([".env"]), new Set());
    expect(packed.cut).toEqual(["config/secrets.json", "keys/id_ed25519"]);
    expect(packed.files).toBe(plan.files - 2);
    const names = listed(packed.tar);
    expect(names).toContain(".env");
    expect(names).not.toContain("config/secrets.json");
  });
});

describe("packState", () => {
  const session = (id: string, cwd: string): string => `{"type":"user","cwd":"${cwd}","sessionId":"${id}"}\n`;
  const piSession = (cwd: string): string => `{"type":"session","cwd":"${cwd}"}\n`;
  /** Every regular file under dir by relative path with its text. */
  const snapshot = (dir: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => [relative(dir, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
    );

  /** Homes on this computer: Claude Code with a session, its tool results and memory for the folder plus a session
   * for another project and its prompt history; Pi with one session for the folder. */
  function homes(real: string): { dir: string; claude: string; pi: string; key: string; piKey: string } {
    const dir = mkdtempSync(join(tmpdir(), "wsp-homes-"));
    dirs.push(dir);
    const claude = join(dir, "claude");
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    put(claude, `projects/${key}/S1.jsonl`, session("S1", real));
    put(claude, `projects/${key}/S1/tool-results/t1.txt`, "out\n");
    put(claude, `projects/${key}/memory/MEMORY.md`, "notes\n");
    put(claude, "projects/-Users-me-other/S2.jsonl", session("S2", "/Users/me/other"));
    put(claude, "history.jsonl", `{"display":"hi","project":"${real}"}\n`);
    const pi = join(dir, "pi");
    const piKey = `--${real.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
    put(pi, `sessions/${piKey}/2026-09-05T21-56-00-000Z_s1.jsonl`, piSession(real));
    return { dir, claude, pi, key, piKey };
  }

  it("copies each named agent's state for the folder to its machine home, re-keyed to dest when the agent is on the machine and as it was when not; another project, the shared files and an agent not named stay out; the homes here are untouched", async () => {
    const root = fixture();
    const real = realpathSync(root);
    const h = homes(real);
    const before = { claude: snapshot(h.claude), pi: snapshot(h.pi) };
    const b = projectBundler(root, { claude: h.claude, pi: h.pi, codex: join(h.dir, "codex") });
    const packed = await b.packState({ dest: "/root/work/proj", agents: [{ agent: "claude", home: "/root/.claude-cfg", present: true }, { agent: "pi", home: "/root/.pi/agent", present: false }] });
    const moved = session("S1", "/root/work/proj");
    expect(packed.agents).toEqual([
      { agent: "claude", files: 3, bytes: Buffer.byteLength(moved) + 4 + 6, outcome: "moved" },
      { agent: "pi", files: 1, bytes: Buffer.byteLength(piSession(real)), outcome: "carried" },
    ]);
    expect(packed.merges).toEqual([]);
    expect(listed(packed.tar)).toEqual([
      "root/.claude-cfg/projects/-root-work-proj/S1.jsonl",
      "root/.claude-cfg/projects/-root-work-proj/S1/tool-results/t1.txt",
      "root/.claude-cfg/projects/-root-work-proj/memory/MEMORY.md",
      `root/.pi/agent/sessions/${h.piKey}/2026-09-05T21-56-00-000Z_s1.jsonl`,
    ]);
    const out = extract(packed.tar);
    expect(readFileSync(join(out, "root/.claude-cfg/projects/-root-work-proj/S1.jsonl"), "utf8")).toBe(moved);
    expect(readFileSync(join(out, `root/.pi/agent/sessions/${h.piKey}/2026-09-05T21-56-00-000Z_s1.jsonl`), "utf8")).toBe(piSession(real));
    expect(snapshot(h.claude)).toEqual(before.claude);
    expect(snapshot(h.pi)).toEqual(before.pi);
  });

  it("an agent whose state is rows alone lands nothing and says so; a move that raises leaves that agent out of the archive and carries the error", async () => {
    const root = fixture();
    const real = realpathSync(root);
    const h = homes(real);
    // A session for a folder inside the project whose key is the destination's own: the root's move finds it in the way.
    put(h.claude, `projects/${h.key}-inner/S9.jsonl`, session("S9", `${real}/inner`));
    const hermes = join(h.dir, "hermes");
    mkdirSync(hermes);
    const b = projectBundler(root, { claude: h.claude, pi: h.pi, hermes });
    const packed = await b.packState({
      dest: `${real}/inner`,
      agents: [{ agent: "claude", home: "/root/.claude-cfg", present: true }, { agent: "hermes", home: "/root/.hermes", present: true }, { agent: "pi", home: "/root/.pi/agent", present: true }],
    });
    expect(packed.agents).toEqual([
      { agent: "claude", files: 0, bytes: 0, outcome: "failed", error: expect.stringMatching(/already exists$/) },
      { agent: "hermes", files: 0, bytes: 0, outcome: "nothing" },
      { agent: "pi", files: 1, bytes: Buffer.byteLength(piSession(`${real}/inner`)), outcome: "moved" },
    ]);
    const key = `${h.piKey.slice(0, -2)}-inner--`;
    expect(listed(packed.tar)).toEqual([`root/.pi/agent/sessions/${key}/2026-09-05T21-56-00-000Z_s1.jsonl`]);
    expect(readFileSync(join(extract(packed.tar), `root/.pi/agent/sessions/${key}/2026-09-05T21-56-00-000Z_s1.jsonl`), "utf8")).toBe(piSession(`${real}/inner`));
    expect(existsSync(join(h.claude, "projects", h.key, "S1.jsonl"))).toBe(true);
  });

  it("an agent on the machine whose rows sit in a shared store gets its module's merge script in the archive under the guest's /tmp; rows alone are transcript-only with a script and no file; an absent agent's rows wait with no script; a store that cannot be read fails that agent alone", async () => {
    const root = fixture();
    const real = realpathSync(root);
    const h = homes(real);
    const hermes = join(h.dir, "hermes");
    mkdirSync(hermes);
    const db = new DatabaseSync(join(hermes, "state.db"));
    db.exec("create table sessions (id text primary key, cwd text, git_repo_root text); create table messages (id integer primary key, session_id text, content text)");
    db.prepare("insert into sessions values ('s1', ?, ?)").run(real, real);
    db.prepare("insert into sessions values ('s2', '/Users/me/other', null)").run();
    db.prepare("insert into messages values (1, 's1', 'hi')").run();
    db.close();
    const opencode = join(h.dir, "opencode");
    put(opencode, "opencode.db", "not a database\n");
    const b = projectBundler(root, { claude: h.claude, hermes, opencode });
    const packed = await b.packState({
      dest: "/root/work/proj",
      agents: [{ agent: "claude", home: "/root/.claude-cfg", present: true }, { agent: "hermes", home: "/root/.hermes", present: true }, { agent: "opencode", home: "/root/.local/share/opencode", present: true }],
    });
    expect(packed.agents).toEqual([
      { agent: "claude", files: 3, bytes: expect.any(Number), outcome: "moved" },
      { agent: "hermes", files: 0, bytes: 0, outcome: "transcript-only" },
      { agent: "opencode", files: 0, bytes: 0, outcome: "failed", error: expect.stringMatching(/not a database/) },
    ]);
    const dir = /^\/tmp\/wsp-merge-[0-9a-f]{8}$/;
    expect(packed.merges).toEqual([{ agent: "hermes", script: expect.stringMatching(/^\/tmp\/wsp-merge-[0-9a-f]{8}\/hermes\.py$/) }]);
    const script = packed.merges[0]!.script;
    expect(script.slice(0, script.lastIndexOf("/"))).toMatch(dir);
    expect(listed(packed.tar)).toEqual([
      "root/.claude-cfg/projects/-root-work-proj/S1.jsonl",
      "root/.claude-cfg/projects/-root-work-proj/S1/tool-results/t1.txt",
      "root/.claude-cfg/projects/-root-work-proj/memory/MEMORY.md",
      script.slice(1),
    ]);
    const out = extract(packed.tar);
    expect(readFileSync(join(out, script), "utf8")).toBe(await PROJECT_STATE_RESOLVERS.get("hermes")!.merge!(hermes, real, "/root/work/proj", "/root/.hermes"));
    expect(statSync(join(out, script)).mode & 0o777).toBe(0o600);
    const away = await b.packState({ dest: "/root/work/proj", agents: [{ agent: "hermes", home: "/root/.hermes", present: false }] });
    expect(away.agents).toEqual([{ agent: "hermes", files: 0, bytes: 0, outcome: "nothing" }]);
    expect(away.merges).toEqual([]);
    expect(listed(away.tar)).toEqual([]);
  });

  it("an agent whose rows stay behind lands its transcripts as they were and says transcript-only even when it is on the machine; an absent agent with no file for the folder says nothing", async () => {
    const root = fixture();
    const real = realpathSync(root);
    const h = homes(real);
    const codex = join(h.dir, "codex");
    const rollout = join(codex, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    const meta = `{"timestamp":"2026-09-05T21:58:00.000Z","type":"session_meta","payload":{"id":"t1","cwd":"${real}","originator":"codex_exec"}}\n`;
    put(codex, relative(codex, rollout), meta);
    const db = new DatabaseSync(join(codex, "state_5.sqlite"));
    db.exec("create table threads (id text primary key, rollout_path text not null, cwd text not null, archived integer not null default 0, updated_at integer not null default 0)");
    db.prepare("insert into threads values (?, ?, ?, 0, 1)").run("t1", rollout, real);
    db.close();
    const gemini = join(h.dir, "gemini");
    mkdirSync(gemini);
    const b = projectBundler(root, { codex, gemini });
    const packed = await b.packState({ dest: "/root/work/proj", agents: [{ agent: "codex", home: "/root/.codex", present: true }, { agent: "gemini", home: "/root/.gemini", present: false }] });
    expect(packed.agents).toEqual([
      { agent: "codex", files: 1, bytes: Buffer.byteLength(meta), outcome: "transcript-only" },
      { agent: "gemini", files: 0, bytes: 0, outcome: "nothing" },
    ]);
    expect(packed.merges).toEqual([{ agent: "codex", script: expect.stringMatching(/^\/tmp\/wsp-merge-[0-9a-f]{8}\/codex\.py$/) }]);
    const script = packed.merges[0]!.script;
    expect(listed(packed.tar)).toEqual(["root/.codex/sessions/2026/09/05/rollout-2026-09-05T21-58-00-t1.jsonl", script.slice(1)]);
    const out = extract(packed.tar);
    expect(readFileSync(join(out, "root/.codex/sessions/2026/09/05/rollout-2026-09-05T21-58-00-t1.jsonl"), "utf8")).toBe(meta);
    expect(readFileSync(join(out, script), "utf8")).toBe(await PROJECT_STATE_RESOLVERS.get("codex")!.merge!(codex, real, "/root/work/proj", "/root/.codex"));
  });
});
