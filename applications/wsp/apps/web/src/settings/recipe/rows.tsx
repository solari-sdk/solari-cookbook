// SPDX-License-Identifier: AGPL-3.0-only
// The card grammar every step's content is drawn in, the first launch's: one
// bordered card of 48 px rows, a hairline between them, an 18 px mark where a
// row has a real one, the name in the sans, meta and state in mono, a slot at
// the right for the row's control or its state word, and a caps mono divider
// row for a group. The card is drawn whole, however many rows it holds, and
// the page it stands on is what scrolls. State is a muted word or the app's
// small spinner, never a chip; nothing moves at rest. Sizes wear the tone the
// protocol gives them, by weight where the step weighs.
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { INIT_ROW_STATES, diskTone, initDiskLine, type SizeTone } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../../components/ui/menu.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.js";
import { TONE_FILL, TONE_TEXT } from "../../lib/tone.js";
import { MICRO_LABEL } from "../../lib/microLabel.js";
import { cn } from "../../lib/utils.js";

export const STATE_WORD = "shrink-0 font-mono text-xs tabular-nums text-muted-foreground";
export const CARD = "w-full overflow-hidden rounded-[10px] border border-border bg-card text-left";

/** A size cell: tabular mono in the tone the protocol gave it. */
export function SizeCell({ tone, children, className }: { tone: SizeTone; children: ReactNode; className?: string }) {
  return (
    <span data-k="size" data-tone={tone} className={cn("font-mono text-xs tabular-nums", TONE_TEXT[tone], className)}>
      {children}
    </span>
  );
}

/** The card as a list of rows, drawn whole: the page it stands on is what scrolls. */
export function Card({ label, children, className, top }: { label?: string; children: ReactNode; className?: string; /** What sits along the card's top edge inside the border, above the rows. */ top?: ReactNode }) {
  return (
    <div data-k="card" className={cn(CARD, "flex flex-col")}>
      {top}
      <ul aria-label={label} className={className}>
        {children}
      </ul>
    </div>
  );
}

/** The disk meter inline after the tally: a 64 px hairline track and the estimate's share of the machine's disk as
 * its fill, in the tone the share earns; the numbers in its tooltip, the overshoot with them once there is one. The
 * overshoot is said there and in Continue's refusal, never as a third line beside the tally. */
export function Meter({ used, total }: { used: number; total: number }) {
  const share = total > 0 ? Math.min(1, used / total) : 0;
  const tone = diskTone(used, total);
  return (
    <>
      <Tooltip>
        <TooltipTrigger data-k="disk" data-tone={tone} data-used={used} data-total={total} aria-label={initDiskLine(used, total)} className="inline-flex h-4 shrink-0 cursor-default items-center outline-none focus-visible:ring-2 focus-visible:ring-ring" render={<span role="img" />}>
          <span aria-hidden className="block h-0.5 w-16 overflow-hidden rounded-full bg-muted-foreground/30">
            <span data-k="disk-fill" className={cn("block h-full rounded-full transition-[width,background-color] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none", TONE_FILL[tone])} style={{ width: `${Math.round(share * 1000) / 10}%` }} />
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" sideOffset={6}>
          {initDiskLine(used, total)}
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
export const ROW = "flex h-12 items-center gap-3 pl-4 pr-[10px]";
export const ROW_LINE = "border-t border-border first:border-t-0";
export const NAME = "min-w-0 flex-1 truncate text-[15px] text-foreground";
export const META = "font-mono text-xs tabular-nums text-muted-foreground";
/** A field inside a row: 32 px high under a 13 px label with 8 px between, the row 72 px. */
export const FIELD_ROW = "flex h-[72px] flex-col justify-center gap-2 pl-4 pr-[10px]";
export const FIELD_LABEL = "text-[13px] leading-none text-foreground";
export const FIELD = "h-8 w-full rounded-md border border-input bg-background font-mono text-xs [&_input]:h-8 [&_input]:leading-8";
/** A field standing on its own, outside any card: 48 px high, 13 px mono. */
export const LONE_FIELD = "h-12 w-full rounded-md border border-input bg-background font-mono text-[13px] [&_input]:h-12 [&_input]:px-[14px] [&_input]:text-[13px] [&_input]:leading-[48px]";

/** One caps mono divider over a group of rows. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <li data-k="group" className={cn(ROW_LINE, "flex h-8 items-center pl-4 text-muted-foreground", MICRO_LABEL)}>
      {children}
    </li>
  );
}

/** The right slot of a row: its control or its state word, right-aligned, one width. */
export function Slot({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("ml-auto flex min-w-24 shrink-0 items-center justify-end gap-2", className)}>{children}</span>;
}

/** A row's picker in its slot, the composer's own control: the current choice with a chevron, the choices as a radio
 * menu that closes on a pick and hands focus back to the trigger. Nothing happens on a pick but the pick; a fixed row's
 * picker is disabled and its state word stands beside it. */
export function RowPicker({ k, label, value, choices, disabled, onPick, row }: { k: string; label: string; value: string | undefined; choices: readonly { value: string; label: string; disabled?: boolean; state?: string }[]; disabled?: boolean; onPick: (value: string) => void; row?: string }) {
  const current = choices.find(c => c.value === value) ?? choices[0];
  return (
    <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost" size="xs" />} className="max-w-56 gap-1 font-mono text-xs text-foreground sm:text-xs" aria-label={label} data-k={k} data-value={current?.value} data-row={row} disabled={disabled === true}>
        <span className="truncate">{current?.label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="w-56">
        <MenuRadioGroup value={current?.value} onValueChange={next => (typeof next === "string" ? onPick(next) : undefined)}>
          {choices.map(c => (
            <MenuRadioItem key={c.value} value={c.value} data-k="option" data-value={c.value} disabled={c.disabled === true}>
              {c.label}
              {c.state !== undefined ? <span className={cn(STATE_WORD, "ml-auto pl-3")}>{c.state}</span> : null}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A row's state: the app's small spinner while it runs, a muted mono word otherwise. */
export function RowState({ state, className }: { state: string; className?: string }) {
  if (state === INIT_ROW_STATES.running) return <Spinner data-k="state" data-state={state} className="size-3.5 text-muted-foreground" />;
  return (
    <span data-k="state" data-state={state} className={cn(STATE_WORD, "max-w-56 truncate", state === INIT_ROW_STATES.failed && "text-destructive-foreground", className)} title={state}>
      {state}
    </span>
  );
}
