// SPDX-License-Identifier: AGPL-3.0-only
// The agents report off one computer or workspace. Which machine a target is,
// and what that computer already said about itself, is the runtime's to know;
// reading the agents, skills and servers off it is the host's, since the
// catalog's readers live there. A read never wakes a machine.
import { randomBytes } from "node:crypto";
import { AgentsReport, HERE_PLACE_ID, THIS_COMPUTER, noSuchAgentsProjectRefusal, sharedAgentsProjectRefusal, ServerToolsAnswer, SignInLine, SkillAdded, SkillHit, SkillPreview, isJoinedComputer, nappingAgentsRefusal, nappingServersRefusal, nappingSignInRefusal, nappingSkillsRefusal, nappingToolsRefusal, noSignInRefusal, noSuchPlaceRefusal, providerAgentsRefusal, type AgentSignInState, type AgentsProject, type AgentsSignInEvent, type AgentsTarget, type DaemonFrame, type PageReach, type ServerAdd, type ServerAsk, type WorkspacePhase, withoutControlChars } from "@wsp/protocol";
import type { Machine } from "@wsp/engine";
import type { DaemonChannel } from "./daemon-channel.js";
import { NO_PLACE_DOOR, type PlaceDoor } from "./places.js";

/** What the host reads off a target: the report less what the runtime stamps on it, and the login its lines are handed
 * to where the road runs as root and the home is somebody else's. */
export type AgentsRead = Omit<AgentsReport, "target" | "readAt" | "stale" | "reach"> & { runAs?: string };

/** Where a read runs: this computer; a computer you joined, over its link, with the login and the sign-ins and
 * versions its own report carries; or any other machine. `projects` are the projects whose folders it covers, each
 * folder absolute on that machine: every one a computer holds for a read of it, the one a target names, or a
 * workspace's own. An act, or a server started for its tools, works in a project only where exactly one is named. */
export type AgentsOn =
  | { kind: "here"; projects?: readonly AgentsProject[] }
  /** `relayed`: this host forwards that computer's sign-in callback port from this computer. */
  | { kind: "box"; machine: Pick<Machine, "exec">; login: { HOME?: string; PATH?: string }; signIns?: Record<string, AgentSignInState>; versions?: Record<string, string>; logins?: string; relayed?: boolean; projects?: readonly AgentsProject[] }
  /** `relayed`: this host forwards the workspace's sign-in callback port from this computer. */
  | { kind: "machine"; machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; projects?: readonly AgentsProject[]; relayed?: boolean };

/** The one project's folder an act there works in: the project its target named, or the workspace's own. */
export const projectOf = (on: AgentsOn): string | undefined => (on.projects?.length === 1 ? on.projects[0]!.path : undefined);

/** Where a sign-in page that returns to localhost reaches the harness on the target: the one rule the sign-in is
 * planned by and the report tells the app. A line handed to another login can open neither the pty's device its page
 * is written to nor the socket of the root daemon its shim posts to, so its page never reaches this computer. */
export const pageReachOf = (on: AgentsOn, runAs?: string): PageReach => (on.kind === "here" ? "here" : on.relayed === true && runAs === undefined ? "relay" : "none");

/** One MCP server of one agent's config on a target, asked for its tools. `key` names the target, which is what an
 * answer is kept under. */
export interface ServerToolsAsk {
  key: string;
  agent: string;
  name: string;
  refresh?: boolean;
}

/** How the host reads the agents off a target, and asks one server there for its tools. Absent on a runtime wired
 * without it, where every read is refused. */
export interface AgentsReader {
  /** `latest` false asks no vendor for a newest version. */
  read(on: AgentsOn, ask?: { latest?: boolean }): Promise<AgentsRead>;
  /** Drops what was kept for the target, which a sign-in there has just changed. */
  forget?(key: string): void;
  tools(on: AgentsOn, ask: ServerToolsAsk): Promise<ServerToolsAnswer>;
}

/** A pty road to a target's daemon, frame by frame, with every event it pushes: what a sign-in's pty runs over. */
export interface PtyLink {
  op(op: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Daemon events as they arrive; the return detaches. */
  onEvent(fn: (e: Record<string, unknown>) => void): () => void;
  /** Settles when the link is gone. */
  closed?: Promise<unknown>;
}

/** An agent's sign-in, or with `server` one MCP server's in that agent's config. */
export interface SignInAsk {
  agent: string;
  server?: string;
}

/** What one watched sign-in is handed: the link its pty runs over, where its steps go, where it hands the writer a
 * code from a page is typed with (nothing once it is gone), the stop from whoever started it, and the host's callback
 * forward to the target where the host holds one. */
export interface SignInRun {
  link: PtyLink;
  emit(step: Omit<AgentsSignInEvent, "type" | "signInId">): void;
  typing(write: ((code: string) => Promise<void>) | undefined): void;
  stop: Promise<void>;
  forward?: SignInForward;
}

/** The host's callback relay as one sign-in uses it: the port the page returns to listened on here and carried to
 * the target, false where this computer could not listen on it; then the address the browser landed on, carried
 * to that port as the one request the browser would have made; and the end of the sign-in, which closes its forward. */
export interface SignInForward {
  arm(url: string): Promise<boolean>;
  deliver(landed: string): Promise<void>;
  close(): void;
}

/** The relay, for the targets it holds a link to that carries callbacks. */
export interface CallbackForwards {
  reaches(target: AgentsTarget): boolean;
  /** A forward for one sign-in, which lives until its close. */
  open(target: AgentsTarget): SignInForward | undefined;
}

/** What the host writes and runs for the agents on a target, beside reading them. */
export interface AgentsActs {
  /** The sign-in as the line the person's own terminal runs there, a row that asks them to pick included. */
  signInLine(on: AgentsOn, ask: SignInAsk): Promise<SignInLine>;
  /** Plans the sign-in, refusing what cannot run in a watched pty, and answers the run. */
  signIn(on: AgentsOn, ask: SignInAsk): Promise<(run: SignInRun) => Promise<void>>;
  /** Writes an agent's token or key into this host's vault. */
  key(agent: string, key: string): Promise<void>;
  /** Writes the wsp server into that agent's own config there. */
  addTools(on: AgentsOn, agent: string): Promise<{ file: string }>;
}

/** One skill there by its name: the project's of that name with `project`, else the one that is not a project's. */
export interface SkillAsk {
  name: string;
  project?: boolean;
}

/** What the host does with skills: skills.sh searched and read by the host alone, and a skill there previewed,
 * installed off skills.sh, turned off or on, and removed, every write as that computer's login. */
export interface SkillsActs {
  search(q: string, limit: number): Promise<SkillHit[]>;
  get(skill: string): Promise<SkillPreview>;
  preview(on: AgentsOn, ask: SkillAsk): Promise<SkillPreview>;
  add(on: AgentsOn, ask: { skill: string; agents?: readonly string[]; project?: boolean }): Promise<SkillAdded>;
  remove(on: AgentsOn, ask: SkillAsk): Promise<{ removed: string[] }>;
  toggle(on: AgentsOn, ask: SkillAsk & { on: boolean }): Promise<{ paths: string[] }>;
}

/** What the host writes into the agents' MCP configs on a target: one server added, removed, or turned off or on,
 * each as that computer's login, each answering the config file it wrote. */
export interface ServersActs {
  add(on: AgentsOn, ask: ServerAdd): Promise<{ file: string }>;
  remove(on: AgentsOn, ask: ServerAsk): Promise<{ file: string }>;
  toggle(on: AgentsOn, ask: ServerAsk & { on: boolean }): Promise<{ file: string }>;
}

/** A remote MCP server's icon by its host, asked by this host alone: a data url, or nothing where there is none or
 * the host may not be asked for. */
export interface ServerIcons {
  /** Where the icons are kept, the folder forget deletes. */
  readonly folder: string;
  /** on is asked again before an answer is kept, so an ask that outlives the person's switch keeps nothing. */
  icon(host: string, refresh?: boolean, on?: () => Promise<boolean>): Promise<string | null>;
  /** Every icon kept on this computer deleted, and no ask still running keeps its answer. */
  forget(): void;
}

/** The refusal for a runtime served without the readers. */
export const NO_AGENTS_READER = "this runtime carries no agents reader; the host that serves the app wires one";

/** One workspace as the read needs it: its project with the folder of its checkout on its machine. */
export interface AgentsWorkspace {
  name: string;
  phase: WorkspacePhase;
  local: boolean;
  machine: Machine;
  project: AgentsProject;
}

export interface AgentsReadOptions<Caller> {
  reader: AgentsReader | undefined;
  places: () => PlaceDoor | undefined;
  workspace: (id: string, origin?: Caller) => Promise<AgentsWorkspace>;
  /** The projects this host holds on a computer, each with its folder there; none where it holds none. */
  projects?: (placeId: string) => Promise<readonly AgentsProject[]>;
  acts?: AgentsActs;
  skills?: SkillsActs;
  servers?: ServersActs;
  /** Absent, or with the person's switch off, every server draws its glyph and nothing is asked. */
  icons?: ServerIcons;
  /** Whether the person lets this host ask vendors for each agent's newest version; absent, it may. */
  latestOn?: () => Promise<boolean>;
  /** One channel to the target's daemon: this computer's, a joined computer's over its link, or a workspace's. */
  channel: (target: AgentsTarget, onEvent: (event: Record<string, unknown>) => void, origin?: Caller) => Promise<DaemonChannel>;
  /** Something written changed what a report reads there; no target is every report. */
  changed: (target?: AgentsTarget) => void;
  now: () => number;
  /** Whether this host forwards a workspace's sign-in callback port from this computer, which is the relay's own
   * answer for every workspace. */
  relayed?: () => boolean;
  /** The host's log: each sign-in's start and end, never its page, code or token. */
  log?: (line: string) => void;
}

/** How many hits a search asks skills.sh for where the asker names no number. */
export const SKILLS_SEARCH_LIMIT = 20;

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

/** A workspace that is napping, which nothing here wakes. */
interface Napping {
  napping: string;
}

export function agentsReads<Caller>(o: AgentsReadOptions<Caller>): {
  read(target: AgentsTarget, origin?: Caller): Promise<AgentsReport>;
  tools(target: AgentsTarget, ask: { agent: string; name: string; refresh?: boolean }, origin?: Caller): Promise<ServerToolsAnswer>;
  forget(workspaceId: string): void;
  signIn(target: AgentsTarget, ask: SignInAsk, emit: (event: AgentsSignInEvent) => void, origin?: Caller): Promise<{ signInId: string; leave(): void }>;
  signInCode(signInId: string, code: string): Promise<void>;
  signInStop(signInId: string): void;
  signInLine(target: AgentsTarget, ask: SignInAsk, origin?: Caller): Promise<SignInLine>;
  key(agent: string, key: string): Promise<void>;
  addTools(target: AgentsTarget, agent: string, origin?: Caller): Promise<{ file: string }>;
  forwards(relay: CallbackForwards): () => void;
  skillsSearch(q: string, limit?: number): Promise<SkillHit[]>;
  skillsGet(skill: string): Promise<SkillPreview>;
  skillsPreview(target: AgentsTarget, ask: SkillAsk, origin?: Caller): Promise<SkillPreview>;
  skillsAdd(target: AgentsTarget, ask: { skill: string; agents?: readonly string[]; project?: boolean }, origin?: Caller): Promise<SkillAdded>;
  skillsRemove(target: AgentsTarget, ask: SkillAsk, origin?: Caller): Promise<{ removed: string[] }>;
  skillsToggle(target: AgentsTarget, ask: SkillAsk & { on: boolean }, origin?: Caller): Promise<{ paths: string[] }>;
  serversAdd(target: AgentsTarget, ask: ServerAdd, origin?: Caller): Promise<{ file: string }>;
  serversRemove(target: AgentsTarget, ask: ServerAsk, origin?: Caller): Promise<{ file: string }>;
  serversToggle(target: AgentsTarget, ask: ServerAsk & { on: boolean }, origin?: Caller): Promise<{ file: string }>;
  serversIcon(host: string, refresh?: boolean): Promise<string | null>;
} {
  /** A write in one project of a computer changes the computer's report, which is the one a page reads. */
  const changed = (target?: AgentsTarget): void => o.changed(target === undefined || !("placeId" in target) ? target : { placeId: target.placeId });
  /** The last report read off each workspace while it ran, which is what a napping one answers. */
  const last = new Map<string, AgentsReport>();
  /** The host's callback relays, which register once they hold their links. */
  const relays = new Set<CallbackForwards>();
  const reached = (target: AgentsTarget): boolean => [...relays].some(relay => relay.reaches(target));
  const forwardOf = (target: AgentsTarget): SignInForward | undefined => {
    for (const relay of relays) {
      const forward = relay.open(target);
      if (forward !== undefined) return forward;
    }
    return undefined;
  };
  const stamped = (target: AgentsTarget, read: AgentsRead & { reach: PageReach }): AgentsReport => AgentsReport.parse({ target, readAt: new Date(o.now()).toISOString(), ...read });
  const readerOf = (): AgentsReader => {
    if (o.reader === undefined) throw new Error(NO_AGENTS_READER);
    return o.reader;
  };
  const actsOf = (): AgentsActs => {
    if (o.acts === undefined) throw new Error(NO_AGENTS_READER);
    return o.acts;
  };
  const skillsOf = (): SkillsActs => {
    if (o.skills === undefined) throw new Error(NO_AGENTS_READER);
    return o.skills;
  };
  /** Each sign-in running, by its id: its code writer, who follows its steps, the last step for one who joins, and
   * its stop. */
  interface Running {
    type?: (code: string) => Promise<void>;
    readonly followers: Set<(event: AgentsSignInEvent) => void>;
    last?: AgentsSignInEvent;
    stop(): void;
  }
  const running = new Map<string, Running>();
  /** The one sign-in of an agent, or of one server, on a target, by that pair: a second start joins it. */
  const starting = new Map<string, Promise<{ signInId: string; run: Running }>>();
  const keyOf = (target: AgentsTarget, ask: SignInAsk): string => JSON.stringify([target, ask.agent, ask.server ?? null]);
  const follow = (signInId: string, run: Running, emit: (event: AgentsSignInEvent) => void): { signInId: string; leave(): void } => {
    if (!run.followers.has(emit)) {
      run.followers.add(emit);
      if (run.last !== undefined) emit(run.last);
    }
    return {
      signInId,
      leave: () => {
        if (run.followers.delete(emit) && run.followers.size === 0) run.stop();
      },
    };
  };
  /** Where a skill or a server there is read or written; a napping workspace is never woken for one. */
  const awakeOn = async (target: AgentsTarget, napping: (name: string) => string, origin?: Caller): Promise<AgentsOn> => {
    const on = await onOf(target, origin);
    if ("napping" in on) throw usage(napping(on.napping));
    return on;
  };
  const skillOn = (target: AgentsTarget, origin?: Caller): Promise<AgentsOn> => awakeOn(target, nappingSkillsRefusal, origin);
  const serversOf = (): ServersActs => {
    if (o.servers === undefined) throw new Error(NO_AGENTS_READER);
    return o.servers;
  };
  /** A write into a server's config there, after which the report there reads again. */
  const serverWrite = async (target: AgentsTarget, origin: Caller | undefined, run: (acts: ServersActs, on: AgentsOn) => Promise<{ file: string }>): Promise<{ file: string }> => {
    const [acts, on] = [serversOf(), await awakeOn(target, nappingServersRefusal, origin)];
    return written(target, () => run(acts, on));
  };
  /** A write there, after which the report there reads again, whether the write held or stopped halfway. */
  const written = async <T,>(target: AgentsTarget, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } finally {
      changed(target);
    }
  };
  /** The projects a computer's target covers: the one it names, every one this host holds there for a read, and none
   * for an act that names none. */
  const projectsAt = async (target: { placeId: string; project?: string }, computer: string, read: boolean): Promise<{ projects?: readonly AgentsProject[] }> => {
    if (target.project === undefined && !read) return {};
    const held = (await o.projects?.(target.placeId)) ?? [];
    if (target.project === undefined) return { projects: held };
    const byName = held.filter(p => p.name === target.project);
    const named = held.find(p => p.id === target.project) ?? (byName.length === 1 ? byName[0] : undefined);
    const said = withoutControlChars(target.project);
    if (named === undefined) throw usage(byName.length > 1 ? sharedAgentsProjectRefusal(said, computer) : noSuchAgentsProjectRefusal(said, computer));
    return { projects: [named] };
  };
  /** Where a target's lines run, or the napping workspace's name; `read` covers every project a computer holds. */
  const onOf = async (target: AgentsTarget, origin?: Caller, read = false): Promise<AgentsOn | Napping> => {
    if ("placeId" in target) {
      if (target.placeId === HERE_PLACE_ID) return { kind: "here", ...(await projectsAt(target, THIS_COMPUTER, read)) };
      const door = o.places();
      if (door === undefined) throw new Error(NO_PLACE_DOOR);
      const rows = await door.list(o.now());
      const row = rows.find(p => p.id === target.placeId);
      if (row === undefined) throw usage(noSuchPlaceRefusal(target.placeId, rows.map(p => p.name)));
      if (!isJoinedComputer(row)) throw usage(providerAgentsRefusal(row.name));
      const report = await door.reportOf(row.id);
      const signIns = door.signInsAt(row.id);
      const machine = { exec: (cmd: string, opts?: { timeoutMs?: number; stdin?: Uint8Array }) => door.exec(row.id, cmd, opts ?? {}) };
      const login = { ...(report?.login["HOME"] !== undefined ? { HOME: report.login["HOME"] } : {}), ...(report?.login["PATH"] !== undefined ? { PATH: report.login["PATH"] } : {}) };
      return {
        kind: "box",
        machine,
        login,
        ...(signIns !== undefined ? { signIns } : {}),
        ...(report?.agentVersions !== undefined ? { versions: report.agentVersions } : {}),
        ...(row.logins !== undefined ? { logins: row.logins } : {}),
        ...(reached(target) ? { relayed: true } : {}),
        ...(await projectsAt(target, row.name, read)),
      };
    }
    const ws = await o.workspace(target.workspaceId, origin);
    if (ws.phase === "napping") return { napping: ws.name };
    return ws.local ? { kind: "here", projects: [ws.project] } : { kind: "machine", machine: ws.machine, projects: [ws.project], ...(o.relayed?.() === true ? { relayed: true } : {}) };
  };
  return {
    async read(target, origin) {
      const reader = readerOf();
      const on = await onOf(target, origin, true);
      if ("napping" in on) {
        const held = "workspaceId" in target ? last.get(target.workspaceId) : undefined;
        if (held === undefined) throw usage(nappingAgentsRefusal(on.napping));
        return { ...held, stale: "napping" };
      }
      const { runAs, ...read } = await reader.read(on, { latest: (await o.latestOn?.()) ?? true });
      const report = stamped(target, { ...read, reach: pageReachOf(on, runAs) });
      if ("workspaceId" in target) last.set(target.workspaceId, report);
      return report;
    },
    async tools(target, ask, origin) {
      const reader = readerOf();
      const on = await onOf(target, origin);
      if ("napping" in on) throw usage(nappingToolsRefusal(on.napping));
      return ServerToolsAnswer.parse(await reader.tools(on, { key: JSON.stringify(target), ...ask }));
    },
    /** A removed workspace's last report goes with it. */
    forget: workspaceId => void last.delete(workspaceId),
    async signIn(target, ask, emit, origin) {
      const key = keyOf(target, ask);
      const held = starting.get(key);
      if (held !== undefined) {
        const { signInId, run } = await held;
        return follow(signInId, run, emit);
      }
      const log = o.log ?? (line => console.warn(line));
      const what = `${withoutControlChars(ask.agent)}${ask.server !== undefined ? `, server ${withoutControlChars(ask.server)}` : ""}, on ${"workspaceId" in target ? `workspace ${target.workspaceId}` : `computer ${target.placeId}`}`;
      const begun = (async () => {
        const acts = actsOf();
        const on = await onOf(target, origin);
        if ("napping" in on) throw usage(nappingSignInRefusal(on.napping));
        const plan = await acts.signIn(on, ask).catch((e: unknown) => {
          log(`sign-in refused: ${what}: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        });
        const signInId = `si_${randomBytes(6).toString("hex")}`;
        log(`sign-in ${signInId} started: ${what}`);
        let stoppedBy = false;
        const readers = new Set<(e: Record<string, unknown>) => void>();
        const channel = await o.channel(target, e => readers.forEach(read => read(e)), origin);
        let settle: () => void = () => {};
        const stopped = new Promise<void>(r => (settle = r));
        const run: Running = {
          followers: new Set([emit]),
          stop: () => {
            if (starting.get(key) === begun) starting.delete(key);
            stoppedBy = true;
            settle();
          },
        };
        running.set(signInId, run);
        const link: PtyLink = {
          op: async (op, extra) => (await channel.send({ op, ...extra } as DaemonFrame)) as Record<string, unknown>,
          onEvent: fn => {
            readers.add(fn);
            return () => readers.delete(fn);
          },
          closed: channel.closed,
        };
        const step = (s: Omit<AgentsSignInEvent, "type" | "signInId">): void => {
          const event: AgentsSignInEvent = { type: "agents.signIn", signInId, ...s };
          run.last = event;
          for (const tell of run.followers) tell(event);
        };
        // A tool's own login types its code on the terminal; only a server's browser flow returns to a callback port.
        const forward = ask.server !== undefined ? forwardOf(target) : undefined;
        void plan({ link, emit: step, typing: write => (write === undefined ? delete run.type : (run.type = write)), stop: stopped, ...(forward !== undefined ? { forward } : {}) })
          .catch((e: unknown) => step({ state: "failed", said: e instanceof Error ? e.message : String(e) }))
          .finally(async () => {
            forward?.close();
            running.delete(signInId);
            if (starting.get(key) === begun) starting.delete(key);
            channel.close();
            log(`sign-in ${signInId} ended: ${what}: ${stoppedBy ? "stopped" : (run.last?.state ?? "failed")}`);
            // That computer lists its logins only when it dials, so a landed one is written here before the reports read again.
            if ("placeId" in target && ask.server === undefined && run.last?.state === "signed-in") {
              try {
                await o.places()?.loginLanded(target.placeId, ask.agent);
              } catch (e) {
                log(`sign-in ${signInId}: the landed login was not noted: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            o.reader?.forget?.(JSON.stringify(target));
            changed(target);
          });
        return { signInId, run };
      })();
      starting.set(key, begun);
      try {
        const { signInId, run } = await begun;
        return follow(signInId, run, emit);
      } catch (e) {
        if (starting.get(key) === begun) starting.delete(key);
        throw e;
      }
    },
    async signInCode(signInId, code) {
      const type = running.get(signInId)?.type;
      if (type === undefined) throw usage(noSignInRefusal);
      await type(code);
    },
    signInStop(signInId) {
      const run = running.get(signInId);
      if (run === undefined) throw usage(noSignInRefusal);
      run.stop();
    },
    async signInLine(target, ask, origin) {
      const acts = actsOf();
      const on = await onOf(target, origin);
      if ("napping" in on) throw usage(nappingSignInRefusal(on.napping));
      return SignInLine.parse(await acts.signInLine(on, ask));
    },
    async key(agent, key) {
      await actsOf().key(agent, key);
      changed();
    },
    skillsSearch: (q, limit = SKILLS_SEARCH_LIMIT) => skillsOf().search(q, limit).then(hits => hits.map(h => SkillHit.parse(h))),
    skillsGet: async skill => SkillPreview.parse(await skillsOf().get(skill)),
    skillsPreview: async (target, ask, origin) => SkillPreview.parse(await skillsOf().preview(await skillOn(target, origin), ask)),
    async skillsAdd(target, ask, origin) {
      const [skills, on] = [skillsOf(), await skillOn(target, origin)];
      return written(target, async () => SkillAdded.parse(await skills.add(on, ask)));
    },
    async skillsRemove(target, ask, origin) {
      const [skills, on] = [skillsOf(), await skillOn(target, origin)];
      return written(target, () => skills.remove(on, ask));
    },
    async skillsToggle(target, ask, origin) {
      const [skills, on] = [skillsOf(), await skillOn(target, origin)];
      return written(target, () => skills.toggle(on, ask));
    },
    serversAdd: (target, ask, origin) => serverWrite(target, origin, (acts, on) => acts.add(on, ask)),
    serversRemove: (target, ask, origin) => serverWrite(target, origin, (acts, on) => acts.remove(on, ask)),
    serversIcon: async (host, refresh) => (o.icons === undefined ? null : o.icons.icon(host, refresh)),
    serversToggle: (target, ask, origin) => serverWrite(target, origin, (acts, on) => acts.toggle(on, ask)),
    async addTools(target, agent, origin) {
      const acts = actsOf();
      const on = await onOf(target, origin);
      if ("napping" in on) throw usage(nappingSignInRefusal(on.napping));
      const added = await acts.addTools(on, agent);
      changed(target);
      return added;
    },
    forwards: relay => {
      relays.add(relay);
      return () => void relays.delete(relay);
    },
  };
}
