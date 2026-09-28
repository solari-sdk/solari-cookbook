// SPDX-License-Identifier: AGPL-3.0-only
// skills.sh, asked by this host and nothing else: its search, and a skill's
// whole folder as its download answers it, which is what the official skills
// CLI installs from. A download is checked whole before a byte of it lands:
// every path plain and inside the skill, a count and size cap, a SKILL.md at
// its root; the archive the host lands is built here, regular files at 0644
// in folders at 0755, so nothing in a skill carries a link or a mode of its
// own and nothing in it runs.
import { isSystemSkill } from "@wsp/catalog";
import { skillMdFrontmatter } from "@wsp/collect";
import { tarOf, type TarEntry } from "@wsp/engine";
import { SKILL_PREVIEW_BYTES, SkillHit, fmtBytes, hasControlChar, skillsSearchEmptyRefusal, type SkillPreview } from "@wsp/protocol";
import { z } from "zod";

export const SKILLS_SH = "https://skills.sh";

/** The one road to skills.sh: the global fetch, or a fake in a test. */
export type SkillsFetch = (url: string, init?: { signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<Response>;

const ASK_MS = 20_000;
const MAX_HOPS = 3;
/** What is read of an answer: a search is small, a download holds up to MAX_TOTAL of text with its escapes. */
const SEARCH_ANSWER_MAX = 1024 * 1024;
const DOWNLOAD_ANSWER_MAX = 12 * 1024 * 1024;

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 1024;

/** A skill's folder name: what every agent's skills folder holds it under. */
export const SKILL_NAME_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

const UNREAD = "skills.sh answered something this wsp does not read.";

const notASkillId = (id: string): string => `${id} is not a skill skills.sh names; it reads <owner>/<repo>/<skill>.`;

/** The owner, repo and folder name of an id skills.sh names, or a refusal before anything is asked. */
export function skillIdOf(id: string): { owner: string; repo: string; skill: string } {
  const parts = id.split("/");
  const [owner = "", repo = "", skill = ""] = parts;
  const plain = (p: string): boolean => REPO_PART.test(p) && p !== "." && p !== "..";
  if (parts.length !== 3 || !plain(owner) || !plain(repo) || !SKILL_NAME_SHAPE.test(skill)) throw usage(notASkillId(id));
  return { owner, repo, skill };
}

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

/** An answer's body read up to `max` bytes, the read stopped and refused the moment it goes past. */
export async function capped(res: Response, max: number, source = "skills.sh"): Promise<Uint8Array> {
  const over = (): Error => new Error(`${source} answered over ${fmtBytes(max)}, which is not read.`);
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel();
    throw over();
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw over();
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** skills.sh's answer at the address, following a redirect only while it stays on skills.sh. */
async function answerAt(fetch: SkillsFetch, url: string, signal: AbortSignal): Promise<Response> {
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { signal, redirect: "manual" });
    } catch (e) {
      throw new Error(`skills.sh did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location === null) return res;
    await res.body?.cancel();
    const next = new URL(location, url);
    if (next.origin !== new URL(SKILLS_SH).origin) throw new Error(`skills.sh sent the ask on to ${next.href}, which is not skills.sh, so it was not followed.`);
    if (hop + 1 >= MAX_HOPS) throw new Error(`skills.sh sent the ask on more than ${MAX_HOPS} times, so it was not followed.`);
    url = next.href;
  }
}

async function ask(fetch: SkillsFetch, path: string, max: number, missing: string): Promise<unknown> {
  const res = await answerAt(fetch, `${SKILLS_SH}${path}`, AbortSignal.timeout(ASK_MS));
  if (res.status === 404) throw usage(missing);
  if (!res.ok) throw new Error(`skills.sh answered ${res.status}.`);
  const bytes = await capped(res, max);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(UNREAD);
  }
}

const SearchAnswer = z.object({ skills: z.array(SkillHit) });

/** skills.sh's search for the query, trimmed; an empty one is refused here, as skills.sh refuses it. */
export async function searchSkills(fetch: SkillsFetch, q: string, limit: number): Promise<SkillHit[]> {
  const query = q.trim();
  if (query === "") throw usage(skillsSearchEmptyRefusal);
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const parsed = SearchAnswer.safeParse(await ask(fetch, `/api/search?${params.toString()}`, SEARCH_ANSWER_MAX, `skills.sh has no search at ${SKILLS_SH}.`));
  if (!parsed.success) throw new Error(UNREAD);
  return parsed.data.skills;
}

/** One file of a skill as it will land: its path inside the skill's folder and its bytes. */
export interface SkillFile {
  path: string;
  bytes: Uint8Array;
}

/** Folder and file names a version control tool reads config from, which can name a command it runs. */
const VCS_NAMES = new Set([".git", ".hg", ".svn", ".bzr", ".jj", ".gitmodules", "_darcs", ".pijul", ".sl"]);
// Code points a Mac's file system has ignored in a name, so ".g\u200cit" once opened as .git.
const IGNORABLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const bare = (seg: string): string => seg.replace(IGNORABLE, "").toLowerCase();
const vcsPath = (path: string): boolean => path.split("/").some(seg => VCS_NAMES.has(bare(seg)));

/** The first folder, "" for the root, that git takes for a repository when someone stands in it, whatever it is
 * called: a HEAD beside objects and refs, or beside a commondir naming where those are. */
function gitFolder(paths: Iterable<string>): string | undefined {
  const under = new Map<string, Set<string>>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const names = under.get(dir) ?? new Set<string>();
      names.add(bare(parts[i]!));
      under.set(dir, names);
    }
  }
  for (const [dir, names] of under) if (names.has("head") && ((names.has("objects") && names.has("refs")) || names.has("commondir"))) return dir;
  return undefined;
}

const plainPath = (path: string): boolean => {
  if (path === "" || Buffer.byteLength(path) > MAX_PATH_BYTES || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) || hasControlChar(path)) return false;
  return path.split("/").every(seg => seg !== "" && seg !== "." && seg !== ".." && Buffer.byteLength(seg) <= MAX_SEGMENT_BYTES);
};

/** The download's files, checked whole: the first path that could land anywhere but inside the skill's own folder,
 * a count or a size past its cap, or no SKILL.md at the root refuses the whole skill in one sentence. */
export function checkSkillFiles(name: string, files: readonly { path?: unknown; contents?: unknown }[]): SkillFile[] {
  if (!SKILL_NAME_SHAPE.test(name)) throw usage(`${name} is not a plain skill name, so nothing was installed.`);
  if (isSystemSkill(name)) throw usage(`${name} is the name of the skill wsp writes, so nothing was installed.`);
  const refuse = (why: string): Error => usage(`${name} was not installed: ${why}`);
  if (files.length > MAX_FILES) throw refuse(`it has ${files.length} files, over the ${MAX_FILES} a skill may have.`);
  const out: SkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (typeof f.path !== "string" || typeof f.contents !== "string") throw new Error(UNREAD);
    if (!plainPath(f.path)) throw refuse(`the download names ${JSON.stringify(f.path)}, which is not a plain path inside the skill.`);
    if (vcsPath(f.path)) throw refuse(`the download names ${JSON.stringify(f.path)}, which a version control tool reads its config from.`);
    if (seen.has(f.path)) throw refuse(`the download names ${f.path} twice.`);
    seen.add(f.path);
    const bytes = new TextEncoder().encode(f.contents);
    if (bytes.byteLength > MAX_FILE_BYTES) throw refuse(`${f.path} is over 1 MB.`);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw refuse("it is over 5 MB in all.");
    out.push({ path: f.path, bytes });
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join("/"))) throw refuse(`the download names ${parts.slice(0, i).join("/")} as a file and as a folder.`);
  }
  const git = gitFolder(seen);
  if (git !== undefined) throw refuse(`${git === "" ? "the skill's own folder" : git} is laid out as a git folder, whose config git runs commands from.`);
  const skillMd = out.find(f => f.path === "SKILL.md");
  if (skillMd === undefined) throw refuse("it has no SKILL.md at its root.");
  // Every agent finds a skill by its folder, so a SKILL.md naming another skill would pass for that one.
  const front = skillMdFrontmatter(new TextDecoder().decode(skillMd.bytes));
  if (front.names !== undefined) throw refuse("its SKILL.md has more than one name line, which agents read apart.");
  const said = front.name;
  if (said === undefined) throw refuse(`its SKILL.md names no name, where it must say ${name}.`);
  if (said !== name) throw refuse(`its SKILL.md names it ${said}, not ${name}.`);
  return out;
}

/** A gzipped tarball of the checked files: every folder at 0755, every file at 0644, no link, no owner but root's
 * placeholder, which an unpack as the login ignores. */
export function skillArchive(files: readonly SkillFile[]): Buffer {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries: TarEntry[] = [...[...dirs].sort().map(path => ({ path, mode: 0o755, dir: true as const })), ...files.map(f => ({ path: f.path, mode: 0o644, content: f.bytes }))];
  return tarOf(entries);
}

/** A SKILL.md as a preview carries it: its first SKILL_PREVIEW_BYTES, cut on a whole character, and its size. */
export function skillPreview(bytes: Uint8Array): SkillPreview {
  if (bytes.byteLength <= SKILL_PREVIEW_BYTES) return { text: new TextDecoder().decode(bytes), size: bytes.byteLength };
  let end = SKILL_PREVIEW_BYTES;
  // A UTF-8 continuation byte is 10xxxxxx: step back to the start of the character the cut fell in.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), size: bytes.byteLength };
}

const DownloadAnswer = z.object({ files: z.array(z.object({ path: z.unknown(), contents: z.unknown() })) });

/** A skill off skills.sh, checked whole: its folder name and its files. */
export async function getSkill(fetch: SkillsFetch, id: string): Promise<{ name: string; files: SkillFile[] }> {
  const { owner, repo, skill } = skillIdOf(id);
  const parsed = DownloadAnswer.safeParse(await ask(fetch, `/api/download/${owner}/${repo}/${skill}`, DOWNLOAD_ANSWER_MAX, `skills.sh has no skill ${id}.`));
  if (!parsed.success) throw new Error(UNREAD);
  return { name: skill, files: checkSkillFiles(skill, parsed.data.files) };
}
