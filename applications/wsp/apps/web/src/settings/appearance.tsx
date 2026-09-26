// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Appearance: the theme picker, the side and each side's theme.
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { SETTINGS_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { ThemePicker } from "./ThemePicker.js";

/** The one patch Restore defaults writes: the side and each side's theme back to the record's defaults. */
export const APPEARANCE_DEFAULTS: PreferencesPatch = { theme: DEFAULT_PREFERENCES.theme, lightTheme: DEFAULT_PREFERENCES.lightTheme, darkTheme: DEFAULT_PREFERENCES.darkTheme };

/** Whether any of those is off its default, which is when Restore defaults stands. */
export const appearanceOffDefaults = (p: Preferences): boolean =>
  p.theme !== DEFAULT_PREFERENCES.theme || p.lightTheme !== DEFAULT_PREFERENCES.lightTheme || p.darkTheme !== DEFAULT_PREFERENCES.darkTheme;

export function appearanceCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  return [
    {
      id: "theme",
      head: SETTINGS_WORDS.theme,
      items: [],
      body: <ThemePicker picks={preferences} onChange={setPreferences} />,
    },
  ];
}
