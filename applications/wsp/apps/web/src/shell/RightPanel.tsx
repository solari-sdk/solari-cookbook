// SPDX-License-Identifier: AGPL-3.0-only
// The right region: one pane at a time over the copied tab strip,
// keyed by the selected workspace. A pane the workspace cannot serve yet (not
// running) stays greyed out in the picker with a reason. Terminal
// surfaces mount the Ghostty drawer in panel mode over the workspace's daemon
// link. The diff runs in its own worker pool, themed for the side the page is
// drawing. With no workspace selected the panel is this computer's own.
import { useEffect, useMemo, type ReactNode } from "react";
import { useWorkspacePorts } from "../browser/model.js";
import { previewTabSnapshots, useBrowserTabs, useWorkspaceBrowserTabs } from "../browser/tabs.js";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider.js";
import { RightPanelSheet } from "../components/RightPanelSheet.js";
import { RightPanelTabs } from "../components/RightPanelTabs.js";
import { MachineSurface } from "../components/machine/MachineSurface.js";
import { ProcessesSurface } from "../components/procs/ProcessesSurface.js";
import { AgentsSurface } from "../components/agents/AgentsSurface.js";
import { BrowserSurface } from "../components/preview/BrowserSurface.js";
import type { PreviewPanelMode } from "../components/preview/PreviewPanelShell.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { DiffSurface } from "../diffs/DiffSurface.js";
import { useAbsentComputer, useWorkspace } from "../protocol/store.js";
import { useAppDark } from "../settings/theme.js";
import { PANE_KINDS, paneOf, type PaneContext, type RightPanelKind } from "../panes.js";
import { isOpenable, useRightPanelStore, type RightPanelSurface, type WorkspaceRightPanelState } from "../rightPanelStore.js";
import { HERE_KEY } from "../terminal/computer.js";
import { openPanelTerminal } from "./shellCommands.js";
import { useTerminalSurfaces, WorkspaceTerminalPanel } from "../components/WorkspaceTerminalPanel.js";

const NO_PENDING: ReadonlySet<string> = new Set();

interface PaneView<K extends RightPanelKind> {
  Surface(props: { workspaceId: string; surface: Extract<RightPanelSurface, { kind: K }>; theme: "light" | "dark" }): ReactNode;
  /** How the pane opens when the store cannot open it alone. */
  open?(workspaceId: string): void;
}

/** What each pane kind draws, the one line per kind the registry in panes.ts cannot hold without importing every
 * pane into the store. */
const PANE_VIEWS: { readonly [K in RightPanelKind]: PaneView<K> } = {
  preview: { Surface: ({ workspaceId, surface }) => <BrowserSurface key={surface.id} workspaceId={workspaceId} surface={surface} /> },
  terminal: {
    Surface: ({ workspaceId, surface }) => <WorkspaceTerminalPanel workspaceId={workspaceId} surface={surface} />,
    open: workspaceId => void openPanelTerminal(workspaceId),
  },
  diff: {
    Surface: ({ workspaceId, theme }) => (
      <DiffWorkerPoolProvider theme={theme}>
        <DiffSurface workspaceId={workspaceId} theme={theme} />
      </DiffWorkerPoolProvider>
    ),
  },
  machine: { Surface: ({ workspaceId }) => <MachineSurface workspaceId={workspaceId} /> },
  processes: { Surface: ({ workspaceId }) => <ProcessesSurface workspaceId={workspaceId} /> },
  agents: { Surface: ({ workspaceId }) => <AgentsSurface workspaceId={workspaceId} /> },
};
const viewOf = (kind: RightPanelKind): PaneView<RightPanelKind> => PANE_VIEWS[kind] as PaneView<RightPanelKind>;

export function RightPanel({
  workspaceId,
  state,
  mode,
  layoutControls,
}: {
  workspaceId: string;
  state: WorkspaceRightPanelState;
  mode: PreviewPanelMode;
  layoutControls?: ReactNode;
}) {
  const workspace = useWorkspace(workspaceId);
  const here = workspaceId === HERE_KEY;
  const absent = useAbsentComputer(workspaceId);
  // The code views take a side as a prop and colour their tokens from it. It has to be the side the page is
  // drawing: a diff themed for the other side draws its lines in an ink the row tints were never measured against.
  const theme = useAppDark() ? "dark" : "light";
  const open = useRightPanelStore(s => s.open);
  const activateSurface = useRightPanelStore(s => s.activateSurface);
  const closeSurface = useRightPanelStore(s => s.closeSurface);
  const close = useRightPanelStore(s => s.close);
  const terminalLabelsById = useTerminalSurfaces(workspaceId);
  const active = state.surfaces.find(surface => surface.id === state.activeSurfaceId) ?? null;
  const browserTabs = useWorkspaceBrowserTabs(workspaceId);
  const ports = useWorkspacePorts(workspaceId);
  const previewSessions = useMemo(() => previewTabSnapshots(browserTabs, ports), [browserTabs, ports]);
  const pruneBrowserTabs = useBrowserTabs(s => s.prune);
  const openBrowserTabIds = useMemo(
    () => state.surfaces.flatMap(surface => (surface.kind === "preview" && surface.resourceId !== null ? [surface.resourceId] : [])),
    [state.surfaces],
  );
  useEffect(() => {
    pruneBrowserTabs(workspaceId, openBrowserTabIds);
  }, [pruneBrowserTabs, workspaceId, openBrowserTabIds]);

  const at: PaneContext = { here, workspace, absent };
  const available = Object.fromEntries(PANE_KINDS.map(kind => [kind, paneOf(kind).available(at)])) as Record<RightPanelKind, boolean>;
  const unavailableReasons = Object.fromEntries(
    PANE_KINDS.flatMap(kind => {
      const reason = paneOf(kind).reason?.(at);
      return reason === undefined ? [] : [[kind, reason]];
    }),
  ) as Partial<Record<RightPanelKind, string>>;

  const ActiveSurface = active === null ? null : viewOf(active.kind).Surface;

  const tabs = (
    <RightPanelTabs
      mode={mode}
      {...(layoutControls !== undefined ? { layoutControls } : {})}
      surfaces={state.surfaces}
      activeSurfaceId={state.activeSurfaceId}
      pendingSurfaceIds={NO_PENDING}
      previewSessions={previewSessions}
      terminalLabelsById={terminalLabelsById}
      onActivate={surface => activateSurface(workspaceId, surface.id)}
      onCloseSurface={surface => closeSurface(workspaceId, surface.id)}
      onAdd={kind => {
        const opens = viewOf(kind).open;
        if (opens) opens(workspaceId);
        else if (isOpenable(kind)) open(workspaceId, kind);
      }}
      available={available}
      unavailableReasons={unavailableReasons}
    >
      {ActiveSurface !== null && active !== null ? (
        <ActiveSurface workspaceId={workspaceId} surface={active} theme={theme} />
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Nothing open here.</EmptyTitle>
            <EmptyDescription>Pick a panel from the tab strip above.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </RightPanelTabs>
  );

  if (mode === "sheet") {
    return (
      <RightPanelSheet open onClose={() => close(workspaceId)}>
        {tabs}
      </RightPanelSheet>
    );
  }
  return tabs;
}
