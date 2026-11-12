/**
 * The version reported in `--report` bundles.
 *
 * Declared here rather than read from `package.json` at runtime: the manifest
 * is not an exported subpath of this package once built, and resolving it from
 * `dist/` would depend on layout. A test asserts this constant matches
 * `package.json`, so the two cannot drift.
 */
export const DOCTOR_VERSION = "0.1.0";
