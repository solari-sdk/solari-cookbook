// SPDX-License-Identifier: AGPL-3.0-only
// Every name a download carries and every URL that reaches one, in one place:
// the release notes, the release job and the site all read them from here, so
// a rename touches this file alone. Nothing here imports node, because the
// site bundles it for a browser.

export const REPO = "https://github.com/Zingzy/wsp";

/** What a release tag looks like, v1.2.3 carrying 1.2.3: the one rule for what the release workflow answers to
 * and for what the host takes as the newest release. */
export const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Where every release and its downloads are listed, which is where anything that has no one asset to point at
 * sends a person: the site's footer, and the app's line about a shell older than the host serving it. */
export const RELEASES = `${REPO}/releases`;

/** What each download on the release page is called for one version, which is the name the notes print. */
export function bundleNames(version) {
  return { mac: `wsp-${version}-mac.dmg`, appImage: `wsp-${version}.AppImage` };
}

/** The copies the release job uploads beside the versioned ones, under names no version moves. GitHub serves the
 * newest release's copy of each at releases/latest/download, which is the only download link the site can hold. */
export const STABLE_NAMES = { mac: "wsp-mac.dmg", appImage: "wsp-linux.AppImage" };

/** Where GitHub serves that asset of whichever release is newest. */
export function downloadUrl(asset) {
  return `${REPO}/releases/latest/download/${asset}`;
}

/** The four names one release's job works with, as the assignments it writes into its own environment. */
export function bundleEnv(version) {
  const versioned = bundleNames(version);
  const lines = [
    ["MAC_DMG", versioned.mac],
    ["MAC_STABLE", STABLE_NAMES.mac],
    ["APPIMAGE", versioned.appImage],
    ["APPIMAGE_STABLE", STABLE_NAMES.appImage],
  ];
  return `${lines.map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}
