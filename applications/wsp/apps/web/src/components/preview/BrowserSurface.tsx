// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's browser surface: the copied chrome row over an iframe on
// the route the runtime mints for one guest port, with the tab's path on it.
// A workspace of this computer shares this computer's ports, so the pane
// frames that same address rather than asking for a route no backend of this
// computer mints; a computer that mints none says so in one sentence of the
// protocol's, naming itself and the address that does answer. The servers
// list is the workspace's port directory; recents live in local storage per
// workspace. The bar shows the loopback address; copy and the frame keep the
// route and its token.
import { Check, Copy, Laptop } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isLocalWorkspace, noPreviewRouteLine } from "@wsp/protocol";
import { stoppedSentence, toPreviewableServers } from "../../adapt/ports.js";
import { useStoppedPort, useWorkspacePorts, useWorkspacePortsSeeded } from "../../browser/model.js";
import { recordVisit, removeVisit, useRecents } from "../../browser/recents.js";
import { useProbedRoute } from "../../browser/refusal.js";
import { currentAddress, useBrowserTab, useBrowserTabs, ZOOM_STEP } from "../../browser/tabs.js";
import { frameSrc, loopbackAddress, loopbackUrl, parseAddress, type Address } from "../../browser/url.js";
import { useForwarded, useWorkspace } from "../../protocol/store.js";
import { useComputerName } from "../../sidebar/workspaceRows.js";
import { useRightPanelStore, type RightPanelSurface } from "../../rightPanelStore.js";
import { clockLabel } from "../../lib/timestampFormat.js";
import { Button } from "../ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
import { PreviewChromeRow } from "./PreviewChromeRow.js";
import { PreviewEmptyState } from "./PreviewEmptyState.js";
import { PreviewMoreMenu } from "./PreviewMoreMenu.js";
import { ZoomIndicator } from "./ZoomIndicator.js";

type PreviewSurface = Extract<RightPanelSurface, { kind: "preview" }>;

const UNFRAMEABLE = "Only ports on this task can be framed here, like localhost:3000.";

export function BrowserSurface({ workspaceId, surface }: { workspaceId: string; surface: PreviewSurface }) {
  const tabId = surface.resourceId;
  const tab = useBrowserTab(workspaceId, tabId);
  const tabs = useBrowserTabs.getState();
  const openBrowser = useRightPanelStore(s => s.openBrowser);
  const ports = useWorkspacePorts(workspaceId);
  const portsSeeded = useWorkspacePortsSeeded(workspaceId);
  const servers = useMemo(() => toPreviewableServers({ ports }), [ports]);
  const [recents, setRecents] = useRecents(workspaceId);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const address = currentAddress(tab);
  const port = address?.port ?? null;
  // A workspace of this computer answers on this computer's own ports, which is the address the person's own
  // browser opens; nothing is minted for it and nothing is probed, since there is no preview edge in between.
  const workspace = useWorkspace(workspaceId);
  const here = workspace !== null && isLocalWorkspace(workspace);
  const computer = useComputerName(workspaceId);
  const { reach, refusal } = useProbedRoute(workspaceId, here ? null : port, tab?.reloadNonce ?? 0);
  const realUrl =
    address === null ? null : here ? loopbackUrl(address.port, address.path) : reach.state === "ready" ? frameSrc(reach.reach.url, address.path) : null;
  const shownUrl = address !== null ? loopbackAddress(address.port, address.path) : "";
  const listening = port === null || !portsSeeded || ports.some(p => p.port === port);
  const stopped = useStoppedPort(workspaceId, port);
  const sentence = listening ? "" : stoppedSentence(port, stopped, clockLabel);
  const forwarded = useForwarded(workspaceId, port);
  const zoom = tab?.zoom ?? 1;
  const framed = realUrl !== null && (refusal === null || refusal.keepsFrame);

  useEffect(() => {
    setLoading(framed);
  }, [framed, realUrl, tab?.reloadNonce]);

  // The port listening again is the cue to probe its route anew, whether the last answer was framed or a refusal card.
  const wasListening = useRef({ port, listening });
  useEffect(() => {
    const prev = wasListening.current;
    wasListening.current = { port, listening };
    if (tabId !== null && realUrl !== null && listening && !prev.listening && prev.port === port) tabs.reload(workspaceId, tabId);
  }, [port, listening, realUrl, tabId, workspaceId, tabs]);

  const frameAddress = (next: Address): void => {
    setHint(null);
    if (tabId === null) openBrowser(workspaceId, tabs.createTab(workspaceId, next));
    else tabs.navigate(workspaceId, tabId, next);
    setRecents(prev => recordVisit(prev, loopbackUrl(next.port, next.path), Date.now()));
  };

  const openUrl = (url: string): void => {
    const next = parseAddress(url);
    if (next === null) {
      setHint(UNFRAMEABLE);
      return;
    }
    frameAddress(next);
  };

  const copyUrl = (): void => {
    if (realUrl !== null) void navigator.clipboard?.writeText(realUrl).catch(() => {});
  };
  const openOutside = (): void => {
    if (realUrl !== null) window.open(realUrl, "_blank", "noopener");
  };
  const withTab = (fn: (id: string) => void) => () => {
    if (tabId !== null) fn(tabId);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-browser-surface>
      <PreviewChromeRow
        url={shownUrl}
        loading={loading}
        canGoBack={tab !== null && tab.index > 0}
        canGoForward={tab !== null && tab.index < tab.entries.length - 1}
        refreshDisabled={realUrl === null}
        onBack={withTab(id => tabs.back(workspaceId, id))}
        onForward={withTab(id => tabs.forward(workspaceId, id))}
        onRefresh={withTab(id => tabs.reload(workspaceId, id))}
        onSubmit={openUrl}
        onOpenInBrowser={realUrl !== null ? openOutside : undefined}
        trailingActions={
          <>
            {forwarded && address !== null ? <OpenOnLaptopButton address={address} /> : null}
            {realUrl !== null ? <CopyUrlButton url={realUrl} /> : null}
            <PreviewMoreMenu
              tabId={tabId}
              hasPage={realUrl !== null}
              zoomFactor={zoom}
              onHardReload={withTab(id => tabs.reload(workspaceId, id))}
              onCopyUrl={copyUrl}
              onOpenInBrowser={openOutside}
              onNewTab={() => openBrowser(workspaceId, null)}
              onZoomIn={withTab(id => tabs.setZoom(workspaceId, id, zoom + ZOOM_STEP))}
              onZoomOut={withTab(id => tabs.setZoom(workspaceId, id, zoom - ZOOM_STEP))}
              onResetZoom={withTab(id => tabs.setZoom(workspaceId, id, 1))}
            />
          </>
        }
      />
      {hint !== null ? (
        <div role="status" className="border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          {hint}
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {port === null ? (
          <PreviewEmptyState
            servers={servers}
            recentEntries={recents}
            onOpenUrl={openUrl}
            onRemoveRecent={url => setRecents(prev => removeVisit(prev, url))}
          />
        ) : reach.state === "failed" ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>{noPreviewRouteLine(port, computer)}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {!listening ? (
              <div title={sentence} className="shrink-0 truncate border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                {sentence}
              </div>
            ) : null}
            {refusal !== null && refusal.keepsFrame ? (
              <div role="status" className="shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{refusal.title}</span> {refusal.detail}
              </div>
            ) : null}
            {refusal !== null && !refusal.keepsFrame ? (
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>{refusal.title}</EmptyTitle>
                  <EmptyDescription>{refusal.detail}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : framed ? (
              <iframe
                key={`${loopbackUrl(port, address?.path)}:${tab?.reloadNonce ?? 0}`}
                title={`:${port}`}
                src={realUrl}
                onLoad={() => setLoading(false)}
                className="block min-h-0 flex-1 border-0 bg-white"
                style={
                  zoom === 1
                    ? undefined
                    : { transform: `scale(${zoom})`, transformOrigin: "0 0", width: `${100 / zoom}%`, height: `${100 / zoom}%` }
                }
              />
            ) : null}
            <ZoomIndicator zoomFactor={zoom} />
          </>
        )}
      </div>
    </div>
  );
}

/** Shown only while the host forwards this port: localhost:<port> on this computer reaches the workspace. */
function OpenOnLaptopButton({ address }: { address: Address }) {
  const here = loopbackAddress(address.port, address.path);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Open on laptop"
            onClick={() => window.open(loopbackUrl(address.port, address.path), "_blank", "noopener,noreferrer")}
          />
        }
      >
        <Laptop />
      </TooltipTrigger>
      <TooltipPopup>Open {here} on this computer</TooltipPopup>
    </Tooltip>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Copy URL"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => {});
            }}
          />
        }
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </TooltipTrigger>
      <TooltipPopup>{copied ? "Copied" : "Copy URL"}</TooltipPopup>
    </Tooltip>
  );
}
