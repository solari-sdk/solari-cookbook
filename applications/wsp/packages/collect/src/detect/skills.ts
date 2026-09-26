// SPDX-License-Identifier: AGPL-3.0-only
// Every skill on a computer, off the folders each catalog agent loads skills
// from: one row per folder name with every folder it lives in, whether that
// folder is a link, and the description off its SKILL.md's frontmatter.
// One command reads every folder, so a computer reached over a link answers
// in one round trip however many skills it keeps.
import { posix } from "node:path";
import { CATALOG_AGENTS, type AgentEntry } from "@wsp/catalog";
import type { AgentsProject, SkillPath, SkillRow, SkillScope } from "@wsp/protocol";
import { type Host, expand, tilde } from "../host.js";

/** One folder to read skills from, absolute: whose own folder it is, where it is one agent's, and what kind. */
export interface SkillRootAt {
  dir: string;
  scope: SkillScope;
  agent?: string;
  /** The project a project folder is in, its path absolute. */
  project?: AgentsProject;
}

export interface SkillsRead {
  skills: SkillRow[];
  refused: string[];
}

/** How much of a SKILL.md is read for its frontmatter. */
export const SKILL_HEAD_BYTES = 4096;

const END = "\x1eEND";

/** Reads the list the finder prints, a line naming each root and then one line per file under it (whether its folder is
 * a link, whether it is turned off, its path), and prints the records: where each linked folder points comes off one ls,
 * and every frontmatter off the one awk, each file cut at `cap` bytes. Only a newline in a name splits a line. */
const FRONTMATTERS = String.raw`function q(s,  o, i) { o = ""; while ((i = index(s, "\047")) > 0) { o = o substr(s, 1, i - 1) "\047\\\047\047"; s = substr(s, i + 1) } return "\047" o s "\047" }
/^r/ { r = substr($0, 2); next }
{
  n++; R[n] = r; K[n] = substr($0, 2, 1); O[n] = substr($0, 3, 1); f = substr($0, 4); F[n] = f
  d = f; if (match(f, "/[^/]*$")) d = substr(f, 1, RSTART - 1); D[n] = d
  if (K[n] == "1" && !(d in L)) { L[d] = ""; cmd = cmd " " q(d) }
}
END {
  if (cmd != "") {
    cmd = "QUOTING_STYLE=literal ls -ld --" cmd " 2>/dev/null"
    while ((cmd | getline line) > 0) {
      # Assumes an absolute name, a target with no newline, and no link named another link plus " -> " and a target start.
      i = index(line, " /")
      if (i == 0) continue
      rest = substr(line, i + 1); best = ""
      for (d in L) if (length(d) > length(best) && substr(rest, 1, length(d) + 4) == d " -> ") best = d
      if (best != "") L[best] = substr(rest, length(best) + 5)
    }
    close(cmd)
  }
  for (j = 1; j <= n; j++) {
    printf "\036%s\037%s\037%s\037%s\037", R[j], D[j], (K[j] == "1" ? L[D[j]] : ""), (O[j] == "1" ? "1" : "")
    f = F[j]; k = 0; b = 0
    while (f != "" && b < cap && (getline line < f) > 0) {
      k++
      if (b + length(line) > cap) line = substr(line, 1, cap - b)
      b += length(line) + 1
      sub(/\r$/, "", line)
      if (k == 1) { if (line != "---") break; continue }
      if (line == "---") break
      print line
    }
    if (f != "") close(f)
  }
}`;

/** Prints, per SKILL.md found under each root (two or three folders down: a category folder is allowed, links are
 * followed), the root, the skill's folder, where that folder links, whether it is turned off (a SKILL.md.off with no
 * SKILL.md beside it), and the frontmatter lines alone. The processes it starts do not grow with the skills. */
const SCRIPT = [
  'for r in "$@"; do',
  '  [ -d "$r" ] || continue',
  "  printf 'r%s\\n' \"$r\"",
  '  find -L "$r" -mindepth 2 -maxdepth 3 \\( -name SKILL.md -o -name SKILL.md.off \\) -type f 2>/dev/null | while IFS= read -r f; do',
  '    d=${f%/*}',
  '    o=0; case $f in *.off) [ -f "$d/SKILL.md" ] && continue; o=1;; esac',
  '    l=0; [ -L "$d" ] && l=1',
  "    printf 'f%s%s%s\\n' \"$l\" \"$o\" \"$f\"",
  "  done",
  `done | LC_ALL=C awk -v cap=${SKILL_HEAD_BYTES} '${FRONTMATTERS}' && printf '\\036END\\n'`,
].join("\n");

/** A one-line YAML value as a string: a quoted one is what its quotes hold, a plain one ends where a comment starts. */
const scalar = (v: string): string => {
  const t = v.trim();
  const single = /^'((?:[^']|'')*)'/.exec(t);
  if (single !== null) return single[1]!.replaceAll("''", "'");
  const double = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  if (double !== null) return double[1]!.replace(/\\(["\\])/g, "$1");
  return t.replace(/(^|\s+)#.*$/, "");
};

/** A top-level `name` or `description` key as YAML reads one: bare or quoted, with or without room before its colon. */
const KEY = /^(?:(name|description)|"(name|description)"|'(name|description)')\s*:(?:\s+(.*))?$/;

/** What a SKILL.md's frontmatter says; `names` counts the name lines when there is more than one. */
export interface SkillFront {
  name?: string;
  description?: string;
  names?: number;
}

/** `name` and `description` off a SKILL.md's frontmatter lines, the first of each: a plain value, a quoted one, or a
 * folded or literal block, read as one line. */
export function skillFrontmatter(text: string): SkillFront {
  const out: SkillFront = {};
  let names = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = KEY.exec(lines[i]!);
    if (m === null) continue;
    const key = (m[1] ?? m[2] ?? m[3]) as "name" | "description";
    if (key === "name") names++;
    let value = (m[4] ?? "").trim();
    const block = /^[>|][-+]?$/.test(value);
    const more: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) more.push(lines[++i]!.trim());
    value = block ? more.join(" ") : [scalar(value), ...more].filter(w => w !== "").join(" ");
    if (value !== "" && out[key] === undefined) out[key] = value;
  }
  if (names > 1) out.names = names;
  return out;
}

/** `name` and `description` off a whole SKILL.md: the lines between its opening `---` and the next, as the reader's
 * script takes them. */
export function skillMdFrontmatter(text: string): SkillFront {
  const lines = text.slice(0, SKILL_HEAD_BYTES).split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  return skillFrontmatter(lines.slice(1, end === -1 ? undefined : end).join("\n"));
}

/** Prints each folder given after the project that is a link or sits under one inside the project. */
const LINKED_SCRIPT = [
  'p=$1; shift',
  'for r in "$@"; do',
  '  s=$r',
  '  while [ "${#s}" -gt "${#p}" ]; do',
  "    if [ -L \"$s\" ]; then printf '%s\\n' \"$r\"; break; fi",
  '    s=${s%/*}',
  '  done',
  'done',
  "printf '\\036END\\n'",
].join("\n");

/** The project's skills folders that are the repo's links: a repo that links one out would hand its skills acts the
 * person's own folders. Every one of them, when the answer does not come back whole. */
async function linkedInside(host: Host, project: string, dirs: readonly string[]): Promise<Set<string>> {
  const said = await host.exec.run("sh", ["-c", LINKED_SCRIPT, "sh", project, ...dirs], { timeoutMs: 20_000 });
  if (said === undefined || !said.trimEnd().endsWith(END)) return new Set(dirs);
  return new Set(said.split("\n").filter(l => dirs.includes(l)));
}

/** The folders every catalog agent loads skills from on that computer, absolute, each once: an agent's own folder
 * carries that agent, a folder several read carries none. Each project adds the folders the agents read inside it,
 * and the plugin indexes name the folders their plugins' skills sit in. */
export async function skillRoots(host: Host, o: { agents?: readonly AgentEntry[]; projects?: readonly AgentsProject[] } = {}): Promise<SkillRootAt[]> {
  const agents = o.agents ?? CATALOG_AGENTS;
  const out = new Map<string, SkillRootAt>();
  const add = (dirs: { dir: string; own: boolean }[], scope: SkillScope, agent: string, project?: AgentsProject): void => {
    for (const { dir, own } of dirs) {
      const at = out.get(dir);
      if (at === undefined) out.set(dir, { dir, scope, ...(own ? { agent } : {}), ...(project !== undefined ? { project } : {}) });
      else if (own && at.agent === undefined) out.set(dir, { ...at, agent });
    }
  };
  for (const a of agents) add(a.skillRoots.user.map((r, i) => ({ dir: expand(host, r.dir), own: i === 0 })), "user", a.id);
  await Promise.all(
    (o.projects ?? []).map(async project => {
      const at = (r: { dir: string }): string => posix.join(project.path, r.dir);
      const linked = await linkedInside(host, project.path, [...new Set(agents.flatMap(a => a.skillRoots.project.map(at)))]);
      for (const a of agents) add(a.skillRoots.project.map((r, i) => ({ dir: at(r), own: i === 0 })).filter(r => !linked.has(r.dir)), "project", a.id, project);
    }),
  );
  const plugins = agents.filter(a => a.pluginSkills !== undefined);
  const indexes = await Promise.all(plugins.map(a => host.fs.readText(expand(host, a.pluginSkills!.index))));
  plugins.forEach((a, i) => {
    const text = indexes[i];
    if (text !== undefined) add(a.pluginSkills!.roots(text).map(dir => ({ dir, own: true })), "plugin", a.id);
  });
  return [...out.values()];
}

/** Every skill under the roots, one row per folder name and kind with every folder it lives in. A folder whose name starts
 * with a dot, one without a SKILL.md, and a skill inside another skill's folder are not skills. An answer cut short
 * is a refusal naming it, never a list that silently stops. */
export async function detectSkills(host: Host, roots: readonly SkillRootAt[]): Promise<SkillsRead> {
  if (roots.length === 0) return { skills: [], refused: [] };
  const said = await host.exec.run("sh", ["-c", SCRIPT, "sh", ...roots.map(r => r.dir)], { timeoutMs: 20_000 });
  if (said === undefined) return { skills: [], refused: ["skills: the folders could not be read"] };
  const refused = said.trimEnd().endsWith(END) ? [] : ["skills: the answer was cut short, so the list is not whole"];
  const rootOf = new Map(roots.map(r => [r.dir, r]));
  const found: { root: SkillRootAt; dir: string; link: string; off: boolean; head: string }[] = [];
  for (const record of said.split("\x1e").slice(1)) {
    const [rootDir, dir, link, off, head] = record.split("\x1f");
    const root = rootDir === undefined ? undefined : rootOf.get(rootDir);
    if (root === undefined || dir === undefined || head === undefined) continue;
    const rel = dir.slice(root.dir.length + 1);
    if (!dir.startsWith(`${root.dir}/`) || rel.split("/").some(seg => seg.startsWith("."))) continue;
    found.push({ root, dir, link: link ?? "", off: off === "1", head });
  }
  const dirs = new Set(found.map(f => `${f.root.dir}\0${f.dir}`));
  const rows = new Map<string, SkillRow>();
  for (const f of found) {
    // A SKILL.md under a folder that is itself a skill belongs to that skill (its examples, its templates).
    const parts = f.dir.slice(f.root.dir.length + 1).split("/");
    if (parts.slice(1).some((_, i) => dirs.has(`${f.root.dir}\0${f.root.dir}/${parts.slice(0, i + 1).join("/")}`))) continue;
    const meta = skillFrontmatter(f.head);
    // Keyed by folder, which is what an agent loads a skill by; the frontmatter's name is the file's own claim.
    const name = posix.basename(f.dir);
    const key = `${f.root.scope}\0${f.root.project?.id ?? ""}\0${name}`;
    const path: SkillPath = {
      path: tilde(host.home, f.dir),
      ...(f.root.agent !== undefined ? { agent: f.root.agent } : {}),
      ...(f.link !== "" ? { linkTo: tilde(host.home, posix.resolve(posix.dirname(f.dir), f.link)) } : {}),
      ...(f.off ? { off: true as const } : {}),
    };
    const row = rows.get(key);
    const project = f.root.project === undefined ? {} : { project: { ...f.root.project, path: tilde(host.home, f.root.project.path) } };
    if (row === undefined) rows.set(key, { name, ...(meta.description !== undefined ? { description: meta.description } : {}), paths: [path], scope: f.root.scope, ...project });
    else if (!row.paths.some(p => p.path === path.path)) row.paths.push(path);
  }
  return { skills: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope) || (a.project?.name ?? "").localeCompare(b.project?.name ?? "")), refused };
}
