// SPDX-License-Identifier: AGPL-3.0-only
/** Semver order: 0.1.10 is above 0.1.9, and a release is above its own prereleases. Negative when the first is the
 * older, positive when the second is, 0 when the two name one release. */
export function compareVersions(a: string, b: string): number;
