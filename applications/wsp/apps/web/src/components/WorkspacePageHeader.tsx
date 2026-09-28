// Adapted from pingdotgg/t3code apps/web/src/components/WorkspacePageHeader.tsx at 57a66608 (MIT).
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { HeaderRow } from "../shell/HeaderRow";
import { useSidebarVisibility } from "./ui/sidebar";

/** Shared workspace top-bar geometry: the frame row itself while the sidebar is away, a plain row beside it otherwise. */
export function WorkspacePageHeader({ className, children, ...props }: ComponentPropsWithoutRef<"header">) {
  const sidebarOpen = useSidebarVisibility();
  return (
    <header
      className={cn("flex shrink-0 items-center pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]", className)}
      {...props}
    >
      <HeaderRow frame={!sidebarOpen} className="flex-1">
        {children}
      </HeaderRow>
    </header>
  );
}
