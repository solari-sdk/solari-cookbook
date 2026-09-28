// SPDX-License-Identifier: AGPL-3.0-only
// The person's Ghostty config as the last pane read it off the host, kept so
// the zoom chords clamp against the base the panes draw from; the panes read
// the host themselves and put what they read here.
import type { TerminalConfig } from "@wsp/protocol";

let file: TerminalConfig | null = null;

export const terminalFile = (): TerminalConfig | null => file;

export function rememberTerminalFile(next: TerminalConfig | null): void {
  file = next;
}
