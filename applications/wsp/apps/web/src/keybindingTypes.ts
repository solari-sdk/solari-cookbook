// SPDX-License-Identifier: AGPL-3.0-only
// The keybinding contract, hand-written from t3code's
// packages/contracts/src/keybindings.ts (57a66608) without its schema
// library. A rule is what a config file holds; a resolved rule is what the
// matcher reads. Commands are the closed set this shell can dispatch.

/** The sidebar slots a chord jumps to, counted down the workspace rows. The
 * chord table, the palette rows and the switch all read this one list, so a
 * tenth slot is added here and nowhere else. */
export const WORKSPACE_SELECT_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type WorkspaceSelectSlot = (typeof WORKSPACE_SELECT_SLOTS)[number];
export type WorkspaceSelectCommand = `workspace.select.${WorkspaceSelectSlot}`;

export function workspaceSelectCommand(slot: WorkspaceSelectSlot): WorkspaceSelectCommand {
  return `workspace.select.${slot}`;
}

export const KEYBINDING_COMMANDS = [
  "sidebar.toggle",
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "terminal.zoomIn",
  "terminal.zoomOut",
  "terminal.zoomReset",
  "rightPanel.toggle",
  "preview.toggle",
  "commandPalette.toggle",
  "settings.toggle",
  "chat.new",
  "workspace.next",
  "workspace.previous",
  "thread.next",
  "thread.previous",
  ...WORKSPACE_SELECT_SLOTS.map(workspaceSelectCommand),
] as const;
export type KeybindingCommand = (typeof KEYBINDING_COMMANDS)[number];

const WORKSPACE_SELECT_SLOT_BY_COMMAND = Object.fromEntries(
  WORKSPACE_SELECT_SLOTS.map(slot => [workspaceSelectCommand(slot), slot]),
) as Record<WorkspaceSelectCommand, WorkspaceSelectSlot>;

export function isWorkspaceSelectCommand(command: KeybindingCommand): command is WorkspaceSelectCommand {
  return command in WORKSPACE_SELECT_SLOT_BY_COMMAND;
}

/** The slot the command jumps to; the command type is the proof it names one. */
export function workspaceSelectSlot(command: WorkspaceSelectCommand): WorkspaceSelectSlot {
  return WORKSPACE_SELECT_SLOT_BY_COMMAND[command];
}

export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_KEYBINDINGS_COUNT = 256;

export interface KeybindingRule {
  readonly key: string;
  readonly command: KeybindingCommand;
  readonly when?: string;
}

export interface KeybindingShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** Command on macOS, Control elsewhere. */
  readonly modKey: boolean;
}

export type KeybindingWhenNode =
  | { readonly type: "identifier"; readonly name: string }
  | { readonly type: "not"; readonly node: KeybindingWhenNode }
  | { readonly type: "and"; readonly left: KeybindingWhenNode; readonly right: KeybindingWhenNode }
  | { readonly type: "or"; readonly left: KeybindingWhenNode; readonly right: KeybindingWhenNode };

export interface ResolvedKeybindingRule {
  readonly command: KeybindingCommand;
  readonly shortcut: KeybindingShortcut;
  readonly whenAst?: KeybindingWhenNode;
}

export type ResolvedKeybindingsConfig = ReadonlyArray<ResolvedKeybindingRule>;

export function isKeybindingCommand(value: string): value is KeybindingCommand {
  return (KEYBINDING_COMMANDS as readonly string[]).includes(value);
}
