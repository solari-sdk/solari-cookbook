/**
 * sdk-version — reads the installed `@solarisdk/browser` version. See
 * design.md §6.2.
 *
 * Two constraints shape the implementation, both from `docs/findings.md`:
 *
 *   F35  `@solarisdk/browser/package.json` is not an exported subpath, so
 *        `require`/`import` of it throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The
 *        manifest is read from the filesystem instead.
 *   §19.2  solari-doctor depends on the same package, so module resolution
 *        would report the doctor's version rather than the user's. The read is
 *        anchored at `ctx.projectRoot`.
 *
 * No network call. `warn` below 0.1.3 reports exposure to a documented bug, not
 * an observed hang — observing that is `browser-lifecycle`'s job.
 */

import type { DoctorContext } from "../context.js";
import { readSdkInstall, SDK_PACKAGE } from "./sdk-install.js";
import type { CheckResult, DoctorCheck } from "../types.js";

/** Below this, `browser.close()` alone can leave the process hung (F27). */
const FIXED_IN = "0.1.3";

/**
 * Compares two dotted version strings.
 *
 * Numeric segments only, with a prerelease suffix ordering before its release
 * so `0.1.3-beta` is treated as still exposed. Returns a negative number when
 * `a` precedes `b`, or `NaN` when either cannot be parsed.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): { parts: number[]; prerelease: boolean } | undefined => {
    const [core = "", ...rest] = version.trim().split("-");
    const parts = core.split(".").map((segment) => Number.parseInt(segment, 10));
    if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return undefined;
    return { parts, prerelease: rest.length > 0 };
  };

  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return Number.NaN;

  const width = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < width; i++) {
    const difference = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease ? -1 : 1;
}

export const sdkVersionCheck: DoctorCheck = {
  id: "sdk-version",
  description: "Compares the installed @solarisdk/browser against 0.1.3",
  costTier: "free",

  run(ctx: DoctorContext): Promise<CheckResult> {
    const { version, problem } = readSdkInstall(ctx.projectRoot);

    // Nothing to assess. `warn` rather than `pass`, because "we could not tell"
    // must not read as "you are safe".
    if (version === undefined) {
      return Promise.resolve({
        id: "sdk-version",
        status: "warn",
        message: problem ?? `${SDK_PACKAGE}'s version could not be determined`,
        durationMs: 0,
        remediation:
          `Install ${SDK_PACKAGE} in this project, or run solari-doctor from the ` +
          "project whose environment you want checked.",
        evidence: { projectRoot: ctx.projectRoot, resolved: false },
      });
    }

    const order = compareVersions(version, FIXED_IN);

    if (Number.isNaN(order)) {
      return Promise.resolve({
        id: "sdk-version",
        status: "warn",
        message: `${SDK_PACKAGE} reports an unrecognised version "${version}"`,
        durationMs: 0,
        remediation:
          `The installed version could not be compared against ${FIXED_IN}. ` +
          "Check the package was installed from the registry and not replaced " +
          "by a link or a local build.",
        evidence: { sdkVersion: version, resolved: true, comparable: false },
      });
    }

    if (order < 0) {
      return Promise.resolve({
        id: "sdk-version",
        status: "warn",
        message: `${SDK_PACKAGE} ${version} is older than ${FIXED_IN}`,
        durationMs: 0,
        remediation:
          `Upgrade to ${SDK_PACKAGE} ${FIXED_IN} or later, where the connection-retry ` +
          "listener is unref'd and browser.close() alone is enough to exit. " +
          "Until then, call await solari.close() in a finally block.",
        issueRef: "solari-cookbook#README-gotcha-1",
        evidence: { sdkVersion: version, fixedIn: FIXED_IN, resolved: true, exposed: true },
      });
    }

    return Promise.resolve({
      id: "sdk-version",
      status: "pass",
      message: `${SDK_PACKAGE} ${version} is at or above ${FIXED_IN}`,
      durationMs: 0,
      evidence: { sdkVersion: version, fixedIn: FIXED_IN, resolved: true, exposed: false },
    });
  },
};
