// SPDX-License-Identifier: AGPL-3.0-only
// One line the thread says about its workspace rather than about the turn:
// the row's meta mono, muted, with the hairline running from the words to the
// right edge, which is what parts it from what the agent wrote. The waking
// line a send puts there and the paused line under a settled thread are the
// same shape, so a person reads one grammar for what the workspace is doing.
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function TimelineRuleLine({ line, children, end, className, ...rest }: ComponentProps<"div"> & { line: string; end?: ReactNode }) {
  return (
    <div {...rest} className={cn("flex h-6 min-w-0 items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground tabular-nums", className)}>
      <span className="shrink-0 whitespace-nowrap">{line}</span>
      {children}
      <span aria-hidden className="h-px min-w-0 flex-1 bg-border" />
      {end === undefined ? null : <span className="shrink-0 whitespace-nowrap">{end}</span>}
    </div>
  );
}
