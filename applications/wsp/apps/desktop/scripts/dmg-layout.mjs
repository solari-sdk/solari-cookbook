// SPDX-License-Identifier: AGPL-3.0-only
// The drag window's geometry, in one place. scripts/dmg-background.mjs draws
// the image to it, electron-builder.yml places the two icons at the same
// numbers, and test/dmg.test.ts holds the yml and the drawn image to this
// file, so moving an icon, the arrow or the line cannot leave the picture behind.

/** The window the disk image opens at: dmg-builder reads it off the background image's size, so the image is drawn
 * at exactly this, and every coordinate below is in its pixels. */
export const DMG_WINDOW = { width: 660, height: 400 };

/** How wide each icon is drawn, which is what the two centres have to stay clear of. */
export const DMG_ICON_SIZE = 128;

/** Where each icon's centre sits: the app on the left, the Applications folder on the right, on one line. */
export const DMG_ICONS = { app: { x: 172, y: 186 }, applications: { x: 488, y: 186 } };

/** The drag arrow between the two: its shaft runs along the icons' centre line, starts one gap clear of the app's
 * frame and ends one gap short of the folder's, is hairline wide, and closes in an open chevron reaching this far each
 * way from it. */
const gap = 40;
export const DMG_ARROW = {
  gap,
  from: DMG_ICONS.app.x + DMG_ICON_SIZE / 2 + gap,
  to: DMG_ICONS.applications.x - DMG_ICON_SIZE / 2 - gap,
  y: DMG_ICONS.app.y,
  stroke: 1.5,
  head: 6,
};

/** Finder draws each icon's name under it, and this is how far under the icon's frame that name can reach. */
export const DMG_LABEL_ROOM = 40;

/** The tallest chrome Finder lays over the stored bounds: the title bar alone measured 32 on macOS 26, and a person
 * whose Finder shows the toolbar gets 52. Whatever the image draws in this band at the bottom is never seen. */
export const DMG_CHROME = 52;

/** The one line of text, its size and where its middle sits: under the names, above the chrome band. */
export const DMG_LINE = { y: 324, size: 11 };
