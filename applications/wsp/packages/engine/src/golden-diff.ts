// SPDX-License-Identifier: AGPL-3.0-only
// The recipe diff: what a golden was built from (the digest its seal wrote)
// against the recipe now, as rows to apply on top and rows the recipe stopped
// asking for. Pure; golden.ts runs the result on a fork or on the kept builder.
import { ROAD_MODULES, isRoad } from "@wsp/catalog";
import { INSTALLER_MOVED_LINE, listedName, MCP_ID_PREFIX, NO_ROAD_WORDS, roadMovedLine, SIGN_IN_LATER, versionMovedLine, type GoldenChange, type GoldenRetired, type LoginChoice, type RecipeDigest } from "@wsp/protocol";

type Tick = RecipeDigest["ticks"][number];
type DigestFile = RecipeDigest["files"][number];

export type Change = "added" | "changed" | "removed";

export interface FileChange {
  id: string;
  dest: string;
  /** missing: still ticked but no longer on this computer; kept on the golden, with a note. */
  change: Change | "missing";
}

/** A tools row installed as a step of the tools stage. */
export interface ToolChange {
  id: string;
  label: string;
  change: Change;
  /** Versions, when the row carries one; a changed version is a reinstall. */
  from?: string;
  to?: string;
  /** Why the row installs differently under the same version: its road or its install lines moved. */
  why?: string;
}

export interface AgentChange {
  id: string;
  label: string;
  change: "added" | "removed";
}

export interface LoginChange {
  id: string;
  label: string;
  /** The login choice before and after; absent when the row was not ticked. */
  from?: LoginChoice;
  to?: LoginChoice;
}

export interface RecipeDiff {
  files: FileChange[];
  tools: ToolChange[];
  agents: AgentChange[];
  logins: LoginChange[];
}

/** A row's rung is the first segment of its id, its default label the last. */
export const rungOf = (id: string): string => id.slice(0, id.indexOf("/"));
export const nameOf = (id: string): string => id.slice(id.lastIndexOf("/") + 1);
const byRung = (ticks: readonly Tick[], rung: string): Map<string, Tick> => new Map(ticks.filter(t => rungOf(t.id) === rung).map(t => [t.id, t]));
const fileKey = (f: DigestFile): string => `${f.id}\0${f.dest}`;
const roadWords = (name: string | undefined): string => (isRoad(name) ? ROAD_MODULES[name].words : NO_ROAD_WORDS);

/** Why a ticked tool installs differently now, its version aside: the road moved, or the lines the road runs did. A
 * tick sealed before the digest carried a road says nothing of it, so nothing moves on its account alone. A pin is
 * what a build recorded, not what the recipe asks, so one moving is no change to apply. */
export function toolMove(was: Tick, now: Tick): string | undefined {
  if (was.road === undefined) return undefined;
  if (was.road !== now.road) return roadMovedLine(roadWords(was.road), roadWords(now.road));
  if (was.installer !== now.installer) return INSTALLER_MOVED_LINE;
  return undefined;
}

/** `labelOf` gives the person's words for a row; the id's last segment when the caller has none. */
export function diffRecipes(from: RecipeDigest, to: RecipeDigest, labelOf: (id: string) => string = nameOf): RecipeDiff {
  const diff: RecipeDiff = { files: [], tools: [], agents: [], logins: [] };

  const before = new Map(from.files.map(f => [fileKey(f), f]));
  const after = new Map(to.files.map(f => [fileKey(f), f]));
  for (const [key, f] of after) {
    const was = before.get(key);
    if (was === undefined) diff.files.push({ id: f.id, dest: f.dest, change: "added" });
    // A volatile entry is recorded, never hashed: its tool rewrites it, or the machine renders it, so its bytes moving is not a change to apply.
    else if (was.digest !== f.digest && was.volatile !== true && f.volatile !== true) diff.files.push({ id: f.id, dest: f.dest, change: "changed" });
  }
  // A delete needs an explicit change: the row unticked, a login no longer chosen as copy, or its dest moved. A
  // ticked file that is no longer on this computer stays on the golden.
  const tickedAfter = new Set(to.ticks.filter(t => rungOf(t.id) !== "logins" || t.choice === "copy").map(t => t.id));
  for (const [key, f] of before) {
    if (after.has(key)) continue;
    const moved = to.files.some(t => t.id === f.id && t.path === f.path && t.dest !== f.dest);
    diff.files.push({ id: f.id, dest: f.dest, change: !tickedAfter.has(f.id) || moved ? "removed" : "missing" });
  }

  const toolsBefore = byRung(from.ticks, "tools");
  const toolsAfter = byRung(to.ticks, "tools");
  for (const [id, t] of toolsAfter) {
    const was = toolsBefore.get(id);
    const pins = { ...(was?.version !== undefined ? { from: was.version } : {}), ...(t.version !== undefined ? { to: t.version } : {}) };
    if (was === undefined) {
      diff.tools.push({ id, label: labelOf(id), change: "added", ...pins });
      continue;
    }
    const why = was.version === t.version ? toolMove(was, t) : undefined;
    if (was.version !== t.version || why !== undefined) diff.tools.push({ id, label: labelOf(id), change: "changed", ...pins, ...(why !== undefined ? { why } : {}) });
  }
  for (const [id, t] of toolsBefore) if (!toolsAfter.has(id)) diff.tools.push({ id, label: labelOf(id), change: "removed", ...(t.version !== undefined ? { from: t.version } : {}) });

  const agentsBefore = byRung(from.ticks, "agents");
  const agentsAfter = byRung(to.ticks, "agents");
  for (const id of agentsAfter.keys()) if (!agentsBefore.has(id)) diff.agents.push({ id, label: labelOf(id), change: "added" });
  for (const id of agentsBefore.keys()) if (!agentsAfter.has(id)) diff.agents.push({ id, label: labelOf(id), change: "removed" });

  const loginsBefore = byRung(from.ticks, "logins");
  const loginsAfter = byRung(to.ticks, "logins");
  for (const id of new Set([...loginsBefore.keys(), ...loginsAfter.keys()])) {
    const was = loginsBefore.get(id);
    const now = loginsAfter.get(id);
    if (was?.choice === now?.choice) continue;
    diff.logins.push({ id, label: labelOf(id), ...(was?.choice !== undefined ? { from: was.choice } : {}), ...(now?.choice !== undefined ? { to: now.choice } : {}) });
  }
  return diff;
}

export function isEmptyDiff(d: RecipeDiff): boolean {
  return d.files.length + d.tools.length + d.agents.length + d.logins.length === 0;
}

/** The rows the delta plans like a first build: the row of every added or
 * changed file, every added or changed tool, every added agent, and every
 * login now chosen as copy. A row re-ships all of its paths. */
export function rowsToApply(d: RecipeDiff): Set<string> {
  const ids = new Set<string>();
  for (const f of d.files) if (f.change === "added" || f.change === "changed") ids.add(f.id);
  for (const t of d.tools) if (t.change !== "removed") ids.add(t.id);
  for (const a of d.agents) if (a.change === "added") ids.add(a.id);
  for (const l of d.logins) if (l.to === "copy") ids.add(l.id);
  return ids;
}

/** What the next version's image carries that its recipe no longer asks for. An update leaves every dropped row on
 * the image: uninstalling asks each manager for an inverse it may not have, on a disk the next full build throws
 * away anyway, so the row is recorded against the version instead and the lineage says what a fork still carries.
 * `previous` is the version being updated; a row ticked again leaves the list at the version that installs it. */
export function retiredBy(d: RecipeDiff, previous: readonly GoldenRetired[] = []): GoldenRetired[] {
  const back = rowsToApply(d);
  const dropped: GoldenRetired[] = [
    ...d.files.filter(f => f.change === "removed").map(f => ({ id: f.id, name: `~/${f.dest}` })),
    ...d.tools.filter(t => t.change === "removed").map(t => ({ id: t.id, name: t.label })),
    ...d.agents.filter(a => a.change === "removed").map(a => ({ id: a.id, name: a.label })),
  ];
  const rows = [...previous.filter(p => !back.has(p.id)), ...dropped.filter(r => !back.has(r.id))];
  return [...new Map(rows.map(r => [r.id, r])).values()];
}

/** What an update does with one login answer. `needsFreshMachine` is true for an answer that only takes on a
 * machine built for it: a sign-in wants a pty on a builder before the seal, so it never reaches a machine that is
 * already running. A key and a token are read out of the vault at every launch, so they reach one. */
interface LoginAnswer {
  line: (label: string) => string;
  needsFreshMachine: boolean;
}

/** One entry per answer the sign-ins screen can give, keyed by the union itself: a fifth answer fails to compile
 * here until it says what it does and whether an update can land it. This is the one place that knows, so the words
 * and the road can never drift apart the way they did when a new answer fell through a catch-all. */
const LOGIN_ANSWERS: Record<LoginChoice, LoginAnswer> = {
  copy: { line: label => `copy the ${label}`, needsFreshMachine: false },
  machine: { line: label => `${label}: a sign-in during the build is not done by an update, so it would not be in the golden; pick the rebuild for it`, needsFreshMachine: true },
  later: { line: label => `${label}: nothing runs for it here; ${SIGN_IN_LATER} on the workspace`, needsFreshMachine: false },
  key: { line: label => `${label}: the API key is held on this computer and set on every turn, so nothing of it lands on the machine`, needsFreshMachine: false },
  skip: { line: label => `retire the ${label}, left signed in on the image`, needsFreshMachine: false },
  token: { line: label => `${label}: the token is held on this computer and set on every turn, so nothing of it lands on the machine`, needsFreshMachine: false },
};

/** A login row the new recipe carries no answer for reads as a skip: the row left the recipe, so the update stops
 * asking for that login and the sign-in stays on the image, which is what skipping it does too. */
const answerFor = (choice: LoginChoice | undefined): LoginAnswer => LOGIN_ANSWERS[choice ?? "skip"];

/** One line per change, for the person. */
export function describeDiff(d: RecipeDiff): string[] {
  const lines: string[] = [];
  const group = (change: Change, items: string[], noun: string): void => {
    if (items.length === 0) return;
    const verb = change === "added" ? "add" : change === "changed" ? "update" : "retire";
    const tail = change === "removed" ? ", left on the image" : "";
    lines.push(`${verb} ${items.length} ${noun}${items.length === 1 ? "" : "s"}: ${items.join(", ")}${tail}`);
  };
  for (const change of ["added", "changed", "removed"] as const) {
    group(change, d.files.filter(f => f.change === change).map(f => `~/${f.dest}`), "file");
    if (change === "changed") for (const f of d.files.filter(x => x.change === "missing")) lines.push(`kept on the golden, no longer on this computer: ~/${f.dest}`);
    group(change, d.tools.filter(t => t.change === change).map(t => (change === "changed" ? `${listedName(t.label)} (${t.why ?? versionMovedLine(t.from, t.to)})` : listedName(t.label))), "tool");
    if (change !== "changed") {
      const agents = d.agents.filter(a => a.change === change);
      group(change, agents.filter(a => !a.id.startsWith(MCP_ID_PREFIX)).map(a => a.label), "agent");
      group(change, agents.filter(a => a.id.startsWith(MCP_ID_PREFIX)).map(a => a.label), "MCP server");
    }
  }
  for (const l of d.logins) lines.push(answerFor(l.to).line(l.label));
  return lines;
}

/** What the build line counts: added and changed rows by noun, then everything the update retires as one. Logins
 * are counted by what the update does with them, so a row moved to sign in on the machine is not counted here at
 * all: that change takes the rebuild road. */
export function changeCounts(d: RecipeDiff): GoldenChange[] {
  const added = (n: number, noun: string): GoldenChange => ({ count: n, noun, word: "added" });
  return [
    added(d.files.filter(f => f.change === "added").length, "file"),
    { count: d.files.filter(f => f.change === "changed").length, noun: "file", word: "updated" },
    added(d.tools.filter(t => t.change === "added").length, "tool"),
    { count: d.tools.filter(t => t.change === "changed").length, noun: "tool", word: "updated" },
    added(d.agents.filter(a => a.change === "added").length, "agent"),
    added(d.logins.filter(l => l.to === "copy").length, "login"),
    { count: retiredBy(d).length, noun: "row", word: "retired" },
  ];
}

/** A change small enough that applying it on a fork beats a rebuild: no
 * agent to install, no login answer needing a machine built for it, at most
 * this many tool installs, and this much to upload. `bytesOf` is a row's size on this computer. */
export const SMALL_TOOLS = 5;
export const SMALL_BYTES = 50 * 1024 * 1024;

export function isSmallDelta(d: RecipeDiff, bytesOf: (id: string) => number): boolean {
  if (d.agents.some(a => a.change === "added")) return false;
  if (d.logins.some(l => answerFor(l.to).needsFreshMachine)) return false;
  if (d.tools.filter(t => t.change !== "removed").length > SMALL_TOOLS) return false;
  const bytes = [...rowsToApply(d)].filter(id => rungOf(id) !== "tools").reduce((n, id) => n + bytesOf(id), 0);
  return bytes <= SMALL_BYTES;
}
