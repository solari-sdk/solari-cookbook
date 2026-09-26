// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { isCancel } from "@clack/core";
import { unicode } from "@clack/prompts";
import { S_BAR_FOCUS, S_BAR_FOCUS_END, card, colourDepth, confirmPrompt, ellipsize, helpLine, muted, passwordPrompt, plainLine, rowsOf, summarize, table, textPrompt, viewport, widthOf, wrap } from "../src/init-layout.js";

describe("init layout", () => {
  it("plainLine leaves what a terminal would: later carriage-return segments overprint earlier ones, escapes and controls go, a tab is a space", () => {
    expect(plainLine("(Reading database ... \r(Reading database ... 5%\r(Reading database ... 100%")).toBe("(Reading database ... 100%");
    expect(plainLine("hello world\rHELLO")).toBe("HELLO world");
    expect(plainLine("Created symlink a \u2192 b.\r\r")).toBe("Created symlink a \u2192 b.");
    expect(plainLine("\x1b[32m> Checking prebuilds...\x1b[0m\x07")).toBe("> Checking prebuilds...");
    expect(plainLine("name:\tvalue\x08")).toBe("name: value");
    expect(plainLine("plain")).toBe("plain");
  });

  it("plainLine ends a row at a CRLF, overprints by code point so no glyph is torn, and drops C1 controls", () => {
    expect(plainLine("line\r\n")).toBe("line");
    expect(plainLine("first\r\nsecond")).toBe("second");
    expect(plainLine("a\nb")).toBe("a b");
    expect(plainLine("\u{1f600}\u{1f600}\rabc")).toBe("abc");
    expect(plainLine("\u{1f600}\u{1f600}\u{1f600}\rab")).toBe("ab\u{1f600}");
    expect(plainLine("\u65e5\u672c\u8a9e\rab")).toBe("ab\u8a9e");
    expect(plainLine("a\x85b\u009fc")).toBe("abc");
  });

  it("ellipsize keeps text that fits and ends cut text with one ellipsis inside the width", () => {
    expect(ellipsize("abc", 3)).toBe("abc");
    expect(ellipsize("abcdef", 4)).toBe("abc…");
    expect(ellipsize("abcdef", 1)).toBe("…");
    expect(ellipsize("abcdef", 0)).toBe("");
  });

  it("table pads each column to its widest cell, right-aligns where asked, and leaves no trailing space", () => {
    const rows = table(
      [
        ["Identity", "10", "82.9 KB", "3 can come"],
        ["Tools", "161", "", "92 can come"],
        ["Shell", "9", "1.1 MB", ""],
      ],
      ["left", "right", "right"],
    );
    expect(rows).toEqual([
      "Identity   10  82.9 KB  3 can come",
      "Tools     161           92 can come",
      "Shell       9   1.1 MB",
    ]);
  });

  it("widthOf reads the stream's columns, falls back to 80, and caps at 100", () => {
    expect(widthOf(new PassThrough())).toBe(80);
    expect(widthOf(Object.assign(new PassThrough(), { columns: 48 }))).toBe(48);
    expect(widthOf(Object.assign(new PassThrough(), { columns: 240 }))).toBe(100);
    expect(widthOf(undefined)).toBe(80);
  });

  it("rowsOf reads the stream's rows and falls back to 20", () => {
    expect(rowsOf(new PassThrough())).toBe(20);
    expect(rowsOf(Object.assign(new PassThrough(), { rows: 30 }))).toBe(30);
    expect(rowsOf(undefined)).toBe(20);
  });

  it("viewport keeps the cursor mid-window, pins the window at both ends, and never goes under one row", () => {
    expect(viewport(20, 0, 5)).toEqual({ start: 0, end: 5 });
    expect(viewport(20, 10, 5)).toEqual({ start: 8, end: 13 });
    expect(viewport(20, 19, 5)).toEqual({ start: 15, end: 20 });
    expect(viewport(3, 1, 5)).toEqual({ start: 0, end: 3 });
    expect(viewport(20, 7, 0)).toEqual({ start: 7, end: 8 });
    expect(viewport(0, 0, 4)).toEqual({ start: 0, end: 0 });
  });

  it("summarize names up to three labels then +N more, drops labels when the width is short, and cuts the last one kept", () => {
    expect(summarize(["a", "b"], 80)).toBe("a, b");
    expect(summarize(["a", "b", "c", "d", "e"], 80)).toBe("a, b, c +2 more");
    expect(summarize(["alpha", "beta", "gamma", "delta"], 20)).toBe("alpha, beta +2 more");
    expect(summarize(["alpha", "beta", "gamma", "delta"], 14)).toBe("alpha +3 more");
    expect(summarize(["a".repeat(30), "beta"], 20)).toBe("aaaaaaaaaaa… +1 more");
    expect(summarize([], 20)).toBe("");
  });

  it("wrap breaks a line at word ends inside the width, indents the rest by two, and cuts a word longer than the width", () => {
    expect(wrap("short line", 20)).toEqual(["short line"]);
    expect(wrap("Installs  Claude Code, Codex, 89 tools plus Homebrew's toolchain", 40)).toEqual(["Installs  Claude Code, Codex, 89 tools", "  plus Homebrew's toolchain"]);
    expect(wrap("a".repeat(30), 10)).toEqual(["aaaaaaaaa…"]);
    expect(wrap("  " + "a".repeat(30), 10)).toEqual(["  aaaaaaa…"]);
    expect(wrap("", 10)).toEqual([""]);
    // A line that fits keeps its spacing: the summary indents the sign-ins under their rung and pads its columns with two spaces.
    expect(wrap("  GitHub CLI login  copy", 40)).toEqual(["  GitHub CLI login  copy"]);
    expect(wrap("Upload    77.0 MB, nothing has left this computer yet", 30)).toEqual(["Upload    77.0 MB, nothing has", "  left this computer yet"]);
    // A caller with columns hands in the indent that lands the rest under its value.
    expect(wrap("Installs  Claude Code, Codex, 89 tools plus Homebrew's toolchain", 40, " ".repeat(10))).toEqual(["Installs  Claude Code, Codex, 89 tools", "          plus Homebrew's toolchain"]);
    // A word wider than the width is cut on its own and the words after it still come through, whatever the indent.
    const path = "/p".repeat(50);
    expect(wrap(`Save the key to ${path} so wsp stops asking?`, 40)).toEqual(["Save the key to", `  ${path.slice(0, 37)}…`, "  so wsp stops asking?"]);
    expect(wrap(`${path} so`, 40)).toEqual([`${path.slice(0, 39)}…`, "  so"]);
    expect(wrap(`Installs  ${path} plus jq`, 40, " ".repeat(10))).toEqual(["Installs", `          ${path.slice(0, 29)}…`, "          plus jq"]);
  });

  it("card prints a bold title on the step glyph and its lines down the bar, an empty line as a bare bar, and long lines wrapped to the width", () => {
    const output = Object.assign(new PassThrough(), { columns: 40 });
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    // The coloured line is 45 characters with its codes and 35 without: it fits the width and passes through whole.
    const red = "\x1b[31mDisk  12.5 GB of 16.1 GB, red line\x1b[39m";
    card("Summary", ["Identity  2 of 3  1.7 KB", "  GitHub CLI login  copy", "", "Installs  Claude Code, Codex, 89 tools plus Homebrew's toolchain", red], output);
    const raw = chunks.join("");
    const lines = stripVTControlCharacters(raw).split("\n");
    expect(lines).toEqual(["│", "◇  Summary", "│  Identity  2 of 3  1.7 KB", "│    GitHub CLI login  copy", "│", "│  Installs  Claude Code, Codex, 89", "│    tools plus Homebrew's toolchain", "│  Disk  12.5 GB of 16.1 GB, red line", ""]);
    expect(raw).toContain(`│  ${red}\n`);
    // The help line is not wrapped, as on the rung screens.
    expect(lines.slice(0, -1).map(l => l.length).filter(n => n > 40)).toEqual([]);
    expect(raw).not.toMatch(/[╮╯─├]/);
  });

  it("the focused bar and its end are one cell wide like clack's thin ones, so focus moving never shifts a column; ASCII off a unicode terminal", () => {
    expect([S_BAR_FOCUS, S_BAR_FOCUS_END]).toEqual(unicode ? ["┃", "┗"] : ["|", "+"]);
    expect(S_BAR_FOCUS.length).toBe(1);
    expect(S_BAR_FOCUS_END.length).toBe(1);
  });

  it("colourDepth is 1 off a terminal and when the env says no colour, Node's depth for TERM and COLORTERM otherwise, and FORCE_COLOR wins", () => {
    expect(colourDepth(false, { TERM: "xterm-256color" })).toBe(1);
    expect(colourDepth(true, { TERM: "dumb" })).toBe(1);
    expect(colourDepth(true, { TERM: "xterm-256color", NO_COLOR: "1" })).toBe(1);
    expect(colourDepth(true, { TERM: "xterm" })).toBe(4);
    expect(colourDepth(true, { TERM: "linux" })).toBe(4);
    expect(colourDepth(true, { TERM: "xterm-256color" })).toBe(8);
    expect(colourDepth(true, { TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe(24);
    expect(colourDepth(false, { FORCE_COLOR: "1" })).toBe(4);
    expect(colourDepth(false, { FORCE_COLOR: "3" })).toBe(24);
    expect(colourDepth(false, { FORCE_COLOR: "0" })).toBe(1);
  });

  it("muted paints a grey from 256 colours up, dim under them, and nothing off a terminal: helpLine's quiet half and the turn stream's tool lines read the same", () => {
    expect(muted("$ git status", 1)).toBe("$ git status");
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      expect(muted("$ git status", 4)).toBe("\x1b[2m$ git status\x1b[22m");
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
    for (const depth of [8, 24]) expect(muted("$ git status", depth)).toBe("\x1b[38;5;243m$ git status\x1b[39m");
    expect(helpLine([{ key: "esc", does: "back" }], 8)).toContain(muted("back", 8));
  });

  it("helpLine joins keys and what they do with dot separators: plain at depth 1, keys plain and the rest dim under 256 colours, two greys from 256 colours up", () => {
    const keys = [
      { key: "space", does: "tick" },
      { key: "← →", does: "fold" },
      { key: "esc", does: "back" },
    ];
    const plain = unicode ? "space tick • ← → fold • esc back" : "space tick   ← → fold   esc back";
    expect(helpLine(keys, 1)).toBe(plain);
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      const sixteen = helpLine(keys, 4);
      expect(stripVTControlCharacters(sixteen)).toBe(plain);
      expect(sixteen).toContain("space \x1b[2mtick\x1b[22m");
      expect(sixteen).not.toContain("38;5;");
      expect([...sixteen.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]).every(c => c === "2" || c === "22")).toBe(true);
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
    for (const depth of [8, 24]) {
      const coloured = helpLine(keys, depth);
      expect(stripVTControlCharacters(coloured)).toBe(plain);
      expect(coloured).toContain("\x1b[38;5;247mspace\x1b[39m");
      expect(coloured).toContain("\x1b[38;5;243mtick\x1b[39m");
      expect(coloured).toContain(unicode ? "\x1b[38;5;243m • \x1b[39m" : "\x1b[38;5;243m   \x1b[39m");
      expect(coloured).not.toContain("\x1b[38;5;247mtick");
    }
  });
});

const KEY = { left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", ctrlC: "\x03" };
const SECRET = "slr_live_fake_solari_key";
const CONFIRM_HELP = unicode ? "← → change • y n answer • enter choose • esc cancel" : "← → change   y n answer   enter choose   esc cancel";
const PASSWORD_HELP = unicode ? "enter next • esc cancel" : "enter next   esc cancel";

function streams(columns?: number) {
  const input = new PassThrough();
  const output = columns === undefined ? new PassThrough() : Object.assign(new PassThrough(), { columns });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return { input, output, text: () => stripVTControlCharacters(chunks.join("")), raw: () => chunks.join("") };
}

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function press(input: PassThrough, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    input.write(k);
    await settle();
  }
}

/** Waits for the output to show the text; a lone escape is only an escape once readline's sequence timeout passes, so the cancelled frame is polled for, not slept for. */
async function until(text: () => string, needle: string, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!text().includes(needle)) {
    if (Date.now() - t0 > ms) throw new Error(`never saw ${needle} in:\n${text()}`);
    await settle();
  }
}

/** Runs the body with the env var set, then puts it back. */
async function withEnv(name: string, value: string | undefined, body: () => Promise<void>): Promise<void> {
  const was = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await body();
  } finally {
    if (was === undefined) delete process.env[name];
    else process.env[name] = was;
  }
}

const sgrSet = (raw: string): string[] => [...new Set([...raw.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]!))].sort();

describe("confirm prompt", () => {
  it("draws the question on the step glyph, the hint and the two answers down the thick bar, the help line on the heavy end; enter takes the marked answer and the finished screen keeps clack's thin bar", async () => {
    const { input, output, text } = streams();
    const p = confirmPrompt({ message: "Boot it?", hint: "No costs nothing.", input, output });
    await settle();
    expect(text()).toBe(`◆  Boot it?\n┃  No costs nothing.\n┃  ○ Yes / ● No\n┗  ${CONFIRM_HELP}`);
    await press(input, KEY.enter);
    expect(await p).toBe(false);
    const done = text().slice(text().lastIndexOf("◇"));
    expect(done).toBe("◇  Boot it?\n│  No costs nothing.\n│  No\n");
  });

  it("left and right move the marker, y and n answer at once, esc and ctrl-c cancel with the answer struck through", async () => {
    const a = streams();
    const pa = confirmPrompt({ message: "Boot it?", input: a.input, output: a.output });
    await settle();
    expect(a.text()).toBe(`◆  Boot it?\n┃  ○ Yes / ● No\n┗  ${CONFIRM_HELP}`);
    await press(a.input, KEY.left);
    expect(a.text().slice(a.text().lastIndexOf("◆"))).toContain("┃  ● Yes / ○ No");
    await press(a.input, KEY.right, KEY.left, KEY.enter);
    expect(await pa).toBe(true);
    expect(a.text().slice(a.text().lastIndexOf("◇"))).toBe("◇  Boot it?\n│  Yes\n");

    const b = streams();
    const pb = confirmPrompt({ message: "Boot it?", input: b.input, output: b.output });
    await settle();
    await press(b.input, "y");
    expect(await pb).toBe(true);
    const c = streams();
    const pc = confirmPrompt({ message: "Boot it?", initialValue: true, input: c.input, output: c.output });
    await settle();
    await press(c.input, "n");
    expect(await pc).toBe(false);

    const d = streams();
    const pd = confirmPrompt({ message: "Boot it?", input: d.input, output: d.output });
    await settle();
    await press(d.input, KEY.esc);
    await until(d.text, "■");
    expect(isCancel(await pd)).toBe(true);
    // The answer that was marked is the one struck through; clack's escape alias must not flip it first.
    expect(d.text().slice(d.text().lastIndexOf("■"))).toBe("■  Boot it?\n│  No\n");
    const e = streams();
    const pe = confirmPrompt({ message: "Boot it?", input: e.input, output: e.output });
    await settle();
    await press(e.input, KEY.ctrlC);
    expect(isCancel(await pe)).toBe(true);
  });

  it("wraps a long question and hint at the width, the rest under the bar with the two-space indent", async () => {
    const { input, output, text } = streams(40);
    const p = confirmPrompt({ message: "Boot a 2 vCPU, 4 GB builder and build this? About $0.11/hr while it runs.", hint: "No costs nothing and keeps the recipe for wsp init --recipe.", input, output });
    await settle();
    const lines = text().split("\n");
    expect(lines).toEqual(["◆  Boot a 2 vCPU, 4 GB builder and build", "┃    this? About $0.11/hr while it runs.", "┃  No costs nothing and keeps the recipe", "┃    for wsp init --recipe.", "┃  ○ Yes / ● No", `┗  ${CONFIRM_HELP}`]);
    // The help line is not wrapped, as on the rung screens.
    expect(lines.slice(0, -1).map(l => l.length).filter(n => n > 40)).toEqual([]);
    await press(input, KEY.enter);
    await p;
    // A newline in the question is a line break, as in the hint.
    const two = streams();
    const q = confirmPrompt({ message: "Boot it?\nIt bills while it runs.", hint: "No costs nothing.", input: two.input, output: two.output });
    await settle();
    expect(two.text()).toBe(`◆  Boot it?\n┃  It bills while it runs.\n┃  No costs nothing.\n┃  ○ Yes / ● No\n┗  ${CONFIRM_HELP}`);
    await press(two.input, KEY.enter);
    await q;
  });

  it("with colour on: cyan glyph and question, dim hint and bar, cyan marker, the two help greys, and no other colour", () =>
    withEnv("FORCE_COLOR", "3", async () => {
      const { input, output, raw } = streams();
      const p = confirmPrompt({ message: "Boot it?", hint: "No costs nothing.", input, output });
      await settle();
      const frame = raw();
      expect(frame).toContain("\x1b[36m◆\x1b[39m  \x1b[36mBoot it?\x1b[39m");
      expect(frame).toContain("\x1b[2m┃\x1b[22m  \x1b[2mNo costs nothing.\x1b[22m");
      expect(frame).toContain("\x1b[2m○\x1b[22m \x1b[2mYes\x1b[22m \x1b[2m/\x1b[22m \x1b[36m●\x1b[39m No");
      expect(frame).toContain("\x1b[2m┗\x1b[22m  \x1b[38;5;247m← →\x1b[39m \x1b[38;5;243mchange\x1b[39m");
      expect(sgrSet(frame)).toEqual(["2", "22", "36", "38;5;243", "38;5;247", "39"].sort());
      await press(input, KEY.enter);
      await p;
      const done = raw().slice(raw().lastIndexOf("\x1b[32m"));
      // The finished frame, then clack's newline and its cursor-show.
      expect(done).toBe("\x1b[32m◇\x1b[39m  Boot it?\n\x1b[2m│\x1b[22m  \x1b[2mNo costs nothing.\x1b[22m\n\x1b[2m│\x1b[22m  \x1b[2mNo\x1b[22m\n\x1b[?25h");
    }));

  it("at 16 colours the help words are dim and no 256-colour code leaves the frame", () =>
    withEnv("FORCE_COLOR", "1", async () => {
      const { input, output, raw } = streams();
      const p = confirmPrompt({ message: "Boot it?", input, output });
      await settle();
      expect(raw()).toContain("← → \x1b[2mchange\x1b[22m");
      expect(raw()).not.toContain("38;5;");
      expect(sgrSet(raw())).toEqual(["2", "22", "36", "39"].sort());
      await press(input, KEY.enter);
      await p;
    }));

  it("under NO_COLOR the frame carries no SGR at all and keeps its glyphs and dots", () =>
    withEnv("FORCE_COLOR", undefined, () =>
      withEnv("NO_COLOR", "1", async () => {
        const { input, output, raw, text } = streams();
        const p = confirmPrompt({ message: "Boot it?", hint: "No costs nothing.", input, output });
        await settle();
        expect(sgrSet(raw())).toEqual([]);
        expect(text()).toBe(`◆  Boot it?\n┃  No costs nothing.\n┃  ○ Yes / ● No\n┗  ${CONFIRM_HELP}`);
        await press(input, KEY.enter);
        await p;
      }),
    ));
});

describe("password prompt", () => {
  it("masks every character, never echoes the text, and returns it on enter; the finished screen shows the mask on the thin bar", async () => {
    const { input, output, text, raw } = streams();
    const p = passwordPrompt({ message: "No Solari key found.", hint: "Solari API key  console.getsolari.com", input, output });
    await settle();
    expect(text()).toBe(`◆  No Solari key found.\n┃  Solari API key  console.getsolari.com\n┃  _\n┗  ${PASSWORD_HELP}`);
    await press(input, SECRET);
    const typed = text().slice(text().lastIndexOf("◆"));
    expect(typed).toContain(`┃  ${"▪".repeat(SECRET.length)}_`);
    await press(input, KEY.enter);
    expect(await p).toBe(SECRET);
    expect(raw()).not.toContain(SECRET);
    expect(raw()).not.toContain(SECRET.slice(0, 4));
    expect(text().slice(text().lastIndexOf("◇"))).toBe(`◇  No Solari key found.\n│  Solari API key  console.getsolari.com\n│  ${"▪".repeat(SECRET.length)}\n`);
  });

  it("enter on nothing returns the empty string with no mask line; esc and ctrl-c cancel", async () => {
    const a = streams();
    const pa = passwordPrompt({ message: "Anthropic API key", input: a.input, output: a.output });
    await settle();
    await press(a.input, KEY.enter);
    expect(await pa).toBe("");
    expect(a.text().slice(a.text().lastIndexOf("◇"))).toBe("◇  Anthropic API key\n");
    const b = streams();
    const pb = passwordPrompt({ message: "Anthropic API key", input: b.input, output: b.output });
    await settle();
    await press(b.input, "abc", KEY.esc);
    await until(b.text, "■");
    expect(isCancel(await pb)).toBe(true);
    expect(b.text().slice(b.text().lastIndexOf("■"))).toBe("■  Anthropic API key\n│  ▪▪▪\n");
    expect(b.raw()).not.toContain("abc");
    const c = streams();
    const pc = passwordPrompt({ message: "Anthropic API key", input: c.input, output: c.output });
    await settle();
    await press(c.input, KEY.ctrlC);
    expect(isCancel(await pc)).toBe(true);
  });

  it("with colour on: cyan glyph and question, dim hint and bar, the inverse cursor, the two help greys, and no other colour", () =>
    withEnv("FORCE_COLOR", "3", async () => {
      const { input, output, raw } = streams();
      const p = passwordPrompt({ message: "No Solari key found.", hint: "Solari API key  console.getsolari.com", input, output });
      await settle();
      await press(input, "ab");
      const frame = raw().slice(raw().lastIndexOf("\x1b[36m◆"));
      expect(frame).toContain("\x1b[36m◆\x1b[39m  \x1b[36mNo Solari key found.\x1b[39m");
      expect(frame).toContain("\x1b[2m┃\x1b[22m  \x1b[2mSolari API key  console.getsolari.com\x1b[22m");
      expect(frame).toContain("\x1b[2m┃\x1b[22m  ▪▪\x1b[7m\x1b[8m_\x1b[28m\x1b[27m");
      expect(frame).toContain("\x1b[2m┗\x1b[22m  \x1b[38;5;247menter\x1b[39m \x1b[38;5;243mnext\x1b[39m");
      expect(sgrSet(frame)).toEqual(["2", "22", "27", "28", "36", "38;5;243", "38;5;247", "39", "7", "8"].sort());
      await press(input, KEY.enter);
      await p;
      expect(raw()).not.toContain("ab\x1b");
      expect(raw().slice(raw().lastIndexOf("\x1b[32m"))).toBe("\x1b[32m◇\x1b[39m  No Solari key found.\n\x1b[2m│\x1b[22m  \x1b[2mSolari API key  console.getsolari.com\x1b[22m\n\x1b[2m│\x1b[22m  \x1b[2m▪▪\x1b[22m\n\x1b[?25h");
    }));

  it("at 16 colours the help words are dim and no 256-colour code leaves the frame", () =>
    withEnv("FORCE_COLOR", "1", async () => {
      const { input, output, raw } = streams();
      const p = passwordPrompt({ message: "Anthropic API key", input, output });
      await settle();
      expect(raw()).toContain("enter \x1b[2mnext\x1b[22m");
      expect(raw()).not.toContain("38;5;");
      expect(sgrSet(raw())).toEqual(["2", "22", "27", "28", "36", "39", "7", "8"].sort());
      await press(input, KEY.enter);
      await p;
    }));

  it("under NO_COLOR the frame carries no SGR at all and keeps its glyphs and dots", () =>
    withEnv("FORCE_COLOR", undefined, () =>
      withEnv("NO_COLOR", "1", async () => {
        const { input, output, raw, text } = streams();
        const p = passwordPrompt({ message: "Anthropic API key", hint: "optional, enter skips", input, output });
        await settle();
        expect(sgrSet(raw())).toEqual([]);
        expect(text()).toBe(`◆  Anthropic API key\n┃  optional, enter skips\n┃  _\n┗  ${PASSWORD_HELP}`);
        await press(input, KEY.enter);
        await p;
      }),
    ));
});

describe("text prompt", () => {
  it("draws the question and hint in the frame, echoes what is typed, and returns it on enter", async () => {
    const { input, output, text } = streams();
    const p = textPrompt({ message: "Which folder on this Mac?", hint: "Enter with nothing imports no project.", input, output });
    await settle();
    expect(text()).toBe(`◆  Which folder on this Mac?\n┃  Enter with nothing imports no project.\n┃  █\n┗  ${PASSWORD_HELP}`);
    await press(input, "/Users/me/code/proj");
    expect(text().slice(text().lastIndexOf("◆"))).toContain("┃  /Users/me/code/proj█");
    await press(input, KEY.enter);
    expect(await p).toBe("/Users/me/code/proj");
    expect(text().slice(text().lastIndexOf("◇"))).toBe("◇  Which folder on this Mac?\n│  Enter with nothing imports no project.\n│  /Users/me/code/proj\n");
  });

  it("enter on nothing is the empty string, and esc and ctrl-c cancel", async () => {
    const a = streams();
    const pa = textPrompt({ message: "Which folder?", input: a.input, output: a.output });
    await settle();
    await press(a.input, KEY.enter);
    expect(await pa).toBe("");
    const b = streams();
    const pb = textPrompt({ message: "Which folder?", input: b.input, output: b.output });
    await settle();
    await press(b.input, "/tmp", KEY.esc);
    await until(b.text, "■");
    expect(isCancel(await pb)).toBe(true);
    const c = streams();
    const pc = textPrompt({ message: "Which folder?", input: c.input, output: c.output });
    await settle();
    await press(c.input, KEY.ctrlC);
    expect(isCancel(await pc)).toBe(true);
  });
  it("draws the question and the hint down the thick bar, the placeholder until something is typed, and gives back what was typed on enter", async () => {
    const { input, output, text } = streams();
    const p = textPrompt({ message: "Which project are you bringing first?", hint: "optional; a folder on this Mac", placeholder: "~/code/app", input, output });
    await settle();
    expect(text()).toBe(`◆  Which project are you bringing first?\n┃  optional; a folder on this Mac\n┃  ~/code/app\n┗  ${PASSWORD_HELP}`);
    await press(input, "~/proj");
    expect(text().slice(text().lastIndexOf("◆"))).toContain("┃  ~/proj");
    await press(input, KEY.enter);
    expect(await p).toBe("~/proj");
    expect(text().slice(text().lastIndexOf("◇"))).toBe("◇  Which project are you bringing first?\n│  optional; a folder on this Mac\n│  ~/proj\n");
  });

  it("enter on an empty line answers with nothing and leaves no line behind, so an optional question costs one keypress", async () => {
    const { input, output, text } = streams();
    const p = textPrompt({ message: "Which project are you bringing first?", input, output });
    await settle();
    await press(input, KEY.enter);
    expect(await p).toBe("");
    expect(text().slice(text().lastIndexOf("◇"))).toBe("◇  Which project are you bringing first?\n");
  });

  it("esc cancels: the typed line is struck through and the answer is clack's cancel", async () => {
    const { input, output, text } = streams();
    const p = textPrompt({ message: "Which project are you bringing first?", input, output });
    await settle();
    await press(input, "~/proj");
    await press(input, KEY.esc);
    expect(isCancel(await p)).toBe(true);
    expect(text()).toContain("~/proj");
  });
});
