// SPDX-License-Identifier: AGPL-3.0-only
// The theme as the page draws it. The stylesheet has two sides, told apart by
// the dark class on the html element, and one sheet per theme, keyed on its
// data-theme; the preference picks a side, or leaves it to the computer, and
// each side draws the theme picked for it. One rule per value says which side
// it draws, and the desktop shell is told the value so its frame and glass
// draw the same side.
import type { Preferences, ThemePreference } from "@wsp/protocol";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { useStore } from "../protocol/store.js";
import { themeFor } from "../themes/index.js";

/** Whether each value draws the dark side, given whether the computer does. */
const DRAWS_DARK: Record<ThemePreference, (systemDark: boolean) => boolean> = {
  system: systemDark => systemDark,
  light: () => false,
  dark: () => true,
};

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** What the page draws its theme from: the side's pick, and each side's theme. */
export type ThemePicks = Pick<Preferences, "theme" | "lightTheme" | "darkTheme">;

/** Sets the side and that side's theme together, with transitions held off for one frame: the stylesheet
 * transitions colours on cards and buttons, and a paint mid-way between two themes is what a switch would show
 * otherwise. */
export function applyTheme({ theme, lightTheme, darkTheme }: ThemePicks, systemDark: boolean): void {
  const dark = DRAWS_DARK[theme](systemDark);
  const html = document.documentElement;
  html.classList.add("no-transitions");
  html.classList.toggle("dark", dark);
  html.dataset["theme"] = dark ? themeFor("dark", darkTheme).id : themeFor("light", lightTheme).id;
  window.requestAnimationFrame(() => html.classList.remove("no-transitions"));
}

/** Mounted once: the html element follows the record's pick before the first paint and at once after, and as the
 * computer's own scheme changes where the pick is system; the desktop shell hears the value so the window's frame,
 * glass and traffic-light bar follow. The pick is a row in Settings, and system is its default, so no side can
 * strand a person where the app cannot read the computer's. */
export function useThemeEffect(): void {
  const theme = useStore(s => s.preferences.theme);
  const lightTheme = useStore(s => s.preferences.lightTheme);
  const darkTheme = useStore(s => s.preferences.darkTheme);
  const systemDark = useMediaQuery(SYSTEM_DARK_QUERY);
  useLayoutEffect(() => {
    applyTheme({ theme, lightTheme, darkTheme }, systemDark);
    desktopBridge()?.setTheme?.(theme);
  }, [theme, lightTheme, darkTheme, systemDark]);
}

const subscribeToHtmlClass = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const readDark = (): boolean => document.documentElement.classList.contains("dark");

/** Which side the page is drawing right now, read off the html element the rule above flips: what a workspace theme
 * following the app needs to know to pick its ink. */
export function useAppDark(): boolean {
  return useSyncExternalStore(subscribeToHtmlClass, readDark, () => false);
}
