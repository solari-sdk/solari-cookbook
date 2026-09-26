// SPDX-License-Identifier: AGPL-3.0-only
// Local-line compose, as a pure table. In line mode (slave termios ICANON)
// printable keys accumulate in a client-side buffer painted on the terminal
// cursor, and Enter ships the whole line in one pty.write; every other key
// flushes the buffer and passes through untouched, so completion, history and
// interrupts need no special cases. In raw mode every key is passthrough.
// Nothing here touches React or the terminal surface: callers apply the returned writes.
import type { DaemonEvent } from "@wsp/protocol";

export type PtyModeReport = Pick<Extract<DaemonEvent, { type: "pty.mode" }>, "mode" | "echo">;

export interface ComposeState extends PtyModeReport {
  readonly buffer: string;
}

export interface ComposeStep {
  readonly state: ComposeState;
  /** Bytes for pty.write, "" for none. */
  readonly toPty: string;
  /** Bytes for the local terminal screen, "" for none. */
  readonly toScreen: string;
}

/** Until a pty.mode event arrives for a pty, it is treated as raw. */
export const RAW_STATE: ComposeState = { mode: "raw", echo: true, buffer: "" };

const ENTER = "\r";
const BACKSPACES = new Set(["\x7f", "\b"]);

function isPrintable(key: string): boolean {
  for (const ch of key) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
  }
  return key.length > 0;
}

// One cell per code point: a wide glyph leaves a stray cell until the pty
// repaints the line, and a line that wrapped cannot be walked back past
// column zero (the terminal has reverse wraparound off).
function erase(text: string): string {
  return "\b \b".repeat([...text].length);
}

/** What the terminal screen currently shows of the local buffer. */
function painted(s: ComposeState): string {
  return s.mode === "line" && s.echo ? s.buffer : "";
}

export function composeKey(state: ComposeState, key: string): ComposeStep {
  if (state.mode === "raw") return { state, toPty: key, toScreen: "" };
  const shown = painted(state);
  const cleared: ComposeState = { ...state, buffer: "" };
  if (key === ENTER) return { state: cleared, toPty: state.buffer + ENTER, toScreen: erase(shown) };
  if (BACKSPACES.has(key) && state.buffer.length > 0) {
    const chars = [...state.buffer];
    chars.pop();
    return { state: { ...state, buffer: chars.join("") }, toPty: "", toScreen: state.echo ? "\b \b" : "" };
  }
  if (isPrintable(key)) return { state: { ...state, buffer: state.buffer + key }, toPty: "", toScreen: state.echo ? key : "" };
  return { state: cleared, toPty: state.buffer + key, toScreen: erase(shown) };
}

/** A pty.mode report: leaving line mode flushes any pending buffer first. */
export function composeMode(state: ComposeState, report: PtyModeReport): ComposeStep {
  const next: ComposeState = { mode: report.mode, echo: report.echo, buffer: report.mode === "line" ? state.buffer : "" };
  const before = painted(state);
  const after = painted(next);
  return {
    state: next,
    toPty: report.mode === "raw" ? state.buffer : "",
    toScreen: before === after ? "" : erase(before) + after,
  };
}
