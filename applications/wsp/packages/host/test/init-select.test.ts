// SPDX-License-Identifier: AGPL-3.0-only
// The rung screen driven through fake streams: keys go in as the escape
// sequences a terminal sends, frames come out and are read with the ANSI
// stripped. Nothing here touches process.stdin.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { LABEL_CAP, LATER_LINE, LOCKED_CAP, answerOf, buildEntries, cutDistinct, focusable, matches, readKey, rungSelect, settle as settleCursor, toggleEntry, type Entry, type SelectItem } from "../src/init-select.js";

const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", space: " ", enter: "\r", esc: "\x1b", ctrlC: "\x03" };

const ITEMS: SelectItem[] = [
  { id: "git", label: "git name and email", detail: ["~/.gitconfig", "512 B"], lock: "on" },
  { id: "gh", label: "gh", group: "Homebrew", detail: ["Brewfile", "reinstalled by brew"] },
  { id: "jq", label: "jq", group: "Homebrew", detail: ["Brewfile", "reinstalled by brew"] },
  { id: "pnpm", label: "pnpm", group: "npm globals", detail: ["npm -g", "reinstalled by npm"] },
  { id: "rectangle", label: "rectangle", group: "Homebrew casks", detail: ["Brewfile", "macOS app, no Linux build"], lock: "off" },
  { id: "zshrc", label: "~/.zshrc", detail: ["~/.zshrc", "3.0 KB"] },
];

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const text = () => stripVTControlCharacters(chunks.join(""));
  const raw = () => chunks.join("");
  const clear = () => chunks.splice(0);
  return { input, output, text, raw, clear };
}

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function press(input: PassThrough, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    input.write(k);
    // A lone escape is only an escape once readline's 50ms sequence timeout passes.
    await settle(k === KEY.esc ? 70 : 5);
  }
}

const shape = (entries: Entry[]): string[] =>
  entries.map(e => {
    switch (e.type) {
      case "locked":
        return "!";
      case "bullet":
        return `•${e.item.id}`;
      case "more":
        return `+${e.count}`;
      case "group":
        return `#${e.group}`;
      case "item":
        return e.item.id;
    }
  });

const lockedRows = (n: number): SelectItem[] => Array.from({ length: n }, (_, i) => ({ id: `base/${i}`, label: `base ${i}`, detail: [], lock: "on" as const }));

const answer = (ticks: string[] = []) => ({ ticks: new Set(ticks), answers: new Map<string, string>() });

describe("rung entries", () => {
  it("puts the rows that always come along first as bullets under one header, then the groups; no all row anywhere", () => {
    expect(shape(buildEntries(ITEMS, "", new Set()))).toEqual([
      "!", "•git", "#Homebrew", "gh", "jq", "#npm globals", "pnpm", "#Homebrew casks", "rectangle", "zshrc",
    ]);
  });

  it("a folded group hides its items; a search matches label or id", () => {
    expect(shape(buildEntries(ITEMS, "", new Set(["Homebrew"])))).toEqual([
      "!", "•git", "#Homebrew", "#npm globals", "pnpm", "#Homebrew casks", "rectangle", "zshrc",
    ]);
    expect(matches(ITEMS[1]!, "GH")).toBe(true);
    expect(matches(ITEMS[5]!, "zsh")).toBe(true);
    expect(matches(ITEMS[5]!, "fish")).toBe(false);
    expect(shape(buildEntries(ITEMS, "j", new Set()))).toEqual(["#Homebrew", "jq"]);
  });

  it("a locked group past the cap shows the first rows and one …and N more line", () => {
    const atCap = shape(buildEntries([...lockedRows(LOCKED_CAP), ITEMS[5]!], "", new Set()));
    expect(atCap.filter(s => s.startsWith("•"))).toHaveLength(LOCKED_CAP);
    expect(atCap.find(s => s.startsWith("+"))).toBeUndefined();
    const over = shape(buildEntries([...lockedRows(LOCKED_CAP + 5), ITEMS[5]!], "", new Set()));
    expect(over.filter(s => s.startsWith("•"))).toHaveLength(LOCKED_CAP - 1);
    expect(over.slice(0, 2)).toEqual(["!", "•base/0"]);
    expect(over.slice(LOCKED_CAP, LOCKED_CAP + 2)).toEqual(["+6", "zshrc"]);
  });

  it("group headings and items take focus; settle skips the rest in either direction", () => {
    const entries = buildEntries(ITEMS, "", new Set());
    expect(entries.map(focusable)).toEqual([false, false, true, true, true, true, true, true, true, true]);
    expect(settleCursor(entries, 0)).toBe(2);
    expect(settleCursor(entries, 1, -1)).toBe(2);
    expect(settleCursor(entries, 99)).toBe(9);
    expect(settleCursor([], 0)).toBe(0);
  });

  it("toggling a group flips only its tickable items; locked items never move", () => {
    const a = answer(["git"]);
    const entries = buildEntries(ITEMS, "", new Set());
    toggleEntry(a, entries[2]!);
    expect([...a.ticks].sort()).toEqual(["gh", "git", "jq"]);
    toggleEntry(a, entries[2]!);
    expect([...a.ticks]).toEqual(["git"]);
    toggleEntry(a, entries[7]!);
    expect(a.ticks.has("rectangle")).toBe(false);
    toggleEntry(a, entries[1]!);
    toggleEntry(a, entries[0]!);
    expect(a.ticks.has("git")).toBe(true);
  });

  it("space and the arrows walk a choice row through its words, and a header moves its whole group as one", () => {
    const choices = [{ value: "copy", label: "copy from this Mac" }, { value: "machine", label: "sign in on the machine" }, { value: "skip", label: "skip" }];
    const items: SelectItem[] = [
      { id: "claude", label: "Claude Code login", group: "Agents", detail: [], choices },
      { id: "codex", label: "Codex login", group: "Agents", detail: [], choices },
    ];
    const entries = buildEntries(items, "", new Set());
    const a = { ticks: new Set<string>(), answers: new Map([["claude", "copy"], ["codex", "machine"]]) };
    // A row moves on its own, forwards and back, and wraps at the ends.
    toggleEntry(a, entries[1]!);
    expect(a.answers.get("claude")).toBe("machine");
    toggleEntry(a, entries[1]!, -1);
    expect(a.answers.get("claude")).toBe("copy");
    toggleEntry(a, entries[1]!, -1);
    expect(a.answers.get("claude")).toBe("skip");
    // The header takes the whole group to one word: from two answers to the first, then on together.
    toggleEntry(a, entries[0]!);
    expect([...a.answers.values()]).toEqual(["copy", "copy"]);
    toggleEntry(a, entries[0]!);
    expect([...a.answers.values()]).toEqual(["machine", "machine"]);
    // A choice row is never a tick, so nothing lands in the ticks.
    expect([...a.ticks]).toEqual([]);
    expect(answerOf(items[0]!, new Map())).toBe("copy");
    expect(answerOf(ITEMS[1]!, new Map())).toBeUndefined();
  });
});

describe("rungSelect", () => {
  it("enter returns the ticks with locked-on items included and locked-off items never", async () => {
    const { input, output, text } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(["gh", "jq", "pnpm", "zshrc"]), input, output });
    await settle();
    const frame = text();
    expect(frame).toContain("Tools");
    expect(frame).toContain("5/7");
    expect(frame).toMatch(/rectangle\s+stays here/);
    expect(frame).toMatch(/▾ Tools\s+always included\n┃\s+• git name and email\n/);
    expect(frame).not.toMatch(/[●○] git name/);
    // The focused row carries the marker in the gutter; every other row keeps a space there so the glyphs line up.
    // The cursor lands on the first group, since there is no all row for it to start on.
    expect(frame).toMatch(/\n┃ ❯ ▾ Homebrew\s+2 of 2\n/);
    // The two lines he struck out are gone with the all row, and so is the list of what was ticked.
    expect(frame).not.toContain("every row on this screen that can be ticked");
    expect(frame).not.toContain("left as it is");
    expect(frame).not.toContain("Selected:");
    expect(frame).toContain(LATER_LINE);
    expect(frame).toMatch(/\n┃\s{5}○ rectangle/);
    // The screen being answered runs the thick bar down its left and ends with the help line; nothing under the title keeps the thin one.
    expect(frame.split("\n").slice(1, -1).every(l => l.startsWith("┃"))).toBe(true);
    expect(frame.split("\n").at(-1)).toBe("┗  space on or off • ← → fold • enter next • esc back");
    expect(frame).not.toContain("macOS app, no Linux build");
    expect(frame).not.toMatch(/—|\p{Emoji_Presentation}/u);
    // Space on the heading the cursor starts on clears its group.
    await press(input, KEY.space);
    expect(text()).toContain("Homebrew");
    await press(input, KEY.enter);
    const result = await p;
    expect(result.kind).toBe("next");
    if (result.kind !== "next") return;
    expect([...result.ticks].sort()).toEqual(["git", "pnpm", "zshrc"]);
    // Once answered the screen is a finished block: clack's thin bar, no thick one left anywhere in it.
    const done = text().slice(text().lastIndexOf("◇  Tools")).split("\n");
    expect(done[0]).toMatch(/◇  Tools\s+5\/7$/);
    expect(done[1]).toBe("│  git name and email, pnpm, ~/.zshrc");
    expect(done.slice(1).some(l => l.includes("┃") || l.includes("┗"))).toBe(false);
  });

  it("a screen with no groups offers no fold key, and a header's own line never squeezes the labels", async () => {
    const { input, output, text } = streams();
    Object.assign(output, { rows: 40, columns: 60 });
    const flat: SelectItem[] = [
      { id: "claude", label: "Claude Code", why: { text: "used here, 151 sessions" }, hint: { text: "208.0 MB" }, detail: [] },
      { id: "codex", label: "Codex", why: { text: "not installed here" }, hint: { text: "455.0 MB" }, detail: [] },
    ];
    const p = rungSelect({ title: "Agents", counter: "1/6", top: "Which coding agents go on your machine image.", items: flat, initial: new Set(["claude"]), input, output });
    await settle();
    expect(text()).toContain("┃  Which coding agents go on your machine image.");
    expect(text().split("\n").at(-1)).toBe("┗  space on or off • enter next • esc back");
    expect(text()).toMatch(/● Claude Code\s+used here, 151 sessions\s+208\.0 MB/);
    await press(input, KEY.ctrlC);
    await p;

    // A long header line takes the why column and the second column together, so the labels keep their width.
    const wide = streams();
    Object.assign(wide.output, { rows: 40, columns: 100 });
    const q = rungSelect({
      title: "Sign-ins",
      counter: "4/6",
      items: [{ id: "claude", label: "Claude Code login", group: "Agents", why: "Keychain: Claude Code-credentials", detail: [], choices: [{ value: "copy", label: "copy from this Mac" }, { value: "skip", label: "skip" }] }],
      initial: new Set(),
      groupLine: () => "1 copy  0 sign in  0 API key  0 skip",
      input: wide.input,
      output: wide.output,
    });
    await settle();
    expect(wide.text()).toContain("Claude Code login");
    expect(wide.text()).toMatch(/▾ Agents\s+1 copy {2}0 sign in {2}0 API key {2}0 skip/);
    await press(wide.input, KEY.ctrlC);
    await q;
  });

  it("a list with no rows says so", async () => {
    const { input, output, text } = streams();
    const p = rungSelect({ title: "Also on this Mac", counter: "3/6", top: "We found these installed on this Mac.", items: [], initial: new Set(), input, output });
    await settle();
    expect(text()).toContain("nothing found");
    await press(input, KEY.enter);
    expect((await p).kind).toBe("next");
  });

  it("with colour on, the title is cyan, a group name is bold, and the frame uses no other colour", async () => {
    // styleText reads FORCE_COLOR at each call, so colour can be turned on for this test alone and turned back off after it.
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    try {
      const { input, output, raw } = streams();
      Object.assign(output, { rows: 40 });
      const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(["gh"]), input, output });
      await settle();
      const frame = raw();
      expect(frame).toContain("\x1b[36m◆\x1b[39m  \x1b[36mTools\x1b[39m");
      expect(frame).toMatch(/▾ \x1b\[1mHomebrew\s*\x1b\[22m/);
      // An unticked row's box, label and second column are all dim.
      expect(frame).toMatch(/\x1b\[2m○\x1b\[22m \x1b\[2mrectangle\s*\x1b\[22m  \x1b\[2m\s*stays here\x1b\[22m/);
      expect(frame).toContain("\x1b[38;5;247mspace\x1b[39m \x1b[38;5;243mon or off\x1b[39m");
      // One accent, dim for the rest, bold on headings, inverse for the search cursor, the two help greys, and their resets.
      const sgr = new Set([...frame.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]));
      expect([...sgr].sort()).toEqual(["1", "2", "22", "27", "36", "38;5;243", "38;5;247", "39", "7"].sort());
      await press(input, KEY.enter);
      await p;
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("at 16 colours the help line falls back to dim words and plain keys, and no 256-colour code leaves the frame", async () => {
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      const { input, output, raw } = streams();
      const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(["gh"]), input, output });
      await settle();
      const frame = raw();
      expect(frame).toContain("\x1b[36m◆\x1b[39m  \x1b[36mTools\x1b[39m");
      expect(frame).toMatch(/▾ \x1b\[1mHomebrew\s*\x1b\[22m/);
      expect(frame).toContain("space \x1b[2mon or off\x1b[22m");
      expect(frame).not.toContain("38;5;");
      const sgr = new Set([...frame.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]));
      expect([...sgr].sort()).toEqual(["1", "2", "22", "27", "36", "39", "7"].sort());
      await press(input, KEY.enter);
      await p;
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("under NO_COLOR nothing in the frame is coloured, bold or dim, and the help line is plain text with its dots", async () => {
    const was = { force: process.env["FORCE_COLOR"], no: process.env["NO_COLOR"] };
    delete process.env["FORCE_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      const { input, output, raw, text } = streams();
      const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(["gh"]), input, output });
      await settle();
      expect([...raw().matchAll(/\x1b\[([0-9;]*)m/g)]).toEqual([]);
      expect(text().split("\n").at(-1)).toBe("┗  space on or off • ← → fold • enter next • esc back");
      await press(input, KEY.enter);
      await p;
    } finally {
      if (was.force !== undefined) process.env["FORCE_COLOR"] = was.force;
      if (was.no === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = was.no;
    }
  });

  it("footer hierarchy: the detail reads in normal text, a bare footer line is dim, a loud one is plain or in its tone right above the dim keys, and the slots hold", async () => {
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    try {
      const { input, output, raw, text } = streams();
      Object.assign(output, { rows: 40 });
      const items: SelectItem[] = [...ITEMS, { id: "bare", label: "bare", detail: [] }, { id: "one", label: "one line", detail: ["only line"] }];
      const footer = (a: { ticks: ReadonlySet<string> }) => ["parts", { text: "Disk: 1.0 GB", ...(a.ticks.has("jq") ? { tone: "yellow" as const } : {}) }];
      const p = rungSelect({ title: "Tools", counter: "5/7", items, initial: new Set(["gh"]), footer, input, output });
      await settle();
      const bar = "\x1b[2m┃\x1b[22m";
      expect(raw()).toContain(`${bar}  \x1b[2mparts\x1b[22m\n${bar}  Disk: 1.0 GB\n\x1b[2m┗\x1b[22m  \x1b[38;5;247mspace`);
      // Ticking the Homebrew group brings jq along and the Disk line takes its tone; nothing else in the footer changes.
      await press(input, KEY.space);
      expect(raw()).toContain(`${bar}  \x1b[2mparts\x1b[22m\n${bar}  \x1b[33mDisk: 1.0 GB\x1b[39m\n\x1b[2m┗\x1b[22m`);
      // The detail keeps its two slots on a row with none and on a row with one, so the lines under it never move.
      expect(text().slice(text().lastIndexOf("◆  Tools"))).toContain("┃  2 in Homebrew\n┃  space turns the whole group on or off\n┃  parts");
      for (let i = 0; i < 8; i += 1) await press(input, KEY.down);
      expect(text().slice(text().lastIndexOf("◆  Tools"))).toMatch(/❯ ○ bare\n┃ {3}○ one line\s*\n┃\n┃\n┃\n┃  parts/);
      await press(input, KEY.down);
      expect(text().slice(text().lastIndexOf("◆  Tools"))).toMatch(/❯ ○ one line\n┃\n┃  only line\n┃\n┃  parts/);
      await press(input, KEY.enter);
      await p;
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("a locked row shows why only in the detail pane, once it is highlighted", async () => {
    const { input, output, text, clear } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(), input, output });
    await press(input, "r", "e", "c", "t");
    clear();
    await press(input, KEY.down);
    expect(text()).toContain("macOS app, no Linux build");
    await press(input, KEY.enter);
    await p;
  });

  it("typing filters, space ticks the match, and the detail pane shows the highlighted item's lines", async () => {
    const { input, output, text, clear } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(["git"]), input, output });
    await press(input, "j", "q");
    clear();
    await press(input, KEY.down);
    const frame = text();
    expect(frame).toContain("reinstalled by brew");
    expect(frame).not.toContain("pnpm");
    await press(input, KEY.space, KEY.enter);
    const result = await p;
    expect(result.kind === "next" && [...result.ticks].sort()).toEqual(["git", "jq"]);
  });

  it("escape goes back and still hands the ticks so the earlier screen can replay them", async () => {
    const { input, output } = streams();
    const p = rungSelect({ title: "Shell", counter: "2/7", items: ITEMS, initial: new Set(["zshrc"]), input, output });
    await press(input, KEY.down, KEY.down, KEY.space, KEY.esc);
    const result = await p;
    expect(result).toEqual({ kind: "back", ticks: new Set(["zshrc", "git", "jq"]), answers: new Map() });
  });

  it("ctrl-c cancels", async () => {
    const { input, output } = streams();
    const p = rungSelect({ title: "Shell", counter: "2/7", items: ITEMS, initial: new Set(), input, output });
    await press(input, KEY.ctrlC);
    expect(await p).toEqual({ kind: "cancel" });
  });

  it("initial ticks for rows not on the screen are dropped from the answer", async () => {
    const { input, output } = streams();
    const p = rungSelect({ title: "Shell", counter: "2/7", items: ITEMS, initial: new Set(["zshrc", "gone"]), input, output });
    await press(input, KEY.enter);
    expect(await p).toEqual({ kind: "next", ticks: new Set(["git", "zshrc"]), answers: new Map() });
  });

  it("rows line up in two columns cut to the width, and never wrap", async () => {
    const wide: SelectItem[] = [
      { id: "a", label: "a".repeat(120), group: "Go binaries", detail: ["go install", "reinstalled by go"], hint: "1.2 MB" },
      { id: "b", label: "short", group: "Go binaries", detail: [], hint: "12 B" },
      { id: "c", label: "c", detail: [] },
    ];
    const { input, output, text } = streams();
    Object.assign(output, { columns: 60 });
    const p = rungSelect({ title: "Tools", counter: "5/7", items: wide, initial: new Set(["a"]), input, output });
    await settle();
    const rows = text().split("\n").filter(l => l.includes("●") || l.includes("○") || l.includes("▾"));
    expect(rows.length).toBe(4);
    expect(rows.map(l => l.length).filter(n => n > 60)).toEqual([]);
    expect(rows.find(l => l.includes("aaaa"))).toMatch(/a…a+\s+1\.2 MB$/);
    // The second column is flush right: every filled second cell ends at the same column.
    const ends = rows.filter(l => /(MB|B|of \d+)$/.test(l)).map(l => l.length);
    expect(new Set(ends).size).toBe(1);
    await press(input, KEY.enter);
    await p;
  });

  it("one long label does not push the second column out: the label column stops at the cap and the label is cut in the middle", async () => {
    const items: SelectItem[] = [
      { id: "long", label: "g".repeat(78), group: "Go binaries", detail: [], hint: "1.2 MB" },
      { id: "short", label: "gopls", group: "Go binaries", detail: [], hint: "12 B" },
      { id: "c", label: "bat", detail: [], hint: "3 KB" },
    ];
    const { input, output, text } = streams();
    Object.assign(output, { columns: 100 });
    const p = rungSelect({ title: "Tools", counter: "5/7", items, initial: new Set(["long"]), input, output });
    await settle();
    const rows = text().split("\n").filter(l => /[●○]/.test(l));
    // Bar, space, marker, space, glyph, space, then the label column; the second column follows the gutter.
    const secondAt = 4 + 2 + LABEL_CAP + 2;
    const long = rows.find(l => l.includes("ggg"))!;
    expect(long).toMatch(/^┃ {5}● g+…g+\s+1\.2 MB$/);
    expect(long.indexOf("…")).toBe(8 + Math.floor((LABEL_CAP - 2 - 1) / 2));
    expect(long.indexOf("1.2 MB") - long.lastIndexOf("g")).toBe(3);
    expect(long.indexOf("1.2 MB")).toBe(secondAt);
    expect(rows.find(l => l.includes("bat"))!.indexOf("3 KB")).toBe(secondAt + 2);
    expect(rows.map(l => l.length).filter(n => n > secondAt + 6)).toEqual([]);
    await press(input, KEY.enter);
    await p;
  });

  it("two labels that would read the same once cut keep the part where they differ, so no two rows on a screen render alike", async () => {
    const a = ".mcp-auth/mcp-remote-0.1/e209b33186e466c19f1e7a229ab12345_tokens.json";
    const b = ".mcp-auth/mcp-remote-0.1/e209b33186e466c19f1e7a229ab12345_client_info.json";
    const c = ".mcp-auth/mcp-remote-0.1/e209b33186e466c19f1e7a229ab12345_tokens.json.bak";
    // Ten characters: the tail alone would read the same for the two that end alike.
    const same = ["alpha/one/deep/path/x/settings.json", "alpha/two/deep/path/x/settings.json"];
    expect(cutDistinct(["short", a], () => 40)).toEqual(["short", ".mcp-auth/mcp-remot…9ab12345_tokens.json"]);
    const cut = cutDistinct([a, b, c], () => 24);
    expect(new Set(cut).size).toBe(3);
    expect(cut.map(l => l.length)).toEqual([24, 24, 24]);
    expect(cut.map(l => l.slice(-9))).toEqual(["kens.json", "info.json", ".json.bak"]);
    expect(cutDistinct(same, () => 12)).toEqual(["…one/deep/pa", "…two/deep/pa"]);
    expect(cutDistinct(same, () => 60)).toEqual(same);
    // One label's tail is the other's whole tail: the cut moves to a window around where they first differ instead.
    expect(cutDistinct(["a/bar/bar", "a/bar/bar/bar"], () => 8)).toEqual(["…bar", "…bar/bar"]);
    const items: SelectItem[] = [
      { id: "a", label: a, group: "~", detail: [] },
      { id: "b", label: b, group: "~", detail: [] },
      { id: "c", label: c, group: "~", detail: [] },
    ];
    const { input, output, text } = streams();
    Object.assign(output, { columns: 60 });
    const p = rungSelect({ title: "Sign-ins and keys", counter: "3/3", items, initial: new Set(), input, output });
    await settle();
    const rows = text().split("\n").filter(l => /[●○] (?!all\b)/.test(l)).map(l => l.replace(/^.*[●○] /, "").trimEnd());
    expect(rows).toHaveLength(3);
    expect(new Set(rows).size).toBe(3);
    expect(rows.every(r => r.endsWith("json") || r.endsWith("bak"))).toBe(true);
    await press(input, KEY.enter);
    await p;
  });

  it("left folds the group under the cursor and right unfolds it", async () => {
    const { input, output, text, clear } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(), input, output });
    await settle();
    clear();
    // The cursor opens on the first heading, so left folds it at once.
    await press(input, KEY.left);
    expect(text()).toContain("Homebrew");
    expect(text()).not.toContain("jq");
    clear();
    await press(input, KEY.right);
    expect(text()).toContain("jq");
    await press(input, KEY.enter);
    await p;
  });

  it("the cursor never lands on the locked rows: it opens on the first row that can be ticked and space leaves the bullets alone", async () => {
    const items: SelectItem[] = [...lockedRows(3), { id: "cfg", label: "~/.ssh/config", detail: ["~/.ssh/config", "1.2 KB"] }, ITEMS[5]!];
    const { input, output, text } = streams();
    const p = rungSelect({ title: "Identity", counter: "1/7", items, initial: new Set(["cfg", "zshrc"]), input, output });
    await settle();
    expect(text()).toMatch(/❯ ● ~\/\.ssh\/config/);
    // Up from the first row stays put, and space there unticks that row and no bullet.
    await press(input, KEY.up, KEY.space);
    expect(text()).toMatch(/❯ ○ ~\/\.ssh\/config/);
    expect(text()).toMatch(/• base 0/);
    await press(input, KEY.enter);
    const result = await p;
    expect(result.kind === "next" && [...result.ticks].sort()).toEqual(["base/0", "base/1", "base/2", "zshrc"]);
  });

  it("a short terminal windows the list to the rows left after the chrome and shows the arrows", async () => {
    const items: SelectItem[] = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, label: `tool ${i}`, detail: [] }));
    const { input, output, text, clear } = streams();
    Object.assign(output, { rows: 14, columns: 80 });
    const p = rungSelect({ title: "Tools", counter: "5/7", items, initial: new Set(), input, output });
    await settle();
    // Title, the change-later line, search, rows, the down arrow, blank, two detail lines, the help line.
    const first = text().split("\n");
    expect(first).toHaveLength(12);
    expect(first.filter(l => /[●○]/.test(l))).toHaveLength(4);
    expect(first.at(-5)).toMatch(/↓ \d+ more$/);
    expect(text()).not.toContain("↑");
    for (let i = 0; i < 10; i++) await press(input, KEY.down);
    // Clack redraws from the first changed line; with the up arrow changing that is everything under the search field.
    clear();
    await press(input, KEY.down);
    const frame = text().split("\n");
    expect(frame.find(l => l.includes("↑"))).toMatch(/↑ 9 more$/);
    expect(frame.find(l => l.includes("↓"))).toMatch(/↓ 7 more$/);
    expect(frame.filter(l => /[●○]/.test(l))).toHaveLength(4);
    expect(frame.filter(l => l.includes("tool 11")).at(-1)).toContain("❯ ○ tool 11");
    await press(input, KEY.enter);
    await p;
  });

  it("a list that fits shows every row with no arrows", async () => {
    const { input, output, text } = streams();
    Object.assign(output, { rows: 40 });
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(), input, output });
    await settle();
    expect(text()).not.toMatch(/[↑↓] \d+ more/);
    expect(text()).toContain("zshrc");
    await press(input, KEY.enter);
    await p;
  });

  it("the line a finished screen leaves names the ticked rows in list order, locked ones first, cut to the width with +N more", async () => {
    const items: SelectItem[] = [
      { id: "a", label: "alpha tool", detail: [] },
      { id: "b", label: "b".repeat(40), detail: [] },
      { id: "c", label: "gamma", detail: [] },
      { id: "d", label: "delta", detail: [] },
      { id: "git", label: "git name and email", detail: [], lock: "on" },
    ];
    const { input, output, text } = streams();
    Object.assign(output, { columns: 60 });
    const p = rungSelect({ title: "Identity", counter: "1/7", items, initial: new Set(["a", "b", "c", "d"]), input, output });
    await settle();
    // Nothing on the open screen lists what was ticked: the rows say it themselves.
    expect(text()).not.toContain("Selected:");
    await press(input, KEY.space, KEY.enter);
    await p;
    const done = text().split("\n").filter(l => l.startsWith("│")).at(-1)!;
    // The always-included row first, then what is left ticked, cut to the width.
    expect(done).toBe("│  git name and email +3 more");
    expect(done.length).toBeLessThanOrEqual(60);
  });

  it("footer lines sit under the detail, are rebuilt from the ticks, and take rows from the window", async () => {
    const items: SelectItem[] = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, label: `row ${i}`, detail: [] }));
    const { input, output, text, clear } = streams();
    Object.assign(output, { rows: 20 });
    const p = rungSelect({
      title: "What they need",
      counter: "2/3",
      items,
      initial: new Set(),
      footer: a => [`${a.ticks.size} ticked`, "the base is on every machine, whatever is ticked"],
      detailLines: 3,
      input,
      output,
    });
    await settle();
    const tail = () => text().split("\n").slice(-3);
    expect(tail()).toEqual([
      expect.stringMatching(/^┃  0 ticked$/),
      expect.stringMatching(/^┃  the base is on every machine, whatever is ticked$/),
      expect.stringMatching(/^┗  space on or off/),
    ]);
    // 20 rows less the cursor line, the five fixed lines, three detail rows and two footer rows leaves 9: twelve entries do not fit.
    expect(text()).toMatch(/↓ \d+ more/);
    const blankDetail = text().split("\n").filter(l => l === "┃").length;
    expect(blankDetail).toBeGreaterThanOrEqual(3);
    clear();
    await press(input, KEY.down, KEY.space);
    expect(tail()[0]).toMatch(/^┃  1 ticked$/);
    await press(input, KEY.enter);
    await p;
  });

  it("without a footer the same list fits, so the footer is what costs the rows", async () => {
    const items: SelectItem[] = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, label: `row ${i}`, detail: [] }));
    const { input, output, text } = streams();
    Object.assign(output, { rows: 20 });
    const p = rungSelect({ title: "Shell", counter: "2/8", items, initial: new Set(), input, output });
    await settle();
    expect(text()).not.toMatch(/more/);
    await press(input, KEY.enter);
    await p;
  });

  it("a screen with nothing ticked hands back an empty answer", async () => {
    const items: SelectItem[] = [{ id: "a", label: "alpha", detail: [] }];
    const { input, output, text } = streams();
    const p = rungSelect({ title: "Shell", counter: "2/7", items, initial: new Set(), input, output });
    await settle();
    expect(text()).toContain("○ alpha");
    await press(input, KEY.enter);
    expect(await p).toEqual({ kind: "next", ticks: new Set(), answers: new Map() });
    expect(text().split("\n").filter(l => l.startsWith("│")).at(-1)).toBe("│  none");
  });
});

describe("readKey", () => {
  it("resolves on an accepted key without echoing it, ignores others, and reads Ctrl-C or escape as cancel", async () => {
    const { input, output, text } = streams();
    const p = readKey(input, output, ["r", "s"]);
    await press(input, "x", "s");
    expect(await p).toBe("s");
    expect(text()).toBe("");
    const q = readKey(input, output, ["r", "s"]);
    await press(input, KEY.ctrlC);
    expect(await q).toBe("cancel");
    expect(text()).toBe("");
  });
});
