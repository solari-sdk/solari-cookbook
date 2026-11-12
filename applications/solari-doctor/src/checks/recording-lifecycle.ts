/**
 * recording-lifecycle — confirms recording is per-session. See design.md §6.4.
 *
 * `--full` only. It costs a browser session plus a real wait, and including it
 * by default would roughly triple the runtime of every run.
 *
 * The poll window is genuinely unsettled, and the output says so. Three figures
 * are in play and none agree:
 *
 *   ~1-3s   the SDK's own doc comment on `getReplayUrl`
 *   ~30s    the cookbook README
 *   8.2s    one measured run
 *   >60s    another measured run, which never produced a replay at all
 *
 * That is verification item A6, still open. The ceiling here is therefore our
 * engineering margin rather than a documented figure, and a failure must be
 * reported as "no replay within our window" rather than as a violated SLA.
 */

import type { DoctorContext } from "../context.js";
import { mapSdkError, sanitizeErrorMessage } from "../runner/errors.js";
import type { CheckResult, DoctorCheck } from "../types.js";

/** The only figure documented by Solari (cookbook README gotcha 2). */
const DOCUMENTED_WINDOW_MS = 30_000;

const POLL_INTERVAL_MS = 2_000;

/** Wording reused by both the pass and fail paths so they cannot drift. */
const VARIANCE_NOTE =
  "Solari documents ~30s; independent runs during this project's verification " +
  "disagreed (one replay at 8.2s, another absent after 60s), so any wider " +
  "window is our margin rather than a documented figure";

export const recordingLifecycleCheck: DoctorCheck = {
  id: "recording-lifecycle",
  description: "Confirms recording is per-session and a replay eventually appears",
  costTier: "expensive",
  dependsOn: ["auth"],

  async run(ctx: DoctorContext): Promise<CheckResult> {
    const solari = ctx.browser();
    const ceilingMs = ctx.deadlines.replayPollMs;
    let browser: Awaited<ReturnType<typeof solari.launch>> | undefined;
    let released = false;

    try {
      browser = await solari.launch({ recording: true });
      const sessionId = browser.id;

      const page = await browser.newPage();
      await page.goto("https://example.com");

      const releasedAt = ctx.clock.now();
      await solari.sessions.releaseAndWait(sessionId);
      released = true;

      let waitedMs = 0;
      let polls = 0;
      let replay: { expiresInSeconds?: number; contentEncoding?: string } | undefined;
      let lastError: unknown;

      while (waitedMs <= ceilingMs) {
        polls += 1;
        try {
          replay = await solari.sessions.getReplayUrl(sessionId);
          break;
        } catch (error) {
          // A 404 while the upload is still in flight is the documented state,
          // not a failure.
          lastError = error;
        }
        await ctx.clock.sleep(POLL_INTERVAL_MS);
        waitedMs = ctx.clock.now() - releasedAt;
      }

      const evidence: Record<string, unknown> = {
        recordingRequested: true,
        polls,
        waitedMs,
        documentedWindowMs: DOCUMENTED_WINDOW_MS,
        ourCeilingMs: ceilingMs,
        replayAvailable: replay !== undefined,
      };

      if (replay === undefined) {
        const mapped = mapSdkError(lastError, "browser");
        return {
          id: "recording-lifecycle",
          status: "fail",
          message: `no replay URL within ${Math.round(ceilingMs / 1000)}s of releasing the session`,
          durationMs: 0,
          details: sanitizeErrorMessage(mapped.evidence.sanitizedMessage),
          // Not phrased as a breached guarantee: the window itself is disputed.
          remediation:
            `The replay had not appeared when polling stopped. ${VARIANCE_NOTE}. ` +
            "A longer wait may still produce it, so treat this as inconclusive " +
            "rather than as a missing recording. Confirm recording: true was " +
            "passed at session creation — it is per-session, not per-account, " +
            "and without it the replay endpoint 404s permanently.",
          issueRef: "solari-cookbook#README-gotcha-2",
          evidence: { ...evidence, ...mapped.evidence },
        };
      }

      return {
        id: "recording-lifecycle",
        status: "pass",
        message: `a replay was available ${Math.round(waitedMs / 1000)}s after release`,
        durationMs: 0,
        remediation:
          "Recording is per-session: pass recording: true at creation, or the " +
          `replay endpoint 404s permanently. ${VARIANCE_NOTE}.`,
        issueRef: "solari-cookbook#README-gotcha-2",
        evidence: {
          ...evidence,
          ...(typeof replay.expiresInSeconds === "number"
            ? { expiresInSeconds: replay.expiresInSeconds }
            : {}),
          ...(typeof replay.contentEncoding === "string"
            ? { contentEncoding: replay.contentEncoding }
            : {}),
        },
      };
    } catch (error) {
      const mapped = mapSdkError(error, "browser");
      return {
        id: "recording-lifecycle",
        status: "fail",
        message: `the recording probe could not run: ${mapped.message}`,
        durationMs: 0,
        details: sanitizeErrorMessage(mapped.evidence.sanitizedMessage),
        remediation: mapped.remediation,
        evidence: { ...mapped.evidence },
      };
    } finally {
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
