// SPDX-License-Identifier: AGPL-3.0-only
// The Skills tab: every skill in every folder an agent reads, one row per
// skill with the agents that read it after its name and the folder it really
// lives in under it. The detail says who wrote it, where every copy is, what
// can be done to it, and draws its SKILL.md: a skill wsp writes is always on,
// a plugin's comes and goes with the plugin, a project's lives in the repo.
// Add a skill searches skills.sh through the host, and a result opens the
// same detail with its SKILL.md before anything is installed.
import { DownloadIcon, PowerIcon, PowerOffIcon, ScrollTextIcon, Trash2Icon } from "lucide-react";
import { agentName, catalogEntry, isSystemSkill, ownSkillFolder, type AgentEntry } from "@wsp/catalog";
import type { AgentsProject, AgentsReport, SkillHit, SkillRow } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, compactCount, holdAll, inProject, notYet, onImage, pickOf, skillKey, whereNow, type RowAct, type RowsContext, type SkillActs, type SkillPicks } from "../agentsRows.js";
import { byName, kind, matchesAny, projectGroups, rowKey, type AddModule, type Choice, type DetailView, type Fact, type GroupBy, type GroupView, type KindModule, type Status } from "./kind.js";

/** The folder a skill really lives in: the one that is no link, else the first. */
const realPath = (row: SkillRow): string => (row.paths.find(p => p.linkTo === undefined) ?? row.paths[0])?.path ?? "";

const agentsOf = (row: SkillRow): string[] => [...new Set(row.paths.flatMap(p => (p.agent === undefined ? [] : [p.agent])))];

/** Off where every folder it lives in is off: no agent loads it. */
const isOff = (row: SkillRow): boolean => row.paths.every(p => p.off === true);

const rowId = (row: SkillRow): string => rowKey(["skill", row.scope], row.project, row.name);

const ON: Status = { state: "on", tone: "good", words: W.on };
const OFF: Status = { state: "off", tone: "quiet", words: W.off };

type Source = "system" | "plugin" | "user" | "project";
const sourceOf = (row: SkillRow): Source => (isSystemSkill(row.name) ? "system" : row.scope);

const SOURCES: readonly { source: Exclude<Source, "project">; label: string }[] = [
  { source: "system", label: "System" },
  { source: "plugin", label: "Plugins" },
  { source: "user", label: "Global" },
];

function actsOf(row: SkillRow, ctx: RowsContext): RowAct[] {
  const source = sourceOf(row);
  if (source === "system" || source === "plugin" || onImage(ctx)) return [];
  const skills = ctx.skills;
  const busy = skills?.busyOf(skillKey(row)) === true;
  const off = isOff(row);
  const turn: RowAct =
    source === "project"
      ? notYet("turn-off", W.turnOff, PowerOffIcon, { hover: W.livesInRepo(realPath(row)) })
      : skills === undefined
        ? notYet(off ? "turn-on" : "turn-off", off ? W.turnOn : W.turnOff, off ? PowerIcon : PowerOffIcon)
        : { id: off ? "turn-on" : "turn-off", label: off ? W.turnOn : W.turnOff, icon: off ? PowerIcon : PowerOffIcon, ...(busy ? {} : { run: () => skills.toggle(row, off) }) };
  const remove: RowAct =
    skills === undefined
      ? notYet("remove", W.remove, Trash2Icon, { destructive: true })
      : { id: "remove", label: W.remove, icon: Trash2Icon, destructive: true, confirm: { title: W.removeTitle(row.name), body: W.removeBody(ctx.on ?? ctx.computer ?? "") }, ...(busy ? {} : { run: () => skills.remove(row) }) };
  return holdAll([turn, remove], ctx);
}

const agentEntry = (id: string): AgentEntry | undefined => {
  const entry = catalogEntry(id);
  return entry?.kind === "agent" ? entry : undefined;
};

/** The installed agents an install is offered for, each held where it reads the shared folder and so has it anyway. */
function agentOptions(report: AgentsReport | null, project: boolean): Choice["options"] {
  return (report?.agents ?? [])
    .filter(a => a.installed)
    .map(a => {
      const entry = agentEntry(a.id);
      const shared = entry !== undefined && ownSkillFolder(entry, project) === undefined;
      return { value: a.id, label: a.name, agent: a.id, ...(shared ? { held: W.readsShared } : {}) };
    });
}

/** What an install takes before the person picks: every installed agent, in the home. */
const firstPicks = (report: AgentsReport | null): SkillPicks => ({ agents: (report?.agents ?? []).filter(a => a.installed).map(a => a.id) });

/** The skill already in the folder a hit installs into: the person's own, or that project's; a plugin's of the same
 * name lives elsewhere and stands in no install's way. */
const installedAs = (hit: SkillHit, report: AgentsReport | null, project: AgentsProject | undefined): SkillRow | undefined =>
  report?.skills.find(s => s.name === hit.skillId && (project === undefined ? s.scope === "user" : inProject(s, project)));

function remoteDetail(hit: SkillHit, report: AgentsReport | null, ctx: RowsContext, skills: SkillActs): DetailView {
  const picks = skills.picksOf(hit.id) ?? firstPicks(report);
  const on = ctx.on ?? ctx.computer ?? "";
  const where = whereNow(report, picks.project, on);
  const there = where.lost === undefined ? installedAs(hit, report, where.project) : undefined;
  const busy = skills.busyOf(hit.id);
  const offered = agentOptions(report, picks.project !== undefined);
  const choices: Choice[] = [
    { id: "agents", label: W.agents, many: true, options: offered, value: offered.filter(o => o.held !== undefined || picks.agents.includes(o.value)).map(o => o.value), set: agents => skills.setPicks(hit.id, { ...picks, agents }) },
    ...(where.options.length === 0
      ? []
      : [
          {
            id: "where",
            label: W.where,
            many: false,
            options: where.options,
            value: [where.value],
            ...(where.lost === undefined ? {} : { lost: where.lost }),
            set: (v: readonly string[]) => {
              const { project: _was, ...rest } = picks;
              const project = v[0] === undefined ? undefined : pickOf(report, v[0]);
              skills.setPicks(hit.id, { ...rest, ...(project === undefined ? {} : { project }) });
            },
          },
        ]),
  ];
  const install: RowAct = {
    id: "install",
    label: busy ? W.installing : W.installName(hit.skillId),
    icon: DownloadIcon,
    ...(busy ? { busy: true } : {}),
    ...(where.lost !== undefined ? { hover: where.lost } : there !== undefined ? { hover: W.alreadyOn(on) } : busy ? {} : { run: () => skills.add(hit.id, picks.agents.filter(a => offered.some(o => o.value === a && o.held === undefined)), where.project) }),
  };
  const doc = skills.remoteOf(hit.id);
  const refused = skills.refusedOf(hit.id);
  const facts: Fact[] = [
    { id: "status", label: W.status, status: there === undefined ? { state: "not-installed", tone: "quiet", words: W.notInstalled } : { state: "installed", tone: "good", words: W.installed } },
    { id: "source", label: W.source, value: hit.source },
    { id: "installs", label: W.installs, value: compactCount(hit.installs) },
  ];
  return {
    title: hit.skillId,
    lead: { kind: "glyph", icon: ScrollTextIcon },
    facts,
    acts: holdAll([install], ctx),
    // Where stays open on an installed skill, since another folder may not have it yet.
    ...(there === undefined || where.options.length > 0 ? { choices } : {}),
    doc: { ...(doc ?? { reading: true }), load: () => skills.loadRemote(hit.id) },
    ...(refused === undefined ? {} : { refused }),
  };
}

/** Add a skill: skills.sh searched by the host, each result by name and repo with its installs, or `installed`. */
function adder(ctx: RowsContext): AddModule | undefined {
  const skills = ctx.skills;
  if (skills === undefined || onImage(ctx)) return undefined;
  const hitsOf = (query: string): readonly SkillHit[] => skills.searchOf(query)?.hits ?? [];
  return {
    title: W.addSkill,
    search: W.searchSkillsSh,
    link: { label: W.skillsSh, href: "https://skills.sh" },
    ask: query => skills.search(query),
    level: (query, report) => {
      const q = query.trim();
      if (q === "") return { reading: false, rows: [], empty: W.typeToSearch };
      const search = skills.searchOf(q);
      const rows = hitsOf(q).map(hit => {
        const there = installedAs(hit, report, undefined) !== undefined;
        return { key: hit.id, title: hit.skillId, subtext: hit.source, fact: there ? W.installed : compactCount(hit.installs), ...(there ? { dim: true } : {}) };
      });
      if (search?.error !== undefined) return { reading: false, rows: [], empty: search.error };
      return { reading: search === undefined || search.reading, rows, ...(search?.hits !== undefined && rows.length === 0 ? { empty: W.noHits(q) } : {}) };
    },
    detail: (key, query, report) => {
      const hit = hitsOf(query.trim()).find(h => h.id === key);
      return hit === undefined ? undefined : remoteDetail(hit, report, ctx, skills);
    },
  };
}

export const SKILLS_KIND: KindModule<SkillRow> = {
  id: "skills",
  icon: ScrollTextIcon,
  word: "Skills",
  noun: n => `${n} ${n === 1 ? "skill" : "skills"}`,
  search: "Search skills",
  add: "Add skill",
  line: project => ["Skills on ", project === undefined ? "" : `, for ${project}`],
  rowHeight: "h-14",
  groupings: ["none", "agent", "source"],
  defaultGroup: shell => (shell === "page" ? "source" : "none"),
  items: (report: AgentsReport) => [...report.skills].sort(byName),
  count: items => items.length,
  key: rowId,
  matches: (row, q) => matchesAny(q, row.name, row.description, realPath(row), row.project?.name, ...agentsOf(row).map(agentName)),
  groups: (items, by: GroupBy): GroupView<SkillRow>[] => {
    if (by === "agent") {
      const agents = [...new Set(items.flatMap(agentsOf))];
      const shared = items.filter(s => agentsOf(s).length === 0);
      return [...agents.map(agent => ({ id: `agent-${agent}`, label: agentName(agent), items: items.filter(s => agentsOf(s).includes(agent)) })), ...(shared.length === 0 ? [] : [{ id: "shared", label: W.shared, items: shared }])];
    }
    if (by === "source") {
      const sources = SOURCES.flatMap(g => {
        const hit = items.filter(s => sourceOf(s) === g.source);
        return hit.length === 0 ? [] : [{ id: `source-${g.source}`, label: g.label, items: hit }];
      });
      return [...sources, ...projectGroups(items.filter(s => sourceOf(s) === "project"))];
    }
    return [{ id: "all", items }];
  },
  row: row => ({ key: rowId(row), title: row.name, lead: { kind: "glyph", icon: ScrollTextIcon }, marks: agentsOf(row), subtext: realPath(row), ...(isOff(row) ? { off: true } : {}) }),
  detail: (row, ctx) => {
    const source = sourceOf(row);
    // The shared folder first, then each agent's own, every one by its own path alone.
    const ordered = [...row.paths].sort((a, b) => Number(a.agent !== undefined) - Number(b.agent !== undefined));
    const status: Fact =
      source === "system"
        ? { id: "status", label: W.status, status: { ...ON, words: W.alwaysOn }, fact: W.keptCurrent }
        : source === "plugin"
          ? { id: "status", label: W.status, status: ON, fact: W.fromPlugin }
          : source === "project"
            ? { id: "status", label: W.status, status: isOff(row) ? OFF : ON, fact: W.inRepo }
            : { id: "status", label: W.status, status: isOff(row) ? OFF : ON };
    const facts: Fact[] = [
      status,
      ...(row.description === undefined ? [] : [{ id: "description", label: W.description, value: row.description }]),
      ...ordered.map((p, at) => ({ id: `path-${at}`, label: at === 0 ? W.path : "", value: p.path, copy: true, ...(p.agent === undefined ? { fact: W.shared } : { agent: p.agent }) })),
    ];
    const skills = ctx.skills;
    const refused = skills?.refusedOf(skillKey(row));
    const doc = skills?.previewOf(row);
    return {
      title: row.name,
      lead: { kind: "glyph", icon: ScrollTextIcon },
      marks: agentsOf(row),
      facts,
      acts: actsOf(row, ctx),
      ...(skills === undefined ? {} : { doc: { ...(doc ?? { reading: true }), load: () => skills.loadPreview(row) } }),
      ...(refused === undefined ? {} : { refused }),
    };
  },
  empty: on => `No skills on ${on} yet.`,
  none: "no skills",
  adder,
};

export const SKILLS = kind(SKILLS_KIND);
