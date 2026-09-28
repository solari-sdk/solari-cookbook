// SPDX-License-Identifier: AGPL-3.0-only
// The signing-in stage of wsp init: each login chosen as "sign in during the
// build" runs in this terminal over a pty on the builder, and its exit code
// says whether it landed; a login whose files were copied is recorded as
// copied, and one left to first use is recorded as that with nothing run for
// it. The summary before the seal offers a retry (with the no-browser variant
// when the table has one) or a skip for a sign-in that failed or that the cap
// ended. What each login came to is written next to the import result so the
// golden's notes carry it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Writable } from "node:stream";
import { styleText } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import { LOGIN_STATE_WORDS, type LoginChoice, type LoginState } from "@wsp/protocol";
import type { GoldenBuilderView, Runtime } from "@wsp/runtime";
import { S_BAR, log, note } from "@clack/prompts";
import { connectDaemonSocket, type ConnectOptions, type DaemonSocket } from "./doctor.js";
import { GUTTER, ellipsize, table, widthOf } from "./init-layout.js";
import { agentName } from "./init-recipe.js";
import { readKey } from "./init-select.js";
import { relayPty, type PtyLink, type RelayTerminal } from "./signin-relay.js";
import { hasLogin, signInFor, type SignIn } from "./signin-table.js";

export interface LoginOutcome {
  id: string;
  label: string;
  state: LoginState;
  /** The command that ran last, when one did. */
  command?: string;
  /** How the last command's pty ended; -1 when it never did. */
  exit?: number;
  note?: string;
  /** What a copied login's files went to the machine without, named by the account. */
  left?: string;
}

/** What the sign-in stage shares with the host's callback relay: whether one
 * page the machine asks to open may open here without a click (the person
 * pressed o in this flow; one o, one open), the page it asked for that o
 * should open instead of the printed link, and where a host line goes while
 * a pty is shown. */
export interface SignInFlow {
  armed: boolean;
  /** The page o opened here; the relay declines to open that one again. */
  openedUrl?: string;
  /** A page the machine asked to open that returns through a forwarded port, arrived while nothing was armed. */
  callbackUrl?: string;
  show?: (line: string) => void;
  /** Each page the machine asks to open while a stage holds this flow, with the callback port when it named one:
   * the hand-off stage prints it for the person, the terminal stage waits for o instead and leaves this unset. */
  onPage?: (url: string, port?: number) => void;
  /** What the relay's line says for a page it did not open; the terminal stage's o is the default. */
  openWords?: string;
}

/** The line the relay logs for a page it did not open, while a pty is on screen. */
export const OPEN_LINE = "press o on the link above to open it here";

/** Where a code from a sign-in's page reaches the tool waiting for it on the machine. The hand-off opens one writer
 * per login while its command runs, and a submit from the app types the code into that login's own pty, the way the
 * person would at the machine's terminal. Nothing is kept here: a code passes through and is gone. */
export class SignInCodes {
  private readonly writers = new Map<string, (code: string) => Promise<void>>();

  /** The login takes a code from now until the returned close, which only closes the writer it opened. */
  open(tool: string, write: (code: string) => Promise<void>): () => void {
    this.writers.set(tool, write);
    return () => {
      if (this.writers.get(tool) === write) this.writers.delete(tool);
    };
  }

  /** Types the code into that login's pty; refused when no sign-in for the tool is waiting for one. */
  async submit(tool: string, code: string): Promise<void> {
    const write = this.writers.get(tool);
    if (write === undefined) throw new Error(`no sign-in for ${tool} is waiting for a code from you`);
    await write(code);
  }
}

export interface HostHooks {
  /** Whether a sign-in page the machine asks for may open here without a click: one open per o the person pressed,
   * and never the page o itself opened. A declined page that names a callback port is kept for the next o. */
  autoOpen(targetId: string, url: string, port?: number): boolean;
  /** The line for a page the relay did not open: while a pty is on screen for the builder it says what to press here,
   * or that the page is the one o already opened; otherwise the relay's own words. */
  openLine(workspace: string, hostname: string, url: string): string;
  /** A host line to show; true when the sign-in stage took it (a pty is on screen), false to print it as usual. */
  onLine(line: string): boolean;
}

/** The host relay's hooks over the flow, for the builder's pages. */
export function flowHooks(flow: SignInFlow, builder: { id: string; name: string }): HostHooks {
  // The relay names the builder's link this way; the line hook only gets the name.
  const target = `${builder.name} (builder)`;
  return {
    autoOpen: (id, url, port) => {
      if (id !== builder.id || url === flow.openedUrl) return false;
      if (flow.armed) {
        flow.armed = false;
        return true;
      }
      if (flow.show === undefined) return false;
      if (port !== undefined) flow.callbackUrl = url;
      flow.onPage?.(url, port);
      return false;
    },
    openLine: (workspace, hostname, url) => {
      if (workspace !== target || flow.show === undefined) return `${workspace}: a sign-in page for ${hostname} is ready; open it from the app`;
      return `${workspace}: ${url === flow.openedUrl ? "that page is already open here" : (flow.openWords ?? OPEN_LINE)}`;
    },
    onLine: line => {
      if (flow.show === undefined) return false;
      flow.show(line);
      return true;
    },
  };
}

export interface BuilderLink {
  link: PtyLink;
  close(): void;
}

/** One daemon socket to the builder, its events fanned out to whoever asks. */
export async function builderLink(rt: Runtime, builder: GoldenBuilderView, connect: (o: ConnectOptions) => Promise<DaemonSocket> = connectDaemonSocket): Promise<BuilderLink> {
  const reach = await rt.golden.builderReach(builder.id);
  if (reach.daemonToken === undefined) throw new Error("the machine has no daemon token yet");
  const fns = new Set<(e: Record<string, unknown>) => void>();
  const sock = await connect({
    url: reach.url,
    token: reach.daemonToken,
    onEvent: e => {
      for (const f of fns) f(e);
    },
  });
  return {
    link: {
      op: (op, extra) => sock.op(op, extra),
      onEvent: fn => {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      closed: sock.closed,
    },
    close: () => sock.close(),
  };
}

export interface SignInStageOptions {
  /** The logins the stage owns: an answer SETTLED_AT names is recorded where it says with nothing run for it, any
   * other is signed in on the builder. */
  logins: readonly ManifestEntry[];
  /** By login id, what its copy went to the machine without; shown beside the row's note throughout. */
  left?: ReadonlyMap<string, string>;
  /** A fresh link to the builder's daemon, dialled before each command so a dropped one costs that command alone. */
  dial(): Promise<BuilderLink>;
  terminal: RelayTerminal;
  /** Set when nobody can type here (no terminal, or --yes): every login is skipped with this note. */
  skipWhy?: string;
  open(url: string): Promise<boolean>;
  flow: SignInFlow;
  /** How long a sign-in that runs here is given. Without it, SIGN_IN_CAP_MS. */
  capMs?: number;
  now?: () => number;
}

/** The whole wait a sign-in running during the build gets, whatever the tool itself would wait for: the build never
 * waits on a person, and a browser sign-in somebody is actually at lands well inside this. A row the cap ends is
 * deferred to the workspace, not failed. */
export const SIGN_IN_CAP_MS = 2 * 60_000;
const dim = (s: string): string => styleText("dim", s);

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/** The row's note and what its copy left behind, as one detail. */
function detailOf(o: LoginOutcome): string {
  return [o.note, o.left].filter(x => x !== undefined).join("; ");
}

/** The row's state and detail; the detail cut to `width` cells for the row as a whole. */
export function stateLine(o: LoginOutcome, width = Infinity): string {
  const word = LOGIN_STATE_WORDS[o.state];
  const colored = o.state === "signed-in" ? styleText("green", word) : o.state === "not-signed-in" ? styleText("yellow", word) : dim(word);
  const detail = ellipsize(detailOf(o), width - o.label.length - word.length - 5);
  return `${o.label}: ${colored}${detail !== "" ? dim(` (${detail})`) : ""}`;
}

/** The outcome an answer reaches with nothing run for it: a copy's files are on the machine already, so its status is
 * the catalog's to check from the app and not this terminal's, and a login left to first use never runs here at all.
 * Nothing for the answers a stage signs in or another step takes. One entry per answer, so a fifth cannot be offered
 * before it says whether the build runs it. */
const SETTLED_AT: Record<LoginChoice, LoginState | undefined> = { copy: "copied", later: "deferred", machine: undefined, key: undefined, skip: undefined, token: undefined };

/** Where this row lands with nothing run for it, or nothing when the stage is to sign it in. */
const settledAt = (e: ManifestEntry): LoginState | undefined => (e.choice === undefined ? undefined : SETTLED_AT[e.choice]);

/** The outcomes a sign-in stage starts from, with every answer the build runs nothing for already settled. What is
 * left is the rows to sign in on the machine, each beside the outcome it fills in. */
export function settledOutcomes(logins: readonly ManifestEntry[], left: ReadonlyMap<string, string> | undefined, output: Writable): { outcomes: LoginOutcome[]; machine: [ManifestEntry, LoginOutcome][] } {
  const outcomes = logins.map((e): LoginOutcome => {
    const had = left?.get(e.id);
    return { id: e.id, label: e.label, state: "skipped", ...(had !== undefined ? { left: had } : {}) };
  });
  const rows = logins.map((e, i): [ManifestEntry, LoginOutcome] => [e, outcomes[i]!]);
  for (const [e, r] of rows) {
    const settled = settledAt(e);
    if (settled === undefined) continue;
    r.state = settled;
    log.message(stateLine(r), { output, symbol: dim(S_BAR) });
  }
  return { outcomes, machine: rows.filter(([e]) => settledAt(e) === undefined) };
}

/** A detail cut below this says nothing, so the column is left out rather than stubbed. */
const DETAIL_ROOM = 12;

/** Label, state, detail per login; the detail is cut so the note frame (6 columns) never wraps a row. A state word
 * long enough to take the whole line leaves the detail out instead of pushing the row past the frame, which is what
 * wrapped it; the line each row printed as it settled carries that detail whole. */
function summaryRows(outcomes: readonly LoginOutcome[], width: number): string[] {
  const labelW = Math.max(...outcomes.map(r => r.label.length));
  const stateW = Math.max(...outcomes.map(r => LOGIN_STATE_WORDS[r.state].length));
  const room = width - 6 - labelW - stateW - 2 * GUTTER.length;
  return table(outcomes.map(r => [r.label, LOGIN_STATE_WORDS[r.state], ellipsize(detailOf(r), room < DETAIL_ROOM ? 0 : room)]));
}

export async function signInStage(o: SignInStageOptions): Promise<LoginOutcome[]> {
  const out = { output: o.terminal.output };
  const capMs = o.capMs ?? SIGN_IN_CAP_MS;
  if (o.logins.length === 0) return [];
  const { outcomes, machine } = settledOutcomes(o.logins, o.left, o.terminal.output);
  if (o.skipWhy !== undefined) {
    for (const [, r] of machine) r.note = o.skipWhy;
    if (machine.length > 0) log.step(`Sign-ins on the machine skipped: ${machine.map(([, r]) => r.label).join(", ")}. ${o.skipWhy[0]!.toUpperCase()}${o.skipWhy.slice(1)}.`, out);
    return outcomes;
  }

  if (machine.length > 0) log.step("Signing in on the machine", out);

  /** The command's pty over one fresh link, its exit code the row's state; every failure is this login's note, never the run's end. */
  const attempt = async (entry: ManifestEntry, r: LoginOutcome, s: SignIn, command: string | undefined): Promise<void> => {
    const daemon = await o.dial();
    try {
      const show = (line: string): void => void o.terminal.output.write(`\r\n  ${dim(line)}\r\n`);
      o.flow.show = show;
      o.flow.armed = false;
      let relayed: Awaited<ReturnType<typeof relayPty>>;
      try {
        relayed = await relayPty({
          link: daemon.link,
          ...(command !== undefined ? { command } : {}),
          terminal: o.terminal,
          open: o.open,
          callbackUrl: () => o.flow.callbackUrl,
          // o on the printed link consents to the one page the machine then asks for; o on that page itself leaves nothing to arm.
          onConsent: url => {
            o.flow.openedUrl = url;
            o.flow.armed = url !== o.flow.callbackUrl;
          },
          timeoutMs: capMs,
          ...(o.now !== undefined ? { now: o.now } : {}),
        });
      } finally {
        o.flow.armed = false;
        delete o.flow.openedUrl;
        delete o.flow.callbackUrl;
        delete o.flow.show;
      }
      o.terminal.output.write("\n");
      r.exit = relayed.exitCode;
      if (relayed.dropped) {
        r.state = "not-signed-in";
        r.note = "the machine's terminal link dropped";
        return;
      }
      if (relayed.timedOut) {
        r.state = "deferred";
        r.note = `stopped after ${minutes(capMs)}`;
        return;
      }
      // The shell's own "not found": the tool is not on the machine, and no retry or status check can change that.
      if (hasLogin(s) && relayed.exitCode === 127) {
        r.state = "skipped";
        r.note = `${toolOf(command ?? "")} is not on the machine`;
        return;
      }
      // A bare shell proves nothing by its exit; a tool's sign-in command does, the way the person just watched it end.
      if (!hasLogin(s)) {
        r.state = "not-verified";
        r.note = [`no status command known for ${agentName(entry)}`, ...(relayed.exitCode !== 0 ? [`exit ${relayed.exitCode}`] : [])].join("; ");
        return;
      }
      r.state = relayed.exitCode === 0 ? "signed-in" : "not-signed-in";
      r.note = `${command} exited ${relayed.exitCode}`;
    } finally {
      daemon.close();
    }
  };

  /** Logins a sign-in was tried for here, pty or not: the offer after a failure is a retry for these, the sign-in itself for a copied login the check refused. */
  const attempted = new Set<LoginOutcome>();
  const run = async (entry: ManifestEntry, r: LoginOutcome, s: SignIn, command: string | undefined): Promise<void> => {
    attempted.add(r);
    const shown = command ?? "a shell on the machine; type the tool's sign-in command, then exit";
    o.terminal.output.write(`${styleText("cyan", "◇")}  ${r.label}${GUTTER}${dim(shown)}\n${dim(S_BAR)}  ${dim("the terminal below is the machine's; Ctrl-C ends the command")}\n`);
    r.command = command;
    delete r.note;
    try {
      await attempt(entry, r, s, command);
    } catch (e) {
      r.state = "not-signed-in";
      r.note = e instanceof Error ? e.message : String(e);
    }
  };

  const pass = async (entry: ManifestEntry, r: LoginOutcome, useFallback: boolean): Promise<void> => {
    const s = signInFor(agentName(entry));
    if (hasLogin(s)) await run(entry, r, s, useFallback && s.fallback !== undefined ? s.fallback : s.login);
    else if (s.kind === "shell") await run(entry, r, s, undefined);
    else {
      r.state = "skipped";
      r.note = s.note;
    }
  };

  for (const [entry, r] of machine) {
    await pass(entry, r, false);
    log.message(stateLine(r), { output: o.terminal.output, symbol: dim(S_BAR) });
  }

  for (;;) {
    note(summaryRows(outcomes, widthOf(o.terminal.output)).join("\n"), "Sign-ins", out);
    // Not signed in (a copied login the check refused among them), not verifiable after a command that did not end
    // clean, or run here and ended by the cap: all three get the machine sign-in, or its retry, or a skip. A tool
    // with no sign-in has nothing to offer, and a row left to first use was never run, so there is nothing to retry.
    const pending = outcomes
      .map((r, i) => [r, i] as const)
      .filter(([r, i]) => (r.state === "not-signed-in" || (r.state === "deferred" && attempted.has(r)) || (r.state === "not-verified" && r.exit !== undefined && r.exit !== 0)) && signInFor(agentName(o.logins[i]!)).kind !== "none");
    if (pending.length === 0) break;
    for (const [r, i] of pending) {
      const entry = o.logins[i]!;
      const s = signInFor(agentName(entry));
      const fallback = hasLogin(s) ? s.fallback : undefined;
      const keys = ["r", ...(fallback !== undefined ? ["f"] : []), "s"];
      const again = attempted.has(r);
      const hint = [again ? "r retry" : "r sign in on the machine", ...(fallback !== undefined ? [`f ${again ? "retry" : "sign in"} with ${fallback}`] : []), `s skip`].join("   ");
      log.message(`${r.label}${GUTTER}${dim(hint)}`, { output: o.terminal.output, symbol: styleText("yellow", "▲") });
      const key = await readKey(o.terminal.input, o.terminal.output, keys);
      if (key === "s" || key === "cancel") {
        r.state = "skipped";
        r.note = "skipped by you";
        continue;
      }
      await pass(entry, r, key === "f");
      log.message(stateLine(r), { output: o.terminal.output, symbol: dim(S_BAR) });
    }
  }
  return outcomes;
}

/** The first word of a command past its NAME=value prefixes: the tool the shell could not find. */
export function toolOf(command: string): string {
  return command.split(" ").find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? command;
}

/** Adds what the sign-in and secrets steps came to to the import result file, the golden's notes; creates it when
 * nothing was imported. replaced says the file was there but could not be read, so the caller can say so. */
export function noteOutcomes(path: string, outcomes: Record<string, unknown>): { replaced: boolean } {
  let existing: Record<string, unknown> = {};
  let replaced = false;
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null) existing = parsed as Record<string, unknown>;
      else replaced = true;
    } catch {
      replaced = true;
    }
  }
  writeFileSync(path, `${JSON.stringify({ ...existing, ...outcomes }, null, 2)}\n`);
  return { replaced };
}

/** The logins the stage owns, each carrying its answer: those to sign in on the machine, those left to first use
 * (settled where they stand, so the build reports them without running anything), and those whose files went along
 * (a copy answer on a ticked row) for the check. */
export function stageLogins(manifest: { entries: readonly ManifestEntry[] }, choices: ReadonlyMap<string, string>, ticks: ReadonlySet<string>): ManifestEntry[] {
  return manifest.entries.flatMap((e): ManifestEntry[] => {
    if (e.rung !== "logins") return [];
    const choice = choices.get(e.id);
    if (choice === "machine" || choice === "later") return [{ ...e, choice }];
    return choice === "copy" && ticks.has(e.id) ? [{ ...e, choice }] : [];
  });
}
