// SPDX-License-Identifier: AGPL-3.0-only
// The Agents tab: every agent on the computer's login PATH, then the ones the
// catalog could put there. An installed row says its version and its sign-in
// state under its name, and offers Sign in where none stands, else Open in
// terminal; the detail says who the agent is and the rest, next step first.
import { BotIcon, CircleArrowUpIcon, DownloadIcon, SquareTerminalIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { catalogEntry, installShown, runsThreads, type AgentEntry } from "@wsp/catalog";
import { compareVersions, MCP_SERVER_NAME, type AgentRow, type AgentsReport } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, agentSignInStart, editImageAct, heldReason, holdAll, notYet, onImage, signInAct, waitingFlow, type RowAct, type RowsContext } from "../agentsRows.js";
import { kind, matchesAny, rowKey, type Fact, type KindModule, type Status } from "./kind.js";

export interface AgentItem {
  readonly row: AgentRow;
  /** The file that names the wsp tools for it, where one does. */
  readonly toolsFile?: string;
}

/** Whether a turn there needs no sign-in first: its own login stands, or the key this host keeps for it. */
export const signedIn = (row: Pick<AgentRow, "signIn">): boolean => row.signIn === "signed-in" || row.signIn === "vault-key";

/** The one word for where an agent's sign-in stands, which every row that draws an agent's state reads. */
export const signInWord = (row: Pick<AgentRow, "signIn">): string =>
  row.signIn === "signed-in" ? W.signedIn : row.signIn === "vault-key" ? W.yourKey : row.signIn === "none" ? W.needsSignIn : W.notChecked;

/** Where an agent's sign-in stands as a dot and its word: working, waiting on a sign-in, or not known. */
export const signInStatus = (row: Pick<AgentRow, "signIn">): Status => ({
  state: row.signIn,
  tone: signedIn(row) ? "good" : row.signIn === "none" ? "waiting" : "quiet",
  words: signInWord(row),
});

/** The newer version its vendor publishes, where one is newer than what stands there. */
const newerThan = (row: AgentRow): string | undefined => (row.version !== undefined && row.latest !== undefined && compareVersions(row.latest, row.version) > 0 ? row.latest : undefined);

const ownHold = (row: AgentRow): string | undefined => (row.road === "own" ? W.ownHold : row.road === "shim" ? W.shimHold : undefined);

/** An agent's row by its id, which its sign-in's flow is kept under wherever the row is drawn. */
export const agentRowId = (agent: string): string => rowKey(["agent"], undefined, agent);

const rowId = (row: AgentRow): string => agentRowId(row.id);

const agentEntry = (id: string): AgentEntry | undefined => {
  const e = catalogEntry(id);
  return e?.kind === "agent" ? e : undefined;
};

/** Starts the agent in the task's own terminal, where the list stands in a task's panel on this computer. */
function openAct(row: AgentRow, ctx: RowsContext): RowAct {
  const bin = agentEntry(row.id)?.bin ?? row.id;
  const typeIn = ctx.typeInTerminal;
  return { id: "open-terminal", label: W.openInTerminal, icon: SquareTerminalIcon, inPlace: true, ...(typeIn === undefined ? { hover: W.fromPanel } : { run: () => typeIn(bin) }) };
}

/** Every act the agent offers where the list stands, next step first. */
function actsOf(item: AgentItem, ctx: RowsContext) {
  const { row } = item;
  if (onImage(ctx)) return { acts: [editImageAct(ctx)] as RowAct[], flow: undefined, step: undefined };
  if (!row.installed) {
    const acts = holdAll([notYet("install", W.install, DownloadIcon)], ctx);
    return { acts, flow: undefined, step: acts[0] };
  }
  const latest = newerThan(row);
  const hold = ownHold(row);
  const signIn = signInAct(rowId(row), agentSignInStart(row, ctx), ctx);
  const adding = ctx.acts?.adding(row.id) === true;
  const addTools: RowAct =
    ctx.where !== "here"
      ? { id: "add-tools", label: W.addTools, icon: WrenchIcon, hover: W.toolsHereOnly }
      : { id: "add-tools", label: W.addTools, icon: WrenchIcon, ...(adding ? { busy: true } : ctx.acts === undefined ? {} : { run: () => ctx.acts!.addTools(row.id) }) };
  const update = notYet("update", W.update, CircleArrowUpIcon, hold === undefined ? {} : { hover: hold });
  const uninstall = notYet("uninstall", W.uninstall, Trash2Icon, { destructive: true, ...(hold === undefined ? {} : { hover: hold }) });
  const running = signIn.act.id === "cancel";
  const tools = row.wspTools ? [] : [addTools];
  const updates = latest === undefined ? [] : [update];
  const open = openAct(row, ctx);
  // Signed in, the next sign-in step is Sign out, which has no road yet; the agent itself is the step.
  const [step, acts]: [RowAct | undefined, RowAct[]] =
    signedIn(row) && !running
      ? [open, [...updates, ...tools, open, uninstall]]
      : row.signInRoad === "none" && !running
        ? [undefined, [...updates, ...tools, uninstall]]
        : [signIn.act, [signIn.act, ...tools, ...updates, uninstall]];
  const held = holdAll(acts, ctx);
  return { acts: held, flow: heldReason(ctx) === undefined ? signIn.flow : undefined, step: step === undefined ? undefined : held.find(a => a.id === step.id) };
}

/** Who the agent is off its catalog entry: the maker, the license and the two pages, the address without its scheme. */
function aboutFacts(entry: AgentEntry | undefined): Fact[] {
  if (entry === undefined) return [];
  const { about } = entry;
  const page = (id: string, label: string, href: string): Fact => ({ id, label, value: href.replace(/^https:\/\//, ""), href });
  return [
    { id: "made-by", label: W.madeBy, value: about.creator },
    { id: "license", label: W.license, value: about.license },
    ...(about.homepage === undefined ? [] : [page("homepage", W.homepage, about.homepage)]),
    ...(about.repo === undefined ? [] : [page("repo", W.repo, about.repo)]),
  ];
}

/** Whether wsp opens threads on it, or installs and manages it only. */
const threadsFact = (row: AgentRow): Fact => ({ id: "threads", label: W.threads, value: runsThreads(row.id) ? W.threadsInWsp : W.threadsNotYet });

/** The line that installs it, to copy; a road no one line installs by says where it installs from instead. */
function installFact(entry: AgentEntry | undefined): Fact[] {
  if (entry === undefined) return [];
  const said = installShown(entry);
  return [{ id: "install", label: W.install, ...("line" in said ? { value: said.line, line: true } : { value: said.words, muted: true }) }];
}

export const AGENTS_KIND: KindModule<AgentItem> = {
  id: "agents",
  icon: BotIcon,
  word: "Agents",
  noun: n => `${n} ${n === 1 ? "agent" : "agents"}`,
  line: () => ["Agents on ", ""],
  rowHeight: "h-[72px]",
  groupings: [],
  defaultGroup: () => "none",
  items: (report: AgentsReport) =>
    report.agents.map(row => {
      const toolsFile = report.servers.find(s => s.agent === row.id && s.name === MCP_SERVER_NAME)?.file;
      return { row, ...(toolsFile === undefined ? {} : { toolsFile }) };
    }),
  count: items => items.filter(i => i.row.installed).length,
  key: item => rowId(item.row),
  matches: (item, q) => matchesAny(q, item.row.name, item.row.version),
  groups: items => {
    const installed = items.filter(i => i.row.installed);
    const available = items.filter(i => !i.row.installed);
    return [...(installed.length === 0 ? [] : [{ id: "installed", items: installed }]), ...(available.length === 0 ? [] : [{ id: "available", label: "Available to install", items: available }])];
  },
  row: (item, ctx) => {
    const { row } = item;
    const { step, flow } = actsOf(item, ctx);
    const quick = onImage(ctx) || waitingFlow(flow) ? undefined : step;
    if (!row.installed) {
      const about = agentEntry(row.id)?.about.description;
      return { key: rowId(row), title: row.name, lead: { kind: "agent", agent: row.id }, available: true, ...(about === undefined ? {} : { subtext: about }), ...(quick === undefined ? {} : { quick }) };
    }
    return {
      key: rowId(row),
      title: row.name,
      lead: { kind: "agent", agent: row.id },
      ...(row.version === undefined ? {} : { subtext: row.version }),
      status: waitingFlow(flow) ? { ...signInStatus(row), words: W.waitingOnYou } : signInStatus(row),
      ...(quick === undefined ? {} : { quick }),
    };
  },
  detail: (item, ctx) => {
    const { row } = item;
    const entry = agentEntry(row.id);
    const { acts, flow } = actsOf(item, ctx);
    const latest = newerThan(row);
    const versionFact = [latest === undefined ? undefined : W.latest(latest), row.pinned !== undefined && row.pinned !== row.version ? W.pins(row.pinned) : undefined].filter(Boolean).join(", ");
    const installedNote = [row.road === "own" ? W.own : row.road === "shim" && row.via === undefined ? W.shim : undefined, row.via === undefined ? undefined : W.viaShim(row.via)].filter(Boolean).join(", ");
    const facts: Fact[] = row.installed
      ? [
          { id: "status", label: W.status, status: signInStatus(row), ...(row.signInRoad !== "none" ? { fact: W.roads[row.signInRoad] } : {}) },
          ...(row.version === undefined ? [] : [{ id: "version", label: W.version, value: row.version, ...(versionFact === "" ? {} : { fact: versionFact }) }]),
          { id: "installed-at", label: W.installedAt, ...(row.path === undefined ? {} : { value: row.path, copy: true }), ...(installedNote === "" ? {} : { fact: installedNote }) },
          { id: "wsp-tools", label: W.wspTools, ...(item.toolsFile === undefined ? { value: W.notAdded, muted: true } : { value: item.toolsFile, copy: true }) },
          threadsFact(row),
          ...aboutFacts(entry),
        ]
      : [{ id: "status", label: W.status, status: { state: "not-installed", tone: "quiet", words: W.notInstalled } }, ...(row.latest === undefined ? [] : [{ id: "latest", label: W.latestLabel, value: row.latest }]), threadsFact(row), ...aboutFacts(entry), ...installFact(entry)];
    return {
      title: row.name,
      lead: { kind: "agent", agent: row.id },
      ...(entry === undefined ? {} : { about: entry.about.description }),
      facts,
      acts,
      ...(flow === undefined ? {} : { flow }),
    };
  },
  empty: on => `No agents found on ${on}.`,
  none: "no agents",
};

export const AGENTS = kind(AGENTS_KIND);
