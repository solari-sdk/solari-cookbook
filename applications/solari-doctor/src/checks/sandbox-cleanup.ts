/**
 * sandbox-cleanup — shows that `close()` does not stop a VM. See design.md §6.6.
 *
 * Creates a sandbox, calls `close()`, and queries the gateway to show the VM is
 * still running; then calls `kill()` and confirms termination.
 *
 * Two API details from `docs/findings.md` shape this:
 *   F14  `close()` is synchronous and returns `void`. It is not awaited.
 *   F29  termination is confirmed by a **404** from `sandboxes.get()`, not by a
 *        state transition — the record is gone.
 *
 * The claim is limited to what the API proves. `sandboxes.get()` reports a
 * state; it exposes no billing field (F19), so the wording locked in §6.6 —
 * "may result in continued resource consumption/billing" — is the strongest
 * statement this check is entitled to make.
 */

import type { DoctorContext } from "../context.js";
import { mapSdkError } from "../runner/errors.js";
import type { CheckResult, DoctorCheck } from "../types.js";

const SANDBOX_TIMEOUT_MS = 60_000;

/** Lets `ci/cleanup.mjs` find resources a killed run left behind. */
const CREATED_BY = "solari-doctor";

/** Locked by design.md §6.6. Not to be strengthened without new evidence. */
const CONSUMPTION_CAVEAT =
  "this may result in continued resource consumption/billing until the VM's " +
  "idle timeout or an explicit kill()";

const REMEDIATION =
  `Call kill() to destroy the VM. close() drops only the local control channel; ` +
  `${CONSUMPTION_CAVEAT}.`;

/** A `GatewayError` with status 404, however the SDK spells it. */
function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

export const sandboxCleanupCheck: DoctorCheck = {
  id: "sandbox-cleanup",
  description: "Shows that close() leaves a sandbox running and kill() ends it",
  costTier: "cheap",
  dependsOn: ["auth"],

  async run(ctx: DoctorContext): Promise<CheckResult> {
    const client = ctx.sandbox();
    let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;
    let killed = false;

    try {
      sandbox = await client.sandboxes.create({
        template: "base",
        timeoutMs: SANDBOX_TIMEOUT_MS,
        // Tagged so a run cancelled before `finally` can be swept afterwards.
        metadata: { createdBy: CREATED_BY },
      });
      await sandbox.connect();
      const sandboxId = sandbox.sandboxId;

      // Synchronous, and deliberately not awaited (F14).
      sandbox.close();

      const afterClose = await client.sandboxes.get(sandboxId);
      const stateAfterClose = (afterClose as { state?: unknown }).state;

      await sandbox.kill();
      killed = true;

      let terminated = false;
      let stateAfterKill: unknown;
      try {
        const afterKill = await client.sandboxes.get(sandboxId);
        stateAfterKill = (afterKill as { state?: unknown }).state;
        terminated = stateAfterKill !== "running";
      } catch (error) {
        // F29: the record is removed, so the re-query 404s. That is the success
        // path, not an error.
        terminated = isNotFound(error);
        if (!terminated) throw error;
        stateAfterKill = "404";
      }

      const evidence: Record<string, unknown> = {
        stateAfterClose: typeof stateAfterClose === "string" ? stateAfterClose : null,
        stateAfterKill: typeof stateAfterKill === "string" ? stateAfterKill : null,
        stillRunningAfterClose: stateAfterClose === "running",
        terminatedAfterKill: terminated,
      };

      if (stateAfterClose !== "running") {
        // Not a failure of the user's environment: the documented behaviour did
        // not reproduce, which is worth reporting but is not their problem.
        return {
          id: "sandbox-cleanup",
          status: "warn",
          message: `after close() the sandbox reported "${String(stateAfterClose)}", not "running"`,
          durationMs: 0,
          details:
            "The documented behaviour is that close() drops only the local " +
            "control channel. This environment did not reproduce that.",
          issueRef: "solari-cookbook#README-gotcha-4",
          evidence,
        };
      }

      if (!terminated) {
        return {
          id: "sandbox-cleanup",
          status: "fail",
          message: "the sandbox was still present after kill()",
          durationMs: 0,
          remediation:
            "kill() returned but the gateway still reports the sandbox. It may " +
            `still be consuming resources; ${CONSUMPTION_CAVEAT}.`,
          issueRef: "solari-cookbook#README-gotcha-4",
          evidence,
        };
      }

      return {
        id: "sandbox-cleanup",
        status: "pass",
        // Short enough for one terminal line; the caveat is in the remediation.
        message: "close() left the sandbox running until kill() ended it",
        durationMs: 0,
        remediation: REMEDIATION,
        issueRef: "solari-cookbook#README-gotcha-4",
        evidence,
      };
    } catch (error) {
      const mapped = mapSdkError(error, "core");
      return {
        id: "sandbox-cleanup",
        status: "fail",
        message: `the cleanup probe could not run: ${mapped.message}`,
        durationMs: 0,
        details: mapped.evidence.sanitizedMessage,
        remediation: mapped.remediation,
        evidence: { ...mapped.evidence },
      };
    } finally {
      // `kill()` is idempotent (F14), so calling it again after the success
      // path is harmless and covers every path that did not reach it.
      if (!killed) {
        try {
          await sandbox?.kill();
        } catch {
          // The check's own result stands; a failed cleanup must not replace it.
        }
      }
    }
  },
};
