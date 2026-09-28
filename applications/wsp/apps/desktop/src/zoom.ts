// SPDX-License-Identifier: AGPL-3.0-only
// The chords the shell's own menu zooms the window on. The menu registers
// them, so the page never sees them; while a terminal holds focus they mean
// that pane's text size, and the shell stands aside and hands the press to the
// page, whose keybindings answer it.
import type { ShellChord } from "@wsp/protocol";

/** A key press as the shell reads it before the page does. */
export interface ShellKeyInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** The keys the menu's Zoom In, Zoom Out and Actual Size rows carry, as a press spells them. */
const ZOOM_KEYS: ReadonlySet<string> = new Set(["+", "=", "-", "0"]);

/** Whether the menu would zoom this window on this press: the platform's mod alone with one of those keys. */
export function isShellZoomChord(input: ShellKeyInput, platform: NodeJS.Platform): boolean {
  if (input.type !== "keyDown" || input.alt) return false;
  const mod = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  return mod && ZOOM_KEYS.has(input.key);
}

/** The same press in the page's spelling. */
export function shellChordOf(input: ShellKeyInput): ShellChord {
  return { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt };
}
