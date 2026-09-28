// SPDX-License-Identifier: AGPL-3.0-only
// A list that refreshes where it stands, for every line that takes --watch.
// The rows are drawn, and on each tick the block is rewound and drawn again,
// so somebody watching a create, a pause or a delete sees the rows move
// without the scrollback filling with copies of one table. No screen library
// and no alternate screen: what is left on the terminal is the last frame,
// where a list printed once would have left it, and Ctrl-C is the terminal's
// own signal rather than a key this reads.
import { usageRefusal } from "@wsp/protocol";
import { cells, rewind } from "./init-layout.js";

/** How often a watched list is drawn again: a second, which is what the create, the pause and the delete a person
 * is watching for are followed inside. */
export const WATCH_EVERY_MS = 1_000;

/** The cursor is taken off the screen while a block redraws under it, since it would sit at the block's end and
 * flick up the screen on every frame; it comes back on every road out, the signal's included. */
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** The signals that end a watch. Ctrl-C at the terminal is the first; the other two are a terminal closing under it
 * and a service stopping it, and all three leave the screen the way the person's own Ctrl-C does. */
const WATCH_STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Where a watch's stop arrives. This process by default; a test hands in its own, since a real signal would take
 * the test runner with it. */
export interface WatchSignals {
  on(signal: (typeof WATCH_STOP_SIGNALS)[number], listener: () => void): unknown;
  off(signal: (typeof WATCH_STOP_SIGNALS)[number], listener: () => void): unknown;
}

/** Where a block that refreshes redraws: raw writes and the width to count wrapped rows at, both off the one
 * stream, so a frame can never be measured against a terminal other than the one it is written to. */
export interface Redraw {
  /** Raw text, no newline added. */
  write(text: string): void;
  /** The stream's width as it is at this moment. */
  columns(): number;
}

export interface WatchDeps extends Redraw {
  everyMs?: number;
  signals?: WatchSignals;
  /** What ends the wait between frames beside the tick: the next reading arriving. A watch whose source pushes
   * draws when it pushes, so a change shows as soon as the daemon saw it rather than up to a tick later; the tick
   * stands under it as the floor, which is what keeps a running clock in the rows moving. Absent, the tick alone. */
  until?(): Promise<void>;
}

/** Draws the block, then draws it again every tick until a stop signal arrives; resolves once it has stopped and
 * the cursor is back. A draw that throws ends the watch and the refusal rides out to the caller, with the screen
 * restored, since a list that cannot be read is not one to keep redrawing. */
export async function watchBlock(lines: () => Promise<readonly string[]>, deps: WatchDeps): Promise<void> {
  const everyMs = deps.everyMs ?? WATCH_EVERY_MS;
  const signals = deps.signals ?? process;
  let stopped = false;
  // Set while a tick is being waited out, so the signal ends the wait rather than the frame after it: a person who
  // pressed Ctrl-C must not watch their terminal for another second before it answers.
  let cutWait: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    cutWait?.();
  };
  for (const sig of WATCH_STOP_SIGNALS) signals.on(sig, stop);
  let drawn: number[] = [];
  deps.write(HIDE_CURSOR);
  try {
    while (!stopped) {
      const rows = await lines();
      // Nothing to draw leaves the block where it is: a bare newline would push it up the screen one row a tick and
      // rewind nothing next time, since the rows it counts would be none.
      if (rows.length > 0) {
        // One write per frame: the rewind clears the block, so a second write would leave the hole on the screen for
        // as long as the terminal took to get it.
        deps.write(`${rewind(drawn, deps.columns())}${rows.join("\n")}\n`);
        drawn = rows.map(cells);
      }
      if (stopped) break;
      const ticked = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, everyMs);
        cutWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      await (deps.until === undefined ? ticked : Promise.race([ticked, deps.until()]));
      cutWait?.();
      cutWait = undefined;
    }
  } finally {
    for (const sig of WATCH_STOP_SIGNALS) signals.off(sig, stop);
    deps.write(SHOW_CURSOR);
  }
}

/** Where a --watch on this line may redraw, or the refusal that says why it may not. A redraw needs a
 * terminal to redraw on, and the objects --json answers with are read by whatever is driving the run rather than by
 * an eye, so neither of those quietly prints one frame and stops. */
export function watchOn(words: string, opts: { json: boolean; redraw?: Redraw | undefined }): { redraw: Redraw } | { refusal: Error } {
  if (opts.json) return { refusal: usageRefusal(`${words} --watch redraws a table and --json answers with objects.`, `Take one of the two: ${words} --watch at a terminal, or ${words} --json for the objects.`) };
  if (opts.redraw === undefined) return { refusal: usageRefusal(`${words} --watch redraws where it stands, and this run has no terminal to redraw on.`, `Run ${words} without --watch to print the list once.`) };
  return { redraw: opts.redraw };
}
