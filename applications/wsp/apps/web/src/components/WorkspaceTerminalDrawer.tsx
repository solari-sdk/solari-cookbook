// SPDX-License-Identifier: AGPL-3.0-only
// The drawer under the chat, bound to the workspace's daemon link: ptys come
// from WorkspaceTerminals, their arrangement from the drawer store, and each
// viewport gets its io from the link. Ptys the right panel opened belong to
// the panel and never appear here; a pty no store claims after a reload is
// the drawer's. The drawer's first open with no pty of its own spawns one;
// closing the last never respawns.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectPanelTerminalIds, useRightPanelStore } from "../rightPanelStore.js";
import { openDrawerTerminal, reportTerminalRefused, splitDrawerTerminal, type SplitDirection } from "../shell/shellCommands.js";
import { selectTerminalUiState, useTerminalDrawerStore } from "../terminal/drawerStore.js";
import { useTerminalViewportConfig } from "../terminal/fontSetting.js";
import { reconcileTerminalIds, type TerminalUiState } from "../terminal/groups.js";
import { getTerminals, onTerminals, type PtyTabView, type WorkspaceTerminals } from "../terminal/link.js";
import { useTerminalPane } from "../terminal/paneWords.js";
import { HERE_KEY } from "../terminal/computer.js";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer.js";

// One first-open spawn per link: concurrent mounts share the create and a
// drawer that later closes its last pty never respawns; a refused create
// clears the slot so the next mount may try again.
const firstSpawn = new WeakMap<WorkspaceTerminals, Promise<PtyTabView>>();

function spawnFirstDrawerTerminal(terms: WorkspaceTerminals): Promise<PtyTabView> | null {
  if (firstSpawn.has(terms)) return null;
  // With no pty anywhere on the link, ensureOpen shares the create with the center tab's own first-open.
  const spawn = (terms.tabs().length === 0 ? terms.ensureOpen() : terms.open()).catch((error: unknown) => {
    firstSpawn.delete(terms);
    throw error;
  });
  firstSpawn.set(terms, spawn);
  return spawn;
}

export function terminalLabels(tabs: readonly PtyTabView[]): ReadonlyMap<string, string> {
  return new Map(tabs.map(t => [t.ptyId, t.exited ? `${t.title} (exited)` : t.title]));
}

export function lostTerminals(tabs: readonly PtyTabView[]): ReadonlySet<string> {
  return new Set(tabs.filter(t => t.lost).map(t => t.ptyId));
}

export function WorkspaceTerminalDrawer({ workspaceId }: { workspaceId: string }) {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  const ui = useTerminalDrawerStore(s => selectTerminalUiState(s.byWorkspaceId, workspaceId));
  if (!terms || !ui.terminalOpen) return null;
  return <LinkedDrawer terms={terms} workspaceId={workspaceId} ui={ui} />;
}

/** The drawer on this computer's own terminal, whose shells open in the home folder. */
export function ComputerTerminalDrawer() {
  return <WorkspaceTerminalDrawer workspaceId={HERE_KEY} />;
}

function LinkedDrawer({ terms, workspaceId, ui }: { terms: WorkspaceTerminals; workspaceId: string; ui: TerminalUiState }) {
  const tabs = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.tabs());
  const status = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.status());
  const refusal = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.refusal());
  const panelIds = useRightPanelStore(useShallow(s => selectPanelTerminalIds(s.byWorkspaceId, workspaceId)));
  const ids = useMemo(() => tabs.map(t => t.ptyId).filter(id => !panelIds.includes(id)), [tabs, panelIds]);
  const labels = useMemo(() => terminalLabels(tabs), [tabs]);
  const lost = useMemo(() => lostTerminals(tabs), [tabs]);
  const { pane, hints, onWake } = useTerminalPane(workspaceId, status, refusal);
  const terminalIo = useCallback((id: string) => terms.io(id), [terms]);
  const terminalConfig = useTerminalViewportConfig(workspaceId);
  const store = useTerminalDrawerStore;

  // Until the link is live its tab list is not the daemon's: the stored arrangement is kept as is and only ptys the link knows get a viewport.
  const shown = useMemo(() => reconcileTerminalIds(ui, ui.terminalIds.filter(id => ids.includes(id))), [ui, ids]);

  useEffect(() => {
    if (status === "live") store.getState().reconcile(workspaceId, ids);
  }, [store, workspaceId, ids, status]);

  useEffect(() => {
    if (status !== "live" || ids.length > 0) return;
    spawnFirstDrawerTerminal(terms)?.then(t => store.getState().add(workspaceId, t.ptyId), (e: unknown) => reportTerminalRefused(workspaceId, e));
  }, [terms, store, workspaceId, status, ids.length]);

  const split = useCallback((direction: SplitDirection) => void splitDrawerTerminal(workspaceId, direction), [workspaceId]);

  return (
    <ThreadTerminalDrawer
      workspaceId={workspaceId}
      height={ui.terminalHeight}
      terminalIds={shown.terminalIds}
      activeTerminalId={shown.activeTerminalId}
      terminalGroups={shown.terminalGroups}
      activeTerminalGroupId={shown.activeTerminalGroupId}
      focusRequestId={0}
      pane={pane}
      paneHints={hints}
      onWake={onWake}
      lostTerminalIds={lost}
      onSplitTerminal={() => split("horizontal")}
      onSplitTerminalVertical={() => split("vertical")}
      onNewTerminal={() => void openDrawerTerminal(workspaceId)}
      onActiveTerminalChange={id => {
        store.getState().activate(workspaceId, id);
        terms.setActive(id);
      }}
      onCloseTerminal={id => {
        store.getState().remove(workspaceId, id);
        void terms.close(id);
      }}
      onHeightChange={h => store.getState().setHeight(workspaceId, h)}
      terminalLabelsById={labels}
      terminalIo={terminalIo}
      terminalConfig={terminalConfig}
    />
  );
}
