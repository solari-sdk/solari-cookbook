// Adapted from pingdotgg/t3code apps/web/src/lib/previewFocus.ts at 57a66608 (MIT).
/**
 * Returns true when the user's keyboard focus is somewhere inside the
 * preview panel (URL bar, chrome buttons). The embedded page is an iframe
 * here, and focus inside it is invisible to the parent document.
 *
 * Used by the global keybinding handler to gate preview commands to only
 * fire while the preview owns focus.
 */
export function isPreviewFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  return activeElement.closest("[data-preview-panel-mode]") !== null;
}
