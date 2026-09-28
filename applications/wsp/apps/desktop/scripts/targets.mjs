// SPDX-License-Identifier: AGPL-3.0-only
// The platform-arch pairs a packaged tree runs, in node's own words, which
// electron-builder's electronPlatformName and Arch enum spell the same way, so
// a target and a machine are comparable without a translation table.

export function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

/** The two targets one mac bundle runs: it is universal, and the process starts on whichever slice the chip is. */
export const MAC_TARGETS = ["darwin-arm64", "darwin-x64"];
