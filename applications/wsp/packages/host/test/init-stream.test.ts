// SPDX-License-Identifier: AGPL-3.0-only
// The stage stream drawn into a small terminal: every frame is replayed through
// a screen that honours the cursor moves the stream writes, and the rows left
// on it are what the person sees. No row may hold two lines, no line may wrap,
// and a step only ever shows once.
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ALREADY_APPLIED } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";
import { SEAL_STEPS, StageStream, reduceStages, streamStages, type StageFrame } from "../src/init.js";
import { UPGRADE_STEPS } from "../src/init-upgrade.js";

const SPINNERS = /[◒◐◓◑]/;
const ev = (stage: string, at: number, detail?: string): StageFrame => ({ type: "golden.stage", name: "default", stage, at, ...(detail !== undefined ? { detail } : {}) });

/** A terminal of `cols` by `rows` cells: printable text, CR, LF, cursor up, cursor to column, erase below and erase line. Styling is dropped.
 * A resize reflows it the way Ghostty does: a row that overflowed continues on the next, and a narrower screen wraps every row wider than it. */
class Screen {
  private cells: string[][];
  /** Whether a row is the continuation of the one above, wrapped there because the text ran past the edge. */
  private wrapped: boolean[];
  private row = 0;
  private col = 0;
  private dropped = 0;

  constructor(
    public cols: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
    this.wrapped = Array<boolean>(rows).fill(false);
  }

  resize(cols: number): void {
    const logical: string[] = [];
    let at = { line: 0, offset: 0 };
    for (let r = 0; r < this.rows; r++) {
      const text = r + 1 < this.rows && this.wrapped[r + 1] ? this.cells[r]!.join("") : this.cells[r]!.join("").trimEnd();
      if (this.wrapped[r]) logical[logical.length - 1] += text;
      else logical.push(text);
      if (r === this.row) at = { line: logical.length - 1, offset: logical[logical.length - 1]!.length - text.length + this.col };
    }
    while (logical.length > 0 && logical.at(-1) === "" && logical.length - 1 > at.line) logical.pop();
    const rows: string[][] = [];
    const wrapped: boolean[] = [];
    let cursor = { row: 0, col: 0 };
    logical.forEach((text, i) => {
      const glyphs = Array.from(text);
      const chunks = glyphs.length === 0 ? [[]] : Array.from({ length: Math.ceil(glyphs.length / cols) }, (_, k) => glyphs.slice(k * cols, (k + 1) * cols));
      if (i === at.line) cursor = { row: rows.length + Math.floor(at.offset / cols), col: at.offset % cols };
      chunks.forEach((chunk, k) => {
        rows.push([...chunk, ...Array<string>(cols - chunk.length).fill(" ")]);
        wrapped.push(k > 0);
      });
    });
    while (rows.length > this.rows) {
      rows.shift();
      wrapped.shift();
      cursor.row -= 1;
      this.dropped += 1;
    }
    while (rows.length < this.rows) {
      rows.push(Array<string>(cols).fill(" "));
      wrapped.push(false);
    }
    this.cols = cols;
    this.cells = rows;
    this.wrapped = wrapped;
    this.row = cursor.row;
    this.col = cursor.col;
  }

  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i));
        if (!m) {
          i += 1;
          continue;
        }
        const arg = m[1] === "" ? undefined : Number(m[1]);
        switch (m[2]) {
          case "A":
            this.row = Math.max(0, this.row - (arg ?? 1));
            break;
          case "G":
            this.col = Math.max(0, (arg ?? 1) - 1);
            break;
          case "J":
            if (arg === undefined || arg === 0) {
              this.cells[this.row]!.fill(" ", this.col);
              for (let r = this.row + 1; r < this.rows; r++) {
                this.cells[r]!.fill(" ");
                this.wrapped[r] = false;
              }
            }
            break;
          case "K":
            if (arg === 2) this.cells[this.row]!.fill(" ");
            else if (arg === undefined || arg === 0) this.cells[this.row]!.fill(" ", this.col);
            break;
          default:
            break;
        }
        i += m[0].length;
        continue;
      }
      if (ch === "\n") {
        this.row += 1;
        this.col = 0;
        this.scroll();
        this.wrapped[this.row] = false;
        i += 1;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i += 1;
        continue;
      }
      const glyph = String.fromCodePoint(text.codePointAt(i)!);
      if (this.col >= this.cols) {
        this.col = 0;
        this.row += 1;
        this.scroll();
        this.wrapped[this.row] = true;
      }
      this.cells[this.row]![this.col] = glyph;
      this.col += 1;
      i += glyph.length;
    }
  }

  private scroll(): void {
    while (this.row >= this.rows) {
      this.cells.shift();
      this.cells.push(Array<string>(this.cols).fill(" "));
      this.wrapped.shift();
      this.wrapped.push(false);
      this.row -= 1;
      this.dropped += 1;
    }
  }

  /** Rows with text, top to bottom; blank rows under the last one are not counted. */
  lines(): string[] {
    const out = this.cells.map(r => r.join("").trimEnd());
    while (out.length > 0 && out.at(-1) === "") out.pop();
    return out;
  }

  /** Rows that scrolled off the top; a stream that fits never loses one. */
  get scrolled(): number {
    return this.dropped;
  }
}

/** One terminal with both of a process's streams on it, as stdout and stderr share a screen; `resize` is the pane changing width under a running stream. */
function terminal(cols: number, rows: number) {
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: cols, rows });
  const stderr = Object.assign(new PassThrough(), { isTTY: true, columns: cols, rows });
  const screen = new Screen(cols, rows);
  output.on("data", (c: Buffer) => screen.feed(c.toString()));
  stderr.on("data", (c: Buffer) => screen.feed(c.toString()));
  const resize = (to: number): void => {
    output.columns = to;
    stderr.columns = to;
    screen.resize(to);
  };
  return { output, stderr, screen, resize };
}

const NODE_WARNING = "(node:72935) MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 abort listeners added to [AbortSignal]. MaxListeners is 10. Use events.setMaxListeners() to increase limit\n(Use `node --trace-warnings ...` to show where the warning was created)\n";

const count = (lines: string[], text: string): number => lines.filter(l => l.includes(text)).length;

describe("seal and upgrade steps", () => {
  it("both name the promoting stage between the snapshot and the fork, in the seal's own words", () => {
    for (const steps of [SEAL_STEPS, UPGRADE_STEPS]) {
      const stages = steps.map(s => s.stage);
      expect(stages.slice(stages.indexOf("snapshotting"))).toEqual(["snapshotting", "promoting", "smoke-forking", "sealed"]);
      expect(steps.find(s => s.stage === "promoting")).toEqual({ stage: "promoting", start: "Saving the image", end: "Image saved", fail: "Saving the image failed" });
    }
  });
});

describe("what a failure is charged with", () => {
  const failed = (detail?: string, over: Partial<StageFrame> = {}): StageFrame => ({ type: "golden.stage", name: "default", stage: "failed", at: 9_000, ...(detail !== undefined ? { detail } : {}), ...over });

  it("a machine the build was already on is answered for where its first stage is the only one out: the kept builder frames one stage and then the failure", () => {
    const view = reduceStages([ev("creating", 0, "your builder from v1, kept since the save"), failed("the image was sealed before the base tools")]);
    expect(view.machine).toBe("gone");
    expect(view.failure).toBe("the image was sealed before the base tools");
    expect(view.steps.find(s => s.stage === "creating")!.state).toBe("failed");
  });

  it("a frame the run pushed itself booted nothing, so the failure is charged no machine", () => {
    const view = reduceStages([ev("creating", 0, "sandbox from base"), failed("the provider refused the create", { booted: false })]);
    expect(view.machine).toBeUndefined();
    expect(view.failure).toBe("the provider refused the create");
  });

  it("a machine the rollback could not remove is still named on the failure that left it", () => {
    const view = reduceStages([ev("creating", 0, "sandbox from base"), ev("deploying-daemon", 1_000), failed("the deploy failed", { left: ["m_1"] })]);
    expect(view.machine).toBe("left");
    expect(view.left).toEqual(["m_1"]);
  });

  it("a failure with no sentence in it is said as the stage it stopped", () => {
    expect(reduceStages([ev("creating", 0, "sandbox from base"), failed("")]).failure).toBe("Creating the machine failed");
    expect(reduceStages([ev("creating", 0, "sandbox from base"), ev("deploying-daemon", 1_000), failed()]).failure).toBe("Installing the base failed");
    // Nothing ran at all: the failure lands on the stage that was about to.
    expect(reduceStages([failed("")]).failure).toBe("Creating the machine failed");
  });
});

describe("stage stream on a terminal", () => {
  it("a long detail under a failed step is cut to the row, so the block never drifts and every step shows once", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(60, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0, "sandbox from default"));
      stream.push(ev("deploying-daemon", 1_000));
      stream.push(ev("applying-setup", 2_000, "38 MB pack"));
      stream.push(ev("uploading-files", 3_000, `HTTP 413 from the edge: ${"the pack is over the cap ".repeat(8)}`));
      vi.advanceTimersByTime(250);
      stream.push(ev("failed", 3_500, `upload refused; ${"the machine's disk holds 4 GB and the pack is 5 GB, ".repeat(3)}`));
      vi.advanceTimersByTime(250);
      stream.stop();
      const lines = screen.lines();
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Base installed")).toBe(1);
      expect(count(lines, "Setup applied")).toBe(1);
      expect(count(lines, "Copying your files failed")).toBe(1);
      expect(lines.every(l => l.length < 60)).toBe(true);
      expect(lines.some(l => l.includes("HTTP 413") && l.endsWith("…"))).toBe(true);
      expect(lines.join("\n")).not.toMatch(SPINNERS);
      expect(screen.scrolled).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const cols of [80, 120]) {
    it(`a detail carrying carriage returns or escape sequences lands on its row as a terminal would leave it, at ${cols} columns`, () => {
      vi.useFakeTimers();
      try {
        const { output, screen } = terminal(cols, 30);
        const written: string[] = [];
        output.on("data", (c: Buffer) => written.push(c.toString()));
        const stream = new StageStream(output, true);
        stream.start();
        stream.push(ev("creating", 0, "sandbox from base"));
        stream.push(ev("deploying-daemon", 1_000, "daemon on node v22.23.2"));
        stream.push(ev("applying-setup", 2_000, "zsh: installing, with shell/oh-my-zsh"));
        const progress = ["(Reading database ... ", ...[5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map(n => `(Reading database ... ${n}%`), "(Reading database ... 12345 files and directories currently installed.)"];
        stream.push(ev("applying-setup", 3_000, `zsh: ${progress.join("\r")}`));
        vi.advanceTimersByTime(100);
        let lines = screen.lines();
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatch(/^[◒◐◓◑]  Applying your setup\s+\(Reading database \.\.\. 12345 files/);
        expect(lines[2]).not.toContain("%");
        stream.push(ev("applying-setup", 4_000, "zsh: Unpacking zsh (5.9-4+b15) ...\r"));
        vi.advanceTimersByTime(100);
        lines = screen.lines();
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatch(/^[◒◐◓◑]  Applying your setup\s+zsh: Unpacking zsh \(5\.9-4\+b15\) \.\.\.$/);
        stream.push(ev("applying-setup", 5_000, `zsh: Created symlink /etc/systemd/system/timers.target.wants/man-db.timer \u2192 /lib/systemd/system/man-db.timer.\r\r`));
        stream.push(ev("uploading-files", 6_000, "38 MB"));
        stream.push(ev("installing-harness", 7_000, "\x07\x1b[2K\x1b[1AClaude Code: \x1b[32m\u2714\x1b[0m Claude Code successfully installed!"));
        vi.advanceTimersByTime(100);
        lines = screen.lines();
        expect(lines).toHaveLength(5);
        expect(lines[2]).toMatch(/^◇  Setup applied\s+zsh: Created symlink \/etc\/sys.*\s+4\.0s$/);
        expect(lines[3]).toMatch(/^◇  Files copied\s+38 MB\s+1\.0s$/);
        expect(lines[4]).toMatch(/^[◒◐◓◑]  Installing agents\s+Claude Code: \u2714 Claude Code/);
        expect(written.join("")).not.toMatch(/\x07|\x1b\[2K|\x1b\[0m/);
        expect(count(lines, "Machine created")).toBe(1);
        expect(lines.every(l => l.length < cols)).toBe(true);
        expect(screen.scrolled).toBe(0);
        stream.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a failed frame's detail is flattened line by line, so the guest's carriage returns and colours never reach the rows", () => {
    const { output, screen } = terminal(80, 30);
    const written: string[] = [];
    output.on("data", (c: Buffer) => written.push(c.toString()));
    const stream = new StageStream(output, true);
    stream.start();
    stream.push(ev("creating", 0, "sandbox from base"));
    stream.push(ev("installing-tools", 1_000, "jq: Setting up jq ... \rSetting up jq ... 100%"));
    stream.push(ev("failed", 2_000, "E: Unable to locate package htop\r\x1b[31mE: Unable to locate package htop\x1b[0m\r\napt-get exited 100\r"));
    stream.stop();
    const lines = screen.lines();
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^◇  Machine created\s+sandbox from base\s+1\.0s$/);
    expect(lines.slice(1)).toEqual(["▲  Installing tools failed", "│  Setting up jq ... 100%", "│  E: Unable to locate package htop", "│  apt-get exited 100"]);
    expect(written.join("")).not.toMatch(/\x1b\[31m|\r/);
  });

  it("a failed step's tail is trimmed to the terminal's height, so the block stays inside the screen it redraws", () => {
    const { output, screen } = terminal(80, 12);
    const stream = new StageStream(output, true);
    stream.start();
    stream.push(ev("creating", 0));
    stream.push(ev("deploying-daemon", 1_000));
    stream.push(ev("installing-tools", 2_000));
    for (let i = 1; i <= 20; i++) stream.push(ev("installing-tools", 2_000 + i, `tool ${i} (${i}/20)`));
    stream.push(ev("failed", 3_000, "no space left on device"));
    stream.stop();
    const lines = screen.lines();
    expect(screen.scrolled).toBe(0);
    expect(lines.length).toBeLessThan(12);
    expect(count(lines, "Machine created")).toBe(1);
    expect(count(lines, "Installing tools failed")).toBe(1);
    expect(lines.at(-2)).toContain("tool 20 (20/20)");
    expect(lines.at(-1)).toContain("no space left on device");
  });

  it("a line said while the stream runs settles above the block, which stays whole under it", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(80, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0, "sandbox from default"));
      vi.advanceTimersByTime(100);
      stream.note("Solari account at its machine cap; waiting 30s for a slot (1/20). Nothing is killed.");
      vi.advanceTimersByTime(100);
      stream.push(ev("deploying-daemon", 1_000));
      vi.advanceTimersByTime(100);
      const lines = screen.lines();
      // The note is longer than the row, so it wraps onto a second line; both sit above the block.
      expect(lines[0]).toBe("│  Solari account at its machine cap; waiting 30s for a slot (1/20). Nothing is");
      expect(lines[1]).toBe("│  killed.");
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Creating the machine")).toBe(0);
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(lines).toHaveLength(4);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a line written to stdout or stderr from outside the stream settles above the block, reaches the sink, and the streams come back on stop", () => {
    vi.useFakeTimers();
    try {
      const { output, stderr, screen } = terminal(80, 30);
      const outWrite = output.write;
      const errWrite = stderr.write;
      const sunk: string[] = [];
      const stream = new StageStream(output, true, undefined, line => sunk.push(line), stderr);
      stream.start();
      expect(output.write).not.toBe(outWrite);
      expect(stderr.write).not.toBe(errWrite);
      stream.push(ev("creating", 0, "sandbox from default"));
      vi.advanceTimersByTime(100);
      stderr.write("heartbeat for builder b1 not written: ETIMEDOUT\n");
      vi.advanceTimersByTime(100);
      stream.push(ev("deploying-daemon", 1_000));
      output.write(Buffer.from("hostname first on m1 failed: \x1b[31mno route\x1b[0m\r\n"));
      vi.advanceTimersByTime(100);
      const lines = screen.lines();
      expect(lines[0]).toBe("│  heartbeat for builder b1 not written: ETIMEDOUT");
      expect(lines[1]).toBe("│  hostname first on m1 failed: no route");
      expect(lines[2]).toMatch(/^◇  Machine created\s+sandbox from default\s+1\.0s$/);
      expect(lines[3]).toMatch(/^[◒◐◓◑]  Installing the base tools$/);
      expect(lines).toHaveLength(4);
      expect(sunk).toEqual(["heartbeat for builder b1 not written: ETIMEDOUT", "hostname first on m1 failed: no route"]);
      stream.stop();
      expect(output.write).toBe(outWrite);
      expect(stderr.write).toBe(errWrite);
      expect(count(screen.lines(), "heartbeat for builder b1")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one stream given as both output and aside is taken once, and stop hands back the write it started with", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(80, 30);
      const original = output.write;
      // Every assignment to write is recorded, so a second take shows up as a count before stop can draw through it.
      const assigned: unknown[] = [];
      let current = original;
      Object.defineProperty(output, "write", {
        configurable: true,
        get: () => current,
        set: (w: typeof original) => {
          assigned.push(w);
          current = w;
        },
      });
      const sunk: string[] = [];
      const stream = new StageStream(output, true, undefined, line => sunk.push(line), output);
      stream.start();
      expect(assigned).toHaveLength(1);
      expect(output.write).not.toBe(original);
      stream.push(ev("creating", 0, "sandbox from base"));
      vi.advanceTimersByTime(100);
      output.write("a line from outside\n");
      vi.advanceTimersByTime(100);
      stream.push(ev("deploying-daemon", 1_000));
      stream.stop();
      expect(assigned).toHaveLength(2);
      expect(output.write).toBe(original);
      const lines = screen.lines();
      expect(lines[0]).toBe("│  a line from outside");
      expect(count(lines, "Machine created")).toBe(1);
      expect(lines).toHaveLength(3);
      expect(sunk).toEqual(["a line from outside"]);
      output.write("after stop\n");
      expect(screen.lines().at(-1)).toBe("after stop");
    } finally {
      vi.useRealTimers();
    }
  });

  for (const [where, aside] of [
    ["/dev/null", () => ({ stderr: new Writable({ write: (_c, _e, cb) => cb() }), sent: undefined })],
    ["a pipe", () => {
      const stderr = new PassThrough();
      const sent: string[] = [];
      stderr.on("data", (c: Buffer) => sent.push(c.toString()));
      return { stderr, sent };
    }],
  ] as const) {
    it(`a stderr sent to ${where} is not a terminal, so its bytes stay where the shell sent them and never reach the block`, () => {
      vi.useFakeTimers();
      try {
        const { output, screen } = terminal(80, 30);
        const { stderr, sent } = aside();
        const errWrite = stderr.write;
        const sunk: string[] = [];
        const stream = new StageStream(output, true, undefined, line => sunk.push(line), stderr);
        stream.start();
        expect(stderr.write).toBe(errWrite);
        stream.push(ev("creating", 0, "sandbox from base"));
        vi.advanceTimersByTime(100);
        const raw = "heartbeat for builder b1 not written: \x1b[31mETIMEDOUT\x1b[0m\r\n";
        stderr.write(raw);
        vi.advanceTimersByTime(100);
        stream.push(ev("deploying-daemon", 1_000));
        vi.advanceTimersByTime(100);
        const lines = screen.lines();
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^◇  Machine created\s+sandbox from base\s+1\.0s$/);
        expect(count(lines, "heartbeat")).toBe(0);
        expect(sunk).toEqual([]);
        if (sent !== undefined) expect(sent.join("")).toBe(raw);
        stream.stop();
        expect(stderr.write).toBe(errWrite);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a stream around a call that rejects still stops: the output comes back and the spinner timer ends", async () => {
    vi.useFakeTimers();
    try {
      const { output, stderr, screen } = terminal(80, 30);
      const write = output.write;
      const rt = { events: { on: () => () => {} } } as unknown as Pick<Runtime, "events">;
      const sunk: string[] = [];
      const failing = streamStages(rt, { output, stderr, isTTY: true }, SEAL_STEPS, () => Promise.reject(new Error("the seal call died")), l => sunk.push(l));
      await expect(failing).rejects.toThrow("the seal call died");
      expect(output.write).toBe(write);
      const rows = screen.lines().length;
      vi.advanceTimersByTime(500);
      expect(screen.lines().length).toBe(rows);
      expect(sunk).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a copy's failed frame on the same host never reaches this run's stream: a frame naming a place is that copy's build", async () => {
    const { output, stderr } = terminal(80, 30);
    let listener: ((e: unknown) => void) | undefined;
    const rt = { events: { on: (_type: string, l: (e: unknown) => void) => ((listener = l), () => (listener = undefined)) } } as unknown as Pick<Runtime, "events">;
    const records: Record<string, unknown>[] = [];
    const view = await streamStages(
      rt,
      { output, stderr, isTTY: false, json: r => records.push(r) },
      SEAL_STEPS,
      async () => {
        listener!({ type: "golden.stage", name: "default", stage: "failed", detail: "the copy at box died", place: "box" });
        listener!({ type: "golden.stage", name: "default", stage: "sealed" });
      },
      () => {},
    );
    expect(view.failure).toBeUndefined();
    expect(records.map(r => r["stage"])).toEqual(["sealed"]);
  });

  for (const cols of [80, 120]) {
    it(`a warning Node prints to stderr past the stream settles above the block and no step is drawn twice, at ${cols} columns`, () => {
      vi.useFakeTimers();
      try {
        const { output, stderr, screen } = terminal(cols, 40);
        const sunk: string[] = [];
        const stream = new StageStream(output, true, undefined, line => sunk.push(line), stderr);
        stream.start();
        stream.push(ev("creating", 0, "sandbox from base"));
        stream.push(ev("deploying-daemon", 5_200, "daemon on node v22.23.2"));
        stream.push(ev("applying-setup", 14_100, "zsh installed as the login shell; shell/oh-my-zsh reinstalled"));
        stream.push(ev("uploading-files", 30_200, "38 MB"));
        vi.advanceTimersByTime(100);
        stderr.write(NODE_WARNING);
        vi.advanceTimersByTime(100);
        stream.push(ev("uploading-files", 47_500, "38 MB in 2 parts in 17.3s"));
        stream.push(ev("installing-harness", 47_500));
        vi.advanceTimersByTime(100);
        const lines = screen.lines();
        expect(count(lines, "Machine created")).toBe(1);
        expect(count(lines, "Base installed")).toBe(1);
        expect(count(lines, "Setup applied")).toBe(1);
        expect(lines[0]).toMatch(/^│  \(node:72935\) MaxListenersExceededWarning: Possible EventTarget memory leak/);
        expect(lines.findIndex(l => l.startsWith("◇  Machine created"))).toBeGreaterThan(1);
        expect(count(lines, "Files copied")).toBe(1);
        expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
        expect(lines.every(l => l.length < cols)).toBe(true);
        expect(screen.scrolled).toBe(0);
        expect(sunk).toEqual(NODE_WARNING.trimEnd().split("\n"));
        stream.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a pane narrowed under the block wraps its rows, and the next redraw still starts at the block's first row", () => {
    vi.useFakeTimers();
    try {
      const { output, screen, resize } = terminal(120, 40);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0, "sandbox from base"));
      stream.push(ev("deploying-daemon", 5_200, "daemon on node v22.23.2"));
      stream.push(ev("applying-setup", 14_100, "zsh installed as the login shell; shell/oh-my-zsh reinstalled"));
      stream.push(ev("uploading-files", 30_200, "38 MB"));
      vi.advanceTimersByTime(100);
      expect(screen.lines()).toHaveLength(4);
      resize(70);
      expect(screen.lines()).toHaveLength(7);
      vi.advanceTimersByTime(100);
      let lines = screen.lines();
      expect(lines).toHaveLength(4);
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Setup applied")).toBe(1);
      expect(lines.every(l => l.length < 70)).toBe(true);
      resize(120);
      stream.push(ev("installing-harness", 47_500));
      vi.advanceTimersByTime(100);
      lines = screen.lines();
      expect(lines).toHaveLength(5);
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Files copied")).toBe(1);
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(screen.scrolled).toBe(0);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("steps follow the frames' order: a step appears on its first frame and closes only when the next stage starts", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(80, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0));
      stream.push(ev("deploying-daemon", 1_000));
      stream.push(ev("applying-setup", 2_000, "38 MB pack"));
      stream.push(ev("uploading-files", 3_000, "38 MB"));
      stream.push(ev("installing-harness", 4_000));
      stream.push(ev("installing-harness", 4_500, "claude (1/3)"));
      vi.advanceTimersByTime(100);
      let lines = screen.lines();
      expect(lines.join("\n")).not.toContain("Tools installed");
      expect(lines.join("\n")).not.toContain("Installing tools");
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(lines.at(-1)).toMatch(/Installing agents\s+claude \(1\/3\)/);

      stream.push(ev("installing-tools", 9_000, "Homebrew's glibc (2/86)"));
      vi.advanceTimersByTime(100);
      lines = screen.lines();
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(lines.at(-2)).toMatch(/Agents installed\s+claude \(1\/3\)\s+5\.0s$/);
      expect(lines.at(-1)).toMatch(/Installing tools\s+Homebrew's glibc \(2\/86\)/);

      stream.push(ev("installing-tools", 60_000, "71 installed, 15 failed"));
      stream.push(ev("ready", 61_000));
      expect(stream.finished).toBe(true);
      stream.stop();
      lines = screen.lines();
      expect(lines.map(l => l.slice(3, 20).trim())).toEqual(["Machine created", "Base installed", "Setup applied", "Files copied", "Agents installed", "Tools installed", "Ready"]);
      expect(lines.join("\n")).not.toMatch(SPINNERS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a step the builder already holds closes on its own frame; a failure with nothing running lands on the stage about to run", () => {
    const { output, screen } = terminal(80, 30);
    const stream = new StageStream(output, true);
    stream.start();
    for (const stage of ["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"]) stream.push(ev(stage, 1_000, ALREADY_APPLIED));
    stream.push(ev("failed", 2_000, "the builder answered exit 1 to a no-op; it is not serving"));
    const view = stream.stop();
    expect(view.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["deploying-daemon", "done"],
      ["applying-setup", "done"],
      ["uploading-files", "done"],
      ["installing-harness", "done"],
      ["installing-tools", "done"],
      ["installing-mcp", "done"],
      ["ready", "failed"],
    ]);
    const lines = screen.lines();
    expect(count(lines, "already applied")).toBe(7);
    expect(lines.at(-2)).toContain("The machine never answered");
    expect(lines.at(-1)).toContain("the builder answered exit 1");
  });

  it("off a terminal each step is announced as it starts and as it ends, in the frames' order", () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    const stream = new StageStream(output, false);
    stream.start();
    stream.push(ev("creating", 0));
    stream.push(ev("installing-harness", 1_000));
    stream.push(ev("installing-tools", 2_000, "gh (1/2)"));
    stream.push(ev("ready", 3_000));
    stream.stop();
    const text = chunks.join("");
    const order = ["Creating the machine", "Machine created", "Installing agents", "Agents installed", "Installing tools", "Tools installed", "Ready"].map(s => text.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toContain("Installing the base");
  });
});

describe("the running step under the current stage", () => {
  const step = { label: "mongosh", command: "npm install -g mongosh" };
  const at = (stage: string, when: number, detail?: string, s?: { label: string; command: string }): StageFrame => ({ ...ev(stage, when, detail), ...(s !== undefined ? { step: s } : {}) });

  it("draws one muted row under the stage with the command the step runs and a clock of whole seconds since its first frame, kept across its output lines and reset by the next step", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const { output, screen } = terminal(100, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0, "sandbox from base"));
      stream.push(at("installing-tools", 2_000, "mongosh (24/30)", step));
      // The rows are what the last tick drew, so the clock is read at a tick.
      vi.advanceTimersByTime(73_040);
      let lines = screen.lines();
      expect(lines).toHaveLength(3);
      expect(lines[1]).toMatch(/^[◒◐◓◑]  Installing tools\s+mongosh \(24\/30\)$/);
      expect(lines[2]).toMatch(/^│  npm install -g mongosh\s+1m 13s$/);
      expect(lines[2]!.length).toBe(99);
      // A line of the tool's own output lands on the stage row whole; the step's row keeps the command and the clock.
      stream.push(at("installing-tools", 75_000, "mongosh: npm warn deprecated inflight@1.0.6", step));
      vi.advanceTimersByTime(5_000);
      lines = screen.lines();
      expect(lines[1]).toMatch(/^[◒◐◓◑]  Installing tools\s+mongosh: npm warn deprecated inflight@1.0.6$/);
      expect(lines[2]).toMatch(/^│  npm install -g mongosh\s+1m 18s$/);
      // The retry after a timeout is one more such line, in words, whole.
      stream.push(at("installing-tools", 80_000, "mongosh: timed out after 300s; trying once more", step));
      vi.advanceTimersByTime(80);
      lines = screen.lines();
      expect(lines[1]).toMatch(/^[◒◐◓◑]  Installing tools\s+mongosh: timed out after 300s; trying once more$/);
      expect(lines[2]).toMatch(/^│  npm install -g mongosh\s+1m 18s$/);
      // The next step starts its own clock.
      stream.push(at("installing-tools", 80_080, "bun (25/30)", { label: "bun", command: "npm install -g bun@1.4.0" }));
      vi.advanceTimersByTime(4_000);
      lines = screen.lines();
      expect(lines[1]).toMatch(/^[◒◐◓◑]  Installing tools\s+bun \(25\/30\)$/);
      expect(lines[2]).toMatch(/^│  npm install -g bun@1.4.0\s+4s$/);
      // A frame of the stage's own, between steps or closing it, takes the row away.
      stream.push(ev("installing-tools", 90_000, "25 installed, 1 failed"));
      vi.advanceTimersByTime(80);
      lines = screen.lines();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^[◒◐◓◑]  Installing tools\s+25 installed, 1 failed$/);
      expect(count(lines, "Machine created")).toBe(1);
      expect(screen.scrolled).toBe(0);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a command wider than the row is cut before the clock, so the seconds stay in view and no row wraps", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { output, screen } = terminal(60, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(at("installing-tools", 1_000, "just (1/1)", { label: "just", command: `curl -fsSL https://example.test/${"a".repeat(80)} | bash` }));
      vi.advanceTimersByTime(314_000);
      const lines = screen.lines();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^│  curl -fsSL https:\/\/example\.test\/a+…\s+5m 14s$/);
      expect(lines[1]!.length).toBe(59);
      expect(screen.scrolled).toBe(0);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a command carrying newlines or escape sequences is flattened to one row, on the screen and in the --json object, so the block never drifts", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const records: Record<string, unknown>[] = [];
      const { output, screen } = terminal(100, 30);
      const stream = new StageStream(output, true, undefined, undefined, undefined, r => records.push(r));
      stream.start();
      const raw = { label: "git", command: "export HOME=/root\nexport PATH=/usr/local/bin\n\x1b[32mapt-get install -y -qq git\x1b[0m" };
      stream.push(at("deploying-daemon", 1_000, "git (2/9)", raw));
      vi.advanceTimersByTime(5_040);
      stream.push(at("deploying-daemon", 6_040, "git: Unpacking git", raw));
      vi.advanceTimersByTime(80);
      const lines = screen.lines();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^│  export HOME=\/root export PATH=\/usr\/local\/bin apt-get install -y -qq git\s+5s$/);
      expect(screen.scrolled).toBe(0);
      expect(records.map(r => (r["step"] as { command: string }).command)).toEqual(["export HOME=/root export PATH=/usr/local/bin apt-get install -y -qq git", "export HOME=/root export PATH=/usr/local/bin apt-get install -y -qq git"]);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the clock has fixed cells, so a cut command's ellipsis stays put as the seconds widen", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { output, screen } = terminal(60, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(at("installing-tools", 1_000, "just (1/1)", { label: "just", command: `curl -fsSL https://example.test/${"a".repeat(80)} | bash` }));
      vi.advanceTimersByTime(4_000);
      const early = screen.lines()[1]!;
      vi.advanceTimersByTime(3_700_000);
      const late = screen.lines()[1]!;
      expect(early).toMatch(/…\s+4s$/);
      expect(late).toMatch(/…\s+61m 44s$/);
      expect(early.indexOf("…")).toBe(late.indexOf("…"));
      expect(late.length).toBe(59);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("every frame is one --json object with the stage, the detail and the step with its seconds so far; another golden's frames are not", () => {
    const records: Record<string, unknown>[] = [];
    const stream = new StageStream(new PassThrough(), false, undefined, undefined, undefined, r => records.push(r));
    stream.start();
    stream.push(ev("creating", 0, "sandbox from base"));
    stream.push(ev("installing-tools", 1_000));
    stream.push(at("installing-tools", 2_000, "mongosh (24/30)", step));
    stream.push(at("installing-tools", 60_400, "mongosh: npm warn deprecated inflight@1.0.6", step));
    stream.push(at("installing-tools", 302_000, "mongosh: timed out after 300s; trying once more", step));
    stream.push({ type: "golden.stage", name: "other", stage: "installing-tools", detail: "nope", at: 303_000 });
    stream.push(ev("installing-tools", 400_000, "25 installed, 1 failed"));
    stream.push(ev("failed", 401_000, "an agent did not install"));
    stream.stop();
    expect(records).toEqual([
      { event: "stage", stage: "creating", detail: "sandbox from base" },
      { event: "stage", stage: "installing-tools" },
      { event: "stage", stage: "installing-tools", detail: "mongosh (24/30)", step: { ...step, elapsedSeconds: 0 } },
      { event: "stage", stage: "installing-tools", detail: "mongosh: npm warn deprecated inflight@1.0.6", step: { ...step, elapsedSeconds: 58 } },
      { event: "stage", stage: "installing-tools", detail: "mongosh: timed out after 300s; trying once more", step: { ...step, elapsedSeconds: 300 } },
      { event: "stage", stage: "installing-tools", detail: "25 installed, 1 failed" },
      { event: "stage", stage: "failed", detail: "an agent did not install" },
    ]);
  });

  it("off a terminal a step's frames print nothing of their own: the stage's start and end lines are the log", () => {
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (c: Buffer) => written.push(c.toString()));
    const stream = new StageStream(output, false);
    stream.start();
    stream.push(ev("creating", 0, "sandbox from base"));
    stream.push(ev("installing-tools", 1_000));
    stream.push(at("installing-tools", 2_000, "mongosh (24/30)", step));
    stream.push(at("installing-tools", 3_000, "mongosh: added 1 package", step));
    stream.push(ev("installing-mcp", 4_000));
    stream.stop();
    const lines = written.join("").split("\n").filter(l => l !== "").map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("│  Creating the machine");
    expect(lines[1]).toMatch(/^◇  Machine created\s+sandbox from base  1\.0s$/);
    expect(lines[2]).toBe("│  Installing tools");
    expect(lines[3]).toMatch(/^◇  Tools installed\s+mongosh: added 1 package  3\.0s$/);
    expect(lines[4]).toBe("│  Installing MCP servers");
  });
});
