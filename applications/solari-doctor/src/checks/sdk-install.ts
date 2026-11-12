/**
 * Locates the SDK installed in the user's project.
 *
 * Shared by `sdk-version` (which wants the version) and `browser-lifecycle`
 * (which wants the module entry point). Both must read the *user's* install
 * rather than solari-doctor's own copy of the same package (§19.2), and neither
 * can use module resolution to do it: `@solarisdk/browser/package.json` is not
 * an exported subpath, and the package has no `require` condition at all
 * (findings F35, F36).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SDK_PACKAGE = "@solarisdk/browser";

export interface SdkInstall {
  /** Absolute path to the installed package directory. */
  packageDir: string;
  version?: string;
  /** Absolute `file:` URL of the module entry, for `import()` in a child. */
  entryUrl?: string;
  /** Set when the install could not be read. The other fields are then absent. */
  problem?: string;
}

/** Absolute path to the installed manifest, anchored at `projectRoot`. */
export function sdkManifestPath(projectRoot: string): string {
  return join(projectRoot, "node_modules", "@solarisdk", "browser", "package.json");
}

/**
 * Reads the installed manifest.
 *
 * Reports why it failed rather than throwing: a missing or malformed install is
 * a diagnosable user environment, not a programmer error.
 */
export function readSdkInstall(projectRoot: string): SdkInstall {
  const packageDir = join(projectRoot, "node_modules", "@solarisdk", "browser");

  let raw: string;
  try {
    raw = readFileSync(sdkManifestPath(projectRoot), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      packageDir,
      problem:
        code === "ENOENT"
          ? `${SDK_PACKAGE} is not installed under ${projectRoot}`
          : `${SDK_PACKAGE}'s manifest could not be read (${String(code)})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { packageDir, problem: `${SDK_PACKAGE}'s manifest is not valid JSON` };
  }

  // `JSON.parse` accepts `null`, `"a string"` and `[]` as valid documents, so a
  // manifest that parses is not yet a manifest that has fields.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { packageDir, problem: `${SDK_PACKAGE}'s manifest is not an object` };
  }

  const manifest = parsed as { version?: unknown; main?: unknown; exports?: unknown };

  const version =
    typeof manifest.version === "string" && manifest.version !== ""
      ? manifest.version
      : undefined;

  const entry = resolveEntry(manifest);
  const entryUrl =
    entry === undefined ? undefined : pathToFileURL(join(packageDir, entry)).href;

  return {
    packageDir,
    ...(version !== undefined ? { version } : {}),
    ...(entryUrl !== undefined ? { entryUrl } : {}),
    ...(version === undefined ? { problem: `${SDK_PACKAGE}'s manifest declares no version` } : {}),
  };
}

/**
 * Picks the module entry from a manifest.
 *
 * Prefers the `import` condition of the `"."` export, which is what the
 * installed 0.1.3 declares, and falls back to `main`.
 */
function resolveEntry(manifest: { main?: unknown; exports?: unknown }): string | undefined {
  const dot = (manifest.exports as { "."?: unknown } | undefined)?.["."];
  const conditions = dot as { import?: unknown; default?: unknown } | undefined;

  for (const candidate of [conditions?.import, conditions?.default, dot, manifest.main]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return undefined;
}
