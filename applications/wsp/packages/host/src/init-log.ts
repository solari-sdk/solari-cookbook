// SPDX-License-Identifier: AGPL-3.0-only
// The run log of wsp init: one file beside the state, appended per run, that
// keeps what the terminal showed for a moment and the result files never held:
// every stage frame, every exec on the builder with its exit and trimmed
// output, the seal's decision and the app's address. The last five runs stay.
// Secrets never enter it: credential-shaped assignments lose their value, and
// every value read from the Keychain is blanked wherever it appears.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redacted } from "@wsp/protocol";
import type { GoldenExec } from "@wsp/runtime";

export const KEPT_RUNS = 5;
const HEAD_LINES = 20;
const TAIL_LINES = 20;
const RUN_HEAD = /^\S+ run [0-9a-f]+ /;
/** A NAME=value whose name says credential, quoted or bare; the value goes. */
const SECRET_ASSIGN = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;

export interface RunLog {
  readonly path: string;
  readonly id: string;
  /** Why the file could not be written, once a write failed; nothing is written after that. */
  readonly failed: string | undefined;
  /** A value that must never appear in the log, wherever it turns up. */
  hide(value: string): void;
  note(text: string): void;
  stage(stage: string, detail?: string): void;
  exec(exec: GoldenExec): void;
}

export function runLogPath(statePath: string): string {
  return join(dirname(statePath), "init.log");
}

export function redact(text: string, hidden: readonly string[] = []): string {
  return redacted(text.replace(SECRET_ASSIGN, "$1=<redacted>"), hidden);
}

/** The first and last lines of a block with a count of what sits between; an empty block is no lines. */
export function trimLines(text: string, head = HEAD_LINES, tail = TAIL_LINES): string[] {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  if (lines.length <= head + tail) return lines;
  return [...lines.slice(0, head), `(${lines.length - head - tail} lines cut)`, ...lines.slice(-tail)];
}

/** Drops the oldest runs so that this one is the fifth at most. */
function rotate(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const starts = lines.flatMap((l, i) => (RUN_HEAD.test(l) ? [i] : []));
  if (starts.length < KEPT_RUNS) return;
  writeFileSync(path, lines.slice(starts[starts.length - (KEPT_RUNS - 1)]!).join("\n"));
}

export function openRunLog(path: string, now: () => Date = () => new Date()): RunLog {
  const id = randomBytes(3).toString("hex");
  const hidden: string[] = [];
  let failed: string | undefined;
  const write = (head: string, body: readonly string[] = []): void => {
    if (failed !== undefined) return;
    try {
      appendFileSync(path, `${[`${now().toISOString()} ${redact(head, hidden)}`, ...body.map(l => `  ${redact(l, hidden)}`)].join("\n")}\n`);
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
  };
  try {
    rotate(path);
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  }
  write(`run ${id} wsp init (pid ${process.pid})`);
  return {
    path,
    id,
    get failed() {
      return failed;
    },
    hide: value => void hidden.push(value),
    note: text => write(`note ${text}`),
    stage: (stage, detail) => write(detail !== undefined ? `stage ${stage}: ${detail}` : `stage ${stage}`),
    exec: e => {
      const took = `${(e.ms / 1000).toFixed(1)}s`;
      const head = e.error !== undefined ? `exec ${e.machineId} failed (${e.error}) ${took}` : `exec ${e.machineId} exit ${e.exitCode} ${took}`;
      write(head, [...e.cmd.replace(/\n$/, "").split("\n").map(l => `$ ${l}`), ...trimLines(e.stdout ?? "").map(l => `> ${l}`), ...trimLines(e.stderr ?? "").map(l => `! ${l}`)]);
    },
  };
}
