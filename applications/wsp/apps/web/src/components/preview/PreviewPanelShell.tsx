// Adapted from pingdotgg/t3code apps/web/src/components/preview/PreviewPanelShell.tsx at 57a66608 (MIT).
import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useResizableWidth } from "../../hooks/useResizableWidth";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { cn } from "../../lib/utils";
import { CENTER_COLUMN_MIN_WIDTH, RIGHT_PANEL_MIN_WIDTH } from "../../rightPanelLayout";
import { RIGHT_PANEL_WIDTH_STORAGE_KEY } from "../../rightPanelStore";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

/**
 * Upper bound as a fraction of the viewport; only binds on wide screens.
 * On narrow windows the container clamp below is what preserves the
 * centre column's space: the app sidebar sits outside the row, so the
 * viewport fraction alone left the column below its width and the composer
 * overflowed.
 */
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - CENTER_COLUMN_MIN_WIDTH;
  // The shell sizes the sidebar so the row holds both minimums once it has
  // given way; the frames of its width transition are narrower, and
  // useResizableWidth's clamp must not see max < min (it would resolve the
  // inversion to min and, via drag-end persistence, overwrite the user's
  // stored width).
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}

/**
 * Shell for the preview panel. In inline mode the panel is user-resizable
 * via a drag handle on the left edge; width persists per browser. In
 * sheet/sidebar modes the parent owns the size.
 */
export function PreviewPanelShell(props: {
  mode: PreviewPanelMode;
  maximized?: boolean;
  /**
   * Overrides the localStorage key used to persist the panel width. Callers
   * embedding this shell for a different surface (e.g. the pull requests
   * page) should pass their own key so resizing one panel doesn't clobber
   * the other's remembered width.
   */
  widthStorageKey?: string;
  /** Overrides the initial width (px) before the user has resized the panel. */
  defaultWidth?: number;
  children: ReactNode;
}) {
  const isInline = props.mode === "inline";
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Only inline non-maximized mode applies `width`/`maxWidth`; skip the
  // container measurement (and its re-renders) everywhere else.
  const maxWidth = useClampedMaxWidth(hostRef, isInline && !props.maximized);
  const { width, handlers } = useResizableWidth({
    storageKey: props.widthStorageKey ?? RIGHT_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: props.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline
          ? props.maximized
            ? "flex-1 border-l border-border"
            : "shrink-0 border-l border-border"
          : "w-full",
      )}
      style={isInline && !props.maximized ? { width: `${width}px` } : undefined}
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={props.maximized ? "true" : "false"}
    >
      {isInline && !props.maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      {props.children}
    </div>
  );
}

/**
 * Track viewport and flex-row widths to derive an upper bound for the panel.
 * Resize-aware so dragging the OS window narrower (or expanding the app
 * sidebar) re-clamps the stored width on the next render (the hook's clamp
 * picks this up automatically). The row is observed rather than the panel
 * itself because the panel competes with its sibling column for row space.
 * Row measurement only runs when `enabled`; modes without a resize handle
 * never apply the resulting width, so they skip the observer entirely.
 */
function useClampedMaxWidth(hostRef: RefObject<HTMLDivElement | null>, enabled: boolean): number {
  const vw = useViewportWidth();
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!enabled) return;
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    // Measure before first paint: the persisted width must be clamped
    // against the row on the initial render, not one observer tick later
    // (the panel would flash over-wide on every mount). clientWidth is
    // integral, so sub-pixel resize deltas bail out of re-rendering.
    const measure = () => {
      setContainerWidth(parent.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  }, [hostRef, enabled]);
  return getPreviewPanelMaxWidth(vw, containerWidth);
}
