/**
 * sandbox-command — confirms sandbox commands are not shell-interpreted.
 * See design.md §6.5.
 *
 * Runs one canary twice. The wrong form passes a whole command line as the
 * binary name and is expected to fail; the right form puts argv in `args` and
 * is expected to succeed.
 *
 * Finding F20 established what "fail" means here: the wrong form **throws
 * `ActionError`** rather than returning a non-zero exit code. Both are handled,
 * because a future SDK could report it either way.
 *
 * Creates a real VM, so `kill()` runs on every path.
 */

import type { DoctorContext } from "../context.js";
import { mapSdkError, sanitizeErrorMessage } from "../runner/errors.js";
import type { CheckResult, DoctorCheck } from "../types.js";

/** A whole command line where a binary name belongs (README gotcha 3). */
const WRONG_FORM = "ls -la";
const RIGHT_FORM = "ls";
const RIGHT_ARGS = ["-la", "/tmp"] as const;

/** Short-lived: the check needs a VM for a few seconds, not minutes. */
const SANDBOX_TIMEOUT_MS = 60_000;

/** Lets `ci/cleanup.mjs` find resources a killed run left behind. */
const CREATED_BY = "solari-doctor";

const REMEDIATION =
  "Sandbox commands are not shell-interpreted. Pass the binary as the command " +
  'and its arguments in `args` — run("ls", { args: ["-la"] }) — or invoke a ' +
  'shell explicitly: run("sh", { args: ["-c", "ls -la | wc -l"] }). Pipes, ' +
  "globs and redirection all need the explicit shell form.";

/** Excerpt for evidence: sanitised, single-line and short. */
function excerpt(text: string): string {
  return sanitizeErrorMessage(text).split("\n")[0]?.slice(0, 120) ?? "";
}

export const sandboxCommandCheck: DoctorCheck = {
  id: "sandbox-command",
  description: "Confirms sandbox commands are not shell-interpreted",
  costTier: "cheap",
  dependsOn: ["auth"],

  async run(ctx: DoctorContext): Promise<CheckResult> {
    const client = ctx.sandbox();
    let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;

    try {
      sandbox = await client.sandboxes.create({
        template: "base",
        timeoutMs: SANDBOX_TIMEOUT_MS,
        // Tagged so a run cancelled before `finally` can be swept afterwards.
        metadata: { createdBy: CREATED_BY },
      });
      await sandbox.connect();

      const evidence: Record<string, unknown> = {
        wrongForm: WRONG_FORM,
        rightForm: `${RIGHT_FORM} ${RIGHT_ARGS.join(" ")}`,
      };

      // The wrong form. A throw and a non-zero exit both count as the
      // documented failure; only success contradicts the documentation.
      let wrongFormRejected: boolean;
      try {
        const wrong = await sandbox.commands.run(WRONG_FORM);
        wrongFormRejected = wrong.exitCode !== 0;
        evidence["wrongFormThrew"] = false;
        evidence["wrongFormExitCode"] = wrong.exitCode;
        evidence["wrongFormStderr"] = excerpt(wrong.stderr);
      } catch (error) {
        const mapped = mapSdkError(error, "core");
        wrongFormRejected = true;
        evidence["wrongFormThrew"] = true;
        evidence["wrongFormErrorClass"] = mapped.evidence.errorClass;
      }

      const right = await sandbox.commands.run(RIGHT_FORM, { args: [...RIGHT_ARGS] });
      evidence["rightFormExitCode"] = right.exitCode;
      evidence["rightFormStdoutBytes"] = right.stdout.length;

      if (!wrongFormRejected) {
        return {
          id: "sandbox-command",
          status: "fail",
          message: `"${WRONG_FORM}" succeeded as a raw command string`,
          durationMs: 0,
          details:
            "The documented behaviour is that a command line passed as the " +
            "binary name is not found. This environment accepted it.",
          remediation: REMEDIATION,
          issueRef: "solari-cookbook#README-gotcha-3",
          evidence,
        };
      }

      if (right.exitCode !== 0) {
        return {
          id: "sandbox-command",
          status: "fail",
          message: `the args-array form exited ${right.exitCode}`,
          durationMs: 0,
          details: excerpt(right.stderr),
          remediation: REMEDIATION,
          evidence,
        };
      }

      return {
        id: "sandbox-command",
        status: "pass",
        message: "commands are not shell-interpreted, as documented",
        durationMs: 0,
        evidence,
      };
    } catch (error) {
      const mapped = mapSdkError(error, "core");
      return {
        id: "sandbox-command",
        status: "fail",
        message: `the sandbox canary could not run: ${mapped.message}`,
        durationMs: 0,
        details: mapped.evidence.sanitizedMessage,
        remediation: mapped.remediation,
        evidence: { ...mapped.evidence },
      };
    } finally {
      // A VM keeps running until its idle timeout, so this runs whatever
      // happened above. `kill()` is idempotent (finding F14).
      try {
        await sandbox?.kill();
      } catch {
        // Nothing useful to report: the check's own result already stands, and
        // a failed cleanup must not replace it.
      }
    }
  },
};
