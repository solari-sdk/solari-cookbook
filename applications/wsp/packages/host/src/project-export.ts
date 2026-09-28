// SPDX-License-Identifier: AGPL-3.0-only
// The bundle's trip home, this computer's side: the folder's archive off the machine lands beside its destination
// and moves into place in one rename, and the agents' state that came with it is keyed to that destination in a
// scratch copy of their homes, then laid over the real homes here. The homes here only gain files.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { PROJECT_STATE_RESOLVERS, countProjectState, destExists, insideFolder, moveProjectState, type UnreadStore } from "@wsp/engine";
import { stateEntryRefusal, storeUnreadLine, type ProjectAgentResult } from "@wsp/protocol";
import type { LandRequest, LandedAgent, LandedProject, ProjectLander } from "@wsp/runtime";
import { CACHE_RULE, outcomeOf } from "./project-bundle.js";

/** A destination is spelled out in full; the wire and the MCP tool carry it as the caller wrote it, so a trailing
 * slash or a dot segment is dropped here before the path names a staging directory or a state key. */
function destination(dest: string): string {
  if (!isAbsolute(dest)) throw new Error(`the destination must be an absolute path, got ${dest}`);
  return resolve(dest);
}

/** Every regular file under a path, or the path itself when it is one. */
function filesAt(path: string): { files: number; bytes: number } | undefined {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(path, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    files++;
    bytes += statSync(join(e.parentPath, e.name)).size;
  }
  return { files, bytes };
}

/** Extracts a gzipped archive on disk into dir with this computer's tar; the archive is read from its file, never
 * held in memory, so a whole project's history costs one temp file and no heap. */
function extract(archive: string, dir: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("tar", ["-xzf", archive, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", fail);
    child.on("close", code => (code === 0 ? done() : fail(new Error(`extracting the archive into ${dir} failed (exit ${code}): ${stderr.trim().slice(-500)}`))));
  });
}

/** What an entry of the archive is, for the sentence that refuses it. */
function entryWord(st: Stats): string {
  if (st.isSymbolicLink()) return "a link";
  if (st.isFIFO()) return "a fifo";
  if (st.isSocket()) return "a socket";
  if (st.isBlockDevice() || st.isCharacterDevice()) return "a device";
  return "neither a folder nor a regular file";
}

/** Whether a real path sits at `root` or under it. Both sides come through realpath, so the answer does not turn on
 * which name a folder was reached by. */
const under = (real: string, root: string): boolean => real === root || real.startsWith(`${root}${sep}`);

/** Every entry the state archive put in the scratch folder, refused whole where any of it is neither a folder nor a
 * regular file. The archive's bytes are a machine's and a link, a fifo or a device in it is a road out of the folder
 * it was opened in for every resolver that runs after, so nothing of it lands rather than the entry being skipped.
 * A hard link entry reads as a regular file here and needs no rule of its own: measured on this computer's bsdtar
 * 3.5.3 (libarchive 3.7.4), a hard link whose target carries `..` is refused outright (`Path contains '..'`, exit
 * 1, so `extract` throws before this runs) and one whose target is absolute loses its leading slash and then names
 * nothing that exists (exit 1 as well); a hard link to a file inside the archive lands as a second name for it,
 * under the folder. */
function refuseUnlandableEntries(scratch: string): void {
  const stack = [scratch];
  while (stack.length > 0) {
    for (const e of readdirSync(stack.pop()!, { withFileTypes: true })) {
      const at = join(e.parentPath, e.name);
      const st = lstatSync(at);
      if (st.isDirectory()) stack.push(at);
      else if (!st.isFile()) throw new Error(stateEntryRefusal(relative(scratch, at), entryWord(st)));
    }
  }
}

/** The agents' state, keyed on the machine to `source`, brought into the homes here keyed to `target`, the real path
 * the folder will have: the archive is opened in a scratch directory, each agent's home there is a skeleton holding
 * what its listing named on the machine alone, the move runs in the skeleton, and the files its module then names for
 * the target are copied over the home here, one by one. A row that lives in a shared store here (an index, a
 * registry) is not written, so that agent is transcript-only. */
async function landState(state: NonNullable<LandRequest["state"]>, source: string, target: string, homes: Readonly<Record<string, string>>): Promise<LandedAgent[]> {
  const scratch = mkdtempSync(join(tmpdir(), "wsp-home-"));
  try {
    await extract(state.archive, scratch);
    refuseUnlandableEntries(scratch);
    const root = realpathSync(scratch);
    // Each expected home is held under the folder the archive was opened in by its real path before a resolver is
    // pointed at it, and a home that is not fails its own agent's row while the others land.
    const unheld = new Map<string, string>();
    const skeletons: Record<string, string> = {};
    for (const [agent, home] of Object.entries(state.homes)) {
      const at = join(scratch, home);
      if (!existsSync(at)) continue;
      if (under(realpathSync(at), root)) skeletons[agent] = at;
      else unheld.set(agent, stateEntryRefusal(home, "a path out of the folder it was opened in"));
    }
    const wanted = CATALOG_AGENTS.filter(a => state.agents === undefined || state.agents.includes(a.id));
    const rows = await countProjectState(source, skeletons, wanted);
    const readable = rows.filter(r => r.error === undefined);
    const reports = new Map((await moveProjectState({ from: source, to: target, homes: skeletons }, readable.map(r => ({ id: r.agent })))).map(r => [r.agent, r]));
    const landed: LandedAgent[] = [];
    for (const row of rows) {
      const report = reports.get(row.agent);
      const resolver = PROJECT_STATE_RESOLVERS.get(row.agent);
      const skeleton = skeletons[row.agent];
      const home = homes[row.agent];
      const base: ProjectAgentResult & { name: string } = { agent: row.agent, name: row.name, files: 0, bytes: 0, outcome: "nothing", sessions: row.sessions };
      if (row.error !== undefined || report?.outcome === "failed") {
        landed.push({ ...base, outcome: "failed", error: row.error ?? (report?.outcome === "failed" ? report.error : "no reason given") });
        continue;
      }
      if (resolver === undefined || skeleton === undefined || home === undefined) {
        landed.push(base);
        continue;
      }
      // Every file the resolver names is read and held under the skeleton before one byte is copied, so a row of a
      // machine's own index naming a path outside it fails that agent's row rather than landing in the home here.
      const realSkeleton = realpathSync(skeleton);
      const copies: { from: string; to: string; bytes: number }[] = [];
      let refusal: string | undefined;
      for (const f of await resolver.entries(skeleton, target)) {
        const st = lstatSync(f);
        const rel = relative(skeleton, f);
        if (!st.isFile()) refusal = stateEntryRefusal(rel, entryWord(st));
        else if (!insideFolder(rel) || !under(realpathSync(f), realSkeleton)) refusal = stateEntryRefusal(f, "a path out of the folder it was opened in");
        if (refusal !== undefined) break;
        copies.push({ from: f, to: join(home, rel), bytes: st.size });
      }
      if (refusal !== undefined) {
        landed.push({ ...base, outcome: "failed", error: refusal });
        continue;
      }
      let bytes = 0;
      for (const c of copies) {
        mkdirSync(dirname(c.to), { recursive: true });
        copyFileSync(c.from, c.to);
        bytes += c.bytes;
      }
      const skipped = report?.outcome === "moved" ? report.moved.reduce((n, m) => n + (m.skipped ?? 0), 0) : 0;
      landed.push({ ...base, files: copies.length, bytes, outcome: outcomeOf(copies.length, true, resolver.carry, report), ...(skipped > 0 ? { skipped } : {}) });
    }
    // A home no resolver was pointed at has no row of the count's, so its own row is made here: the person reads
    // which agent's state did not come home and why, and the rest of the archive still lands.
    for (const [agent, why] of unheld) {
      if (!wanted.some(a => a.id === agent)) continue;
      landed.push({ agent, name: CATALOG_AGENTS.find(a => a.id === agent)?.name ?? agent, files: 0, bytes: 0, outcome: "failed", error: why });
    }
    return landed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A store the listing on the machine could not read, as a row of the report: nothing of that agent's state
 * travelled, so the row says which store and why rather than the export reading as a home with nothing in it. */
const unreadRows = (unread: readonly UnreadStore[] = []): LandedAgent[] =>
  unread.map(u => ({
    agent: u.agent,
    name: CATALOG_AGENTS.find(a => a.id === u.agent)?.name ?? u.agent,
    files: 0,
    bytes: 0,
    outcome: "failed",
    error: storeUnreadLine(u.store, u.why),
  }));

/** Lands the folder's archive at dest and the agents' state that came with it. The folder is extracted into a
 * staging directory beside dest, the state is opened in a scratch home, keyed to the path dest will have and laid
 * over the homes here, and only then is the staging directory renamed onto dest, so a failure anywhere before that
 * rename leaves nothing at or beside the destination. An existing destination is refused first and again at the
 * rename, unless `replace` removes it. */
async function land(req: LandRequest, homes: Readonly<Record<string, string>>): Promise<LandedProject> {
  const dest = destination(req.dest);
  const at = filesAt(dest);
  if (at !== undefined && !req.replace) throw destExists(dest, at.files);
  const staging = `${dest}.wsp-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(staging, { recursive: true });
  try {
    await extract(req.archive, staging);
    const target = join(dirname(realpathSync(staging)), basename(dest));
    const landed = req.state === undefined ? [] : await landState(req.state, req.source, target, homes);
    const order = (a: LandedAgent): number => CATALOG_AGENTS.findIndex(c => c.id === a.agent);
    const agents = [...landed, ...unreadRows(req.unread)].sort((a, b) => order(a) - order(b));
    const now = filesAt(dest);
    if (now !== undefined) {
      if (!req.replace) throw destExists(dest, now.files);
      rmSync(dest, { recursive: true, force: true });
    }
    renameSync(staging, dest);
    return { ...(filesAt(dest) ?? { files: 0, bytes: 0 }), agents };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** This computer's side of project.export; `homes` is each agent's home here by catalog id, the production caller's
 * under the real home directory, so a test never writes the homes on this computer. */
export function projectLander(homes: Readonly<Record<string, string>>): ProjectLander {
  return {
    caches: CACHE_RULE,
    probe: async dest => {
      const at = filesAt(destination(dest));
      return at === undefined ? undefined : { files: at.files };
    },
    land: req => land(req, homes),
  };
}
