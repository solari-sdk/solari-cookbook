// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in stage with nobody at this terminal. Each login chosen as "sign in
// on the machine" runs on the builder the same way, but instead of showing the
// machine's terminal this prints the page the tool wants opened, the code the
// flow shows when it has one, and the command that opens that page on this
// computer; then it waits, asking the tool's own status on the machine, until
// the person finishes, the command ends, or the deadline passes. With --json
// each of those is one object on stdout for whoever is driving the run. A
// login whose row says it finishes by callback runs with a browser to reach,
// so its page returns through the forwarded port and no code comes back; one
// whose page hands a code back takes that code from the client and types it
// into the tool. A code is never read out of the output, kept or printed.
import type { Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";
import type { StatusCheck } from "@wsp/catalog";
import type { ManifestEntry } from "@wsp/collect";
import { fmtDuration, redirectsToMachine, shellQuote, type SignInFinish } from "@wsp/protocol";
import { S_BAR, log } from "@clack/prompts";
import { agentName } from "./init-recipe.js";
import { SIGN_IN_CAP_MS, settledOutcomes, stateLine, toolOf, type BuilderLink, type LoginOutcome, type SignInCodes, type SignInFlow } from "./init-signin.js";
import { openerCommand } from "./relay.js";
import { runQuiet, stripOsc8, urlsIn, watchPty, type WatchOutcome } from "./signin-relay.js";
import { hasLogin, questionsOf, signInFor } from "./signin-table.js";

export interface HandoffOptions {
  /** The logins the stage owns, the same rows the terminal stage takes: a choice of copy is recorded as copied,
   * any other is signed in on the builder. */
  logins: readonly ManifestEntry[];
  /** By login id, what its copy went to the machine without; shown beside the row's note. */
  left?: ReadonlyMap<string, string>;
  /** A fresh link to the builder's daemon, dialled before each command and each status check so a dropped one
   * costs that one alone. */
  dial(): Promise<BuilderLink>;
  output: Writable;
  /** One object per hand-off and per outcome, under --json; absent, only the lines above are printed. */
  json?(record: Record<string, unknown>): void;
  /** This computer, for the command that opens a page on it. */
  platform: "darwin" | "linux";
  /** How long the person gets per sign-in. Without it, SIGN_IN_CAP_MS. */
  deadlineMs?: number;
  /** How often the tool's own status is asked on the machine while it waits. Default 5s, slowing after the first
   * minute. */
  pollMs?: number;
  /** How long a command the status says is through is given to end on its own before its pty is killed. Default 2s. */
  graceMs?: number;
  /** The host relay's flow for the builder: the pages the machine asks to open arrive here, and a page that names a
   * callback port is the one that works, so it is handed over in place of anything the tool printed. */
  flow?: SignInFlow;
  /** Where a code from a page reaches the login waiting for it: each login that can take one opens its writer here
   * while its command runs. Without it no row takes a code, which is what a run with no client to submit one is. */
  codes?: SignInCodes;
  now?: () => number;
  /** A stop from the person: the sign-in running is settled as not signed in and the rest are not started. */
  signal?: AbortSignal;
}

const POLL_MS = 5_000;
/** Past this much of the wait the person is on the page or gone, so the checks slow to SLOW_POLL_MS: sixteen
 * minutes at five seconds is about two hundred guest ptys for one login. */
const FAST_FOR_MS = 60_000;
const SLOW_POLL_MS = 20_000;
const GRACE_MS = 2_000;
/** A status command that hangs is given up on, so one bad check never eats the person's deadline. */
const STATUS_MS = 60_000;
/** The tool's output kept for the code scan: the page and its code come first, and a tool that prints for the whole
 * cap must not be held in memory. */
const TEXT_CAP = 16 * 1024;
const dim = (s: string): string => styleText("dim", s);
/** The note on a sign-in the person stopped before it was through. */
export const STOPPED_NOTE = "stopped before the sign-in was through";

/** The code the page will ask for, in the shape the catalog row says this flow prints it: read outside the URLs the
 * tool printed, so a page's own query string is never mistaken for a code. A row with no shape shows no code. */
export function codeIn(text: string, shape: RegExp | undefined): string | undefined {
  if (shape === undefined) return undefined;
  const plain = stripVTControlCharacters(stripOsc8(text));
  const words = urlsIn(plain).reduce((s, url) => s.replaceAll(url, " "), plain);
  return shape.exec(words)?.[0];
}

/** A callback sign-in's pty runs with a DISPLAY, which the daemon otherwise drops so a tool takes its paste-code
 * road instead: gcloud, gemini and railway read an empty DISPLAY as "no browser here". Nothing ever connects to it;
 * the shim as BROWSER is what carries the page to this computer, and the forwarded port carries the redirect back.
 * Written here rather than imported: the daemon is a binary the host cannot import, so the host mirrors the guest's
 * constants (see doctor.ts). */
export const CALLBACK_DISPLAY = ":0";

/** The environment a login's pty runs with, by the road its row finishes on; nothing added on the other roads. */
export function signInEnv(finish: SignInFinish): Record<string, string> | undefined {
  return finish === "callback" ? { DISPLAY: CALLBACK_DISPLAY } : undefined;
}

/** The road the row is on, read off the page the tool asked for: a page that redirects back to the machine is the
 * callback road, whose forward may still be on its way, so the row shows that page and asks for nothing. A callback
 * login whose page returns somewhere else fell back to its own paste-code page, so the person's code is what
 * finishes it, and the row says so at once rather than after a forward that is never coming. */
export function rowFinish(declared: SignInFinish, url: string): SignInFinish {
  return declared === "callback" && !redirectsToMachine(url) ? "code" : declared;
}

/** How long until the status is next asked: pollMs through the first minute, then the slower of it and SLOW_POLL_MS. */
export function cadence(elapsedMs: number, pollMs: number): number {
  return elapsedMs < FAST_FOR_MS ? pollMs : Math.max(pollMs, SLOW_POLL_MS);
}

/** Resolves after ms, or as soon as `until` settles, leaving no timer behind either way. */
function wait(ms: number, until: Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    void until.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export async function handoffStage(o: HandoffOptions): Promise<LoginOutcome[]> {
  const out = { output: o.output };
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? POLL_MS;
  const graceMs = o.graceMs ?? GRACE_MS;
  if (o.logins.length === 0) return [];
  const { outcomes, machine } = settledOutcomes(o.logins, o.left, o.output);
  // A login the build runs nothing for is a row of the build too: it settles here, before any page, and is never
  // announced otherwise.
  for (const [entry, r] of o.logins.map((e, i): [ManifestEntry, LoginOutcome] => [e, outcomes[i]!])) {
    if (r.state === "copied" || r.state === "deferred") o.json?.({ event: "sign-in-result", tool: agentName(entry), label: r.label, state: r.state });
  }
  if (machine.length === 0) return outcomes;
  log.step("Signing in on the machine. Each page below is yours to open on this computer; the run waits for you.", out);

  /** The tool's own status on the machine: true when it says signed in, else why it did not. */
  const asked = async (status: StatusCheck): Promise<true | string> => {
    try {
      const daemon = await o.dial();
      try {
        const run = await runQuiet(daemon.link, status.typed ?? status.command, STATUS_MS);
        if (run.dropped) return "the machine's terminal link dropped";
        if (run.timedOut) return `${status.command} did not answer`;
        if (status.signedIn(run.output, run.exitCode)) return true;
        return status.why?.(run.output) ?? `${status.command} says not signed in`;
      } finally {
        daemon.close();
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const announce = (r: LoginOutcome, tool: string, command: string, url: string, code: string | undefined, capMs: number, finish: SignInFinish): void => {
    const opener = `${openerCommand(o.platform)} ${shellQuote(url)}`;
    o.json?.({
      event: "sign-in",
      tool,
      label: r.label,
      browserUrl: url,
      ...(code !== undefined ? { code } : {}),
      finish,
      nextCommand: opener,
      waitSeconds: Math.round(capMs / 1000),
    });
    log.step(
      [
        `${r.label}: open ${url} on this computer${code === undefined ? "" : `, then enter the code ${code}`}`,
        ...(finish === "code" ? [dim("a code that page hands back goes in the field under this row; it is typed on the machine for you")] : []),
        dim(opener),
        dim(`${command} is running on the machine; this run waits up to ${fmtDuration(capMs)} for you`),
      ].join("\n"),
      out,
    );
  };

  /** The sign-in command on the builder while the status is asked beside it; the first of the three to answer settles the row. */
  const sign = async (entry: ManifestEntry, r: LoginOutcome): Promise<void> => {
    const tool = agentName(entry);
    const s = signInFor(tool);
    if (!hasLogin(s)) {
      r.note = s.kind === "shell" ? `no sign-in command known for ${tool}; sign in from the app's terminal` : (s.note ?? "nothing to run on a headless machine");
      return;
    }
    const command = s.login;
    const status = s.status;
    const capMs = o.deadlineMs ?? SIGN_IN_CAP_MS;
    r.command = command;
    // The row stands from the moment the command starts: a tool prints its banner before its page, and a status that
    // already says signed in never prints one, so a reader waiting for the page alone would show nothing while this runs.
    o.json?.({ event: "sign-in", tool, label: r.label });
    const daemon = await o.dial();
    let settle: (() => void) | undefined;
    const stop = new Promise<void>(resolve => (settle = resolve));
    o.signal?.addEventListener("abort", () => settle?.(), { once: true });
    let seen = "";
    /** The last page handed over, the code handed over beside it, and whether that page was one that returns
     * through a forwarded port. */
    let told: string | undefined;
    let shownCode: string | undefined;
    let forwarded = false;
    let run: WatchOutcome | undefined;
    /** Why the pty never started, when it did not: the wait below has nothing to wait for then. */
    let failure: string | undefined;
    /** A question only the person can answer, in the tool's own words: no answer here can be the right one, so the
     * row says which question stopped it rather than waiting out the cap on a page that is never coming. */
    let theirs: string | undefined;
    /** A page the tool printed, or one the machine asked the host to open. The forwarded one is what a redirect
     * back to the machine actually reaches, so once it has arrived it is the page and printed links are ignored;
     * anything else replaces what was handed over, since a tool prints its banner before its sign-in page. The
     * same page goes again when its code lands after it, which is the order doppler prints the two in. */
    const page = (url: string, port?: number): void => {
      const fresh = url !== told;
      if (fresh && forwarded && port === undefined) return;
      const code = codeIn(seen, s.code);
      if (!fresh && code === shownCode) return;
      if (port !== undefined) forwarded = true;
      told = url;
      shownCode = code;
      announce(r, tool, command, url, code, capMs, rowFinish(s.finish, url));
    };
    if (o.flow !== undefined) {
      o.flow.show = line => log.message(dim(line), { output: o.output, symbol: dim(S_BAR) });
      o.flow.openWords = "its sign-in page is the one handed to you above";
      o.flow.onPage = page;
    }
    const env = signInEnv(s.finish);
    const codes = s.finish === "none" ? undefined : o.codes;
    /** Closes this login's code writer; only a login that can take one ever opens it. */
    let closeCode: (() => void) | undefined;
    const watching = watchPty({
      link: daemon.link,
      command,
      timeoutMs: capMs,
      stop,
      questions: questionsOf(s),
      onQuestion: asked => {
        if (!("person" in asked.question)) return;
        theirs = asked.matched;
        settle?.();
      },
      ...(env !== undefined ? { env } : {}),
      onData: chunk => {
        if (seen.length < TEXT_CAP) seen += chunk;
      },
      // A tool that prints its page one line before its code: the row goes again once the code is there to show.
      onScanned: () => {
        if (told !== undefined && shownCode === undefined && s.code !== undefined) page(told);
      },
      onUrl: url => page(url),
      ...(codes !== undefined
        ? {
            onTyping: write => {
              closeCode?.();
              // The Enter the person would press: the tool reads the code as one typed line.
              closeCode = write === undefined ? undefined : codes.open(tool, code => write(`${code}\r`));
            },
          }
        : {}),
    }).then(
      w => (run = w),
      (e: unknown) => void (failure = e instanceof Error ? e.message : String(e)),
    );
    const started = now();
    const until = started + capMs;
    /** What the status said when it said signed in, once it does. */
    let landed: string | undefined;
    let why: string | undefined;
    try {
      while (run === undefined && failure === undefined && now() < until) {
        await wait(cadence(now() - started, pollMs), watching);
        if (run !== undefined || failure !== undefined || status === undefined) continue;
        const answer = await asked(status);
        if (answer === true) {
          landed = `${status.command} says signed in`;
          break;
        }
        why = answer;
      }
      // A tool that has just signed in is still writing (gh sets the git protocol and credential helper after
      // auth), so a status that flipped waits for it to end on its own before the pty is killed.
      if (landed !== undefined) await wait(graceMs, watching);
      settle?.();
      await watching;
      if (run === undefined) {
        r.state = "not-signed-in";
        r.note = failure ?? "the sign-in command never ran";
        return;
      }
      const w = run;
      if (w.exitCode !== -1) r.exit = w.exitCode;
      if (landed !== undefined) {
        r.state = "signed-in";
        r.note = landed;
        return;
      }
      if (theirs !== undefined) {
        r.state = "not-signed-in";
        r.note = `${command} asks "${theirs}", which only you can answer; sign in from the app's terminal`;
        return;
      }
      // The cap ran out with the person not through: the build moves on and the row says where the sign-in goes
      // instead. A stop from the person overwrites this below, which is a different thing to have happened.
      if (w.stopped || w.timedOut) {
        r.state = "deferred";
        r.note = [`no sign-in within ${fmtDuration(capMs)}`, ...(told !== undefined ? [] : ["no page to open was ever printed or asked for"]), ...(why !== undefined ? [why] : [])].join("; ");
        return;
      }
      if (w.dropped) {
        r.state = "not-signed-in";
        r.note = "the machine's terminal link dropped";
        return;
      }
      // The shell's own "not found": the tool is not on the machine, and no status check can change that.
      if (w.exitCode === 127) {
        r.state = "skipped";
        r.note = `${toolOf(command)} is not on the machine`;
        return;
      }
      if (w.exitCode === 0) {
        r.state = "signed-in";
        r.note = `${command} exited 0`;
        return;
      }
      // The command ended badly with the person perhaps already through the page: its own status has the last word.
      if (status === undefined) {
        r.state = "not-signed-in";
        r.note = `${command} exited ${w.exitCode}`;
        return;
      }
      const answer = await asked(status);
      r.state = answer === true ? "signed-in" : "not-signed-in";
      r.note = answer === true ? `${status.command} says signed in` : `${command} exited ${w.exitCode}; ${answer}`;
    } finally {
      settle?.();
      closeCode?.();
      daemon.close();
      if (o.flow !== undefined) {
        delete o.flow.show;
        delete o.flow.openWords;
        delete o.flow.onPage;
        delete o.flow.callbackUrl;
      }
    }
  };

  const stoppedNow = (): boolean => o.signal?.aborted ?? false;
  for (const [entry, r] of machine) {
    if (stoppedNow()) {
      r.state = "not-signed-in";
      r.note = STOPPED_NOTE;
      o.json?.({ event: "sign-in-result", tool: agentName(entry), label: r.label, state: r.state, note: r.note });
      continue;
    }
    try {
      await sign(entry, r);
    } catch (e) {
      r.state = "not-signed-in";
      r.note = e instanceof Error ? e.message : String(e);
    }
    if (stoppedNow() && r.state !== "signed-in") {
      r.state = "not-signed-in";
      r.note = STOPPED_NOTE;
    }
    o.json?.({ event: "sign-in-result", tool: agentName(entry), label: r.label, state: r.state, ...(r.note !== undefined ? { note: r.note } : {}) });
    log.message(stateLine(r), { output: o.output, symbol: dim(S_BAR) });
  }
  return outcomes;
}
