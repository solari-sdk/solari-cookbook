// SPDX-License-Identifier: AGPL-3.0-only
// The one table of settings groups: each id's words, glyph, whether it has
// defaults to restore, the function that states its page's cards as data and
// the one that states the pages under it. The sidebar, the search, the
// breadcrumb and Restore defaults all read this table; adding a group is one
// id in groupIds.ts, one entry here and its page module. A group marked empty
// is not drawn, which is General today: no pick the record holds is a
// behaviour yet.
import { FolderIcon, InfoIcon, KeyboardIcon, MonitorIcon, PaletteIcon, ShieldIcon, SlidersHorizontalIcon, SmartphoneIcon, UserIcon, type LucideIcon } from "lucide-react";
import { PLACES_WORDS } from "@wsp/protocol";
import type { Preferences, PreferencesPatch } from "@wsp/protocol";
import { aboutCards, aboutMeta } from "./about.js";
import { accountCards } from "./account.js";
import { APPEARANCE_DEFAULTS, appearanceCards, appearanceOffDefaults } from "./appearance.js";
import { computerSubPages, computersCards } from "./computers.js";
import { devicesCards } from "./devices.js";
import { ABOUT_WORDS, ACCOUNT_WORDS, DEVICES_WORDS, KEYBINDINGS_WORDS, PRIVACY_WORDS, PROJECTS_WORDS, SETTINGS_WORDS } from "./format.js";
import { SETTINGS_GROUP_IDS, type SettingsGroupId } from "./groupIds.js";
import { keybindingsCards } from "./keybindings.js";
import { PRIVACY_DEFAULTS, privacyCards, privacyOffDefaults } from "./privacy.js";
import { projectSubPages, projectsCards } from "./projects.js";
import { normalizeSearchText } from "../lib/utils.js";
import { itemWords, type SettingsCardData, type SettingsItem } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import type { SettingsAt } from "./settingsStore.js";

export interface SettingsGroup {
  readonly id: SettingsGroupId;
  readonly name: string;
  readonly glyph: LucideIcon;
  /** The defaults a person can restore, where the group's rows have any: whether a row is off them, and the one
   * patch that puts them back. */
  readonly restore?: { readonly off: (preferences: Preferences) => boolean; readonly patch: PreferencesPatch };
  /** A group whose page has no row yet, which is not drawn: a group with nothing in it is decoration. */
  readonly empty?: true;
  readonly cards: (ctx: SettingsContext) => SettingsCardData[];
  /** The pages under this group in the sidebar, where the group lists nouns that each have a page of their own.
   * The sidebar reads this and nothing else, so a group that gains pages is one entry here and its page module. */
  readonly sub?: (ctx: SettingsContext) => { at: SettingsAt; name: string }[];
  /** One mono word at the right edge of the group's sidebar row, where the group has a state worth a glance. */
  readonly meta?: (ctx: SettingsContext) => string | undefined;
}

const TABLE: Record<SettingsGroupId, Omit<SettingsGroup, "id">> = {
  general: { name: "General", glyph: SlidersHorizontalIcon, empty: true, cards: () => [] },
  appearance: { name: SETTINGS_WORDS.appearance, glyph: PaletteIcon, restore: { off: appearanceOffDefaults, patch: APPEARANCE_DEFAULTS }, cards: appearanceCards },
  computers: { name: PLACES_WORDS.section, glyph: MonitorIcon, cards: computersCards, sub: computerSubPages },
  projects: { name: PROJECTS_WORDS.title, glyph: FolderIcon, cards: projectsCards, sub: projectSubPages },
  devices: { name: DEVICES_WORDS.title, glyph: SmartphoneIcon, cards: devicesCards },
  account: { name: ACCOUNT_WORDS.title, glyph: UserIcon, cards: accountCards },
  privacy: { name: PRIVACY_WORDS.title, glyph: ShieldIcon, restore: { off: privacyOffDefaults, patch: PRIVACY_DEFAULTS }, cards: privacyCards },
  keybindings: { name: KEYBINDINGS_WORDS.title, glyph: KeyboardIcon, cards: keybindingsCards },
  about: { name: ABOUT_WORDS.title, glyph: InfoIcon, cards: aboutCards, meta: aboutMeta },
};

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroup> = SETTINGS_GROUP_IDS.map(id => ({ id, ...TABLE[id] }));

export const groupById = (id: SettingsGroupId): SettingsGroup => ({ id, ...TABLE[id] });

/** The groups the sidebar draws: those whose page has something on it. */
export const drawnGroups = (): SettingsGroup[] => SETTINGS_GROUPS.filter(group => group.empty !== true);

/** Every item of a group's page whose words hold the query, case aside: what the search page and the sidebar's
 * dimming read. A list row matches by its name, since its title is the name. */
export function searchGroup(group: SettingsGroup, ctx: SettingsContext, query: string): SettingsItem[] {
  const q = normalizeSearchText(query);
  if (q === "") return [];
  return group.cards(ctx).flatMap(card => card.items.filter(item => itemWords(item).some(word => normalizeSearchText(word).includes(q))));
}

/** The palette row's description: the groups a person will find, named. */
export const groupNames = (): string => drawnGroups().map(group => group.name).join(", ");
