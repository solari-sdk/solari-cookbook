// SPDX-License-Identifier: AGPL-3.0-only
// The secrets step of wsp init: the pack cut every secret export out of the
// rc files it carried, and the sign-ins screen may have asked for an API key
// instead of a login, so each name is asked for here once the machine is up.
// The value is typed hidden, travels to the builder in the pty's environment
// and lands in a profile.d file of its own (and in fish's conf.d when fish is
// there), so a later update re-uploading the rc file cannot strip it; a name
// already in that file is not asked again. The value is never on the pty's
// command line, on this screen or in the run log.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { S_BAR, isCancel, log } from "@clack/prompts";
import { shellQuote } from "@wsp/protocol";
import { passwordPrompt } from "./init-layout.js";
import type { BuilderLink } from "./init-signin.js";
import { runQuiet, type QuietRun } from "./signin-relay.js";

export type SecretState = "set" | "skipped" | "failed";

/** One value to ask for: the variable set on the machine and where it comes from, in the words the question uses. */
export interface SecretAsk {
  name: string;
  /** "cut from ~/.zshrc", "the key Claude Code reads there". */
  from: string;
}

export interface SecretOutcome extends SecretAsk {
  state: SecretState;
  note?: string;
}

export interface SecretsStageOptions {
  /** Every value to ask for: what the pack cut, then the API keys the sign-ins screen chose. */
  asks: readonly SecretAsk[];
  /** A fresh link to the builder's daemon, dialled before each command so a dropped one costs that command alone. */
  dial(): Promise<BuilderLink>;
  input: Readable;
  output: Writable;
  /** Set when nobody can type here (no terminal, or --yes): every name is skipped with this note. */
  skipWhy?: string;
  /** Keeps the value out of the run log. */
  hide(value: string): void;
  /** A command that hangs is given up after this. Default 1 min. */
  timeoutMs?: number;
}

/** Login shells read profile.d; fish reads its conf.d instead, so a fish machine gets the value twice. */
export const SH_FILE = "/etc/profile.d/wsp-secrets.sh";
export const FISH_FILE = "/etc/fish/conf.d/wsp-secrets.fish";
const COMMAND_MS = 60_000;
/** The pty environment variables that carry the lines; the command names them and never a value. */
const SH_ENV = "WSP_SECRET_LINE";
const FISH_ENV = "WSP_FISH_LINE";
const FISH_MARK = "WSP_FISH";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const dim = (s: string): string => styleText("dim", s);

/** The line profile.d gets: single quotes keep the value byte for byte. */
export function exportLine(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

/** The line fish's conf.d gets, quoted the way fish reads single quotes. */
export function fishLine(name: string, value: string): string {
  return `set -gx ${name} '${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** What is on the machine already: the names the secrets file exports (the values stay there), then a mark when
 * fish is installed. The probe is an if so the command ends 0 on a machine without fish. */
export function readCommand(): string {
  return `sed -n 's/^export \\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' ${SH_FILE} 2>/dev/null; if command -v fish >/dev/null 2>&1; then echo ${FISH_MARK}; fi`;
}

/** Appends the lines the pty's environment holds, the file created mode 600 and kept there. */
export function appendCommand(fish: boolean): string {
  const sh = `umask 077; printf '%s\\n' "$${SH_ENV}" >> ${SH_FILE} && chmod 600 ${SH_FILE}`;
  return fish ? `${sh} && mkdir -p /etc/fish/conf.d && printf '%s\\n' "$${FISH_ENV}" >> ${FISH_FILE} && chmod 600 ${FISH_FILE}` : sh;
}

function stateLine(o: SecretOutcome, fish: boolean): string {
  switch (o.state) {
    case "set":
      return `${o.name}: ${styleText("green", "set")} ${o.note ?? `in ${SH_FILE}${fish ? ` and ${FISH_FILE}` : ""} on the machine`}`;
    case "skipped":
      return `${o.name}: ${dim("skipped")}${o.note !== undefined ? dim(` (${o.note})`) : ""}`;
    case "failed":
      return `${o.name}: ${styleText("yellow", "not set")}${o.note !== undefined ? dim(` (${o.note})`) : ""}`;
    default: {
      const _exhaustive: never = o.state;
      return _exhaustive;
    }
  }
}

function whyNot(run: QuietRun, timeoutMs: number): string | undefined {
  if (run.dropped) return "the machine's terminal link dropped";
  if (run.timedOut) return `no answer within ${Math.round(timeoutMs / 60_000)} min`;
  if (run.exitCode !== 0) return `the shell answered exit ${run.exitCode}`;
  return undefined;
}

/** One quiet command over one fresh link; a rejection is the reason, never the run's end. */
async function quietly(o: SecretsStageOptions, command: string, env: Record<string, string>, timeoutMs: number): Promise<QuietRun | string> {
  try {
    const daemon = await o.dial();
    try {
      const run = await runQuiet(daemon.link, command, timeoutMs, env);
      return whyNot(run, timeoutMs) ?? run;
    } finally {
      daemon.close();
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function secretsStage(o: SecretsStageOptions): Promise<SecretOutcome[]> {
  // One variable is one ask however many rows want it: the machine's file is read once, before the loop, so a second
  // ask for a name would not see the first one land and would append it twice.
  const outcomes: SecretOutcome[] = [...o.asks.reduce((by, ask) => by.set(ask.name, [...(by.get(ask.name) ?? []), ask.from]), new Map<string, string[]>())].map(([name, from]): SecretOutcome => ({ name, from: from.join("; "), state: "skipped" }));
  if (outcomes.length === 0) return outcomes;
  const out = { output: o.output };
  if (o.skipWhy !== undefined) {
    for (const r of outcomes) r.note = o.skipWhy;
    const where = [...new Set(outcomes.map(r => r.from))].join(", ");
    log.step(`Secrets skipped: ${outcomes.map(r => r.name).join(", ")} (${where}). ${o.skipWhy[0]!.toUpperCase()}${o.skipWhy.slice(1)}.`, out);
    return outcomes;
  }
  const timeoutMs = o.timeoutMs ?? COMMAND_MS;
  log.step("Paste each value to set it on the machine, or leave it empty to skip.", out);
  const machine = await quietly(o, readCommand(), {}, timeoutMs);
  if (typeof machine === "string") log.warn(`The machine's secrets file was not read (${machine}); every name is asked.`, out);
  const lines = typeof machine === "string" ? [] : machine.output.split("\n");
  const present = new Set(lines.filter(l => l !== FISH_MARK && NAME.test(l)));
  const fish = lines.includes(FISH_MARK);
  for (const r of outcomes) {
    if (present.has(r.name)) {
      r.state = "set";
      r.note = "on the machine from an earlier run";
    } else {
      const value = await passwordPrompt({ message: r.name, hint: `${r.from}; the value is set on the machine and never shown here`, input: o.input, output: o.output });
      if (isCancel(value) || value === "") {
        r.note = "skipped by you";
      } else {
        o.hide(value);
        const env = { [SH_ENV]: exportLine(r.name, value), ...(fish ? { [FISH_ENV]: fishLine(r.name, value) } : {}) };
        const written = await quietly(o, appendCommand(fish), env, timeoutMs);
        if (typeof written === "string") {
          r.state = "failed";
          r.note = written;
        } else {
          r.state = "set";
        }
      }
    }
    log.message(stateLine(r, fish), { output: o.output, symbol: dim(S_BAR) });
  }
  return outcomes;
}
