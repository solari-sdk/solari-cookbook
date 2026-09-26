// SPDX-License-Identifier: AGPL-3.0-only
// The ports the host forwards to this computer, under the workspaces. A row
// for a printed link is the link (localhost:<port> here reaches the
// workspace); a row for a sign-in callback is a label, since a bare request
// into an OAuth listener ends the flow. Both carry the workspace's name as the
// host gave it, how long the port has been open, and a stop. Rows come from
// the host's list and its forward events; nothing here guesses.
import { XIcon } from "lucide-react";
import { useState } from "react";
import { loopbackUrl } from "../browser/url.js";
import { Spaced } from "../components/ui/spaced.js";
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { useForwards, useStore } from "../protocol/store.js";
import { SectionRow } from "./SectionRow.js";
import { compactTimeLabel } from "./workspaceRows.js";

export function ForwardsList() {
  const forwards = useForwards();
  const stop = useStore(s => s.stopForward);
  const [collapsed, setCollapsed] = useState(false);
  // Re-render each minute so the ages move.
  useNowMinute();
  if (forwards.length === 0) return null;
  return (
    <SidebarGroup data-testid="forwards-list" className="pt-0">
      <SectionRow label="Forwarded ports" count={forwards.length} collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />
      {collapsed ? null : (
        <SidebarGroupContent>
          <SidebarMenu>
            {forwards.map(f => {
              return (
                <SidebarMenuItem key={`${f.workspaceId}:${f.port}`} data-forward={`${f.workspaceId}:${f.port}`} data-forward-kind={f.kind}>
                  {f.kind === "callback" ? (
                    <div className="flex h-12 min-w-0 items-center gap-2 rounded-md p-2 text-left text-sm">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                        <span className="truncate text-sidebar-foreground">sign-in callback for {f.name}</span>
                        <span className="truncate text-[11px] font-normal text-sidebar-muted-foreground tabular-nums">
                          <Spaced parts={[`localhost:${f.port}`, compactTimeLabel(f.startedAt)]} />
                        </span>
                      </span>
                    </div>
                  ) : (
                    <SidebarMenuButton
                      size="lg"
                      render={<a href={loopbackUrl(f.port)} target="_blank" rel="noopener noreferrer" />}
                      data-sidebar-row
                      data-row-id={`fwd:${f.workspaceId}:${f.port}`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                        <span className="truncate text-sidebar-foreground tabular-nums">localhost:{f.port}</span>
                        <span className="truncate text-[11px] font-normal text-sidebar-muted-foreground">
                          <Spaced parts={[f.name, compactTimeLabel(f.startedAt)]} />
                        </span>
                      </span>
                    </SidebarMenuButton>
                  )}
                  <SidebarMenuAction aria-label={`Stop forwarding localhost:${f.port}`} onClick={() => void stop(f.workspaceId, f.port)}>
                    <XIcon />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
