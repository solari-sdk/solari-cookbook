// SPDX-License-Identifier: AGPL-3.0-only
// The settings pages' grammar, in one place so every page reads it from here
// rather than from each other: one card per section, a component hairline at
// its edge and between what it holds, none under the last; a sub-head over
// every card but a page's first; a row of a fixed height with a title over a
// one-line description and one slot at the right edge, holding one mono word
// and at most one control; a line of a fixed height with a label at the left
// and one mono word or keycaps at the right. A card holds rows or lines,
// never both, so a page's rhythm is one height per card.
//
// Below 640 px there is no room for a title, a sentence and a value on one
// line, and no hover to read a cut word on: so a description takes two lines
// there, held whether it needs them or not, and a line puts its value under
// its label with two lines for it. A value is the one thing whose length is
// not bounded, so a card holding a row with one puts every slot in that card
// on a line of its own under the description and stands its rows at 88; a
// card whose slots are buttons and chevrons keeps them beside the text and
// stands at 64. A description gets the room the slot leaves it: two lines of
// the whole width where the slot has moved under it, three of the narrower
// box where it stands beside it. A row carrying chips grows there instead, so
// no chip is cut. One height per card otherwise, nothing cut.
import { Chips, type ChipItem } from "../components/ui/chips.js";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Kbd, KbdGroup } from "../components/ui/kbd.js";
import { Spaced } from "../components/ui/spaced.js";
import { cn } from "../lib/utils.js";
import { FACT, VALUE } from "./format.js";

/** Which mono a word in a slot wears: the foreground for a value a person reads, the muted for a state. */
export type WordClass = "value" | "fact";

/** Words for one slot: a phrase, or facts drawn apart by space and read as one line by a search or a hover. */
export type Words = string | ReadonlyArray<string>;
const wordsLine = (words: Words): string => (typeof words === "string" ? words : words.join(", "));
const WordsSlot = ({ words }: { words: Words }) => (typeof words === "string" ? words : <Spaced parts={words} />);
const WORD_CLASS: Record<WordClass, string> = { value: VALUE, fact: FACT };

/** The height every row stands, whatever its words, and the two it takes below 640 px: the shorter where its slot
 * stays beside a two-line description, the taller where the slot has moved under it. A line stands at one height
 * too, and at the taller one below 640 px, where whatever is at its right stands under its label instead. */
export const ROW_CLASS = "h-16";
export const NARROW_ROW_CLASS = "max-sm:h-18";
export const DROPPED_ROW_CLASS = "max-sm:h-24";
export const LINE_CLASS = "h-11 max-sm:h-14";

/** One row of a settings page as data: its words, which the search reads, and the slot's render. */
export interface SettingsRowData {
  readonly kind: "row";
  readonly id: string;
  readonly title: string;
  /** A glyph before the title, where the row's noun has one of its own: a project's. */
  readonly lead?: ReactNode;
  /** One mono word after the title, in the fact class: the default mark on a computer. */
  readonly mark?: string;
  /** One sentence, or machine words in the mono fact class where `mono` is set; a list is facts held apart by space. */
  readonly description: Words;
  /** The facts as chips in place of the description line, which stays the words a search reads. */
  readonly chips?: readonly ChipItem[];
  readonly mono?: boolean;
  /** The one mono word in the slot, before the control, and the id a door or a list reaches it by. */
  readonly word?: string;
  readonly wordClass?: WordClass;
  readonly wordK?: string;
  /** At most one control: a segmented control, a stepper, a select, a button. */
  readonly control?: ReactNode;
  /** A row that opens a page: the whole row is the button and the slot ends in the chevron. */
  readonly open?: () => void;
  /** Extra attributes the tests and the screenshot list reach the row by. */
  readonly attrs?: Record<string, string>;
}

/** One line: a fact a person scans, or a chord. */
export interface SettingsLineData {
  readonly kind: "line";
  readonly id: string;
  readonly label: string;
  readonly value?: Words;
  readonly valueClass?: WordClass;
  /** Keycaps at the right, one group per chord. */
  readonly keys?: ReadonlyArray<ReadonlyArray<string>>;
  /** A word between the chords where they read as a range. */
  readonly keysJoiner?: string;
  /** One sentence on hover, never a description under the label. */
  readonly hover?: string;
  readonly attrs?: Record<string, string>;
}

export type SettingsItem = SettingsRowData | SettingsLineData;

/** One card: rows or lines, a sub-head over every card but a page's first, and at most one button under it for
 * the act the card invites. */
export interface SettingsCardData {
  readonly id: string;
  readonly head?: string;
  readonly items: ReadonlyArray<SettingsItem>;
  readonly under?: ReactNode;
  /** A control too large for a row, drawn under the head in place of the card's surface. */
  readonly body?: ReactNode;
}

/** The words a search reads on an item: its title or label, its description and its hover sentence. */
export function itemWords(item: SettingsItem): string[] {
  return item.kind === "row" ? [item.title, wordsLine(item.description)] : [item.label, ...(item.hover === undefined ? [] : [item.hover])];
}

/** Two lines of the words' own line height below 640 px, held whether they take one line or two, wrapped on a
 * space and cut at the second: the room a description and a value each get where no hover can read a cut word. */
const TWO_LINES_NARROW = "max-sm:line-clamp-2 max-sm:min-h-[2lh] max-sm:whitespace-normal";
/** Three of them, for a description that has kept the slot beside it and so has a narrower box to say itself in. */
const THREE_LINES_NARROW = "max-sm:line-clamp-3 max-sm:min-h-[3lh] max-sm:whitespace-normal";

export const CARD_SURFACE = "overflow-hidden rounded-[10px] border border-border bg-card";
const TITLE_CLASS = "text-sm leading-5 text-foreground";
const DESCRIPTION_CLASS = "text-xs leading-4 text-muted-foreground";
/** The hover a row that opens a page takes: the sidebar rows' step, in the same 150 ms. */
const OPENS_CLASS = "w-full cursor-pointer text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export function Card({ id, head, lede, under, body, children }: { id: string; head?: ReactNode; /** One sentence under the head, for a card whose rows need the why. */ lede?: string; under?: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return (
    <section data-settings-card={id} {...(typeof head === "string" ? { "aria-label": head } : {})} className="flex flex-col gap-3">
      {head === undefined && lede === undefined ? null : (
        <div className="flex flex-col gap-1.5">
          {head === undefined ? null : (
            <h2 data-settings-head className="text-[13px] leading-4 font-medium text-foreground">
              {head}
            </h2>
          )}
          {lede === undefined ? null : (
            <p data-settings-lede className="text-xs leading-4 text-muted-foreground">
              {lede}
            </p>
          )}
        </div>
      )}
      {body ?? <div className={cn(CARD_SURFACE, "flex flex-col divide-y divide-border")}>{children}</div>}
      {under === undefined ? null : <div className="flex gap-2">{under}</div>}
    </section>
  );
}

/** One row: the title over its description at the left, the slot at the right edge. Where the card drops below
 * 640 px the slot stands on a line of its own under the description, the word at its left and the control at its
 * right, and the description holds two lines of the whole width; where it does not, the slot keeps its place and
 * the description holds three of the narrower box. Either way nothing is cut where no hover can read it. */
export function Row({ id, title, lead, mark, description, chips, mono = false, word, wordClass = "value", wordK, control, open, drops = false, attrs }: Omit<SettingsRowData, "kind"> & { /** Whether every slot in this row's card moves under its description below 640 px, because one of them holds a value. */ drops?: boolean }) {
  const slot =
    word === undefined && control === undefined && open === undefined ? null : (
      <div data-settings-slot className={cn("flex min-w-0 max-w-[60%] shrink items-center gap-3", drops && (word === undefined ? "max-sm:w-full max-sm:max-w-full max-sm:justify-end" : "max-sm:w-full max-sm:max-w-full max-sm:justify-between"))}>
        {word === undefined ? null : (
          <span data-settings-word {...(wordK === undefined ? {} : { "data-k": wordK })} className={cn(WORD_CLASS[wordClass], "min-w-0 truncate text-right max-sm:whitespace-normal max-sm:text-left")} title={word}>
            {word}
          </span>
        )}
        {control}
        {open === undefined ? null : <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      </div>
    );
  const body = (
    <>
      {lead === undefined ? null : <span className="flex shrink-0 items-center">{lead}</span>}
      <div className={cn("flex min-w-0 flex-1 flex-col justify-center gap-1", !drops && "max-sm:gap-0.5")}>
        <span className="flex min-w-0 items-center gap-2">
          <span data-settings-title className={cn(TITLE_CLASS, "truncate")}>
            {title}
          </span>
          {mark === undefined ? null : (
            <span data-settings-mark className={cn(FACT, "shrink-0")}>
              {mark}
            </span>
          )}
        </span>
        {chips === undefined ? (
          <span data-settings-description className={cn(mono ? FACT : DESCRIPTION_CLASS, "truncate", drops ? TWO_LINES_NARROW : THREE_LINES_NARROW)} title={wordsLine(description)}>
            <WordsSlot words={description} />
          </span>
        ) : (
          <Chips items={chips} className="mt-1.5" />
        )}
      </div>
      {slot}
    </>
  );
  const rowClass = cn("flex items-center gap-6 px-5", chips === undefined ? ROW_CLASS : "min-h-24 gap-5 px-6 py-5", chips === undefined && (drops ? DROPPED_ROW_CLASS : NARROW_ROW_CLASS), drops && "max-sm:flex-col max-sm:items-stretch max-sm:justify-center max-sm:gap-1");
  // Marked, so the height a row stands at below 640 px is read off the row rather than worked out a second time.
  const dropMark = drops ? { "data-settings-drops": "" } : {};
  if (open !== undefined) {
    return (
      <button type="button" data-settings-row={id} className={cn(rowClass, OPENS_CLASS)} onClick={open} {...dropMark} {...attrs}>
        {body}
      </button>
    );
  }
  return (
    <div data-settings-row={id} className={rowClass} {...dropMark} {...attrs}>
      {body}
    </div>
  );
}

/** One line: the label at the left, at the right one mono word or the chord's keycaps. The sentence a line has to
 * say is its hover text; a line carries no description. Below 640 px whatever is at the right stands under the
 * label instead, a value with two lines of its own: at that width a label and a value sharing one line cut each
 * other, and a keycap cannot be cut at all, so the label went instead. A line with nothing at its right is a
 * sentence rather than a label, and takes the two lines there. */
export function Line({ id, label, value, valueClass = "value", keys, keysJoiner, hover, attrs }: Omit<SettingsLineData, "kind">) {
  const bare = value === undefined && keys === undefined;
  return (
    <div data-settings-line={id} className={cn(LINE_CLASS, "flex items-center gap-4 px-5 max-sm:flex-col max-sm:items-stretch max-sm:justify-center max-sm:gap-0")} {...(hover === undefined ? {} : { title: hover })} {...attrs}>
      {/* The label grows to push the value to the right edge while the two share a line, and takes its own height
          below 640 px, where they are stacked and a grown label would be squeezed under its own line. */}
      <span data-settings-label className={cn(TITLE_CLASS, "min-w-0 flex-1 truncate max-sm:flex-none", bare && TWO_LINES_NARROW)}>
        {label}
      </span>
      {value === undefined ? null : (
        <span data-settings-word className={cn(WORD_CLASS[valueClass], "min-w-0 max-w-[60%] truncate text-right", TWO_LINES_NARROW, "max-sm:max-w-full max-sm:text-left")} title={wordsLine(value)}>
          <WordsSlot words={value} />
        </span>
      )}
      {keys === undefined ? null : (
        <span data-settings-keys className="flex shrink-0 items-center gap-2 max-sm:justify-start">
          {keys.map((chord, at) => (
            <span key={chord.join("+")} className="flex items-center gap-2">
              {at > 0 && keysJoiner !== undefined ? <span className={FACT}>{keysJoiner}</span> : null}
              <KbdGroup>
                {chord.map(key => (
                  <Kbd key={key} className="font-mono">
                    {key}
                  </Kbd>
                ))}
              </KbdGroup>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** How long a description may be and still say itself in the three narrow lines a slot standing beside it leaves.
 * A count of characters is a proxy for a width only the browser knows, so it is deliberately short of what the
 * box holds; the render test walks every row of every screen at 390 and fails on a word its box cannot hold,
 * which is what actually holds this honest. */
const NARROW_DESCRIPTION_BUDGET = 56;

/** Whether a card puts its slots under their descriptions below 640 px, every row of it at once so the card is
 * one height: a row holding a value, whose length is not bounded, or a description with more to say than the
 * narrower box beside a slot holds. */
export const cardDrops = (items: ReadonlyArray<SettingsItem>): boolean =>
  items.some(item => item.kind === "row" && (item.word !== undefined || wordsLine(item.description).length > NARROW_DESCRIPTION_BUDGET));

/** A card's items drawn from their data: the one renderer every page and the search page share. */
export function Cards({ cards }: { cards: ReadonlyArray<SettingsCardData> }) {
  return (
    <>
      {cards.map(card => {
        const drops = cardDrops(card.items);
        return (
          <Card key={card.id} id={card.id} head={card.head} under={card.under} body={card.body}>
            {card.items.map(item => {
              if (item.kind === "line") {
                const { kind: _line, ...line } = item;
                return <Line key={item.id} {...line} />;
              }
              const { kind: _row, ...row } = item;
              return <Row key={item.id} {...row} drops={drops} />;
            })}
          </Card>
        );
      })}
    </>
  );
}
