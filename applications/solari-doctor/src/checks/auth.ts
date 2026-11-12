/**
 * auth — detects the resulting authentication failure. See design.md §6.1.
 *
 * The wording matters and is locked by §6.1. This check cannot observe the
 * key-creation modal described in cookbook issue #1: that happened in a browser
 * before this tool ran. What it observes is a key that is missing, malformed or
 * rejected.
 *
 * Detection uses `sandboxes.list({ limit: 1 })` — the cheapest authenticated
 * call that creates no resource. Auth is matched on `status === 401`, never on
 * an error code: `code` is `undefined` for a 401 on both SDKs (finding F28).
 */

import type { DoctorContext } from "../context.js";
import { mapSdkError } from "../runner/errors.js";
import type { CheckResult, DoctorCheck } from "../types.js";

/** Documented in the cookbook README and every example `.env.example`. */
const KEY_PREFIX = "slr_live_";

/**
 * Anything an HTTP header value cannot carry: control characters and
 * non-ASCII.
 *
 * A key pasted across a line break is a realistic mistake — it is the failure
 * cookbook issue #1 describes. Without this the request fails inside `fetch`
 * with "the control connection is not open", which points at entirely the wrong
 * thing.
 */
const ILLEGAL_IN_HEADER = /[^\x09\x20-\x7E]/;

/**
 * Structural facts about the key, with no part of its value.
 *
 * Length and segment count are recorded because they help diagnose a truncated
 * paste. They are not used to fail the check: only one real key has ever been
 * observed (finding F21, n=1), and reporting a valid key as malformed is worse
 * than reporting nothing.
 */
function describeKey(apiKey: string): Record<string, unknown> {
  return {
    keyPresent: true,
    keyPrefixOk: apiKey.startsWith(KEY_PREFIX),
    keyLength: apiKey.length,
    keySegments: apiKey.split("_").length,
  };
}

export const authCheck: DoctorCheck = {
  id: "auth",
  description: "Detects the resulting authentication failure",
  costTier: "free",

  async run(ctx: DoctorContext): Promise<CheckResult> {
    const apiKey = ctx.apiKey?.trim();

    if (apiKey === undefined || apiKey === "") {
      return {
        id: "auth",
        status: "fail",
        message: "SOLARI_API_KEY is not set",
        durationMs: 0,
        remediation:
          "Set SOLARI_API_KEY to a key from console.getsolari.com. Note that " +
          "the key-creation modal closes immediately after the first key is " +
          "generated, so the secret is easy to miss; generating a second key " +
          "leaves the modal open.",
        issueRef: "solari-cookbook#1",
        evidence: { keyPresent: false },
      };
    }

    const keyEvidence = describeKey(apiKey);

    // Checked before the call: an invalid header value fails deep inside fetch
    // with an error that describes the transport rather than the key.
    if (ILLEGAL_IN_HEADER.test(apiKey)) {
      return {
        id: "auth",
        status: "fail",
        message: "SOLARI_API_KEY contains a character that cannot be sent in a header",
        durationMs: 0,
        details:
          "Control characters and non-ASCII are not valid in an HTTP header " +
          "value, so the key was never sent.",
        remediation:
          "The key has probably picked up a line break or stray character on " +
          "the way in — check for a newline if it was pasted from a terminal, " +
          "or re-copy it from console.getsolari.com.",
        issueRef: "solari-cookbook#1",
        evidence: { ...keyEvidence, keyHeaderSafe: false },
      };
    }

    try {
      await ctx.sandbox().sandboxes.list({ limit: 1 });
    } catch (error) {
      const mapped = mapSdkError(error, "core");
      const unauthorized = mapped.evidence.status === 401;

      return {
        id: "auth",
        status: "fail",
        message: unauthorized ? "the API key was rejected (HTTP 401)" : mapped.message,
        durationMs: 0,
        // A malformed-looking key is only mentioned once authentication has
        // actually failed, so a valid key of an unfamiliar shape is never
        // reported as the problem.
        remediation:
          unauthorized && keyEvidence["keyPrefixOk"] === false
            ? `${mapped.remediation} The key also does not begin with "${KEY_PREFIX}", ` +
              "which suggests it was truncated or copied incompletely."
            : mapped.remediation,
        ...(unauthorized ? { issueRef: "solari-cookbook#1" } : {}),
        evidence: { ...keyEvidence, ...mapped.evidence },
      };
    }

    return {
      id: "auth",
      status: "pass",
      message: "the API key authenticated successfully",
      durationMs: 0,
      evidence: keyEvidence,
    };
  },
};
