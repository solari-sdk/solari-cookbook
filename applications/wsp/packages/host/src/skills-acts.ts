// SPDX-License-Identifier: AGPL-3.0-only
// A skill on one computer or workspace: its SKILL.md read for a preview, a
// skill off skills.sh installed, turned off or on, removed. Every line runs
// as the computer's login (asLogin), through the road its kind has: this
// computer's own shell, a joined computer's exec with stdin, a workspace's
// machine with its bytes staged first. The skill is found by the same reader
// the report uses, so an act names only folders the report shows. The skill
// wsp writes and a plugin's are always on; a project's lives in the repo and
// is not turned off here.
import { posix } from "node:path";
import { CATALOG_AGENTS, PROJECT_SHARED_SKILLS, SHARED_SKILLS, isSystemSkill, ownSkillFolder } from "@wsp/catalog";
import { detectSkills, expand, nodeHost, skillRoots, tilde, type Host } from "@wsp/collect";
import type { ExecResult } from "@wsp/engine";
import { noSuchSkillRefusal, pluginSkillRefusal, projectSkillOffRefusal, shellQuote, systemSkillRefusal, type SkillAdded, type SkillPreview, type SkillRow } from "@wsp/protocol";
import { projectOf, type AgentsOn, type SkillAsk, type SkillsActs } from "@wsp/runtime";
import { getSkill, searchSkills, skillArchive, skillPreview, type SkillsFetch } from "./skills-sh.js";
import { firstLine, roadOf, type Road } from "./target-road.js";

/** The exit a line takes when the skill's folder is already there, so nothing is written over it. */
const THERE_EXIT = 3;
/** The exit a line takes, with the link and where it points on stdout, when a folder it would touch sits under a link. */
const HELD_EXIT = 4;
/** The exit a preview takes when its SKILL.md is a link out of the skills folders. */
const OUT_EXIT = 5;
/** What a preview reads of a SKILL.md at most; the preview itself carries the first SKILL_PREVIEW_BYTES. */
const PREVIEW_READ_CAP = 2 * 1024 * 1024;

/** A shell function: the first folder above $1, below $2, that is a link, printed with where it points, else false.
 * With $3, a real path, a link that resolves inside it is passed over. */
const LINK_ABOVE = [
  "linked() {",
  "  p=${1%/*}",
  '  while [ -n "$p" ] && [ "$p" != "$2" ] && [ "$p" != / ]; do',
  '    if [ -L "$p" ]; then',
  '      if [ -n "$3" ] && r=$(realpath "$p" 2>/dev/null); then case $r/ in "$3"/*) p=${p%/*}; continue;; esac; fi',
  "      printf '%s\\t%s\\n' \"$p\" \"$(readlink \"$p\")\"",
  "      return 0",
  "    fi",
  "    p=${p%/*}",
  "  done",
  "  return 1",
  "}",
].join("\n");

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

/** The project a target holds, which a project's skill needs. */
function theProject(on: AgentsOn): string {
  const project = projectOf(on);
  if (project === undefined) throw usage("A project's skill goes in from a workspace of that project, or from its computer's page.");
  return project;
}

/** The one skill the act names, off the same reader the report uses: the project's with `project`, else the one that
 * is not a project's, a person's own before a plugin's of the same name. */
async function findSkill(road: Road, on: AgentsOn, ask: SkillAsk): Promise<{ row: SkillRow; roots: string[] }> {
  // Only the one project an act names: two projects' skills of one name would leave the act guessing.
  const roots = await skillRoots(road.host, projectOf(on) !== undefined ? { projects: on.projects! } : {});
  const read = await detectSkills(road.host, roots);
  const rows = read.skills.filter(s => s.name === ask.name && (ask.project === true ? s.scope === "project" : s.scope !== "project"));
  const row = rows.find(s => s.scope !== "plugin") ?? rows[0];
  if (row === undefined) throw usage(read.refused[0] ?? noSuchSkillRefusal(ask.name));
  return { row, roots: roots.map(r => r.dir) };
}

/** The skills folder a skill's folder sits in, the deepest that holds it; a link at or above it is the person's own setup. */
const rootOf = (dir: string, roots: readonly string[]): string =>
  roots.filter(r => dir.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? posix.dirname(dir);

/** A line that exits HELD_EXIT naming the link when any of the folders sits under one below its skills folder. */
const heldLine = (dirs: readonly string[], roots: readonly string[]): string =>
  [LINK_ABOVE, ...dirs.map(d => `linked ${shellQuote(d)} ${shellQuote(rootOf(d, roots))} && exit ${HELD_EXIT}`)].join("\n");

/** The link and where it points, off a line that exited HELD_EXIT. */
function linkSaid(res: ExecResult, home: string): { link: string; to: string } {
  const [link = "", to = ""] = res.stdout.trim().split("\n")[0]!.split("\t");
  return { link: tilde(home, link), to: tilde(home, to) };
}

/** The held skill's refusal, off a line that exited HELD_EXIT. */
function heldRefusal(res: ExecResult, road: Road, row: SkillRow): void {
  if (res.exitCode !== HELD_EXIT) return;
  const { link, to } = linkSaid(res, road.host.home);
  throw usage(skillUnderLinkRefusal(row.name, link, to));
}

export const skillUnderLinkRefusal = (name: string, link: string, to: string): string => `${name} sits under ${link}, a link to ${to}, so its files belong to that checkout and wsp leaves them as they are.`;
export const skillLinkOnlyRefusal = (name: string, path: string, to: string, word: "on" | "off"): string => `${name} is a link to ${to} at ${path}, whose files wsp does not change, so nothing was turned ${word}.`;

/** The folder a skill really lives in: the first that is no link, else the first. */
const realPath = (row: SkillRow): string => (row.paths.find(p => p.linkTo === undefined) ?? row.paths[0]!).path;

/** Whether a person may change the skill: never the one wsp writes or a plugin's, and never turn off a project's. */
function mayChange(row: SkillRow, act: "toggle" | "remove"): void {
  if (isSystemSkill(row.name)) throw usage(systemSkillRefusal(row.name));
  if (row.scope === "plugin") throw usage(pluginSkillRefusal(row.name));
  if (act === "toggle" && row.scope === "project") throw usage(projectSkillOffRefusal(row.name, realPath(row)));
}

export interface SkillsActsOptions {
  fetch?: SkillsFetch;
  /** This computer's Host; the node one, over this login's home, unless a test names another. */
  here?: () => Host;
}

export function skillsActs(o: SkillsActsOptions = {}): SkillsActs {
  const fetch: SkillsFetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const here = o.here ?? nodeHost;
  return {
    search: (q, limit) => searchSkills(fetch, q, limit),
    get: async skill => {
      const got = await getSkill(fetch, skill);
      return skillPreview(got.files.find(f => f.path === "SKILL.md")!.bytes);
    },
    preview: async (on, ask): Promise<SkillPreview> => {
      const road = await roadOf(on, here, "the skill");
      const { row, roots } = await findSkill(road, on, ask);
      const q = shellQuote;
      const line = [
        `d=${q(expand(road.host, realPath(row)))}`,
        'f="$d/SKILL.md"; [ -e "$f" ] || f="$d/SKILL.md.off"',
        '[ -f "$f" ] || exit 1',
        'if [ -L "$f" ]; then',
        '  r=$(realpath "$f") || exit 1',
        `  ok=; for a in "$d" ${roots.map(q).join(" ")}; do a=$(realpath "$a" 2>/dev/null) || continue; case $r in "$a"/*) ok=1;; esac; done`,
        `  [ -n "$ok" ] || exit ${OUT_EXIT}`,
        "fi",
        'wc -c < "$f" | tr -d " "',
        `head -c ${PREVIEW_READ_CAP} "$f"`,
      ].join("\n");
      const res = await road.run(line);
      if (res.exitCode === OUT_EXIT) throw usage(`The SKILL.md of ${row.name} at ${realPath(row)} is a link out of the skills folders, so it is not read.`);
      const cut = res.stdout.indexOf("\n");
      const size = Number(res.stdout.slice(0, cut));
      if (res.exitCode !== 0 || cut === -1 || !Number.isInteger(size)) throw new Error(`The SKILL.md of ${row.name} at ${realPath(row)} could not be read.`);
      return { ...skillPreview(new TextEncoder().encode(res.stdout.slice(cut + 1))), size };
    },
    add: async (on, ask): Promise<SkillAdded> => {
      const project = ask.project === true ? theProject(on) : undefined;
      const unknown = (ask.agents ?? []).filter(id => !CATALOG_AGENTS.some(a => a.id === id));
      if (unknown.length > 0) throw usage(`The catalog has no agent ${unknown.join(", ")}.`);
      const got = await getSkill(fetch, ask.skill);
      const road = await roadOf(on, here, "the skill");
      const home = road.host.home;
      const inside = (dir: string): string => (project !== undefined ? posix.join(project, dir) : expand(road.host, dir));
      const dest = posix.join(inside(project !== undefined ? PROJECT_SHARED_SKILLS : SHARED_SKILLS), got.name);
      // Named agents get their folder made; with none named, an agent gets the skill where its own folder's home is.
      const named = ask.agents !== undefined;
      const agents = CATALOG_AGENTS.filter(a => (named ? ask.agents!.includes(a.id) : true)).flatMap(a => {
        const root = ownSkillFolder(a, project !== undefined);
        return root === undefined ? [] : [{ id: a.id, root, dir: inside(root.dir) }];
      });
      const q = shellQuote;
      // A project's folder that links out of it would put the skill somewhere the project does not hold.
      const held = project === undefined ? [] : [LINK_ABOVE, `b=$(realpath ${q(project)}) || exit 1`, ...[dest, ...agents.map(a => posix.join(a.dir, got.name))].map(d => `linked ${q(d)} ${q(project)} "$b" && exit ${HELD_EXIT}`)];
      const lines = [
        ...held,
        "umask 022",
        't=$(mktemp) || exit 1',
        'trap \'rm -f -- "$t"\' EXIT',
        'cat > "$t"',
        `if [ -e ${q(dest)} ] || [ -L ${q(dest)} ]; then exit ${THERE_EXIT}; fi`,
        `mkdir -p ${q(dest)} && tar --no-same-owner --no-same-permissions -xzf "$t" -C ${q(dest)} && [ -f ${q(`${dest}/SKILL.md`)} ] || { rm -rf -- ${q(dest)}; exit 1; }`,
        ...agents.map(a => {
          const at = posix.join(a.dir, got.name);
          const put = a.root.lands === "link" ? `ln -s -- ${q(posix.relative(a.dir, dest))} ${q(at)}` : `mkdir -p ${q(at)} && tar --no-same-owner --no-same-permissions -xzf "$t" -C ${q(at)}`;
          const home = named ? "true" : `[ -d ${q(posix.dirname(a.dir))} ]`;
          return `if ${home} && [ ! -e ${q(at)} ] && [ ! -L ${q(at)} ]; then mkdir -p ${q(a.dir)} && ${put} && printf '%s\\t%s\\n' ${q(a.id)} ${q(at)}; fi`;
        }),
      ];
      const res = await road.run(lines.join("\n"), skillArchive(got.files));
      if (res.exitCode === THERE_EXIT) throw usage(`${got.name} is already at ${tilde(home, dest)}, so nothing was installed.`);
      if (res.exitCode === HELD_EXIT) {
        const { link, to } = linkSaid(res, home);
        throw usage(`${got.name} was not installed: ${link} is a link to ${to}, out of the project.`);
      }
      if (res.exitCode !== 0) throw new Error(`${got.name} was not installed: ${firstLine(res)}`);
      const placed = res.stdout
        .split("\n")
        .filter(l => l.includes("\t"))
        .map(l => {
          const [agent = "", path = ""] = l.split("\t");
          return { agent, path: tilde(home, path) };
        });
      return { path: tilde(home, dest), agents: placed };
    },
    remove: async (on, ask) => {
      const road = await roadOf(on, here, "the skill");
      const { row, roots } = await findSkill(road, on, ask);
      mayChange(row, "remove");
      // rm -rf never follows a link it is handed, so a link goes and the folder it points to stays unless it is itself
      // one of the skill's folders; a link between the skills folder and the skill it does follow, so such a skill is held.
      const paths = row.paths.map(p => p.path);
      const dirs = paths.map(p => expand(road.host, p));
      const res = await road.run(`${heldLine(dirs, roots)}\nrm -rf -- ${dirs.map(shellQuote).join(" ")}`);
      heldRefusal(res, road, row);
      if (res.exitCode !== 0) throw new Error(`${row.name} was not removed: ${firstLine(res)}`);
      return { removed: paths };
    },
    toggle: async (on, ask) => {
      const road = await roadOf(on, here, "the skill");
      const { row, roots } = await findSkill(road, on, ask);
      mayChange(row, "toggle");
      const word = ask.on ? "on" : "off";
      // Renamed where the skill really lives; every link to it follows.
      const real = row.paths.filter(p => p.linkTo === undefined).map(p => p.path);
      const only = row.paths[0]!;
      if (real.length === 0) throw usage(skillLinkOnlyRefusal(row.name, only.path, only.linkTo ?? only.path, word));
      const [from, to] = ask.on ? ["SKILL.md.off", "SKILL.md"] : ["SKILL.md", "SKILL.md.off"];
      const dirs = real.map(p => expand(road.host, p));
      const q = shellQuote;
      const renames = dirs.map(
        (dir, i) => `if [ -f ${q(`${dir}/${from}`)} ] && [ ! -e ${q(`${dir}/${to}`)} ]; then mv -- ${q(`${dir}/${from}`)} ${q(`${dir}/${to}`)} || exit 1; echo "moved ${i}"; elif [ -f ${q(`${dir}/${from}`)} ]; then echo "both ${i}"; fi`,
      );
      const res = await road.run([heldLine(dirs, roots), ...renames].join("\n"));
      heldRefusal(res, road, row);
      if (res.exitCode !== 0) throw new Error(`${row.name} was not turned ${word}: ${firstLine(res)}`);
      const said = res.stdout.split("\n").map(l => l.split(" "));
      const moved = said.filter(([k]) => k === "moved").map(([, i]) => real[Number(i)]!);
      if (moved.length > 0) return { paths: moved };
      const both = said.find(([k]) => k === "both");
      throw usage(both !== undefined ? `${row.name} was not turned ${word}: ${real[Number(both[1])]} already holds a ${to}, so nothing was renamed.` : `${row.name} is already ${word}, so nothing was renamed.`);
    },
  };
}
