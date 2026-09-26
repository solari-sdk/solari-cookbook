// SPDX-License-Identifier: AGPL-3.0-only
// The container widths the agents manager changes shape at, each a literal so
// the stylesheet carries it. Measured in the render probe (agents-layout
// browser test) with the app's fonts and these classes: the tab control with
// icon, word and a three-figure count on every segment (W1) and with icon and word alone
// (W2), each plus the manager's 16 px on both sides. A kind added to the tabs
// moves both.
export const TAB_WIDTHS = { full: 422, words: 339 } as const;

/** Under W2: the tabs drop their words for icon and count, and the marks after a name stop at two. */
export const NARROW = { hidden: "@max-[339px]:hidden", shown: "@max-[339px]:inline-flex" } as const;

/** Between W2 and W1 the tabs keep their words and drop their counts, and the toolbar says the open tab's count. */
export const TABS = {
  narrowPad: "@max-[339px]:px-2.5",
  countHidden: "@min-[339px]:@max-[422px]:hidden",
  countShown: "@min-[339px]:@max-[422px]:inline",
  /** The toolbar's Add keeps its glyph alone while the count stands beside the search, so the search keeps its word. */
  addWordHidden: "@max-[422px]:hidden",
} as const;
