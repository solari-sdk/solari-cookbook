// SPDX-License-Identifier: AGPL-3.0-only
/** Which side of the stylesheet a theme draws: the side the dark class and the window's own appearance follow. */
export type ThemeSide = "light" | "dark";

/** One theme: the id its sheet keys on, the word the picker shows, the one line its tooltip says, and its side. */
export interface Theme {
  readonly id: string;
  readonly word: string;
  readonly line: string;
  readonly side: ThemeSide;
}
