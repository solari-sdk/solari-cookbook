// Adapted from pingdotgg/t3code apps/web/src/rightPanelLayout.ts at 57a66608 (MIT).
import { SIDEBAR_MAX_WIDTH } from "./shell/sidebarWidth.js";

/** At this viewport width and under, the right panel is a sheet over the centre column instead of a column beside it. */
export const RIGHT_PANEL_SHEET_MAX_VIEWPORT = 980;
export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = `(max-width: ${RIGHT_PANEL_SHEET_MAX_VIEWPORT}px)`;
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";
/** The narrowest the inline panel goes; the drag handle and the shell's rule both stop here. */
export const RIGHT_PANEL_MIN_WIDTH = 360;
/** The least the centre column keeps beside the inline panel: the composer's picker row reads whole down to about
 * 300 px (measured 2026-09-09), and the panel's own clamp leaves the column this much. */
export const CENTER_COLUMN_MIN_WIDTH = 360;

/** With the panel inline the sidebar is the column that gives way: it may take only what the window has left once the
 * panel and the centre column keep their minimums. The sidebar's own minimum still holds, since the kit's clamp puts
 * the minimum first, and the panel is a sheet before a window gets that narrow. */
export function sidebarMaxWidthBeside(viewportWidth: number, panelInline: boolean): number {
  return panelInline ? Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - RIGHT_PANEL_MIN_WIDTH - CENTER_COLUMN_MIN_WIDTH) : SIDEBAR_MAX_WIDTH;
}
