// SPDX-License-Identifier: AGPL-3.0-only
/** Where the lockup's optical centre sits in its box, top down: the wordmark's x-height band runs from y 1 to y 9 of
 * the 14-unit viewBox (the p's descender hangs below it), so the eye reads the line at y 5, two units above the box's
 * middle. A caller that centres the lockup on a line shifts the box down by that much. */
export const LOCKUP_OPTICAL_CENTRE = 5 / 14;
