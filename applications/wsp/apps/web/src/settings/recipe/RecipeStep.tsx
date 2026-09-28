// SPDX-License-Identifier: AGPL-3.0-only
// One step drawn under the Image card, the recipe's and the build's alike: its
// count, title and sentence over the step's content, the quiet links at the
// left of the foot, what a build takes and the keycap at its right, and the
// slot a refusal or a held link's reason lands in, standing in every state so
// its arrival moves nothing.
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { FACT } from "../format.js";
import { RefusalSlot } from "../sheetParts.js";
import { MICRO_LABEL } from "../../lib/microLabel.js";

export interface StepAction {
  k: string;
  word: string;
  onPress: () => void;
  /** Drawn and not pressable; its reason is the slot's to say. */
  disabled?: boolean;
  /** An act after which the build does not come back: neutral at rest, the danger ink on hover. */
  destructive?: boolean;
  /** The confirmation of such an act, the one place red stands at rest: the solid destructive button. */
  confirm?: boolean;
  /** Stays pressable while another press is with the host, since it is what stops that one. */
  whileBusy?: boolean;
}

export function RecipeStep({
  root = "recipe",
  k,
  counter,
  headline,
  top,
  note,
  cost,
  primary,
  links,
  refusal,
  waiting,
  busy = false,
  children,
}: {
  /** The word the step's parts are named under, so the recipe and the build under one card never read as each other. */
  root?: string;
  k: string;
  counter?: string;
  headline: string;
  top?: string;
  note?: string;
  cost?: string[];
  primary?: Omit<StepAction, "k">;
  links: StepAction[];
  refusal: string | null;
  /** A muted line in the slot while nothing is refused. */
  waiting?: string;
  /** A press is with the host: every press but Close and one that stops it waits for it. */
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div data-k={root} data-step={k} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        {counter === undefined ? null : (
          <p data-k={`${root}-counter`} className={cn(MICRO_LABEL, "text-muted-foreground")}>
            {counter}
          </p>
        )}
        <h3 data-k={`${root}-title`} className="text-sm leading-5 font-medium text-foreground">
          {headline}
        </h3>
        {top === undefined || top === "" ? null : (
          <p data-k={`${root}-sentence`} className="text-xs leading-4 text-muted-foreground">
            {top}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-col">{children}</div>
      {note === undefined ? null : (
        <p data-k={`${root}-note`} className="text-xs leading-4 text-muted-foreground">
          {note}
        </p>
      )}
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {links.map(link => (
            <Button
              key={link.k}
              data-k={`${root}-${link.k}`}
              size="xs"
              variant={link.confirm === true ? "destructive" : "ghost-muted"}
              disabled={link.disabled === true || (busy && link.k !== "close" && link.whileBusy !== true)}
              onClick={link.onPress}
              className={cn(link.destructive === true && link.confirm !== true && "transition-colors duration-150 hover:text-destructive-foreground focus-visible:text-destructive-foreground")}
            >
              {link.word}
            </Button>
          ))}
        </div>
        {cost === undefined ? null : (
          <span data-k={`${root}-cost`} className={cn(FACT, "flex shrink-0 flex-col items-end whitespace-nowrap leading-4")}>
            {cost.map(line => (
              <span key={line}>{line}</span>
            ))}
          </span>
        )}
        {primary === undefined ? null : (
          <Button data-k={`${root}-primary`} size="xs" variant="default" held={primary.disabled === true} disabled={busy} onClick={primary.onPress}>
            {primary.word}
          </Button>
        )}
      </div>
      <RefusalSlot k={`${root}-refusal`} {...(refusal === null ? {} : { said: refusal })} {...(waiting === undefined ? {} : { waiting })} />
    </div>
  );
}
