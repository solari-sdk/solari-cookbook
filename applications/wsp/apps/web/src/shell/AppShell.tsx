// SPDX-License-Identifier: AGPL-3.0-only
// The three regions: a resizable sidebar on the left, the selected
// workspace's panes in the center, the surface panel on the right. State
// drives every switch here; there is no router.
import { useEffect, type ReactNode } from "react";
import { ContextMenuHost } from "../actions/ContextMenuHost.js";
import { CommandPalette } from "../components/palette/CommandPalette.js";
import { WorkspaceSwitcher } from "../components/switcher/WorkspaceSwitcher.js";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls.js";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail, type SidebarWidthStore } from "../components/ui/sidebar.js";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { useViewportWidth } from "../hooks/useViewportWidth.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { isDesktopMac } from "../lib/desktopShell.js";
import { cn } from "../lib/utils.js";
import { Notices } from "../notices/Notice.js";
import { useSelectedWorkspaceId, useSettingsOpen, useStore } from "../protocol/store.js";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY, sidebarMaxWidthBeside } from "../rightPanelLayout.js";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./sidebarWidth.js";
import { trackThreadHistory } from "./threadHistory.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { SettingsHeaderActions } from "../settings/SettingsHeaderActions.js";
import { SettingsSidebar } from "../settings/SettingsSidebar.js";
import { WorkspaceSidebar } from "../sidebar/WorkspaceSidebar.js";
import { workspaceOrHere } from "../terminal/computer.js";
import { selectTerminalUiState, useTerminalDrawerStore } from "../terminal/drawerStore.js";
import { hostAsleep } from "../boot.js";
import { DisconnectedBanner } from "./DisconnectedBanner.js";
import { KeybindingDispatcher } from "./KeybindingDispatcher.js";
import { RightPanel } from "./RightPanel.js";
import { SignInBanner } from "./SignInBanner.js";
import { ThreadBreadcrumb } from "./ThreadBreadcrumb.js";

/** The dragged width goes onto the host's preferences record, so a browser tab on the same host opens at it and
 * the settings page's reset reaches this window. */
const sidebarWidthStore: SidebarWidthStore = {
  read: () => useStore.getState().preferences.sidebarWidth ?? null,
  // A drag ends on a fractional width past the shell's cap of the moment; the record keeps whole pixels inside the
  // sidebar's own bounds, the ones the settings page's stepper holds a typed width to.
  write: width => void useStore.getState().setPreferences({ sidebarWidth: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width))) }),
  subscribe: onChange =>
    useStore.subscribe((s, prev) => {
      if (s.preferences.sidebarWidth !== prev.preferences.sidebarWidth) onChange();
    }),
};
const RIGHT_PANEL_SHORTCUT_LABEL = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.toggle");
const TERMINAL_SHORTCUT_LABEL = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "terminal.toggle");

export function AppShell({ children }: { children: ReactNode }) {
  const workspaceId = useSelectedWorkspaceId();
  // With no workspace on screen the terminal and the panel are this computer's own.
  const terminalKey = workspaceOrHere(workspaceId);
  const conn = useStore(s => s.conn);
  const panel = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, terminalKey));
  const toggleVisibility = useRightPanelStore(s => s.toggleVisibility);
  const terminalOpen = useTerminalDrawerStore(s => selectTerminalUiState(s.byWorkspaceId, terminalKey).terminalOpen);
  const toggleTerminal = useTerminalDrawerStore(s => s.toggle);
  // Settings takes the window: its own sidebar in the app sidebar's place and the page in the whole region right of
  // it, with Restore defaults where the layout controls were. The panel's own record is untouched, so every
  // surface is back as it was the moment Settings closes.
  const settingsOpen = useSettingsOpen();
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const viewportWidth = useViewportWidth();
  const rightPanelOpen = panel.isOpen && !settingsOpen;
  const panelInline = rightPanelOpen && !useSheet;
  // The switch chord walks the threads last opened, so every selection is remembered from here on.
  useEffect(() => trackThreadHistory(), []);

  const layoutControls = (
    <PanelLayoutControls
      terminalOpen={terminalOpen}
      terminalShortcutLabel={TERMINAL_SHORTCUT_LABEL}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={RIGHT_PANEL_SHORTCUT_LABEL}
      liveAgentCount={0}
      onToggleTerminal={() => toggleTerminal(terminalKey)}
      onToggleRightPanel={() => toggleVisibility(terminalKey)}
    />
  );

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <KeybindingDispatcher />
      <CommandPalette />
      <ContextMenuHost />
      <WorkspaceSwitcher />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        className={cn(isDesktopMac() ? "sidebar-vibrancy" : "sidebar-glass", "border-r border-sidebar-border text-sidebar-foreground")}
        resizable={{ minWidth: SIDEBAR_MIN_WIDTH, maxWidth: sidebarMaxWidthBeside(viewportWidth, panelInline), width: sidebarWidthStore }}
      >
        {settingsOpen ? <SettingsSidebar /> : <WorkspaceSidebar />}
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        {/* A window on another computer says the one running wsp is asleep in the sidebar's own line, as a fact
            rather than an alert; the banner is for a wsp that stopped on the computer this window is at. */}
        {!hostAsleep(conn) && (conn === "closed" || conn === "reconnecting") ? <DisconnectedBanner reconnecting={conn === "reconnecting"} /> : null}
        <SignInBanner />
        <div className="flex min-h-0 flex-1 flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shell-center>
            <WorkspacePageHeader>
              <ThreadBreadcrumb />
              {settingsOpen ? (
                <div className="ml-auto mr-px">
                  <SettingsHeaderActions />
                </div>
              ) : panelInline ? null : (
                <div className="ml-auto mr-px">{layoutControls}</div>
              )}
            </WorkspacePageHeader>
            <div className="relative h-0">
              <Notices />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </div>
          {rightPanelOpen ? (
            <RightPanel workspaceId={terminalKey} state={panel} mode={useSheet ? "sheet" : "inline"} {...(useSheet ? {} : { layoutControls })} />
          ) : null}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
