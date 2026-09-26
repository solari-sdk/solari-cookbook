// SPDX-License-Identifier: AGPL-3.0-only
// The MCP servers tab: one entry per server across agents, folded where two
// agents in one scope name the same server with the same command or address.
// The row says where it is reached and its state as a dot and a word; the
// detail is the /mcp view: status, command, names, each agent's file, the
// tools, and the next step first. A server's state is what its one tools
// connect answered, asked when the tab shows it for the person's own servers,
// a command only on this computer and elsewhere on Check, and on List tools
// for a project's; no press but a sign-in, Reconnect or Read
// again asks again, so opening the tools changes nothing. Turn off and on and
// Remove act on every agent the entry is set up for, and Add an MCP server is
// a form in place of the list.
import { ActivityIcon, PlugIcon, PowerIcon, PowerOffIcon, RefreshCwIcon, ServerIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { agentName, mcpSwitch } from "@wsp/catalog";
import type { AgentsProject, AgentsReport, McpRow, McpTool, McpToolParam, ServerToolsAnswer } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, editImageAct, heldReason, holdAll, notYet, onImage, serverSignInStart, signInAct, waitingFlow, type FlowView, type RowAct, type RowsContext, type ToolsState } from "../agentsRows.js";
import { AddServerForm } from "../AddServerForm.js";
import { byName, kind, matchesAny, projectGroups, rowKey, type Fact, type GroupBy, type GroupView, type KindModule, type Lead, type ServerState, type Status, type UnderRow } from "./kind.js";

/** Where a server is set up: the person's own files, or the project's. */
type Scope = "global" | "project";

export interface ServerEntry {
  readonly key: string;
  readonly name: string;
  readonly scope: Scope;
  /** The project a project server is set up in. */
  readonly project?: AgentsProject;
  /** The command with its values hidden, or the address. */
  readonly reach: string;
  readonly stdio: boolean;
  /** One per agent it is set up for, in the report's order. */
  readonly rows: readonly McpRow[];
}

const scopeOf = (row: McpRow): Scope => (row.scope === "project" ? "project" : "global");
const reachOf = (row: McpRow): string => (row.transport.kind === "stdio" ? row.transport.line : row.transport.host);
/** The box a server's row and detail lead with: its own icon where it is reached over an address. */
const leadOf = (entry: ServerEntry): Lead => ({ kind: "box", icon: ServerIcon, ...(entry.stdio || entry.reach === "" ? {} : { host: entry.reach }) });
const rowId = (row: McpRow): string => rowKey(["server", row.agent, row.scope], row.project, row.name);

/** One entry per server: the same name reached the same way in the same scope, and the same project, is one server
 * set up for each agent. */
export function foldServers(rows: readonly McpRow[]): ServerEntry[] {
  const out = new Map<string, { name: string; scope: Scope; project?: AgentsProject; reach: string; stdio: boolean; rows: McpRow[] }>();
  for (const row of rows) {
    const key = [scopeOf(row), ...(row.project === undefined ? [] : [row.project.id]), row.name, row.transport.kind, reachOf(row)].join("\0");
    const was = out.get(key);
    if (was === undefined) out.set(key, { name: row.name, scope: scopeOf(row), ...(row.project !== undefined ? { project: row.project } : {}), reach: reachOf(row), stdio: row.transport.kind === "stdio", rows: [row] });
    else was.rows.push(row);
  }
  return [...out].map(([key, e]) => ({ key: `server-${key.replaceAll("\0", "-")}`, ...e }));
}

/** A command server of the person's own on a computer other than this one, which a check would start there: it waits
 * for Check, since a joined computer may run more than the person's agents. */
const heldCommand = (row: McpRow, ctx: RowsContext): boolean => row.transport.kind === "stdio" && row.scope !== "project" && (ctx.where === "box" || ctx.where === "box-task" || ctx.where === "fork");

/** Whether a row's tools connect is asked the moment the tab shows it: the person's own servers that are on and take no
 * key from the environment, wherever the report is live, a command only on this computer. A project's are what a repo
 * names, asked on List tools. */
export const checksOnShow = (row: McpRow, ctx: RowsContext): boolean =>
  ctx.tools !== undefined && ctx.where !== "provider" && (ctx.heldWhy ?? null) === null && row.enabled && row.scope !== "project" && row.auth !== "env-key" && !heldCommand(row, ctx);

/** One agent's state for a server: off, then what its connect answered, `checking` while that answer is on its way,
 * and the config's own word for a server nothing asked. */
export function rowState(row: McpRow, s: ToolsState | undefined, ctx: RowsContext): ServerState {
  if (!row.enabled) return "off";
  if (s?.answer !== undefined) return s.answer.auth;
  if (s?.listing === true) return "checking";
  if (s?.error !== undefined) return "failed";
  return checksOnShow(row, ctx) ? "checking" : heldCommand(row, ctx) ? "unknown" : row.auth;
}

/** Worst first: what a folded entry's one status says. */
const WORST: readonly ServerState[] = ["failed", "needs-sign-in", "off", "checking", "unknown", "env-key", "open", "signed-in", "connected"];

interface Standing {
  readonly row: McpRow;
  readonly state: ServerState;
  readonly answer?: ServerToolsAnswer;
  readonly listing: boolean;
  readonly error?: string;
  /** Why a command there waits for Check. */
  readonly held?: string;
}

const standings = (entry: ServerEntry, ctx: RowsContext): Standing[] =>
  entry.rows.map(row => {
    const s = ctx.tools?.of(row);
    const held = s === undefined && heldCommand(row, ctx) ? W.checkStarts(ctx.on ?? ctx.computer ?? "") : undefined;
    return { row, state: rowState(row, s, ctx), listing: s?.listing === true, ...(s?.answer === undefined ? {} : { answer: s.answer }), ...(s?.error === undefined ? {} : { error: s.error }), ...(held === undefined ? {} : { held }) };
  });

const worstOf = (all: readonly Standing[]): Standing => [...all].sort((a, b) => WORST.indexOf(a.state) - WORST.indexOf(b.state))[0]!;

/** The standing whose connect speaks for the server's tools: one that listed them, else one that answered or is
 * asking. */
const askedOf = (all: readonly Standing[]): Standing | undefined => all.find(s => s.answer?.tools !== undefined) ?? all.find(s => s.answer !== undefined || s.error !== undefined || s.listing);

export function statusOf(s: Standing): Status {
  const { state } = s;
  const tools = s.answer?.tools;
  switch (state) {
    case "connected":
    case "signed-in":
      return { state, tone: "good", words: state === "connected" ? W.connected : W.signedIn, ...(tools === undefined ? {} : { count: W.toolsCount(tools.length) }) };
    case "checking":
      return { state, tone: "quiet", words: W.checking };
    case "open":
      return { state, tone: "quiet", words: W.noSignInNeeded };
    case "env-key":
      return { state, tone: "quiet", words: W.keyFromEnvironment };
    case "needs-sign-in":
      return { state, tone: "waiting", words: W.needsSignIn, hover: W.signInToSee };
    case "failed": {
      const why = s.error ?? s.answer?.refused;
      return { state, tone: "bad", words: W.failed, ...(why === undefined ? {} : { hover: why }) };
    }
    case "off":
      return { state, tone: "quiet", words: W.off };
    case "unknown":
      return { state, tone: "quiet", words: W.notChecked, ...(s.answer?.holder !== undefined ? { hover: W.holdsSignIn(agentName(s.answer.holder)) } : s.held !== undefined ? { hover: s.held } : {}) };
  }
}

/** The acts, next step first, and the sign-in flow standing for any of the entry's agents. */
function actsOf(entry: ServerEntry, ctx: RowsContext, openUnder: () => void) {
  const all = standings(entry, ctx);
  const worst = worstOf(all);
  const asked = askedOf(all);
  if (ctx.where === "provider") return { all, worst, asked, acts: [] as RowAct[], signIns: new Map<string, RowAct>(), flow: undefined as FlowView | undefined };
  const tools = ctx.tools;
  const check: RowAct = {
    id: "check",
    label: W.check,
    icon: ActivityIcon,
    hover: W.startsOnce,
    inPlace: true,
    ...(tools === undefined ? {} : { run: () => entry.rows.forEach(r => tools.list(r)) }),
  };
  const waitsForCheck = asked?.answer === undefined && asked?.listing !== true && entry.rows.some(r => heldCommand(r, ctx));
  // A fork is a copy of the image, so its one act besides Check is the image's.
  if (onImage(ctx)) return { all, worst, asked, acts: [...(waitsForCheck ? [check] : []), editImageAct(ctx)], signIns: new Map<string, RowAct>(), flow: undefined };
  const primary = asked?.row ?? worst.row;
  const list: RowAct = {
    id: "list-tools",
    label: W.listTools,
    icon: WrenchIcon,
    hover: W.startsOnce,
    ...(tools === undefined
      ? {}
      : {
          run: () => {
            tools.list(primary);
            openUnder();
          },
        }),
  };
  const listing = asked?.listing === true;
  const reconnect: RowAct = { id: "reconnect", label: listing ? W.listing : W.reconnect, icon: RefreshCwIcon, ...(listing ? { busy: true } : tools === undefined ? {} : { run: () => tools.list(worst.state === "failed" ? worst.row : primary, true) }) };
  const view: RowAct = { id: "view-tools", label: W.viewTools, icon: WrenchIcon, ...(asked?.answer?.holder !== undefined && asked.answer.tools === undefined ? { hover: W.holdsSignIn(agentName(asked.answer.holder)) } : {}), run: openUnder };
  const servers = ctx.servers;
  const busy = servers?.busyOf(entry.key) === true;
  // A server turns off only where every agent it is set up for keeps a switch per server.
  const unswitched = entry.rows.find(r => !mcpSwitch(r.agent));
  const turn = (on: boolean): RowAct => {
    const [id, label, icon] = on ? (["turn-on", W.turnOn, PowerIcon] as const) : (["turn-off", W.turnOff, PowerOffIcon] as const);
    if (servers === undefined) return notYet(id, label, icon);
    if (unswitched !== undefined) return notYet(id, label, icon, { hover: W.noSwitch(agentName(unswitched.agent)) });
    return { id, label, icon, ...(busy ? { busy: true } : { run: () => servers.toggle(entry.key, entry.rows.filter(r => r.enabled !== on), on) }) };
  };
  const turnOff = turn(false);
  const turnOn = turn(true);
  const files = [...new Set(entry.rows.map(r => r.file))];
  const remove: RowAct =
    servers === undefined
      ? notYet("remove", W.remove, Trash2Icon, { destructive: true })
      : { id: "remove", label: W.remove, icon: Trash2Icon, destructive: true, confirm: { title: W.removeTitle(entry.name), body: W.leavesFiles(files, ctx.on ?? ctx.computer ?? "") }, ...(busy ? { busy: true } : { run: () => servers.remove(entry.key, entry.rows) }) };
  // Each agent that needs its own sign-in, and the flow any one of them drew.
  const signIns = new Map<string, RowAct>();
  let flow: FlowView | undefined;
  for (const s of all) {
    const made = signInAct(rowId(s.row), serverSignInStart(s.row, ctx), ctx);
    if (made.flow !== undefined && flow === undefined) flow = made.flow;
    if (s.state === "needs-sign-in" || made.act.id === "cancel" || (s.state === "unknown" && !entry.stdio)) signIns.set(s.row.agent, made.act);
  }
  const signIn = signIns.get(worst.row.agent) ?? [...signIns.values()][0];
  const withSignIn = signIn === undefined ? [] : [signIn];
  const acts: RowAct[] =
    worst.state === "needs-sign-in"
      ? [...withSignIn, turnOff, remove]
      : worst.state === "failed"
        ? [reconnect, turnOff, remove]
        : worst.state === "off"
          ? [turnOn, remove]
          : worst.state === "checking"
            ? [turnOff, remove]
            : asked?.answer !== undefined
              ? [view, ...withSignIn, reconnect, turnOff, remove]
              : entry.rows.some(r => heldCommand(r, ctx))
                ? [check, turnOff, remove]
                : [list, ...withSignIn, turnOff, remove];
  // Opening the tools reads the answer already here, so it stands wherever the other acts are held.
  const held = holdAll(acts, ctx).map(a => (a.id === view.id ? view : a));
  return { all, worst, asked, acts: held, signIns, flow: heldReason(ctx) === undefined ? flow : undefined };
}

const NO_NAV = (): void => {};

/** A tool as a row of its server's tools, and its own level: the description whole, then each parameter by name with
 * its type and whether a call needs it. */
function toolRow(tool: McpTool): UnderRow {
  const facts = (p: McpToolParam): string | undefined => [p.type, p.required ? W.required : undefined].filter(w => w !== undefined).join(", ") || undefined;
  return {
    key: tool.name,
    title: tool.name,
    ...(tool.description === undefined ? {} : { subtext: tool.description, body: tool.description }),
    ...(tool.params === undefined
      ? {}
      : {
          list: {
            label: W.parameters,
            items: tool.params.map(p => {
              const fact = facts(p);
              return { name: p.name, ...(fact === undefined ? {} : { fact }), ...(p.description === undefined ? {} : { about: p.description }) };
            }),
          },
        }),
  };
}

/** Global first, then one group per project, each by its name with its folder. */
function scopeGroups(items: readonly ServerEntry[], ctx: RowsContext): GroupView<ServerEntry>[] {
  const global = items.filter(e => e.scope === "global");
  return [...(global.length === 0 ? [] : [{ id: "global", label: "Global", items: global }]), ...projectGroups(items.filter(e => e.scope === "project"))];
}

export const SERVERS_KIND: KindModule<ServerEntry> = {
  id: "servers",
  icon: PlugIcon,
  word: "MCP servers",
  noun: n => `${n} ${n === 1 ? "server" : "servers"}`,
  search: "Search MCP servers",
  add: "Add MCP server",
  line: project => ["MCP servers on ", project === undefined ? "" : `, for ${project}`],
  rowHeight: "h-[84px]",
  groupings: ["scope", "agent", "none"],
  defaultGroup: () => "scope",
  items: (report: AgentsReport) => foldServers(report.servers).sort(byName),
  count: items => items.length,
  key: entry => entry.key,
  matches: (entry, q) => matchesAny(q, entry.name, entry.reach, entry.project?.name, ...entry.rows.flatMap(r => [agentName(r.agent), r.file])),
  groups: (items, by: GroupBy, ctx) => {
    if (by === "none") return [{ id: "all", items }];
    if (by === "agent") {
      const agents = [...new Set(items.flatMap(e => e.rows.map(r => r.agent)))];
      return agents.map(agent => ({ id: `agent-${agent}`, label: agentName(agent), items: items.filter(e => e.rows.some(r => r.agent === agent)) }));
    }
    return scopeGroups(items, ctx);
  },
  row: (entry, ctx) => {
    const { worst, acts, flow } = actsOf(entry, ctx, NO_NAV);
    const status = statusOf(worst);
    const step =
      worst.state === "needs-sign-in" ? acts.find(a => a.id === "sign-in" || a.id === "cancel") : worst.state === "failed" ? acts.find(a => a.id === "reconnect") : worst.state === "off" ? acts.find(a => a.id === "turn-on") : acts.find(a => a.id === "check");
    const quick = waitingFlow(flow) || (onImage(ctx) && step?.id !== "check") ? undefined : step;
    return {
      key: entry.key,
      title: entry.name,
      lead: leadOf(entry),
      marks: entry.rows.map(r => r.agent),
      subtext: entry.reach,
      status: waitingFlow(flow) ? { ...status, words: W.waitingOnYou } : status,
      ...(quick === undefined ? {} : { quick }),
    };
  },
  detail: (entry, ctx, nav) => {
    const { all, worst, asked, acts, signIns, flow } = actsOf(entry, ctx, nav.openUnder);
    const listed = asked?.answer?.tools;
    // The detail's Tools line carries the count, so its status says the word alone.
    const { count: _count, ...status } = statusOf(worst);
    const first = entry.rows[0]!;
    const names = [...new Set(entry.rows.flatMap(r => r.envNames))].join(", ");
    const disagree = new Set(all.map(s => s.state)).size > 1;
    const holder = asked?.answer?.holder;
    const refused = asked?.error ?? asked?.answer?.refused;
    const wrote = ctx.servers?.refusedOf(entry.key);
    const toolsFact: Fact =
      listed !== undefined
        ? { id: "tools", label: W.tools, value: W.toolsCount(listed.length) }
        : holder !== undefined
          ? { id: "tools", label: W.tools, value: W.keepsSignIn(agentName(holder)), muted: true }
          : { id: "tools", label: W.tools, value: worst.state === "needs-sign-in" ? W.signInToSee : W.notListed, muted: true };
    const recipe = entry.rows.find(r => r.inRecipe !== undefined)?.inRecipe;
    const facts: Fact[] = [
      { id: "status", label: W.status, status, ...(status.state === "failed" && status.hover !== undefined ? { fact: status.hover } : {}) },
      { id: "reach", label: entry.stdio ? W.command : W.url, value: entry.reach, copy: true },
      ...(names === "" ? [] : [{ id: "names", label: entry.stdio ? W.environment : W.headers, value: names, muted: true }]),
      ...all.map((s, at) => {
        const act = disagree && entry.rows.length > 1 ? signIns.get(s.row.agent) : undefined;
        return {
          id: `config-${s.row.agent}`,
          label: at === 0 ? W.configLocation : "",
          value: s.row.file,
          agent: s.row.agent,
          copy: true,
          ...(disagree ? { fact: statusOf(s) } : {}),
          ...(act === undefined ? {} : { act: heldReason(ctx) === undefined ? act : { ...act, hover: heldReason(ctx)! } }),
        } satisfies Fact;
      }),
      toolsFact,
      ...(recipe === undefined ? [] : [{ id: "recipe", label: W.recipe, value: recipe ? W.inRecipe : W.notInRecipe, muted: !recipe }]),
    ];
    const tools = asked?.row ?? first;
    const refresh = ctx.tools === undefined || heldReason(ctx) !== undefined || onImage(ctx) ? undefined : () => ctx.tools!.list(tools, true);
    const quiet = refused !== undefined || listed !== undefined ? undefined : holder !== undefined ? W.keepsSignIn(agentName(holder)) : worst.state === "needs-sign-in" ? W.signInToSee : undefined;
    return {
      title: entry.name,
      lead: leadOf(entry),
      marks: entry.rows.map(r => r.agent),
      facts,
      acts,
      ...(flow === undefined ? {} : { flow }),
      ...(wrote !== undefined ? { refused: wrote } : refused === undefined ? {} : { refused }),
      under: {
        title: W.toolsOf(entry.name),
        reading: asked?.listing === true || worst.state === "checking",
        ...(listed === undefined ? {} : { rows: listed.map(toolRow) }),
        ...(asked?.answer === undefined ? {} : { readAt: asked.answer.readAt }),
        ...(refused === undefined ? {} : { refused }),
        ...(quiet === undefined ? {} : { empty: quiet }),
        ...(refresh === undefined ? {} : { refresh }),
      },
    };
  },
  shown: (entries, ctx) => {
    const tools = ctx.tools;
    if (tools === undefined) return;
    for (const row of entries.flatMap(e => e.rows)) if (checksOnShow(row, ctx) && tools.of(row)?.listing !== true) tools.list(row);
  },
  empty: on => `No MCP servers on ${on} yet.`,
  none: "no MCP servers",
  form: ctx => (ctx.servers === undefined || onImage(ctx) ? undefined : { title: W.addServer, Form: AddServerForm }),
};

export const SERVERS = kind(SERVERS_KIND);
