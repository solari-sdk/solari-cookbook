// Adapted from pingdotgg/t3code apps/web/src/components/preview/PreviewMoreMenu.tsx at 57a66608 (MIT).
// The Electron previewBridge is gone: every action is a prop, and the items a
// plain frame cannot serve (DevTools, appearance, device toolbar, separate
// window, clear cookies and cache) are dropped.
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface Props {
  /** Active preview tab id. Tab-targeting actions are disabled without it. */
  tabId: string | null;
  /** True while a page is framed; zoom and reload act on it. */
  hasPage: boolean;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  onHardReload: () => void;
  onCopyUrl: () => void;
  onOpenInBrowser: () => void;
  onNewTab: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
}

/**
 * Three-dot menu in the chrome row: hard reload, copy, open outside, a new
 * tab, and the zoom cluster.
 */
export function PreviewMoreMenu({
  tabId,
  hasPage,
  zoomFactor,
  onHardReload,
  onCopyUrl,
  onOpenInBrowser,
  onNewTab,
  onZoomIn,
  onZoomOut,
  onResetZoom,
}: Props) {
  const tabDisabled = !tabId || !hasPage;

  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Preview menu" />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuItem onClick={onHardReload} disabled={tabDisabled}>
          Hard reload
        </MenuItem>
        <MenuItem onClick={onCopyUrl} disabled={tabDisabled}>
          Copy URL
        </MenuItem>
        <MenuItem onClick={onOpenInBrowser} disabled={tabDisabled}>
          Open in system browser
        </MenuItem>
        <MenuItem onClick={onNewTab}>New tab</MenuItem>
        <MenuSeparator />
        {/*
          Zoom row: label + inline control cluster. `closeOnClick=false`
          keeps the menu open while the user clicks the +/− buttons.
        */}
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={tabDisabled}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={onZoomOut}
              aria-label="Zoom out"
              disabled={tabDisabled}
            >
              <Minus />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={onZoomIn}
              aria-label="Zoom in"
              disabled={tabDisabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={onResetZoom}
              aria-label="Reset zoom"
              className="[:hover,[data-pressed]]:bg-foreground/10"
              disabled={tabDisabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
