// SPDX-License-Identifier: AGPL-3.0-only
/** The width the right panel's code view has in the app's default 1280 by 800 window. The harness lays its panel
 * out at it and the test asserts it, so the two can never drift; its own module because the harness page mounts
 * React at import and a test that read the number from there would mount it too. */
export const PANEL_WIDTH = 539;
