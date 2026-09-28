// SPDX-License-Identifier: AGPL-3.0-only
// The rows both project dialogs are built from: a section of the one container
// with its small label and the hairline above it, a mono path input for a
// browser tab, the desktop's picker row, a fact row with its value flush
// right, the caches row whose list opens under its count, a row the person
// ticks, and the one slot above the footer that reads the step under way, the
// refusal or the landed line over a thin bar. Every row is one height so
// nothing moves between states; only the slot's words may grow, since a
// refusal or a landed line is never cut.
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible.js";
import { Input } from "../components/ui/input.js";
import { cn } from "../lib/utils.js";
import { count, type StatusTone } from "./projectTrip.js";

const SECTION_LABEL = "font-mono text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground";

/** One section of the dialog's single container: its label, and a hairline above it unless it opens the container. */
export function TripSection({ k, label, htmlFor, children }: { k: string; label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <section data-k={k} className="flex flex-col gap-1.5 border-t border-border/50 py-3 first:border-t-0 first:pt-0">
      {htmlFor === undefined ? (
        <p className={SECTION_LABEL}>{label}</p>
      ) : (
        <label htmlFor={htmlFor} className={SECTION_LABEL}>
          {label}
        </label>
      )}
      {children}
    </section>
  );
}

/** A path typed into a browser tab, where no system picker exists; the section around it carries its label. */
export function FolderField({
  id,
  value,
  placeholder,
  disabled,
  autoFocus,
  onChange,
  onEnter,
}: {
  id: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  autoFocus?: boolean;
  onChange: (next: string) => void;
  onEnter?: () => void;
}) {
  const keyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && onEnter !== undefined) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <Input
      id={id}
      nativeInput
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      className="font-mono text-xs"
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      onKeyDown={keyDown}
    />
  );
}

/** The folder as the desktop shell's picker gave it: the glyph, the path in mono, and the one key that changes it. */
export function FolderPickerRow({ path, placeholder, disabled, onPick }: { path: string; placeholder: string; disabled: boolean; onPick: () => void }) {
  const empty = path === "";
  return (
    <div className="flex h-8 items-center gap-2">
      <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span data-k="path" className={cn("min-w-0 flex-1 truncate font-mono text-xs", empty ? "text-muted-foreground" : "text-foreground")} title={empty ? undefined : path}>
        {empty ? placeholder : path}
      </span>
      <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={disabled} onClick={onPick}>
        {empty ? "Choose folder" : "Change"}
      </Button>
    </div>
  );
}

/** A fact with its value flush right; a value that is a number or a path is mono, prose is not, a word standing in
 * for a value not yet known is muted, and any of them is cut with an ellipsis and rides its title whole. */
export function FactRow({ label, k, title, mono = true, muted = false, children }: { label: string; k: string; title?: string; mono?: boolean; muted?: boolean; children: ReactNode }) {
  return (
    <div className="flex h-7 min-w-0 items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn("min-w-0 truncate text-right", muted ? "text-muted-foreground" : "text-foreground", mono && "font-mono tabular-nums")}
        title={title ?? (typeof children === "string" ? children : undefined)}
        data-k={k}
      >
        {children}
      </span>
    </div>
  );
}

/** The caches left behind as a count, with the list behind a disclosure so a long one wraps below the row instead of
 * being cut; before the trip knows them, the idle word muted, or nothing. */
export function CachesRow({ excluded, idle = "" }: { excluded: readonly string[] | null; idle?: ReactNode }) {
  if (excluded === null || excluded.length === 0) {
    return (
      <FactRow label="Caches left behind" k="caches" muted={excluded === null}>
        {excluded === null ? idle : "none"}
      </FactRow>
    );
  }
  return (
    <Collapsible>
      <FactRow label="Caches left behind" k="caches">
        <CollapsibleTrigger className="group inline-flex items-center gap-1">
          {count(excluded.length, "folder")}
          <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
      </FactRow>
      <CollapsiblePanel>
        <p data-k="cache-list" className="break-all pb-1.5 text-right font-mono text-[11px] leading-4 text-muted-foreground">
          {excluded.join(", ")}
        </p>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** A row the person ticks: the tick in the neutral ramp, what it is, and whatever words the trip gives its tick. */
export function ConsentRow({
  label,
  mono,
  checked,
  disabled,
  title,
  onToggle,
  children,
}: {
  /** What the row is, its own name for a screen reader and the first thing it shows. */
  label: string;
  mono: boolean;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onToggle: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <li className="flex h-7 items-center gap-2 text-xs" {...(title === undefined ? {} : { title })}>
      <Checkbox tone="neutral" checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onToggle} />
      <span className={cn("shrink-0 truncate text-foreground", mono && "max-w-[45%] font-mono")}>{label}</span>
      {children}
    </li>
  );
}

/** How far a transfer has come, 0 to 1, as a thin bar. */
function Bar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(fraction * 100);
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="block h-1 w-full overflow-hidden rounded-full bg-border">
      <span className="block h-full rounded-full bg-foreground/70 transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** The one slot above the footer: what the trip has to say right now over a thin bar. Empty at rest, its height
 * always taken so nothing moves when the trip starts. The words are a step under way in muted mono, a quiet landed
 * line, the caution colour for a refusal that asks for a replace, the error colour for one that does not. Two lines
 * of the row's height and never cut: a sentence wraps into the second line, an unbroken path breaks where it must,
 * and a third line grows the box rather than being clipped. The bar, when there is one, is labelled by the words. */
export function TripStatus({ tone, fraction, children }: { tone: StatusTone; fraction: number | null; children: string }) {
  return (
    <div data-k="progress" className="flex flex-col gap-1.5">
      <p
        role="status"
        data-k="progress-line"
        className={cn(
          "min-h-7 break-words text-[11px] leading-[14px]",
          tone === "step" ? "font-mono text-muted-foreground" : tone === "quiet" ? "text-muted-foreground" : tone === "caution" ? "text-warning-foreground" : "text-destructive-foreground",
        )}
        title={children}
      >
        {children}
      </p>
      <div className="h-1 w-full">{fraction === null ? null : <Bar fraction={fraction} label={children} />}</div>
    </div>
  );
}
