// SPDX-License-Identifier: AGPL-3.0-only
// A project folder on this computer, read for the trip to a workspace: the tracked tree, the state beside it
// that is not a cache, and the repository whole. A cache is recreated on the machine, never carried.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CACHE_DIRS, FINDER_METADATA, bareUrls, fileSignals, keysSignal } from "@wsp/collect";
import { PROJECT_STATE_RESOLVERS, TAR_MAX_FILE_BYTES, countProjectState, filesUnder, fitsTar, moveProjectState, resolveProjectPath, tarOf, underProject, type AgentMoveReport, type CacheRule, type TarEntry } from "@wsp/engine";
import { CredentialSignal, type ProjectAgentOutcome, type ProjectAgentResult, type ProjectCarry, type ProjectPlan, type ProjectRewrite, type ProjectSecret } from "@wsp/protocol";
import type { PackedProject, PackedState, ProjectBundler, StateRequest } from "@wsp/runtime";

/** A virtual environment goes by any name; this file inside it says what it is. */
const VENV_MARKER = "pyvenv.cfg";
const GIT_DIR = ".git";
/** What git names the file it holds while one command writes: index.lock, HEAD.lock, packed-refs.lock, a ref's, maintenance's. */
const GIT_LOCK = ".lock";
/** The one file judged under a .git directory, the repository's own and each submodule's under .git/modules: remote
 * URLs, credential helpers and http headers live here, and a nested repository's .git travels whole like the root one. */
const GIT_CONFIG = /(^|\/)\.git(\/modules\/[^/]+)*\/config$/;
/** An inline credential helper is a shell command, quoted by git when it holds a semicolon; its words are read as
 * KEY=value lines by the collector's key-name rule, a `--token=` flag as the key `token`. */
const INLINE_HELPER = /^\s*helper\s*=\s*"?!(.*)$/gm;
/** In a repository config any userinfo on an http(s) URL is auth material (GitHub's documented `https://TOKEN@host`
 * form); the home scan keeps treating a lone username as a name. */
const HTTP_USERINFO = /\b(https?:\/\/)[^\s/@"']+@([^\s"']+)/gi;
/** `[http]` or `[http "https://host/"]`, the prefix git gives the keys under it. */
const SECTION = /^\s*\[([^\s"\]]+)(?:\s+"([^"]*)")?\s*\]/;
/** An extraheader carrying an Authorization header is a token with no bare form: the line is dropped whole. */
const AUTH_HEADER = /^\s*extraheader\s*=\s*"?authorization\s*:/i;
const LS_FILES_MAX_BYTES = 256 * 1024 * 1024;

/** The cache rule for a directory: its whole name is on the collector's list. A file is never a cache by name. */
export function isCacheDir(name: string): boolean {
  return CACHE_DIRS.has(name);
}

/** A directory holding a .git file is a worktree or submodule checkout whose repository lives elsewhere; it is
 * recreated from that repository, so it stays behind like a cache on both trips, tracked (a submodule) or not, as
 * the guest's find cannot ask git. The folder's own root is judged apart, since a root .git file is the folder being
 * one such checkout. */
function holdsGitFile(dir: string): boolean {
  try {
    return statSync(join(dir, GIT_DIR)).isFile();
  } catch {
    return false;
  }
}

/** A folder git tracks, by the marker at its top: a .git directory, or the .git file a worktree or submodule
 * checkout carries. One stat, so a picker can mark a whole level without running git once per folder. */
export function isRepoFolder(dir: string): boolean {
  return existsSync(join(dir, GIT_DIR));
}

/** The same rule as find spells it, for the archive a machine packs on the trip home and for the nap-time vault: the
 * directory list by name, the Finder file by name, and the venv and checkout markers for a directory under any name. */
export const CACHE_RULE: CacheRule = {
  dirs: [...CACHE_DIRS],
  files: [FINDER_METADATA],
  markers: [VENV_MARKER, GIT_DIR],
};

interface BundlePath {
  /** Relative to the folder, slash-separated: the path in the archive. */
  rel: string;
  abs: string;
}
export type BundleFile = BundlePath &
  (
    | {
        kind: "file";
        mode: number;
        bytes: number;
        /** Secret-shaped by the collector's credential rules, which read untracked and ignored files only; travels only when named. */
        secret: boolean;
      }
    | { kind: "dir"; mode: number }
    | {
        kind: "link";
        /** The target as written, never followed. */
        target: string;
      }
  );

export interface ProjectListing {
  plan: ProjectPlan;
  files: BundleFile[];
}

async function trackedPaths(source: string): Promise<Set<string>> {
  const out = await new Promise<string>((res, rej) => {
    execFile("git", ["-C", source, "ls-files", "-z"], { maxBuffer: LS_FILES_MAX_BYTES }, (err, stdout, stderr) => {
      if (err) rej(new Error(`git ls-files failed in ${source}: ${String(stderr).trim() || err.message}`));
      else res(stdout);
    });
  });
  return new Set(out.split("\0").filter(p => p !== ""));
}

/** Every directory that holds a tracked path, so a cache-named directory git tracks part of is entered for those. */
function ancestors(paths: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) for (let cut = p.lastIndexOf("/"); cut > 0; cut = p.lastIndexOf("/", cut - 1)) dirs.add(p.slice(0, cut));
  return dirs;
}

interface Walk {
  source: string;
  tracked: ReadonlySet<string>;
  trackedDirs: ReadonlySet<string>;
  files: BundleFile[];
  secrets: ProjectSecret[];
  /** The files and the directories left behind, by relative path: the caches, the Finder's metadata, git's locks. */
  excluded: string[];
  skipped: { path: string; note: string }[];
  scans: Promise<void>[];
}

const codeOf = (e: unknown): string => (e as { code?: string }).code ?? "error";

const bySignalOrder = (a: CredentialSignal, b: CredentialSignal): number => CredentialSignal.options.indexOf(a) - CredentialSignal.options.indexOf(b);

/** A repository config as it would land: every http(s) userinfo and every other URL password removed, every
 * Authorization extraheader line dropped, and what that took out named for the person. */
function rewriteGitConfig(text: string): { text: string; rewrite: ProjectRewrite } {
  const urls: string[] = [];
  const http = text.replace(HTTP_USERINFO, (_, scheme: string, rest: string) => {
    urls.push(`${scheme}${rest}`);
    return `${scheme}${rest}`;
  });
  const bare = bareUrls(http);
  urls.push(...bare.urls);
  const drop: string[] = [];
  let section = "";
  const kept = bare.text.split("\n").filter(line => {
    const s = SECTION.exec(line);
    if (s !== null) {
      section = s[2] === undefined ? (s[1] ?? "") : `${s[1]}.${s[2]}`;
      return true;
    }
    if (!AUTH_HEADER.test(line)) return true;
    const key = `${section}.extraheader`;
    if (!drop.includes(key)) drop.push(key);
    return false;
  });
  return { text: kept.join("\n"), rewrite: { urls, drop } };
}

/** The repository's config under the collector's rules plus the bundle's reading of it: the url rule and http userinfo
 * over the whole file, the key-name rule over inline helpers and Authorization headers. The rewrite is offered when
 * it removes every secret shape found: a helper or a key elsewhere that holds a secret has no bare form. */
async function gitConfigSecret(path: string, st: { size: number; mode: number }, read: () => Promise<string | undefined>): Promise<ProjectSecret | undefined> {
  const text = await read();
  if (text === undefined) return undefined;
  const shared = (await fileSignals("config", { bytes: st.size, mode: st.mode }, async () => text, false)) ?? [];
  const helper = [...text.matchAll(INLINE_HELPER)].some(m => keysSignal((m[1] ?? "").split(/\s+/).map(w => w.replace(/^-+/, "")).join("\n")));
  const { rewrite } = rewriteGitConfig(text);
  const signals = [...shared];
  if (rewrite.urls.length > 0 && !signals.includes("url")) signals.push("url");
  if ((helper || rewrite.drop.length > 0) && !signals.includes("keys")) signals.push("keys");
  if (signals.length === 0) return undefined;
  signals.sort(bySignalOrder);
  const offered = (rewrite.urls.length > 0 || rewrite.drop.length > 0) && !helper && !shared.some(s => s === "keys" || s === "pem");
  return { path, bytes: st.size, signals, ...(offered ? { rewrite } : {}) };
}

/** One directory level. The secret scan skips a tracked file and, under .git, judges only a repository config; under a cache-named directory only tracked paths are kept.
 * A directory or entry the process cannot read is named in skipped and the walk goes on; only the folder itself throws. */
function walk(w: Walk, dir: string, relDir: string, inGit: boolean, onlyTracked: boolean): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    if (relDir === "") throw e;
    w.skipped.push({ path: relDir, note: `cannot be read (${codeOf(e)}); what it holds does not travel` });
    return;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const rel = relDir === "" ? name : `${relDir}/${name}`;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch (e) {
      w.skipped.push({ path: rel, note: `cannot be read (${codeOf(e)})` });
      continue;
    }
    const mode = st.mode & 0o7777;
    const isTracked = w.tracked.has(rel);
    if (onlyTracked && !isTracked && !w.trackedDirs.has(rel)) continue;
    if (rel === GIT_DIR && st.isFile()) {
      w.skipped.push({ path: rel, note: `a worktree or submodule checkout: its repository is at ${readFileSync(abs, "utf8").trim().replace(/^gitdir: /, "")} and does not travel` });
      continue;
    }
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs);
      if (isAbsolute(target) || !underProject(resolve(dirname(abs), target), w.source)) w.skipped.push({ path: rel, note: `a link to ${target}, outside the folder; not followed` });
      else if (!fitsTar(rel, target)) w.skipped.push({ path: rel, note: "a link the archive cannot hold: the path or the target is too long" });
      else w.files.push({ rel, abs, kind: "link", target });
      continue;
    }
    if (st.isDirectory()) {
      const git = inGit || name === GIT_DIR;
      const cache = !git && ((!isTracked && (isCacheDir(name) || existsSync(join(abs, VENV_MARKER)))) || holdsGitFile(abs));
      if (cache) {
        w.excluded.push(rel);
        if (!w.trackedDirs.has(rel)) continue;
      }
      if (!fitsTar(rel)) {
        w.skipped.push({ path: rel, note: "a path too long for the archive" });
        continue;
      }
      w.files.push({ rel, abs, kind: "dir", mode });
      walk(w, abs, rel, git, onlyTracked || cache);
      continue;
    }
    if (!st.isFile()) {
      w.skipped.push({ path: rel, note: "not a regular file" });
      continue;
    }
    if (!inGit && !isTracked && name === FINDER_METADATA) {
      w.excluded.push(rel);
      continue;
    }
    // A lock is one git command's own moment on this computer; carried, it is a repository that refuses to open.
    if (inGit && name.endsWith(GIT_LOCK)) {
      w.excluded.push(rel);
      continue;
    }
    if (st.size > TAR_MAX_FILE_BYTES) {
      w.skipped.push({ path: rel, note: "over 8 GB, more than a tar header holds" });
      continue;
    }
    if (!fitsTar(rel)) {
      w.skipped.push({ path: rel, note: "a path too long for the archive" });
      continue;
    }
    const file: BundleFile = { rel, abs, kind: "file", mode, bytes: st.size, secret: false };
    w.files.push(file);
    // A tracked file's content is in the repository, which travels whole, so cutting the working copy protects nothing.
    if (isTracked) continue;
    const gitConfig = GIT_CONFIG.test(rel);
    if (inGit && !gitConfig) continue;
    const read = async (): Promise<string | undefined> => {
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return undefined;
      }
    };
    const scan = gitConfig ? gitConfigSecret(rel, st, read) : fileSignals(name, { bytes: st.size, mode: st.mode }, read, false).then(signals => signals && { path: rel, bytes: st.size, signals });
    w.scans.push(
      scan.then(secret => {
        if (secret === undefined) return;
        file.secret = true;
        w.secrets.push(secret);
      }),
    );
  }
}

/** What an import of the folder would carry. Names and sizes are read, file bodies only for the secret scan of small
 * structured files; a .git file (a worktree or a submodule checkout) is named and left, since its repository lives
 * elsewhere. The agents with sessions for the folder are counted in `homes`, each agent's home by catalog id, which
 * the caller names so a test never opens the homes on this computer. Throws when the folder is not an absolute path
 * to a directory. */
export async function planProject(source: string, homes: Readonly<Record<string, string>>): Promise<ProjectListing> {
  if (!isAbsolute(source)) throw new Error(`the folder must be an absolute path, got ${source}`);
  const root = resolveProjectPath(source);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a folder on this computer`);
  const repo = isRepoFolder(root);
  const tracked = repo ? await trackedPaths(root) : new Set<string>();
  const w: Walk = { source: root, tracked, trackedDirs: ancestors(tracked), files: [], secrets: [], excluded: [], skipped: [], scans: [] };
  walk(w, root, "", false, false);
  await Promise.all(w.scans);
  w.secrets.sort((a, b) => (a.path < b.path ? -1 : 1));
  const regular = w.files.filter((f): f is BundleFile & { kind: "file" } => f.kind === "file");
  const plan: ProjectPlan = {
    source: root,
    repo,
    files: regular.length,
    bytes: regular.reduce((n, f) => n + f.bytes, 0),
    secrets: w.secrets,
    excluded: w.excluded,
    skipped: w.skipped,
    agents: await countProjectState(root, homes),
  };
  return { plan, files: w.files };
}

/** The gzipped archive of a listing, every entry at its path relative to the folder with its mode; a secret-shaped
 * file travels only when `carry` names its path, or rewritten as the plan offered when `rewrite` names a path the plan
 * offered that for. Bytes are read now, so a file that changed since the plan travels as it is at this moment; the
 * file on this computer is never written. */
export function packProject(listing: ProjectListing, carry: ReadonlySet<string>, rewrite: ReadonlySet<string>): PackedProject {
  const offered = new Set(listing.plan.secrets.filter(s => s.rewrite !== undefined).map(s => s.path));
  const entries: TarEntry[] = [];
  const cut: string[] = [];
  const rewritten: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const f of listing.files) {
    if (f.kind === "dir") {
      entries.push({ path: f.rel, mode: f.mode, dir: true });
      continue;
    }
    if (f.kind === "link") {
      entries.push({ path: f.rel, target: f.target });
      continue;
    }
    const rewriting = f.secret && offered.has(f.rel) && rewrite.has(f.rel);
    if (f.secret && !rewriting && !carry.has(f.rel)) {
      cut.push(f.rel);
      continue;
    }
    const content = rewriting ? Buffer.from(rewriteGitConfig(readFileSync(f.abs, "utf8")).text) : readFileSync(f.abs);
    if (rewriting) rewritten.push(f.rel);
    entries.push({ path: f.rel, mode: f.mode, content });
    files += 1;
    bytes += content.length;
  }
  return { tar: tarOf(entries), files, bytes, cut, rewritten };
}

/** One agent's outcome from what travelled and what its module did with it: files the module re-keyed are moved only
 * when its carry says they hold every key; otherwise the rows that list them are still to be merged on the machine
 * and it is transcript-only until the merge there has run. */
export function outcomeOf(files: number, present: boolean, carry: ProjectCarry | undefined, report: AgentMoveReport | undefined, merging = false): ProjectAgentOutcome {
  if (report?.outcome === "failed") return "failed";
  if (files === 0 && !merging) return "nothing";
  if (!present) return "carried";
  return report?.outcome === "moved" && carry === "moves" ? "moved" : "transcript-only";
}

/** Each named agent's state for the folder, copied out of its home on this computer into a home of its own under a
 * scratch directory, re-keyed there to the destination for the agents on the machine, and archived at the agent's
 * machine home for the guest's root; beside them, for each agent on the machine whose rows sit in a shared store, the
 * merge script its module emits, at a scratch path under the guest's /tmp. The homes on this computer are read, never
 * written; an agent whose move or merge raises lands nothing and carries the error. */
export async function packState(root: string, homes: Readonly<Record<string, string>>, req: StateRequest): Promise<PackedState> {
  const scratch = mkdtempSync(join(tmpdir(), "wsp-state-"));
  try {
    const skeletons: Record<string, string> = {};
    for (const { agent } of req.agents) {
      const resolver = PROJECT_STATE_RESOLVERS.get(agent);
      const home = homes[agent];
      if (resolver === undefined || home === undefined || !existsSync(home)) continue;
      const skeleton = join(scratch, agent);
      for (const file of await resolver.entries(home, root)) {
        const copy = join(skeleton, relative(home, file));
        mkdirSync(dirname(copy), { recursive: true });
        copyFileSync(file, copy);
      }
      skeletons[agent] = skeleton;
    }
    const present = req.agents.filter(a => a.present).map(a => ({ id: a.agent }));
    const reports = new Map((await moveProjectState({ from: root, to: req.dest, homes: skeletons }, present)).map(r => [r.agent, r]));
    const entries: TarEntry[] = [];
    const agents: ProjectAgentResult[] = [];
    const merges: PackedState["merges"] = [];
    const mergeDir = `/tmp/wsp-merge-${randomBytes(4).toString("hex")}`;
    for (const { agent, home, present } of req.agents) {
      const resolver = PROJECT_STATE_RESOLVERS.get(agent);
      let report = reports.get(agent);
      const here = homes[agent];
      let script: string | undefined;
      if (present && report?.outcome !== "failed" && resolver?.merge !== undefined && here !== undefined && existsSync(here)) {
        try {
          script = await resolver.merge(here, root, req.dest, home);
        } catch (e) {
          report = { agent, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
        }
      }
      const skeleton = skeletons[agent];
      const files = skeleton === undefined || report?.outcome === "failed" ? [] : filesUnder(skeleton, "").map(f => ({ abs: f, rel: relative(skeleton, f) }));
      let bytes = 0;
      for (const f of files) {
        const content = readFileSync(f.abs);
        entries.push({ path: `${home}/${f.rel}`, mode: statSync(f.abs).mode & 0o7777, content });
        bytes += content.length;
      }
      if (script !== undefined) {
        const path = `${mergeDir}/${agent}.py`;
        entries.push({ path, mode: 0o600, content: script });
        merges.push({ agent, script: path });
      }
      const outcome = outcomeOf(files.length, present, resolver?.carry, report, script !== undefined);
      agents.push({ agent, files: files.length, bytes, outcome, ...(report?.outcome === "failed" ? { error: report.error } : {}) });
    }
    return { tar: tarOf(entries), agents, merges };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The folder as the runtime's project.import op reads it: planned once, packed when consent is known; `homes` is
 * each agent's home by catalog id, the production caller's under the real home directory. */
export function projectBundler(source: string, homes: Readonly<Record<string, string>>): ProjectBundler {
  let listing: Promise<ProjectListing> | undefined;
  const listed = (): Promise<ProjectListing> => (listing ??= planProject(source, homes));
  return {
    plan: async () => (await listed()).plan,
    pack: async (carry, rewrite) => packProject(await listed(), carry, rewrite),
    packState: async req => packState((await listed()).plan.source, homes, req),
  };
}
