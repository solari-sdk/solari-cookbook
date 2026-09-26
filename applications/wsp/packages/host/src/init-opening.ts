// SPDX-License-Identifier: AGPL-3.0-only
// The first thing wsp init prints: the wordmark in shaded greys, then the
// badge line that opens the clack frame, then the state file this run sets up
// and the flag that starts a fresh one. Off a terminal, or under --yes, one
// plain line with the version and that same state line.
import { styleText } from "node:util";
import { intro, log } from "@clack/prompts";
import { imageBuiltOnLine, stateFileLine } from "@wsp/protocol";
import type { InitIO } from "./init.js";
import { colourDepth, grey, muted } from "./init-layout.js";

export const TAGLINE = "your setup, on cloud machines, for coding agents";

/** "wsp" in block letters, written out so no font library is needed. */
export const WORDMARK: readonly string[] = [
  "██╗    ██╗███████╗██████╗ ",
  "██║    ██║██╔════╝██╔══██╗",
  "██║ █╗ ██║███████╗██████╔╝",
  "██║███╗██║╚════██║██╔═══╝ ",
  "╚███╔███╔╝███████║██║     ",
  " ╚══╝╚══╝ ╚══════╝╚═╝     ",
];

// Greys in the middle of the ramp, so they read on dark and light backgrounds alike.
const FILL = [250, 248, 246, 244, 242, 240];
const OUTLINE = 237;

/** Each row a step darker than the one above; the box-drawing outline darker than the blocks it edges. */
export function wordmark(colour = true): string[] {
  if (!colour) return [...WORDMARK];
  return WORDMARK.map((row, i) => row.replace(/█+|[^█ ]+/g, run => grey(run.startsWith("█") ? FILL[i]! : OUTLINE, run)));
}

export function opening(io: Pick<InitIO, "output" | "isTTY" | "env">, o: { command: string; version: string; yes: boolean; statePath: string }): void {
  const out = { output: io.output };
  const depth = colourDepth(io.isTTY, io.env);
  if (!io.isTTY || o.yes) {
    intro(`wsp ${o.version}`, out);
    log.message(stateFileLine(o.statePath), out);
    return;
  }
  io.output.write(`\n${wordmark(depth >= 8).join("\n")}\n\n`);
  intro(`${styleText("inverse", ` ${o.command} `)}  ${styleText("dim", `${TAGLINE}  ${o.version}`)}`, out);
  log.message(muted(stateFileLine(o.statePath), depth), out);
}

/** The line under the opening that names the place the image is built on, in the state line's own weight, or the
 * one saying why that is not the place --on named. */
export function builtOn(io: Pick<InitIO, "output" | "isTTY" | "env">, place: string, kept?: string): void {
  const out = { output: io.output };
  const line = kept ?? imageBuiltOnLine(place);
  log.message(io.isTTY ? muted(line, colourDepth(io.isTTY, io.env)) : line, out);
}
