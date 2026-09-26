// SPDX-License-Identifier: AGPL-3.0-only
// Facts as a row of small tinted chips, each with its own glyph, rather than
// words joined by dots.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export interface ChipItem {
  readonly text: string;
  readonly icon?: LucideIcon;
  readonly glyph?: ReactNode;
  readonly className?: string;
}

export const CHIP =
  "inline-flex h-6 max-w-full items-center gap-1.5 truncate rounded-md border border-border bg-foreground/[0.04] px-2 font-mono text-[11px] text-foreground/75 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]";

export function Chip({ item }: { item: ChipItem }) {
  const Icon = item.icon;
  return (
    <span data-chip className={cn(CHIP, item.className)} title={item.text}>
      {item.glyph ?? (Icon === undefined ? null : <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />)}
      <span className="truncate">{item.text}</span>
    </span>
  );
}

export function Chips({ items, className }: { items: readonly (ChipItem | null | undefined | false)[]; className?: string }) {
  const shown = items.filter((item): item is ChipItem => item !== null && item !== undefined && item !== false && item.text !== "");
  return (
    <div data-chips className={cn("flex flex-wrap gap-2", className)}>
      {shown.map(item => (
        <Chip key={item.text} item={item} />
      ))}
    </div>
  );
}
