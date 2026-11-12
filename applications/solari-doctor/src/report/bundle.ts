/**
 * `--report` bundle. See design.md §9.
 *
 * Carries doctor version, SDK and runtime versions, region, check statuses,
 * error class names and timings. It must never carry the API key, cookies, page
 * content, profile data or screenshots.
 *
 * A report is meant to be shared, so everything written here passes through
 * `sanitizeValue` first. That is a whitelist of primitive shapes rather than a
 * blacklist of known-bad keys: a check added later cannot leak a field this
 * module has never heard of.
 */

import { SCHEMA_VERSION } from "./json.js";
import { DOCTOR_VERSION } from "../version.js";
import type { CheckResult, Diagnosis } from "../types.js";

/** Redacted in place wherever a string carries one (design.md §9). */
const API_KEY_PATTERN = /slr_(?:live|test)_[A-Za-z0-9_-]+/g;

/**
 * Evidence keys that are dropped regardless of value.
 *
 * Belt-and-braces alongside the pattern above: a key named `apiKey` holding a
 * value that does not match the pattern is still a credential.
 */
const FORBIDDEN_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "cookies",
  "password",
  "secret",
  "storagestate",
  "screenshot",
  "token",
]);

const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 4;

export interface ReportEnvironment {
  doctorVersion: string;
  node: string;
  platform: string;
  region?: string;
  baseUrl?: string;
}

export interface ReportBundle {
  schemaVersion: number;
  environment: ReportEnvironment;
  checks: readonly CheckResult[];
  diagnoses: readonly Diagnosis[];
}

export interface BundleInput {
  results: readonly CheckResult[];
  diagnoses: readonly Diagnosis[];
  region?: string | undefined;
  baseUrl?: string | undefined;
  nodeVersion?: string;
  platform?: string;
}

/**
 * Reduces a value to report-safe primitives.
 *
 * Strings are redacted and truncated; numbers and booleans pass through; arrays
 * and plain objects recurse to `MAX_DEPTH`. Anything else — a class instance, a
 * function, a Buffer — is replaced by its type name, so an unexpected value can
 * describe itself without disclosing its contents.
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;

  if (typeof value === "string") {
    return value.replace(API_KEY_PATTERN, "slr_***redacted***").slice(0, MAX_STRING_LENGTH);
  }

  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, depth + 1));
  }

  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        Object.defineProperty(output, key, {
          value: "[redacted]",
          enumerable: true,
          writable: true,
          configurable: true,
        });
        continue;
      }
      // `defineProperty`, not assignment: `output["__proto__"] = x` sets the
      // object's prototype instead of creating a key, so a hostile evidence
      // key would silently reshape the sanitised object.
      Object.defineProperty(output, key, {
        value: sanitizeValue(entry, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  }

  return `[${typeof value}]`;
}

/** Applies `sanitizeValue` to the free-text and evidence fields of a result. */
function sanitizeResult(result: CheckResult): CheckResult {
  return {
    id: result.id,
    status: result.status,
    message: sanitizeValue(result.message) as string,
    durationMs: result.durationMs,
    ...(result.details !== undefined
      ? { details: sanitizeValue(result.details) as string }
      : {}),
    ...(result.remediation !== undefined
      ? { remediation: sanitizeValue(result.remediation) as string }
      : {}),
    ...(result.issueRef !== undefined ? { issueRef: result.issueRef } : {}),
    ...(result.evidence !== undefined
      ? { evidence: sanitizeValue(result.evidence) as Record<string, unknown> }
      : {}),
  };
}

export function buildReportBundle(input: BundleInput): ReportBundle {
  return {
    schemaVersion: SCHEMA_VERSION,
    environment: {
      doctorVersion: DOCTOR_VERSION,
      node: input.nodeVersion ?? process.version,
      platform: input.platform ?? process.platform,
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    },
    checks: input.results.map(sanitizeResult),
    diagnoses: input.diagnoses,
  };
}

export function renderReportBundle(input: BundleInput): string {
  return `${JSON.stringify(buildReportBundle(input), null, 2)}\n`;
}
