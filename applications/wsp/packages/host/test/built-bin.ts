// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, type SuiteFactory } from "vitest";

/** The cli as pnpm build leaves it; only the build makes it, so a test that spawns it cannot make it. */
export const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
/** A built package's library entry, for a test whose host has to be a real process of its own. */
export const distOf = (pkg: string): string => new URL(`../../${pkg}/dist/index.js`, import.meta.url).href;

export const DIST = distOf("host");

/** A suite that spawns the built cli: never a silent pass when the build is absent. */
export function describeWithBin(name: string, suite: SuiteFactory): void {
  if (existsSync(BIN)) describe(name, suite);
  else describe(name, () => it.skip(`${BIN} is missing: run pnpm build first`, () => {}));
}

/** A suite whose own child imports built packages: it skips on the ones that are missing rather than dying on a
 * module it cannot resolve, so a tree with only some packages built says which build is absent. */
export function describeWithDists(name: string, pkgs: readonly string[], suite: SuiteFactory): void {
  const missing = pkgs.filter(pkg => !existsSync(fileURLToPath(distOf(pkg))));
  if (missing.length === 0) describe(name, suite);
  else describe(name, () => it.skip(`${missing.join(", ")} not built: run pnpm build first`, () => {}));
}
