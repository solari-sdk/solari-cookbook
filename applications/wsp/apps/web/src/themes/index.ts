// SPDX-License-Identifier: AGPL-3.0-only
// The one list of themes. A theme is its module and its sheet, keyed on its id; adding one is its two files and
// its line here.
import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { denim } from "./denim.js";
import { frost } from "./frost.js";
import { graphite } from "./graphite.js";
import { linen } from "./linen.js";
import { moss } from "./moss.js";
import { paper } from "./paper.js";
import { pitch } from "./pitch.js";
import { tungsten } from "./tungsten.js";
import type { Theme, ThemeSide } from "./theme.js";

export type { Theme, ThemeSide } from "./theme.js";

export const THEMES: readonly Theme[] = [paper, linen, frost, graphite, denim, tungsten, moss, pitch];

export const themeById = (id: string): Theme | undefined => THEMES.find(t => t.id === id);

function sideDefault(side: ThemeSide, id: string): Theme {
  const theme = themeById(id);
  if (theme?.side !== side) throw new Error(`the default ${side} theme ${id} is not registered on that side`);
  return theme;
}

/** Each side's default, the record's own default pick. */
export const SIDE_DEFAULT: Record<ThemeSide, Theme> = {
  light: sideDefault("light", DEFAULT_PREFERENCES.lightTheme),
  dark: sideDefault("dark", DEFAULT_PREFERENCES.darkTheme),
};

/** The theme a side draws for a pick: the pick when it is registered on that side, else the side's default. */
export function themeFor(side: ThemeSide, id: string): Theme {
  const theme = themeById(id);
  return theme?.side === side ? theme : SIDE_DEFAULT[side];
}
