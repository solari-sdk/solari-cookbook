// SPDX-License-Identifier: AGPL-3.0-only
// The terminal's actions, one registry: what the drawer's toolbar and the
// surface's context menu offer for the active terminal.
import { ClipboardPasteIcon, CopyIcon, EraserIcon, PlusIcon, SquareSplitHorizontalIcon, SquareSplitVerticalIcon, Trash2Icon } from "lucide-react";
import { NO_CLIPBOARD_READ, NO_TERMINAL, NOTHING_SELECTED, SPLIT_LIMIT, TERMINAL_WORDS } from "./format.js";
import type { ActionEntry } from "./registry.js";

export interface TerminalTarget {
  readonly hasSelection: boolean;
  readonly atSplitLimit: boolean;
}

/** copy, paste and clear act on one surface, so only the surface's own menu has them; the drawer's toolbar resolves
 * the registry without them and never shows those rows. */
export interface TerminalVerbs {
  readonly copy?: (() => Promise<void>) | undefined;
  /** Absent where the page cannot read the clipboard. */
  readonly paste?: (() => Promise<void>) | undefined;
  readonly clear?: (() => void) | undefined;
  readonly split: () => void;
  readonly splitVertical: () => void;
  readonly newTerminal: () => void;
  readonly close: () => void;
}

export const terminalActions: ReadonlyArray<ActionEntry<TerminalTarget, TerminalVerbs>> = [
  {
    id: "copy",
    group: "clipboard",
    icon: () => CopyIcon,
    title: () => TERMINAL_WORDS.copy,
    refusal: (target, verbs) => (verbs.copy === undefined ? NO_TERMINAL : target.hasSelection ? null : NOTHING_SELECTED),
    run: (_target, verbs) => verbs.copy?.(),
  },
  {
    id: "paste",
    group: "clipboard",
    icon: () => ClipboardPasteIcon,
    title: () => TERMINAL_WORDS.paste,
    refusal: (_target, verbs) => (verbs.paste === undefined ? NO_CLIPBOARD_READ : null),
    run: (_target, verbs) => verbs.paste?.(),
  },
  {
    id: "clear",
    group: "screen",
    icon: () => EraserIcon,
    title: () => TERMINAL_WORDS.clear,
    refusal: (_target, verbs) => (verbs.clear === undefined ? NO_TERMINAL : null),
    run: (_target, verbs) => verbs.clear?.(),
  },
  {
    id: "split",
    group: "panes",
    icon: () => SquareSplitHorizontalIcon,
    shortcutCommand: "terminal.split",
    title: () => TERMINAL_WORDS.split,
    refusal: target => (target.atSplitLimit ? SPLIT_LIMIT : null),
    run: (_target, verbs) => verbs.split(),
  },
  {
    id: "split-vertical",
    group: "panes",
    icon: () => SquareSplitVerticalIcon,
    title: () => TERMINAL_WORDS.splitVertical,
    refusal: target => (target.atSplitLimit ? SPLIT_LIMIT : null),
    run: (_target, verbs) => verbs.splitVertical(),
  },
  {
    id: "new",
    group: "panes",
    icon: () => PlusIcon,
    shortcutCommand: "terminal.new",
    title: () => TERMINAL_WORDS.new,
    refusal: () => null,
    run: (_target, verbs) => verbs.newTerminal(),
  },
  {
    id: "close",
    group: "panes",
    icon: () => Trash2Icon,
    destructive: true,
    title: () => TERMINAL_WORDS.close,
    refusal: () => null,
    run: (_target, verbs) => verbs.close(),
  },
];
