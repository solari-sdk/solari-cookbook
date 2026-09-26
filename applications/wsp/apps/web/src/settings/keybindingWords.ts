// SPDX-License-Identifier: AGPL-3.0-only
// The words the Keybindings page says for each command in the closed set, one
// table, exhaustive: a command added to the set must get its words here or
// the type check refuses the build. The nine jump commands each have an entry
// and the page folds them into one line.
import { WORKSPACE_SELECT_SLOTS, workspaceSelectCommand, type KeybindingCommand } from "../keybindingTypes.js";

export const JUMP_WORD = "Jump to a task";

export const KEYBINDING_WORDS: Record<KeybindingCommand, string> = {
  "commandPalette.toggle": "Search",
  "settings.toggle": "Settings",
  "sidebar.toggle": "Toggle the sidebar",
  "terminal.toggle": "Toggle the terminal drawer",
  "rightPanel.toggle": "Toggle the right panel",
  "preview.toggle": "Toggle the preview",
  "chat.new": "New thread",
  "workspace.next": "Next task",
  "workspace.previous": "Previous task",
  "thread.next": "Next thread",
  "thread.previous": "Previous thread",
  "terminal.split": "Split the terminal",
  "terminal.new": "New terminal",
  "terminal.zoomIn": "Zoom in",
  "terminal.zoomOut": "Zoom out",
  "terminal.zoomReset": "Reset the zoom",
  ...(Object.fromEntries(WORKSPACE_SELECT_SLOTS.map(slot => [workspaceSelectCommand(slot), JUMP_WORD])) as Record<ReturnType<typeof workspaceSelectCommand>, string>),
};
