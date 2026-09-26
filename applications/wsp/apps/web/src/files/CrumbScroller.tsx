// SPDX-License-Identifier: AGPL-3.0-only
// The scroller both crumb rows in the panel sit in, the panes' folder and the
// open file: no bar, the cut edge faded, and the row's height held whatever
// the panel's width is.
import type { ComponentProps, ReactNode } from "react";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { cn } from "../lib/utils.js";

export function CrumbScroller({
  label,
  rowClassName,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof ScrollArea>, "children"> & {
  label: string;
  rowClassName?: string;
  children: ReactNode;
}) {
  return (
    <ScrollArea hideScrollbars scrollFade className={cn("min-w-0 flex-1 rounded-none", className)} {...props}>
      <nav aria-label={label} className={cn("flex h-full w-max min-w-full items-center", rowClassName)}>
        {children}
      </nav>
    </ScrollArea>
  );
}
