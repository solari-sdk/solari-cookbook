// Adapted from pingdotgg/t3code apps/web/src/components/sidebar/SidebarChrome.tsx at 57a66608 (MIT).
// The router, settings and update-pill hooks are replaced by props: the
// header is the shell's frame row with the wordmark, the footer holds what
// the sidebar puts in it. The stage backdrop and the utility menu are left out.
import type { ReactNode } from "react";
import { memo } from "react";

import { Lockup } from "../brand/Brand";
import { SidebarFooter } from "../components/ui/sidebar";
import { HeaderRow } from "../shell/HeaderRow";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({ children }: { children?: ReactNode }) {
  return (
    <HeaderRow frame className="@container/sidebar-header relative" data-slot="sidebar-header">
      {/* At 14px tall the optical centre sits 2px above the box's middle, so the box drops 2px onto the row's centre line. */}
      <Lockup className="h-3.5 w-fit shrink-0 translate-y-0.5 text-muted-foreground" />
      {children}
    </HeaderRow>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter({ children }: { children?: ReactNode }) {
  return <SidebarFooter className="p-[var(--sidebar-content-inset)]">{children}</SidebarFooter>;
});
