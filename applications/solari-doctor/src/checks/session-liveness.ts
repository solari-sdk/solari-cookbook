/**
 * session-liveness — confirms liveness is derived from the connection.
 * See design.md §6.7.
 *
 * **Not a reproduction of cookbook issue #25.** That would require waiting out
 * the real session lifetime on every run, which fails design principle 2. The
 * ten-minute finding stays documented and is surfaced by
 * `solari-doctor --explain session-liveness`, never re-verified at runtime.
 *
 * What this does verify is that the tool reads liveness from the connection
 * rather than the `status` field: a session is ended server-side, and
 * `isConnected()` must flip to false. The `disconnected` event and a throwing
 * page call corroborate it.
 *
 * `TargetClosedError` is deliberately not imported. It is a `patchright-core`
 * class, not a Solari export, and the thrown constructor is bundler-renamed —
 * it arrived as `TargetClosedError2` live (finding F30). Matching on
 * `isConnected()` avoids the question entirely.
 */

import type { DoctorContext } from "../context.js";
import { mapSdkError, sanitizeErrorMessage } from "../runner/errors.js";
import type { CheckResult, DoctorCheck } from "../types.js";

/** Interval between `isConnected()` polls after the session is released. */
const POLL_INTERVAL_MS = 250;

/** Ceiling for the flip. Observed live at under 3s (finding F31). */
const DISCONNECT_CEILING_MS = 5_000;

interface RawEmitter {
  on(event: string, listener: () => void): unknown;
}

export const sessionLivenessCheck: DoctorCheck = {
  id: "session-liveness",
  description: "Confirms liveness is read from the connection, not the status field",
  costTier: "cheap",
  dependsOn: ["auth"],

  async run(ctx: DoctorContext): Promise<CheckResult> {
    const solari = ctx.browser();
    let browser: Awaited<ReturnType<typeof solari.launch>> | undefined;
    let released = false;

    try {
      browser = await solari.launch();
      const sessionId = browser.id;

      const connectedWhileAlive = browser.isConnected();

      let disconnectedEventFired = false;
      try {
        (browser.raw as unknown as RawEmitter).on("disconnected", () => {
          disconnectedEventFired = true;
        });
      } catch {
        // Corroborating signal only; its absence does not invalidate the check.
      }

      // Ended server-side rather than by a local close: that is what a session
      // dying under a running program actually looks like.
      await solari.sessions.releaseAndWait(sessionId);
      released = true;

      let connectedAfterRelease = true;
      let waited = 0;
      while (waited < DISCONNECT_CEILING_MS) {
        connectedAfterRelease = browser.isConnected();
        if (!connectedAfterRelease) break;
        await ctx.clock.sleep(POLL_INTERVAL_MS);
        waited += POLL_INTERVAL_MS;
      }

      let pageCallThrew = false;
      let thrownClass: string | undefined;
      try {
        await browser.newPage();
      } catch (error) {
        pageCallThrew = true;
        thrownClass = error instanceof Error ? error.constructor.name : typeof error;
      }

      const evidence: Record<string, unknown> = {
        connectedWhileAlive,
        connectedAfterRelease,
        disconnectedEventFired,
        pageCallThrew,
        waitedMs: waited,
        // Recorded, never matched on: the name is bundler-dependent (F30).
        ...(thrownClass !== undefined ? { thrownClass } : {}),
      };

      if (connectedAfterRelease) {
        return {
          id: "session-liveness",
          status: "fail",
          message: `isConnected() still reported true ${waited}ms after the session was released`,
          durationMs: 0,
          details:
            "Liveness cannot be derived from the connection in this environment, " +
            "which is the signal solari-doctor and the SDK examples both rely on.",
          remediation:
            "Do not treat this session as usable. Note that GET /sessions/:id is " +
            "not an alternative — it reports a dead session as active (cookbook " +
            "issue #25); run `solari-doctor --explain session-liveness` for that " +
            "finding.",
          issueRef: "solari-cookbook#25",
          evidence,
        };
      }

      return {
        id: "session-liveness",
        status: "pass",
        message: "isConnected() reported false once the session ended",
        durationMs: 0,
        remediation:
          "Derive liveness from the connection, not from the status field: " +
          "GET /sessions/:id reports a dead session as active (cookbook issue " +
          "#25). Run `solari-doctor --explain session-liveness` for the detail.",
        issueRef: "solari-cookbook#25",
        evidence,
      };
    } catch (error) {
      const mapped = mapSdkError(error, "browser");
      return {
        id: "session-liveness",
        status: "fail",
        message: `the liveness probe could not run: ${mapped.message}`,
        durationMs: 0,
        details: sanitizeErrorMessage(mapped.evidence.sanitizedMessage),
        remediation: mapped.remediation,
        evidence: { ...mapped.evidence },
      };
    } finally {
      // A session holds a plan slot until its deadline, so it is released on
      // every path. `close()` is idempotent and also releases (finding F14).
      try {
        if (!released) await browser?.close();
      } catch {
        // The check's own result stands; a failed cleanup must not replace it.
      }
      // The client is shared and memoised; the CLI disposes of it once every
      // check has finished (finding F43).
    }
  },
};
