// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's terminal surface: the same drawer in panel mode, with the
// surface's terminal ids and split direction as its one group and the right
// panel store as the arrangement. The panel owns the ptys it opened; they
// still come from the workspace's link, which also hands out their io.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore.js";
import { openPanelTerminal, splitPanelTerminal, type SplitDirection } from "../shell/shellCommands.js";
import { useTerminalViewportConfig } from "../terminal/fontSetting.js";
import { getTerminals, NOT_OPENED_YET, onTerminals, type WorkspaceTerminals } from "../terminal/link.js";
import { useTerminalPane } from "../terminal/paneWords.js";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty.js";
import { lostTerminals, terminalLabels } from "./WorkspaceTerminalDrawer.js";

const NO_TABS: readonly never[] = [];

/**
 * Tab titles for the panel's terminal surfaces, from the link's pty list. The
 * same list prunes surfaces whose pty the link no longer has (closed elsewhere,
 * or persisted from a session whose ptys are gone), so no surface outlives its
 * pty. Pruning waits for a live link, whose list is the daemon's.
 */
export function useTerminalSurfaces(workspaceId: string): ReadonlyMap<string, string> {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  const subscribe = useCallback((fn: () => void) => (terms ? terms.onTabs(fn) : () => {}), [terms]);
  const tabs = useSyncExternalStore(subscribe, () => (terms ? terms.tabs() : NO_TABS));
  const subscribeStatus = useCallback((fn: () => void) => (terms ? terms.onStatus(fn) : () => {}), [terms]);
  const status = useSyncExternalStore(subscribeStatus, () => (terms ? terms.status() : NOT_OPENED_YET));
  const reconcile = useRightPanelStore(s => s.reconcileTerminalSurfaces);
  useEffect(() => {
    if (terms && status === "live") reconcile(workspaceId, tabs.map(t => t.ptyId));
  }, [terms, reconcile, workspaceId, tabs, status]);
  return useMemo(() => terminalLabels(tabs), [tabs]);
}

export function WorkspaceTerminalPanel({
  workspaceId,
  surface,
}: {
  workspaceId: string;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
}) {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  if (!terms) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>No terminal link for this task.</EmptyTitle>
          <EmptyDescription>Terminals connect while the task is running.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <LinkedPanel terms={terms} workspaceId={workspaceId} surface={surface} />;
}

function LinkedPanel({
  terms,
  workspaceId,
  surface,
}: {
  terms: WorkspaceTerminals;
  workspaceId: string;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
}) {
  const tabs = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.tabs());
  const status = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.status());
  const refusal = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.refusal());
  const labels = useMemo(() => terminalLabels(tabs), [tabs]);
  const lost = useMemo(() => lostTerminals(tabs), [tabs]);
  const { pane, hints, onWake } = useTerminalPane(workspaceId, status, refusal);
  const terminalIo = useCallback((id: string) => terms.io(id), [terms]);
  const terminalConfig = useTerminalViewportConfig(workspaceId);
  const activateTerminal = useRightPanelStore(s => s.activateTerminal);
  const closeTerminal = useRightPanelStore(s => s.closeTerminal);
  // Only ptys the link knows get a viewport; a surface persisted across a reload waits for the link to adopt its ptys.
  const terminalIds = useMemo(() => surface.terminalIds.filter(id => tabs.some(t => t.ptyId === id)), [surface.terminalIds, tabs]);
  const activeTerminalId = terminalIds.includes(surface.activeTerminalId) ? surface.activeTerminalId : (terminalIds[0] ?? "");
  const groups = useMemo(
    () => [
      {
        id: surface.id,
        terminalIds,
        ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
      },
    ],
    [surface.id, terminalIds, surface.splitDirection],
  );
  const split = (direction: SplitDirection) => void splitPanelTerminal(workspaceId, surface.id, direction);

  return (
    <ThreadTerminalDrawer
      mode="panel"
      workspaceId={workspaceId}
      height={0}
      terminalIds={terminalIds}
      activeTerminalId={activeTerminalId}
      terminalGroups={groups}
      activeTerminalGroupId={surface.id}
      focusRequestId={0}
      pane={pane}
      paneHints={hints}
      onWake={onWake}
      lostTerminalIds={lost}
      onSplitTerminal={() => split("horizontal")}
      onSplitTerminalVertical={() => split("vertical")}
      onNewTerminal={() => void openPanelTerminal(workspaceId)}
      onActiveTerminalChange={id => activateTerminal(workspaceId, surface.id, id)}
      onCloseTerminal={id => {
        closeTerminal(workspaceId, surface.id, id);
        void terms.close(id);
      }}
      onHeightChange={() => {}}
      terminalLabelsById={labels}
      terminalIo={terminalIo}
      terminalConfig={terminalConfig}
    />
  );
}
