// SPDX-License-Identifier: AGPL-3.0-only
// What bundles.mjs hands a TypeScript reader. The module itself stays plain
// JavaScript because the release job runs it with no build behind it; this is
// how the site and the app read it without opening their compilers to JS.
/** What each download on the release page is called for one version, which is the name the notes print. */
export function bundleNames(version: string): { mac: string; appImage: string };
/** The copies the release job uploads beside the versioned ones, under names no version moves. */
export const STABLE_NAMES: { mac: string; appImage: string };
/** Where GitHub serves that asset of whichever release is newest. */
export function downloadUrl(asset: string): string;
/** The four names one release's job works with, as the assignments it writes into its own environment. */
export function bundleEnv(version: string): string;
export const REPO: string;
/** What a release tag looks like, v1.2.3 carrying 1.2.3. */
export const RELEASE_TAG: RegExp;
/** Where every release and its downloads are listed. */
export const RELEASES: string;
