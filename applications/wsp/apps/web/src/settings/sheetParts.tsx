// SPDX-License-Identifier: AGPL-3.0-only
// The three pieces both Add a computer and Connect a provider are drawn from:
// a row holding one fact with the glyph that copies it, the running list of
// what a road has done so far, and the two-line slot a refusal lands in. The
// slot stands whether or not it holds a sentence, so a refusal arriving moves
// nothing on the screen under it.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { copyText } from "../actions/clipboard.js";
import { Button } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { MICRO_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { STATE_WORD } from "./recipe/rows.js";

/** How long the copy glyph stands as a check before it is a copy glyph again. */
const COPIED_MS = 1_400;

/** The mask that fades a copy line's right edge while more of it waits past the box. */
const MORE_TO_SCROLL = "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]";

/** Whether a line runs past its box and is not scrolled to its end, read again on every scroll and resize. */
function useMoreToScroll(value: string): { ref: RefObject<HTMLSpanElement | null>; more: boolean; measure: () => void } {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = (): void => {
    const el = ref.current;
    if (el !== null) setMore(el.scrollWidth > el.clientWidth && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    measure();
    if (el === null || typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [value]);
  return { ref, more, measure };
}

/** How wide a copy row's label column stands, so the values under each other line up whatever their labels are:
 * wide enough for ADDRESS, the longest, at 11 px caps with the tracking the label wears. */
const LABEL_WIDTH = "w-14";

/** A fact somebody has to type on another computer: its label in a fixed column, the fact in mono, and the glyph
 * that copies it. The fact is one run of text that scrolls sideways in its own box, since a line broken or cut is
 * not the line a person pastes. */
export function CopyRow({ label, value, k, children }: { label?: string; value: string; k: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const scroll = useMoreToScroll(value);
  const copy = (): void => {
    void copyText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {},
    );
  };
  return (
    <div data-copy-row={k} className="flex h-10 w-full items-center gap-3 rounded-md border border-border bg-card px-3">
      {label === undefined ? null : (
        <span className={cn(LABEL_WIDTH, MICRO_LABEL, "shrink-0 text-muted-foreground")}>{label}</span>
      )}
      {/* The name is on the value, not the row: a reader after the fact alone must not also get the label. */}
      <span
        ref={scroll.ref}
        data-k={k}
        onScroll={scroll.measure}
        className={cn("min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs tabular-nums text-foreground [scrollbar-color:color-mix(in_srgb,var(--border)_78%,transparent)_transparent] [scrollbar-width:thin]", scroll.more && MORE_TO_SCROLL)}
        title={value}
      >
        {value}
      </span>
      {children}
      <Button variant="ghost-muted" size="icon-xs" className="shrink-0" aria-label={`Copy the ${(label ?? "line").toLowerCase()}`} onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** One line of what a road has done: the words at the left, and at the right end the spinner while it runs, a check
 * once it is done, or a quiet word where the line carries one. */
export interface RoadLine {
  word: string;
  state: "running" | "done" | "waiting";
  /** The figure or the word at the right end: how long a stage took, or that a line is not required. */
  fact?: string;
}

/** The list of lines under a road, one 32 px line each, in the order they happened. A line longer than the sheet is
 * cut from the right and carries the whole of itself as its hover text. */
export function RoadLines({ lines, k = "lines" }: { lines: readonly RoadLine[]; k?: string }) {
  return (
    <ul data-k={k} className="flex flex-col">
      {lines.map(line => (
        <li key={line.word} data-k="line" data-state={line.state} className="flex h-8 items-center gap-3 border-border/60 border-b last:border-transparent">
          <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", line.state === "waiting" ? "text-muted-foreground" : "text-foreground")} title={line.word}>
            {line.word}
          </span>
          {line.fact === undefined ? null : <span className={STATE_WORD}>{line.fact}</span>}
          {line.state === "running" ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          {line.state === "done" ? <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        </li>
      ))}
    </ul>
  );
}

/** The slot under a field a refusal lands in: two lines at 12 px mono, standing at that height whether or not it
 * holds one. What happened is in the destructive ink; what to do about it follows in the foreground's. The same
 * slot carries, in the muted ink, why the keycap under it is held, so that reason is read before any click; a
 * refusal replaces it. Newlines in a refusal are kept: a computer that took the agent and did not dial back reads
 * its own log lines under the sentence, and HTML would otherwise run all eleven together. */
export function RefusalSlot({ k, said, fix, waiting, children }: { k: string; said?: string; fix?: string; waiting?: string; children?: ReactNode }) {
  return (
    <p data-k={k} className="min-h-9 whitespace-pre-line break-words font-mono text-xs leading-[18px] text-destructive-foreground">
      {said ?? ""}
      {fix === undefined ? null : <span className="text-foreground"> {fix}</span>}
      {said === undefined && waiting !== undefined ? (
        <span data-k="waiting" className="text-muted-foreground">
          {waiting}
        </span>
      ) : null}
      {children}
    </p>
  );
}
