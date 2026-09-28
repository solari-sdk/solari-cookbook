// Adapted from pingdotgg/t3code apps/web/src/lib/terminalFocus.ts at 57a66608 (MIT).
// Every terminal surface marks its root with data-terminal-owner; the drawer
// and the right panel are the owners the shortcuts tell apart.
const TERMINAL_FOCUS_SELECTOR = "[data-terminal-owner]";

export type TerminalFocusOwner = "drawer" | "right-panel";

function focusedTerminalRoot(): HTMLElement | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  return activeElement.closest<HTMLElement>(TERMINAL_FOCUS_SELECTOR);
}

export function isTerminalFocused(): boolean {
  return focusedTerminalRoot() !== null;
}

/** Which surface holds the focused terminal; the first-run builder's terminal is focused but owned by neither. */
export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const owner = focusedTerminalRoot()?.dataset["terminalOwner"];
  return owner === "drawer" || owner === "right-panel" ? owner : null;
}
