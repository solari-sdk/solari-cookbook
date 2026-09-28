// SPDX-License-Identifier: AGPL-3.0-only
// The one contract an agent reads wsp by: with --json stdout carries JSON
// alone, every refusal or failure is one line on stderr, and the exit code is
// the class the error belongs to. The class is read off the kind stamped on
// the error where it was born (the engine's for a provider answer, the two
// helpers here for a refusal), never off its words, so every door classes
// the same failure the same way.
import { z } from "zod";
import { refusalLine } from "./format.js";

export const ExitClass = z.enum(["ok", "provider", "auth", "usage"]);
export type ExitClass = z.infer<typeof ExitClass>;

/** The exit code each class owns, the same on every verb and command. */
export const EXIT_CODES: Readonly<Record<ExitClass, number>> = { ok: 0, provider: 1, auth: 2, usage: 3 };

/** What each class means, in the words the skill, the help and the instructions quote. */
export const EXIT_WORDS: Readonly<Record<ExitClass, string>> = {
  ok: "it did what its line says; with --json stdout holds the answer",
  provider: "the host, the runtime, Solari or the machine refused or failed",
  auth: "no key, no sign-in, or the host refused the token",
  usage: "the line was refused before anything ran: a missing argument, an unknown flag or a value nothing takes",
};

/** A failure as --json prints it on stderr and as a tool error carries it beside its text. */
export const VerbFailure = z.object({ error: z.string(), class: ExitClass.exclude(["ok"]), exit: z.number().int() });
export type VerbFailure = z.infer<typeof VerbFailure>;

const KIND_CLASS: Readonly<Record<string, Exclude<ExitClass, "ok">>> = { usage: "usage", invalid: "usage", auth: "auth", "not-found": "usage" };

/** The class of an error, by the kind stamped on it; one with no kind, or a kind no class claims, is the provider's. */
export function exitClassOf(e: unknown): Exclude<ExitClass, "ok"> {
  const kind = typeof e === "object" && e !== null ? (e as { kind?: unknown }).kind : undefined;
  return (typeof kind === "string" ? KIND_CLASS[kind] : undefined) ?? "provider";
}

/** JSON text with DEL and the C1 controls escaped: JSON.stringify escapes C0 alone, and a terminal acts on a raw C1
 * CSI or OSC byte as it does on ESC. Those characters only ever stand inside a string, so the value parses the same. */
export const escapeC1 = (json: string): string => json.replace(/[\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Every JSON a verb prints, answer or failure. */
export const jsonLine = (value: unknown, space?: number): string => escapeC1(JSON.stringify(value, null, space) ?? "null");

export function verbFailure(e: unknown): VerbFailure {
  const cls = exitClassOf(e);
  return { error: e instanceof Error ? e.message : String(e), class: cls, exit: EXIT_CODES[cls] };
}

/** A refusal in both halves, what happened and then what to do about it, because one that only names the fault
 * leaves the person to work the fix out for themselves. The message is `refusalLine`'s join, which a terminal
 * prints; `fix` rides beside it so a client that draws the halves apart reads it rather than guessing at the text. */
export const refusal = (happened: string, fix: string, kind?: string): Error & { fix: string; kind?: string } =>
  Object.assign(new Error(refusalLine(happened, fix)), { fix }, kind !== undefined ? { kind } : {});

/** What a refusal said before its fix: the message with the fix `refusal` joined on taken back off the end. */
export const refusalSaid = (message: string, fix: string | undefined): string => (fix !== undefined && message.endsWith(` ${fix}`) ? message.slice(0, -fix.length - 1) : message);

const stringProp = (e: object, key: "fix" | "kind"): string | undefined => {
  const v = (e as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

/** A rejection read into the halves a refusal was stamped with: the sentence before its fix, the fix, the kind. */
export function refusalParts(e: unknown): { said: string; fix: string | undefined; kind: string | undefined } {
  if (!(e instanceof Error)) return { said: String(e), fix: undefined, kind: undefined };
  const fix = stringProp(e, "fix");
  return { said: refusalSaid(e.message, fix), fix, kind: stringProp(e, "kind") };
}

/** How much of one line a refusal keeps where it outlives its answer, in a log or on a job every client reads:
 * refusals repeat what they were sent, and a computer's own log lines carry no bound. */
export const SAID_LINE_CHARS = 400;
/** The lines a kept refusal keeps: its own sentence and the ten a computer's log adds under it. */
const SAID_LINES = 11;

export const markedCut = (line: string, max = SAID_LINE_CHARS): string => (line.length > max ? `${line.slice(0, max)} (cut ${line.length - max} characters)` : line);

/** A refusal as a host keeps it for every client to read: each line cut, and the lines past the eleventh said as cut. */
export function keptSaid(said: string): string {
  const lines = said.split("\n");
  const kept = lines.slice(0, SAID_LINES).map(line => markedCut(line));
  return (lines.length > SAID_LINES ? [...kept, `(cut ${lines.length - SAID_LINES} lines)`] : kept).join("\n");
}

/** A line refused before anything ran: a missing argument, a flag or a value nothing takes. */
export const usageRefusal = (happened: string, fix: string): Error => refusal(happened, fix, "usage");

/** No key, no sign-in, or a token the host refused. */
export const authRefusal = (message: string): Error => Object.assign(new Error(message), { kind: "auth" });

/** A name this host holds nothing by: a workspace, a thread. Nothing ran and no provider was asked, so it classes
 * with the other values nothing takes rather than with what a provider refused, whichever door was typed. */
export const notFoundRefusal = (message: string): Error => Object.assign(new Error(message), { kind: "not-found" });
