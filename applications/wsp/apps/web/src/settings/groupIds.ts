// SPDX-License-Identifier: AGPL-3.0-only
// The closed list of settings groups in the order the sidebar draws them. The
// table in groups.ts gives each its words, glyph and page; the store reads a
// remembered page against this list. Adding a group is one id here and one
// entry there.
export const SETTINGS_GROUP_IDS = ["general", "appearance", "computers", "projects", "devices", "account", "privacy", "keybindings", "about"] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

export const isSettingsGroupId = (word: string): word is SettingsGroupId => (SETTINGS_GROUP_IDS as readonly string[]).includes(word);
