// SPDX-License-Identifier: AGPL-3.0-only
// The block that refreshes where it stands: what it writes per frame, that it
// rewinds exactly the rows the last frame took at the width the terminal has
// now, and that a stop signal ends it with the cursor back on the screen.
import { describe, expect, it } from "vitest";
import { watchBlock, watchOn, type WatchDeps, type WatchSignals } from "../src/watch.js";

/** A terminal that records every write, and the signals a test fires by hand: a real one would take the runner. */
function screen(columns = 100): { writes: string[]; deps: WatchDeps; fire: () => void } {
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  const signals: WatchSignals = { on: (_sig, l) => listeners.add(l), off: (_sig, l) => listeners.delete(l) };
  return {
    writes,
    deps: { write: t => void writes.push(t), columns: () => columns, everyMs: 1, signals },
    fire: () => {
      for (const l of [...listeners]) l();
    },
  };
}

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

describe("a list that refreshes where it stands", () => {
  it("draws one write per frame, rewinds the rows the last frame took, and gives the cursor back on the stop", async () => {
    const { writes, deps, fire } = screen();
    let tick = 0;
    const watching = watchBlock(async () => {
      tick++;
      if (tick === 3) queueMicrotask(fire);
      return [`WORKSPACE  STATE`, `alpha      Running ${tick}`];
    }, deps);
    await watching;

    expect(writes[0]).toBe(HIDE);
    expect(writes.at(-1)).toBe(SHOW);
    const frames = writes.slice(1, -1);
    expect(frames).toHaveLength(3);
    // The first frame has nothing above it to rewind over; every frame after it rewinds the two rows it drew.
    expect(frames[0]).toBe("WORKSPACE  STATE\nalpha      Running 1\n");
    expect(frames[1]).toBe("\x1b[2A\x1b[G\x1b[JWORKSPACE  STATE\nalpha      Running 2\n");
    expect(frames[2]).toBe("\x1b[2A\x1b[G\x1b[JWORKSPACE  STATE\nalpha      Running 3\n");
  });

  it("counts the rows a frame wrapped onto at the width the terminal has now, so a narrowed window is not half cleared", async () => {
    const { writes, deps, fire } = screen(10);
    let tick = 0;
    await watchBlock(async () => {
      tick++;
      if (tick === 2) queueMicrotask(fire);
      // 25 cells over a 10 cell terminal is three rows, not one.
      return ["x".repeat(25)];
    }, deps);
    expect(writes.slice(1, -1)[1]).toBe(`\x1b[3A\x1b[G\x1b[J${"x".repeat(25)}\n`);
  });

  it("a draw that throws ends the watch with the cursor back and the refusal carried out to the caller", async () => {
    const { writes, deps } = screen();
    await expect(watchBlock(async () => Promise.reject(new Error("the host stopped answering")), deps)).rejects.toThrow("the host stopped answering");
    expect(writes).toEqual([HIDE, SHOW]);
  });

  it("the stop takes its listeners back off, so a watch that ended leaves nothing of its own on the process", async () => {
    const { deps } = screen();
    const held = new Set<() => void>();
    const signals: WatchSignals = {
      on: (_s, l) => {
        held.add(l);
        return undefined;
      },
      off: (_s, l) => held.delete(l),
    };
    await watchBlock(async () => {
      // One listener per signal the watch stops on, all of them the same handler.
      expect(held.size).toBe(1);
      queueMicrotask(() => [...held].forEach(l => l()));
      return ["one row"];
    }, { ...deps, signals });
    expect(held.size).toBe(0);
  });

  it("draws nothing for empty rows and leaves the block it drew where it is, rather than walking it up the screen", async () => {
    const { writes, deps, fire } = screen();
    let tick = 0;
    await watchBlock(async () => {
      tick++;
      if (tick === 4) queueMicrotask(fire);
      // A source that goes quiet for two ticks: the rows it had must stay where they are, not scroll on a newline.
      return tick === 2 || tick === 3 ? [] : ["one row"];
    }, deps);
    const frames = writes.slice(1, -1);
    expect(frames).toEqual(["one row\n", "\x1b[1A\x1b[G\x1b[Jone row\n"]);
  });

  it("draws as soon as the source pushes rather than waiting out the tick", async () => {
    const { writes, deps, fire } = screen();
    let pushes = 0;
    let tick = 0;
    // A tick far past the run: every frame after the first is the push alone, so this counts pushes and not ticks.
    await watchBlock(
      async () => {
        tick++;
        if (tick === 3) queueMicrotask(fire);
        return [`row ${tick}`];
      },
      {
        ...deps,
        everyMs: 60_000,
        until: () =>
          new Promise<void>(resolve => {
            pushes++;
            setTimeout(resolve, 1);
          }),
      },
    );
    expect(writes.slice(1, -1)).toHaveLength(3);
    expect(pushes).toBe(2);
  });

  it("keeps drawing on the tick when the source stops pushing, so a screen never freezes on a quiet link", async () => {
    const { writes, deps, fire } = screen();
    let tick = 0;
    // An until that never settles: every frame after the first is the tick alone.
    await watchBlock(
      async () => {
        tick++;
        if (tick === 2) queueMicrotask(fire);
        return [`row ${tick}`];
      },
      { ...deps, everyMs: 1, until: () => new Promise<void>(() => {}) },
    );
    expect(writes.slice(1, -1)).toHaveLength(2);
  });

  it("refuses --watch where there is no terminal to redraw on and beside --json, in two halves each", () => {
    const redraw = { write: (): void => {}, columns: () => 100 };
    const noTerminal = watchOn("wsp workspaces", { json: false });
    expect("refusal" in noTerminal && noTerminal.refusal.message).toContain("wsp workspaces --watch redraws where it stands");
    expect("refusal" in noTerminal && noTerminal.refusal.message).toContain("Run wsp workspaces without --watch to print the list once.");
    const json = watchOn("wsp threads", { json: true, redraw });
    expect("refusal" in json && json.refusal.message).toContain("wsp threads --watch redraws a table and --json answers with objects.");
    // A terminal and no --json: where it will draw, and nothing refused.
    expect(watchOn("wsp workspaces", { json: false, redraw })).toEqual({ redraw });
  });
});
