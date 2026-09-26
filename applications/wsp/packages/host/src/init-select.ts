// SPDX-License-Identifier: AGPL-3.0-only
// One screen of wsp init as a list: a sentence saying what it decides,
// searchable rows under group headings that carry their own counts and toggle
// as a unit, rows that always come along shown as bullets the cursor skips, a
// window sized to the terminal, and a detail pane for the highlighted item. A
// row is answered by a tick, or by one word cycled with the arrows where the
// screen gives it choices. Built on @clack/core so the frame diffing, raw mode
// and cancel handling are clack's; the keys and the layout are ours.
import type { Key } from "node:readline";
import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { Prompt, isCancel } from "@clack/core";
import { S_BAR, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_SUBMIT } from "@clack/prompts";
import { GUTTER, S_BAR_FOCUS, S_BAR_FOCUS_END, accent, colourDepth, ellipsize, helpLine, isTTY, rowsOf, summarize, viewport, widthOf, wrap, type Align, type HelpKey } from "./init-layout.js";

/** The 16-colour names the Disk line may take, in order of weight. */
export type Tone = "yellow" | "yellowBright" | "red";
/** A footer line: dim as a bare string; an object is loud, in normal text or its tone's colour. */
export type FooterLine = string | { text: string; tone?: Tone };

/** A column's text with the paint it takes once it has been padded, so a colour never changes a column's width. */
export interface Cell {
  text: string;
  paint?: (padded: string) => string;
}
/** A column: a bare string is dim. */
export type Column = string | Cell;

export interface SelectItem {
  id: string;
  label: string;
  /** The dim second column: a size, a state word. */
  hint?: Column;
  /** The column between the label and the hint: why the row is on. Absent on every item, the column is not drawn. */
  why?: Column;
  group?: string;
  /** Lines for the detail pane while this item is highlighted; the reason a row is locked belongs here. */
  detail: string[];
  /** on: always ticked, shown as a bullet the cursor skips. off: never ticked. */
  lock?: "on" | "off";
  /** The words this row is answered with instead of a tick, cycled with the arrows; the answer is the second column. */
  choices?: readonly Choice[];
}

/** One answer a row can take: the value the screen reads back, and the words the row shows. */
export interface Choice {
  value: string;
  label: string;
}

export type Entry =
  | { type: "locked"; items: SelectItem[] }
  | { type: "bullet"; item: SelectItem }
  | { type: "more"; count: number }
  | { type: "group"; group: string; items: SelectItem[]; folded: boolean }
  | { type: "item"; item: SelectItem };

export interface RungSelectOptions {
  title: string;
  /** The section counter shown after the title ("2/5"). */
  counter: string;
  /** The one sentence under the title saying what this screen decides. */
  top?: string;
  items: SelectItem[];
  initial: ReadonlySet<string>;
  /** The answer each choice row starts on; a row the map does not name starts on its first choice. */
  answers?: ReadonlyMap<string, string>;
  /** Lines under the rows, rebuilt from the current answers and given the columns a line may take; the same
   * count every frame, so nothing moves. */
  footer?: (a: RungAnswer, width: number) => FooterLine[];
  /** Rows the detail pane keeps for the highlighted item; two unless a screen has more to say. */
  detailLines?: number;
  /** The header over the rows that always come along: its own name, with its count and total from `groupLine` like
   * any other group. Absent, the block sits under the screen's title with the word "always included". */
  lockedTitle?: string;
  /** What a group's header says after its name; the ticked count of its rows unless the screen has more to say. */
  groupLine?: (items: readonly SelectItem[], a: RungAnswer) => string;
  input?: Readable;
  output?: Writable;
}

export interface RungAnswer {
  ticks: Set<string>;
  /** The answer of every choice row, by id. */
  answers: Map<string, string>;
}
export type RungSelectResult = ({ kind: "next" } & RungAnswer) | ({ kind: "back" } & RungAnswer) | { kind: "cancel" };

/** The widths a frame's three columns settled on. */
interface Columns {
  label: number;
  why: number;
  second: number;
}

const DETAIL_LINES = 2;
/** The bar, a space, the focus marker, a space before every row. */
const EDGE = 4;
/** Title, search, blank, the help line; the top line, the detail pane, the footer and the two more-lines of a windowed list come on top. */
const FIXED_LINES = 4;
/** A locked group longer than this shows its first rows and "…and N more". */
export const LOCKED_CAP = 12;
/** The label column stops here; one long label is cut rather than pushing every second cell to the far edge. */
export const LABEL_CAP = 40;
const dim = (s: string): string => styleText("dim", s);
const textOf = (c: Column | undefined): string => (c === undefined ? "" : typeof c === "string" ? c : c.text);
const paintOf = (c: Column | undefined): ((padded: string) => string) => (typeof c === "object" && c.paint !== undefined ? c.paint : dim);
const LOCKED_WORD = "always included";
const EMPTY_WORD = "nothing found";
/** The second line of every list screen: nothing here is a decision the person is stuck with. */
export const LATER_LINE = "You can change this later.";
const KEY_TICK: HelpKey = { key: "space", does: "on or off" };
const KEY_CHOOSE: HelpKey = { key: "← →", does: "choose" };
const KEY_NEXT: HelpKey = { key: "enter", does: "next" };
const KEY_BACK: HelpKey = { key: "esc", does: "back" };
const KEY_FOLD: HelpKey = { key: "← →", does: "fold" };

export function matches(item: SelectItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
}

export const focusable = (e: Entry): boolean => e.type === "group" || e.type === "item";

export function buildEntries(items: readonly SelectItem[], query: string, folded: ReadonlySet<string>): Entry[] {
  const shown = items.filter(i => matches(i, query));
  const locked = shown.filter(i => i.lock === "on");
  const rest = shown.filter(i => i.lock !== "on");
  const out: Entry[] = [];
  if (locked.length > 0) {
    out.push({ type: "locked", items: locked });
    const bullets = locked.length > LOCKED_CAP ? locked.slice(0, LOCKED_CAP - 1) : locked;
    for (const item of bullets) out.push({ type: "bullet", item });
    if (bullets.length < locked.length) out.push({ type: "more", count: locked.length - bullets.length });
  }
  let i = 0;
  while (i < rest.length) {
    const item = rest[i]!;
    if (item.group === undefined) {
      out.push({ type: "item", item });
      i += 1;
      continue;
    }
    const group = item.group;
    const members: SelectItem[] = [];
    while (i < rest.length && rest[i]!.group === group) members.push(rest[i++]!);
    const isFolded = folded.has(group);
    out.push({ type: "group", group, items: members, folded: isFolded });
    if (!isFolded) for (const m of members) out.push({ type: "item", item: m });
  }
  return out;
}

/** The nearest focusable index from `at`, looking in `dir` first and back the other way when that side has none. */
export function settle(entries: readonly Entry[], at: number, dir: 1 | -1 = 1): number {
  const bounded = Math.min(Math.max(0, at), Math.max(0, entries.length - 1));
  for (let i = bounded; i >= 0 && i < entries.length; i += dir) if (focusable(entries[i]!)) return i;
  for (let i = bounded; i >= 0 && i < entries.length; i -= dir) if (focusable(entries[i]!)) return i;
  return 0;
}

const tickable = (i: SelectItem): boolean => i.lock === undefined && i.choices === undefined;
/** A row that comes along or can: always included or open to a tick. Only a row locked out is out, so a screen's one
 * denominator is what the found table called able to come. */
const unlocked = (i: SelectItem): boolean => i.lock !== "off";
/** The answer a choice row stands on: what the screen was given, else its first choice. */
export const answerOf = (i: SelectItem, answers: ReadonlyMap<string, string>): string | undefined =>
  i.choices === undefined ? undefined : (answers.get(i.id) ?? i.choices[0]?.value);

function flipAll(ticks: Set<string>, items: readonly SelectItem[]): void {
  const free = items.filter(tickable);
  const allOn = free.length > 0 && free.every(i => ticks.has(i.id));
  for (const i of free) {
    if (allOn) ticks.delete(i.id);
    else ticks.add(i.id);
  }
}

/** The row's next choice in `dir`; the group cycles as one, from the answer its rows share or from the first. */
function cycle(a: RungAnswer, items: readonly SelectItem[], dir: 1 | -1): void {
  const rows = items.filter(i => i.choices !== undefined);
  const values = [...new Set(rows.map(i => answerOf(i, a.answers)))];
  for (const i of rows) {
    const choices = i.choices ?? [];
    const at = values.length === 1 ? choices.findIndex(c => c.value === values[0]) : -1;
    const next = choices[(at + dir + choices.length * 2) % choices.length];
    if (next !== undefined) a.answers.set(i.id, next.value);
  }
}

/** Space on a row or a header: a tick flips, a choice row moves to its next word. */
export function toggleEntry(a: RungAnswer, entry: Entry, dir: 1 | -1 = 1): void {
  switch (entry.type) {
    case "group":
      if (entry.items.some(i => i.choices !== undefined)) cycle(a, entry.items, dir);
      else flipAll(a.ticks, entry.items);
      return;
    case "item":
      if (entry.item.choices !== undefined) return cycle(a, [entry.item], dir);
      if (!tickable(entry.item)) return;
      if (a.ticks.has(entry.item.id)) a.ticks.delete(entry.item.id);
      else a.ticks.add(entry.item.id);
      return;
    case "locked":
    case "bullet":
    case "more":
      return;
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

function fmtCount(on: number, of: number): string {
  return `${on} of ${of}`;
}

/** What was ticked over a group's rows that can come; the row count for a group of locked rows alone. */
function groupCount(items: readonly SelectItem[], ticks: ReadonlySet<string>): string {
  const free = items.filter(unlocked);
  if (free.length === 0) return String(items.length);
  return fmtCount(free.filter(i => ticks.has(i.id)).length, free.length);
}

/** Cuts a label to width from the middle, keeping its tail: the part of a path that differs. */
function middle(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  const head = Math.floor((width - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`;
}

function commonPrefix(texts: readonly string[]): number {
  const first = texts[0] ?? "";
  let n = 0;
  while (n < first.length && texts.every(t => t[n] === first[n])) n += 1;
  return n;
}

/** Every label cut to its width, no two alike: labels that would read the same once cut show the part where they first differ instead. */
export function cutDistinct(labels: readonly string[], widthOf: (i: number) => number): string[] {
  const out = labels.map((l, i) => middle(l, widthOf(i)));
  for (let round = 0; round < 8; round += 1) {
    const groups = new Map<string, number[]>();
    out.forEach((t, i) => {
      if (t !== labels[i]) groups.set(t, [...(groups.get(t) ?? []), i]);
    });
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const at = commonPrefix(group.map(i => labels[i]!));
      const from = (i: number, start: number): string => `…${labels[i]!.slice(start, start + widthOf(i) - 1)}`;
      const tails = group.map(i => from(i, Math.min(at, Math.max(0, labels[i]!.length - (widthOf(i) - 1)))));
      // Tails that still read alike (one label's tail is the other's whole tail) give way to a window around the first differing character.
      const next = new Set(tails).size === group.length ? tails : group.map(i => from(i, Math.max(0, at - Math.floor((widthOf(i) - 1) / 2))));
      group.forEach((i, k) => {
        if (next[k] !== out[i]) {
          out[i] = next[k]!;
          changed = true;
        }
      });
    }
    if (!changed) break;
  }
  return out;
}

class RungPrompt extends Prompt<RungAnswer> {
  cursor = 0;
  back = false;
  readonly folded = new Set<string>();
  private lastQuery = "";

  constructor(private readonly o: RungSelectOptions) {
    super({ render: () => this.frame(), ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}) }, true);
    const ticks = new Set([...o.initial].filter(id => o.items.some(i => i.id === id)));
    for (const i of o.items) {
      if (i.lock === "on") ticks.add(i.id);
      if (i.lock === "off") ticks.delete(i.id);
    }
    const answers = new Map<string, string>();
    for (const i of o.items) {
      const value = answerOf(i, o.answers ?? new Map());
      if (value !== undefined) answers.set(i.id, value);
    }
    this.value = { ticks, answers };
    this.cursor = settle(this.entries(), 0);
    this.on("cursor", action => this.onCursor(action));
    this.on("key", (_char, key) => {
      if (key.name === "escape") this.back = true;
    });
    this.on("userInput", q => {
      if (q !== this.lastQuery) {
        this.lastQuery = q;
        this.cursor = settle(this.entries(), 0);
      }
    });
  }

  /** Space ticks instead of typing into the search. */
  protected override _isActionKey(_char: string | undefined, key: Key): boolean {
    return key.name === "space";
  }

  private entries(): Entry[] {
    return buildEntries(this.o.items, this.userInput, this.folded);
  }

  private answer(): RungAnswer {
    return this.value ?? { ticks: new Set(), answers: new Map() };
  }

  private ticks(): Set<string> {
    return this.answer().ticks;
  }

  /** Whether the arrows choose a row's word here; a screen with choices does not fold. */
  private get chooses(): boolean {
    return this.o.items.some(i => i.choices !== undefined);
  }

  private onCursor(action?: string): void {
    const entries = this.entries();
    const at = entries[this.cursor];
    switch (action) {
      case "up":
        this.cursor = settle(entries, this.cursor - 1, -1);
        return;
      case "down":
        this.cursor = settle(entries, this.cursor + 1, 1);
        return;
      case "space":
        if (at) toggleEntry(this.answer(), at);
        return;
      case "left": {
        if (this.chooses) {
          if (at) toggleEntry(this.answer(), at, -1);
          return;
        }
        const group = at?.type === "group" ? at.group : at?.type === "item" ? at.item.group : undefined;
        if (group === undefined) return;
        this.folded.add(group);
        this.cursor = Math.max(0, this.entries().findIndex(e => e.type === "group" && e.group === group));
        return;
      }
      case "right":
        if (this.chooses) {
          if (at) toggleEntry(this.answer(), at, 1);
          return;
        }
        if (at?.type === "group") this.folded.delete(at.group);
        return;
      default:
        return;
    }
  }

  /** The columns: labels as wide as the widest one up to the cap, the why column as wide as its widest cell, the
   * second column flush right. The label gives up what the other two take. */
  private columns(width: number): { label: number; why: number; second: number } {
    const items = this.o.items;
    const hasLocked = items.some(i => i.lock === "on");
    const labels = [3, ...items.map(i => i.label.length + (i.group !== undefined || i.lock === "on" ? 2 : 0)), ...items.map(i => i.group?.length ?? 0), hasLocked ? (this.o.lockedTitle ?? this.o.title).length : 0];
    // A header's own line is flush right over the why and the second column together, so a long one never squeezes
    // the labels; only the rows' own cells set this width.
    const second = Math.max(
      fmtCount(items.length, items.length).length,
      ...items.map(i => textOf(this.second(i)).length),
      // Every word a choice row can take, so the column holds still while the arrows move it.
      ...items.flatMap(i => (i.choices ?? []).map(c => c.label.length)),
    );
    // The label is what the row is: it takes what it needs up to the cap, and the why column gives way, since a path
    // or a count reads well enough cut.
    const label = Math.max(8, Math.min(Math.max(...labels), LABEL_CAP, width - EDGE - 2 - GUTTER.length - second));
    const want = Math.max(0, ...items.map(i => textOf(i.why).length));
    const room = width - EDGE - 2 - label - GUTTER.length - second - GUTTER.length;
    return { label, why: want === 0 || room < 8 ? 0 : Math.min(want, room), second };
  }



  /** What a group's header says after its name. */
  private groupLine(items: readonly SelectItem[]): string {
    return this.o.groupLine?.(items, this.answer()) ?? groupCount(items, this.ticks());
  }

  /** The indent of an item's row: grouped rows and bullets sit two columns in. */
  private static indent(i: SelectItem): number {
    return i.group !== undefined || i.lock === "on" ? 2 : 0;
  }

  /** Every item's label cut to the label column, no two alike. */
  private cuts(cols: Columns): Map<SelectItem, string> {
    const items = this.o.items;
    const cut = cutDistinct(items.map(i => i.label), i => cols.label - RungPrompt.indent(items[i]!));
    return new Map(items.map((i, k) => [i, cut[k]!]));
  }

  /** The second column of an item row: its answer where the screen gives it choices, its lock, or its hint. */
  private second(i: SelectItem): Column {
    const answer = answerOf(i, this.answer().answers);
    if (answer !== undefined) return i.choices?.find(c => c.value === answer)?.label ?? answer;
    if (i.lock === "off") return "stays here";
    return i.hint ?? "";
  }

  /** A cell padded to its column and then painted, so its colour costs no width; an empty cell is bare spaces. */
  private static cell(c: Column | undefined, width: number, align: Align): string {
    const t = textOf(c);
    if (t === "") return " ".repeat(width);
    return paintOf(c)(align === "right" ? t.padStart(width) : ellipsize(t, width).padEnd(width));
  }

  private line(glyph: string, label: string, why: Column | undefined, second: Column | undefined, indent: number, cols: Columns, current: boolean, heading: boolean): string {
    const field = ellipsize(label, cols.label - indent).padEnd(cols.label - indent);
    const text = heading ? styleText("bold", field) : current ? field : dim(field);
    // A row with nothing in the why column is a header: its own line takes the why and the second column together.
    const span = why === undefined && cols.why > 0 ? cols.why + GUTTER.length + cols.second : cols.second;
    const whyCell = cols.why === 0 || why === undefined ? "" : `${GUTTER}${RungPrompt.cell(why, cols.why, "left")}`;
    const cell = textOf(second) === "" ? "" : `${GUTTER}${RungPrompt.cell(second, span, "right")}`;
    return `${current ? accent("❯") : " "} ${" ".repeat(indent)}${glyph} ${text}${whyCell}${cell}`.trimEnd();
  }

  private row(entry: Entry, current: boolean, cols: Columns, cuts: Map<SelectItem, string>): string {
    const ticks = this.ticks();
    const box = (on: boolean): string => (on ? accent("●") : dim("○"));
    const label = (i: SelectItem): string => cuts.get(i) ?? i.label;
    switch (entry.type) {
      case "locked":
        // The rows that always come along are a group like the others when the screen names them, title and count and all.
        return this.o.lockedTitle === undefined
          ? this.line(dim("▾"), this.o.title, undefined, LOCKED_WORD, 0, cols, false, false)
          : this.line(dim("▾"), this.o.lockedTitle, undefined, this.groupLine(entry.items), 0, cols, false, true);
      case "bullet":
        return this.line(dim("•"), label(entry.item), entry.item.why, entry.item.hint ?? "", 2, cols, false, false);
      case "more":
        return `      ${dim(`…and ${entry.count} more`)}`;
      case "group":
        return this.line(entry.folded ? "▸" : "▾", entry.group, undefined, this.groupLine(entry.items), 0, cols, current, true);
      case "item": {
        const i = entry.item;
        // A row answered with a word carries no box: its answer is the second column, and one of the words is skip.
        const glyph = i.choices !== undefined ? " " : box(ticks.has(i.id));
        return this.line(glyph, label(i), i.why, this.second(i), RungPrompt.indent(i), cols, current, false);
      }
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
  }

  private detail(at: Entry | undefined): string[] {
    const rows = this.o.detailLines ?? DETAIL_LINES;
    const lines =
      at === undefined
        ? []
        : at.type === "group"
          ? [`${at.items.length} in ${at.group}`, at.items.some(i => i.choices !== undefined) ? "space or the arrows move the whole group" : "space turns the whole group on or off"]
          : at.type === "item"
            ? at.item.detail
            : [];
    return Array.from({ length: rows }, (_, i) => lines[i] ?? "");
  }

  /** The one line a finished screen leaves: the rows it ticked, or how its answers fell. */
  private settled(width: number): string {
    const items = this.o.items;
    if (this.chooses) {
      const answers = this.answer().answers;
      const counts = new Map<string, number>();
      for (const i of items) {
        const value = answerOf(i, answers);
        if (value === undefined) continue;
        const word = i.choices?.find(c => c.value === value)?.label ?? value;
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
      const parts = [...counts].map(([word, n]) => `${n} ${word}`);
      return parts.length === 0 ? "none" : summarize(parts, width, parts.length);
    }
    const ticks = this.ticks();
    const labels = [...items.filter(i => i.lock === "on"), ...items.filter(i => i.lock !== "on" && ticks.has(i.id))].map(i => i.label);
    return labels.length === 0 ? "none" : summarize(labels, width);
  }

  private frame(): string {
    const width = widthOf(this.o.output);
    const counter = `${GUTTER}${dim(this.o.counter)}`;

    if (this.state === "submit" || (this.state === "cancel" && this.back)) {
      return `${styleText("green", S_STEP_SUBMIT)}  ${this.o.title}${counter}\n${dim(S_BAR)}  ${dim(this.back ? "back" : this.settled(width - EDGE))}`;
    }
    if (this.state === "cancel") {
      return `${styleText("red", S_STEP_CANCEL)}  ${this.o.title}${counter}\n${dim(S_BAR)}  ${dim("cancelled")}`;
    }

    const entries = this.entries();
    this.cursor = settle(entries, this.cursor);
    const at = entries[this.cursor];
    const detail = this.detail(at);
    const footer = this.o.footer?.(this.answer(), width - EDGE) ?? [];
    const top = [...(this.o.top === undefined ? [] : wrap(this.o.top, width - EDGE)), LATER_LINE];
    // One row is left for the terminal's cursor line; a list that does not fit gives two more rows to the arrows.
    const room = rowsOf(this.o.output) - 1 - FIXED_LINES - top.length - detail.length - footer.length;
    const { start, end } = viewport(entries.length, this.cursor, entries.length <= room ? entries.length : room - 2);
    const cols = this.columns(width);
    const cuts = this.cuts(cols);
    const bar = dim(S_BAR_FOCUS);

    const lines: string[] = [];
    lines.push(`${accent(S_STEP_ACTIVE)}  ${accent(this.o.title)}${counter}`);
    for (const t of top) lines.push(`${bar}  ${dim(t)}`);
    lines.push(`${bar}  ${dim("search")}  ${this.userInput}${styleText("inverse", " ")}`);
    if (this.o.items.length === 0) lines.push(`${bar}  ${dim(EMPTY_WORD)}`);
    else if (entries.length === 0) lines.push(`${bar}  ${dim("no match")}`);
    if (start > 0) lines.push(`${bar}  ${dim(`↑ ${start} more`)}`);
    for (let i = start; i < end; i++) lines.push(`${bar} ${this.row(entries[i]!, i === this.cursor, cols, cuts)}`);
    if (end < entries.length) lines.push(`${bar}  ${dim(`↓ ${entries.length - end} more`)}`);
    lines.push(bar);
    // The highlighted row's own lines read in normal text; everything under them is dim but the one loud footer line.
    for (const d of detail) lines.push(`${bar}  ${ellipsize(d, width - EDGE)}`.trimEnd());
    for (const f of footer) {
      const text = ellipsize(typeof f === "string" ? f : f.text, width - EDGE);
      lines.push(text === "" ? bar : `${bar}  ${typeof f === "string" ? dim(text) : f.tone === undefined ? text : styleText(f.tone, text)}`);
    }
    const keys: HelpKey[] = this.chooses
      ? [KEY_CHOOSE, KEY_NEXT, KEY_BACK]
      : [KEY_TICK, ...(this.o.items.some(i => i.group !== undefined) ? [KEY_FOLD] : []), KEY_NEXT, KEY_BACK];
    lines.push(`${dim(S_BAR_FOCUS_END)}  ${helpLine(keys, colourDepth(isTTY(this.o.output)))}`);
    return lines.join("\n");
  }
}

export async function rungSelect(o: RungSelectOptions): Promise<RungSelectResult> {
  const prompt = new RungPrompt(o);
  const result = await prompt.prompt();
  const answer: RungAnswer = prompt.value ?? { ticks: new Set<string>(), answers: new Map<string, string>() };
  if (isCancel(result)) return prompt.back ? { kind: "back", ...answer } : { kind: "cancel" };
  return { kind: "next", ...answer };
}

/** One keypress, by name ("c", "return"); ctrl-c and escape resolve as "cancel". */
export function readKey(input: Readable, output: Writable, accept: readonly string[]): Promise<string> {
  return new Promise(resolve => {
    emitKeypressEvents(input);
    const tty = input as Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
    if (tty.isTTY && tty.setRawMode) tty.setRawMode(true);
    const done = (value: string): void => {
      input.off("keypress", onKey);
      if (tty.isTTY && tty.setRawMode) tty.setRawMode(false);
      input.pause();
      resolve(value);
    };
    const onKey = (char: string | undefined, key: Key): void => {
      if (key.sequence === "\x03" || key.name === "escape") return done("cancel");
      const name = key.name ?? char;
      if (name !== undefined && accept.includes(name)) done(name);
    };
    input.on("keypress", onKey);
    input.resume();
  });
}
