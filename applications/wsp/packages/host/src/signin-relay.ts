// SPDX-License-Identifier: AGPL-3.0-only
// A pty on the builder shown in this terminal, the way ssh would: keystrokes
// go up, bytes come down, the local terminal sits in raw mode for the
// duration and its size follows. The only thing read from the stream is a
// URL the tool printed, which is re-shown as a hyperlink with `o` to open it
// on this computer, unless the tool asked for a page that returns through a
// forwarded port, which o opens instead; codes and tokens are never looked at.
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";
import type { Question } from "@wsp/catalog";
import { hasControlChar, lastLine, shellQuote } from "@wsp/protocol";
import type { PtyLink } from "@wsp/runtime";

export type { PtyLink };

export interface RelayTerminal {
  input: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(on: boolean): unknown };
  output: Writable & { columns?: number; rows?: number };
}

export interface RelayOptions {
  link: PtyLink;
  /** The line the guest shell runs; the pty exits with its status. Absent: a bare shell the person exits. */
  command?: string;
  terminal: RelayTerminal;
  /** Opens a URL on this computer; called only when the person presses o. */
  open(url: string): Promise<boolean>;
  /** The page the tool asked the machine to open, when one arrived that returns through a forwarded port:
   * o opens it in place of the printed link, whose page only shows a code to paste. */
  callbackUrl?(): string | undefined;
  /** The person pressed o and this URL opened here. */
  onConsent?(url: string): void;
  /** Rides the pty's environment on the far side, where the daemon's own defaults would otherwise decide: what a
   * tool whose store lives somewhere other than its default home is run with, without quoting it into the line. */
  env?: Record<string, string>;
  /** The pty is killed after this long. */
  timeoutMs: number;
  /** A URL that ends a chunk is offered after this much quiet, for a tool that prints it and blocks. Default 300 ms. */
  flushMs?: number;
  now?: () => number;
}

export interface RelayOutcome {
  /** -1 when the pty never exited (a timeout or a dropped link). */
  exitCode: number;
  timedOut: boolean;
  /** The daemon link went away under the pty. */
  dropped: boolean;
  /** Distinct URLs the tool printed. */
  urls: number;
  /** How many times o opened one here. */
  opened: number;
}

/** A pressed o opens the URL only this soon after it appeared, and only before any text was typed
 * (Enter and other control keys keep the offer: gh asks for an Enter before its own open). */
export const OFFER_MS = 60_000;
const OPENED_PRINTED = "opened on this computer; if the page shows a code, paste it into the terminal above";
const OPENED_PAGE = "opened the sign-in page; it returns to the machine on its own";
const FLUSH_MS = 300;
const PRINTABLE = /[\x20-\x7e\u00a0-\uffff]/;
/** Arrow keys and the like, CSI or application-mode SS3: a menu moved is not text typed. */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[A-Z]/g;
const TAIL_CHARS = 2048;
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\x00-\x1f\x7f]+/g;

export function stripOsc8(text: string): string {
  return text.replace(OSC8, "");
}

/** URLs in the text, trailing punctuation dropped, a match that runs to the very end left for the next chunk. */
export function urlsIn(text: string): string[] {
  const clean = stripOsc8(text);
  const out: string[] = [];
  for (const m of clean.matchAll(URL_IN_TEXT)) {
    if (m.index + m[0].length === clean.length) continue;
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** Feeds chunks and reports each URL once, even one split across two chunks. */
export class UrlScanner {
  private tail = "";
  private seen = new Set<string>();
  feed(chunk: string): string[] {
    const text = this.tail + chunk;
    this.tail = text.slice(-TAIL_CHARS);
    return this.fresh(urlsIn(text));
  }
  /** Settles a URL that ended the last chunk, as if a line break had followed it. */
  flush(): string[] {
    return this.fresh(urlsIn(`${this.tail}\n`));
  }
  private fresh(urls: string[]): string[] {
    const out = urls.filter(u => !this.seen.has(u));
    for (const u of out) this.seen.add(u);
    return out;
  }
}

/** A question the tool printed, and its own words there. */
export interface Asked {
  question: Question;
  /** What the shape matched, for a row that has to say which question stopped it. */
  matched: string;
}

/** Feeds chunks and reports each question the row declares once. The tail is kept raw and the escapes come out of
 * the joined text, so neither a question nor an escape sequence the pty split across two chunks can hide a shape. */
export class QuestionScanner {
  private tail = "";
  private readonly seen = new Set<Question>();
  constructor(private readonly questions: readonly Question[]) {}
  feed(chunk: string): Asked[] {
    if (this.seen.size === this.questions.length) return [];
    const raw = this.tail + chunk;
    this.tail = raw.slice(-TAIL_CHARS);
    const text = stripVTControlCharacters(stripOsc8(raw));
    const out: Asked[] = [];
    for (const question of this.questions) {
      const matched = this.seen.has(question) ? undefined : question.asks.exec(text)?.[0];
      if (matched === undefined) continue;
      this.seen.add(question);
      out.push({ question, matched });
    }
    return out;
  }
}

export function hyperlink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

const dim = (s: string): string => styleText("dim", s);

/** The daemon answers a refused op with {ok:false, error} and the socket resolves that envelope; here a refusal throws. */
function okOrThrow(op: string, reply: Record<string, unknown>): Record<string, unknown> {
  if (reply["ok"] !== true) throw new Error(`${op} refused: ${typeof reply["error"] === "string" ? reply["error"] : "no reason given"}`);
  return reply;
}

function ptyIdOf(reply: Record<string, unknown>): string {
  const id = okOrThrow("pty.create", reply)["ptyId"];
  if (typeof id !== "string") throw new Error("pty.create answered without a pty id");
  return id;
}

/** What the pty prints the moment the typed line has run and the tool starts: everything before it is the shell's
 * prompt and its echo of the line, which are not the tool's words. */
export const TOOL_STARTS = "\x1e";

/** Puts a command in a file only the daemon's login can read, in a folder of its own, and answers the folder. */
const STAGE = `umask 077 && d=$(mktemp -d "\${TMPDIR:-/tmp}/wsp-line.XXXXXX") && cat > "$d/line" && printf '%s' "$d"`;

/** A command put where a short typed line reads it: a canonical tty line holds 1024 bytes on macOS and bash takes the
 * typed line before its line editor has the tty, so a command typed whole is cut off past that. */
export interface Staged {
  dir: string;
  /** The folder's file, quoted for the shell. */
  file: string;
  clear(): Promise<void>;
}

async function stage(link: PtyLink, command: string): Promise<Staged> {
  const reply = await link.op("exec", { cmd: STAGE, stdin: Buffer.from(command, "utf8").toString("base64") });
  const dir = typeof reply["stdout"] === "string" ? reply["stdout"] : "";
  if (reply["exitCode"] !== 0 || !dir.startsWith("/") || hasControlChar(dir)) {
    throw new Error(`could not put the command on that computer: ${lastLine(String(reply["stderr"] ?? reply["error"] ?? "")) ?? "no reason given"}`);
  }
  return { dir, file: shellQuote(`${dir}/line`), clear: async () => void (await link.op("exec", { cmd: `rm -rf -- ${shellQuote(dir)}` }).catch(() => {})) };
}

/** The line typed into the pty's bash: it reads the staged command, removes its folder, prints the byte that marks the
 * tool starting and exec's the command, so the pty ends with the tool whatever way it ends. */
export function shellLine(staged: Pick<Staged, "dir" | "file">): string {
  return `c=$(< ${staged.file}); rm -rf -- ${shellQuote(staged.dir)}; printf '\\036'; exec bash -c "$c"\r`;
}

/** Hands on only what the pty printed once the tool started: a login banner, the prompt and the echo of the typed line
 * are the shell's, so a page or a code read there is not the tool's. */
function fromTool(): (chunk: string) => string {
  let started = false;
  return chunk => {
    if (started) return chunk;
    const at = chunk.indexOf(TOOL_STARTS);
    if (at < 0) return "";
    started = true;
    return chunk.slice(at + TOOL_STARTS.length);
  };
}

export async function relayPty(o: RelayOptions): Promise<RelayOutcome> {
  const { input, output } = o.terminal;
  const now = o.now ?? Date.now;
  const cols = output.columns ?? 80;
  const rows = output.rows ?? 24;
  // bash by name: the person's login shell may read interactive rc files that would sit under the typed line.
  const ptyId = ptyIdOf(await o.link.op("pty.create", { cols, rows, shell: "bash", ...(o.env !== undefined ? { env: o.env } : {}) }));
  const scanner = new UrlScanner();
  const tool = o.command === undefined ? (chunk: string) => chunk : fromTool();
  let staged: Staged | undefined;
  const outcome: RelayOutcome = { exitCode: -1, timedOut: false, dropped: false, urls: 0, opened: 0 };
  let offer: { url: string; at: number; typed: boolean } | undefined;
  let done: (() => void) | undefined;
  const exited = new Promise<void>(r => (done = r));
  const show = (urls: string[]): void => {
    for (const url of urls) {
      outcome.urls += 1;
      offer = { url, at: now(), typed: false };
      output.write(`\r\n  ${dim("link")}  ${hyperlink(url)}  ${dim("o opens it on this computer")}\r\n`);
    }
  };
  let flush: NodeJS.Timeout | undefined;

  const detach = o.link.onEvent(e => {
    if (e["ptyId"] !== ptyId) return;
    if (e["type"] === "pty.data") {
      const data = String(e["data"]);
      output.write(data);
      const said = tool(data);
      if (said === "") return;
      show(scanner.feed(said));
      if (flush) clearTimeout(flush);
      flush = setTimeout(() => show(scanner.flush()), o.flushMs ?? FLUSH_MS);
      flush.unref();
      return;
    }
    if (e["type"] === "pty.exit") {
      outcome.exitCode = Number(e["exitCode"]);
      done?.();
    }
  });
  void o.link.closed?.then(() => {
    if (outcome.exitCode === -1) outcome.dropped = true;
    done?.();
  });

  const wasRaw = input.isRaw === true;
  let rawSet = false;
  const onData = (chunk: Buffer | string): void => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (s === "o" && offer !== undefined && !offer.typed && now() - offer.at <= OFFER_MS) {
      const page = o.callbackUrl?.();
      const url = page ?? offer.url;
      o.onConsent?.(url);
      void o.open(url).then(ok => {
        if (ok) outcome.opened += 1;
        output.write(`\r\n  ${dim(ok ? (page !== undefined ? OPENED_PAGE : OPENED_PRINTED) : "could not open a browser here; use the link above")}\r\n`);
      });
      return;
    }
    if (offer !== undefined && PRINTABLE.test(s.replace(CSI, ""))) offer.typed = true;
    void o.link.op("pty.write", { ptyId, data: s }).catch(() => {});
  };
  const onResize = (): void => {
    void o.link.op("pty.resize", { ptyId, cols: output.columns ?? cols, rows: output.rows ?? rows }).catch(() => {});
  };
  const timer = setTimeout(() => {
    outcome.timedOut = true;
    done?.();
  }, o.timeoutMs);
  timer.unref();

  try {
    okOrThrow("pty.attach", await o.link.op("pty.attach", { ptyId }));
    if (input.isTTY && input.setRawMode) {
      input.setRawMode(true);
      rawSet = true;
    }
    input.on("data", onData);
    input.resume();
    output.on("resize", onResize);
    if (o.command !== undefined) {
      staged = await stage(o.link, o.command);
      await o.link.op("pty.write", { ptyId, data: shellLine(staged) });
    }
    await exited;
  } finally {
    clearTimeout(timer);
    if (flush) clearTimeout(flush);
    input.off("data", onData);
    input.pause();
    output.off("resize", onResize);
    if (rawSet && input.setRawMode) input.setRawMode(wasRaw);
    detach();
    await o.link.op("pty.kill", { ptyId }).catch(() => {});
    await staged?.clear();
  }
  return outcome;
}

export interface WatchOutcome {
  /** -1 when the pty never exited: a timeout, a dropped link, or the caller's stop. */
  exitCode: number;
  timedOut: boolean;
  /** The daemon link went away under the pty. */
  dropped: boolean;
  /** The caller had seen enough and ended it before the tool did. */
  stopped: boolean;
}

export interface WatchOptions {
  link: PtyLink;
  /** The line the guest shell runs; the pty exits with its status. */
  command: string;
  /** Every chunk the tool printed, before that chunk's URLs are reported, so a code printed beside a page is in
   * hand when the page arrives. */
  onData?(text: string): void;
  /** Each URL the tool printed, once. */
  onUrl?(url: string): void;
  /** The end of a chunk, once its pages have been reported: where a caller acts on what it could only judge with
   * those in hand, like a code the tool printed under its page. */
  onScanned?(): void;
  /** Rides the pty's environment on the machine, where the daemon's own defaults would otherwise decide. */
  env?: Record<string, string>;
  /** The questions the row declares: an answer the row carries is typed on the tool's own pty as its line appears,
   * once, the way the person at that terminal would press it. */
  questions?: readonly Question[];
  /** Each declared question as the tool printed it, once, whether or not the row answered it. */
  onQuestion?(asked: Asked): void;
  /** Handed the pty's own input once it is attached, and nothing once it is gone: what a code from a page is typed
   * with, from wherever the person pasted it. A refused write rejects, so the caller can say so. */
  onTyping?(write: ((data: string) => Promise<void>) | undefined): void;
  /** The pty is killed after this long. */
  timeoutMs: number;
  /** Settles when the caller wants the pty ended early. */
  stop?: Promise<unknown>;
  /** A URL that ends a chunk is reported after this much quiet, for a tool that prints it and blocks. Default 300 ms. */
  flushMs?: number;
}

/** The same pty as relayPty with nobody at this terminal: nothing is drawn, the
 * tool's output goes to the caller and each page it prints is reported as it
 * arrives, and the only thing typed back is what onTyping's holder sends. What
 * the sign-in hand-off runs, where the person opens the page on their own
 * computer instead. */
export async function watchPty(o: WatchOptions): Promise<WatchOutcome> {
  // Wide, so a printed URL is never wrapped onto two lines before the scanner reads it.
  const ptyId = ptyIdOf(await o.link.op("pty.create", { cols: 200, rows: 50, shell: "bash", ...(o.env !== undefined ? { env: o.env } : {}) }));
  const scanner = new UrlScanner();
  const outcome: WatchOutcome = { exitCode: -1, timedOut: false, dropped: false, stopped: false };
  let ended = false;
  let done: (() => void) | undefined;
  const exited = new Promise<void>(r => (done = r));
  const end = (mark: () => void): void => {
    if (ended) return;
    ended = true;
    mark();
    done?.();
  };
  let flush: NodeJS.Timeout | undefined;
  const report = (urls: string[]): void => {
    for (const url of urls) o.onUrl?.(url);
  };
  const questions = new QuestionScanner(o.questions ?? []);
  const tool = fromTool();
  let staged: Staged | undefined;
  const detach = o.link.onEvent(e => {
    if (e["ptyId"] !== ptyId) return;
    if (e["type"] === "pty.data") {
      const data = tool(String(e["data"]));
      if (data === "") return;
      o.onData?.(data);
      for (const asked of questions.feed(data)) {
        if ("answer" in asked.question) void o.link.op("pty.write", { ptyId, data: asked.question.answer }).catch(() => {});
        o.onQuestion?.(asked);
      }
      report(scanner.feed(data));
      o.onScanned?.();
      if (flush) clearTimeout(flush);
      flush = setTimeout(() => {
        report(scanner.flush());
        o.onScanned?.();
      }, o.flushMs ?? FLUSH_MS);
      flush.unref();
      return;
    }
    if (e["type"] === "pty.exit") end(() => (outcome.exitCode = Number(e["exitCode"])));
  });
  void o.link.closed?.then(() => end(() => (outcome.dropped = true)));
  void o.stop?.then(() => end(() => (outcome.stopped = true)));
  const timer = setTimeout(() => end(() => (outcome.timedOut = true)), o.timeoutMs);
  timer.unref();
  try {
    okOrThrow("pty.attach", await o.link.op("pty.attach", { ptyId }));
    o.onTyping?.(async data => void okOrThrow("pty.write", await o.link.op("pty.write", { ptyId, data })));
    staged = await stage(o.link, o.command);
    await o.link.op("pty.write", { ptyId, data: shellLine(staged) });
    await exited;
  } finally {
    clearTimeout(timer);
    if (flush) clearTimeout(flush);
    o.onTyping?.(undefined);
    detach();
    await o.link.op("pty.kill", { ptyId }).catch(() => {});
    await staged?.clear();
  }
  return outcome;
}

export interface QuietRun {
  output: string;
  exitCode: number;
  timedOut: boolean;
  /** The daemon link went away before the command answered. */
  dropped: boolean;
}

const STATUS_MARK = "WSP_STATUS";

/** Runs one command on the builder with nothing shown: the output between the
 * echoed line and the exit marker, for the secrets step. `env` rides the pty's
 * environment, where a value never reaches the echoed line. */
export async function runQuiet(link: PtyLink, command: string, timeoutMs: number, env: Record<string, string> = {}): Promise<QuietRun> {
  const ptyId = ptyIdOf(await link.op("pty.create", { cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", ...env } }));
  let text = "";
  /** Index of the exit marker line in what arrived so far, -1 before it. */
  const markAtEnd = (): number => {
    const lines = text.replace(/\r/g, "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) if (/^WSP_STATUS \d+$/.test(lines[i]!)) return i;
    return -1;
  };
  let done: (() => void) | undefined;
  const exited = new Promise<void>(r => (done = r));
  const detach = link.onEvent(e => {
    if (e["ptyId"] !== ptyId) return;
    if (e["type"] === "pty.data") text += String(e["data"]);
    if (e["type"] === "pty.exit") done?.();
  });
  let timedOut = false;
  let dropped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    done?.();
  }, timeoutMs);
  timer.unref();
  void link.closed?.then(() => {
    if (done !== undefined && markAtEnd() < 0) dropped = true;
    done?.();
  });
  let staged: Staged | undefined;
  try {
    okOrThrow("pty.attach", await link.op("pty.attach", { ptyId }));
    staged = await stage(link, command);
    await link.op("pty.write", { ptyId, data: `c=$(cat ${staged.file}); rm -rf -- ${shellQuote(staged.dir)}; eval "$c"; printf '\\n${STATUS_MARK} %s\\n' $?; exit\r` });
    await exited;
  } finally {
    clearTimeout(timer);
    detach();
    await link.op("pty.kill", { ptyId }).catch(() => {});
    await staged?.clear();
  }
  const lines = text.replace(/\r/g, "").split("\n");
  const markAt = markAtEnd();
  const exitCode = markAt >= 0 ? Number(/(\d+)$/.exec(lines[markAt]!)![1]) : -1;
  // The first line is the shell echoing what was typed.
  const body = lines.slice(1, markAt >= 0 ? markAt : undefined);
  // Tools colour into the pty (opencode 1.18.18 paints key names even piped); the readers want the words.
  return { output: stripVTControlCharacters(body.join("\n")).trim(), exitCode, timedOut, dropped };
}
