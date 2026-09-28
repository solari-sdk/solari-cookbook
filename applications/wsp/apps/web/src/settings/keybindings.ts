// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Keybindings: one line per default rule, the label at the left
// and the chord's keycaps at the right, worded per platform, a command with
// two chords showing both, and the three keys that are not rules under them.
// A rule whose chord a browser tab keeps for itself is not drawn in a tab.
// Nothing here is editable and the group has no defaults.
import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "../keybindingDefaults.js";
import { browserTabClaimsShortcut, formatShortcutLabel } from "../keybindings.js";
import { isWorkspaceSelectCommand, WORKSPACE_SELECT_SLOTS, workspaceSelectCommand, type KeybindingCommand, type KeybindingRule } from "../keybindingTypes.js";
import { KEYBINDINGS_WORDS } from "./format.js";
import { JUMP_WORD, KEYBINDING_WORDS } from "./keybindingWords.js";
import type { SettingsCardData, SettingsLineData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

/** The cards, each the commands it lists in the order they are read. */
const SHELL: readonly KeybindingCommand[] = ["commandPalette.toggle", "settings.toggle", "sidebar.toggle", "terminal.toggle", "rightPanel.toggle", "preview.toggle"];
const WORK: readonly KeybindingCommand[] = ["chat.new", "workspace.next", "workspace.previous", "thread.next", "thread.previous", workspaceSelectCommand(WORKSPACE_SELECT_SLOTS[0])];
const TERMINAL: readonly KeybindingCommand[] = ["terminal.split", "terminal.new", "terminal.zoomIn", "terminal.zoomOut", "terminal.zoomReset"];

/** Where the page reads the platform and the shell from, injected so a test builds its expectation from the same
 * source the page read rather than from a literal. */
export interface KeybindingsRead {
  readonly platform: string;
  readonly desktopShell: boolean;
}

/** The chords of one command as the page draws them: every rule for it that reaches this shell, each label one
 * keycap. The nine jump commands fold into one line that reads the first and the last slot. */
export function chordsOf(rules: ReadonlyArray<KeybindingRule>, command: KeybindingCommand, read: KeybindingsRead): string[][] {
  const labels = rules
    .filter(rule => (isWorkspaceSelectCommand(command) ? isWorkspaceSelectCommand(rule.command) : rule.command === command))
    .map(rule => parseKeybindingShortcut(rule.key))
    .filter((shortcut): shortcut is NonNullable<typeof shortcut> => shortcut !== null)
    .filter(shortcut => read.desktopShell || !browserTabClaimsShortcut(shortcut, read.platform))
    .map(shortcut => formatShortcutLabel(shortcut, read.platform));
  if (isWorkspaceSelectCommand(command)) {
    const first = labels[0];
    const last = labels.at(-1);
    return first === undefined || last === undefined ? [] : [[first], [last]];
  }
  return labels.map(label => [label]);
}

function linesOf(rules: ReadonlyArray<KeybindingRule>, commands: readonly KeybindingCommand[], read: KeybindingsRead): SettingsLineData[] {
  return commands.flatMap(command => {
    const keys = chordsOf(rules, command, read);
    if (keys.length === 0) return [];
    const jump = isWorkspaceSelectCommand(command);
    return [{ kind: "line" as const, id: jump ? "workspace.select" : command, label: jump ? JUMP_WORD : KEYBINDING_WORDS[command], keys, ...(jump ? { keysJoiner: "to" } : {}), attrs: { "data-command": jump ? "workspace.select" : command } }];
  });
}

/** The three keys that are not rules, in the platform's own spelling of the one chord among them. */
function fixedLines(read: KeybindingsRead): SettingsLineData[] {
  const submit = parseKeybindingShortcut("mod+enter");
  return [
    { kind: "line", id: "send", label: KEYBINDINGS_WORDS.sendMessage, keys: [["Enter"]] },
    { kind: "line", id: "submit-comment", label: KEYBINDINGS_WORDS.submitComment, keys: [[submit === null ? "Enter" : formatShortcutLabel(submit, read.platform)]] },
    { kind: "line", id: "leave-settings", label: KEYBINDINGS_WORDS.leaveSettings, keys: [["Esc"]] },
  ];
}

export function keybindingCards(rules: ReadonlyArray<KeybindingRule>, read: KeybindingsRead): SettingsCardData[] {
  return [
    { id: "shell", items: linesOf(rules, SHELL, read) },
    { id: "work", head: KEYBINDINGS_WORDS.workspacesAndThreads, items: linesOf(rules, WORK, read) },
    { id: "terminal", head: KEYBINDINGS_WORDS.terminal, items: linesOf(rules, TERMINAL, read) },
    { id: "fixed", head: KEYBINDINGS_WORDS.fixed, items: fixedLines(read) },
  ];
}

export function keybindingsCards(ctx: SettingsContext): SettingsCardData[] {
  return keybindingCards(DEFAULT_KEYBINDINGS, { platform: ctx.platform, desktopShell: ctx.desktopShell });
}
