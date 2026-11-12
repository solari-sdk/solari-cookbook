/**
 * browser-lifecycle — observes whether a process that opened a session exits.
 * See design.md §6.3.
 *
 * Runs the work in a child process and watches from the parent. A process
 * cannot reliably report whether it would itself have hung, so an in-process
 * implementation of this check would be meaningless.
 *
 * Two deadlines, both bounded, so the parent always terminates:
 *   - `launchBudgetMs` to reach the moment the browser is closed
 *   - `deadlines.childExitMs` for the child to exit *after* that moment
 *
 * The exit deadline runs from the close, not from spawn. A live launch was
 * measured at ~3.1s, so a deadline running from spawn would report a healthy
 * slow network as a hang.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { DoctorContext } from "../context.js";
import { mapSdkError, sanitizeErrorMessage } from "../runner/errors.js";
import type { CheckResult, DoctorCheck } from "../types.js";

/** Generous: the observed live launch was ~3.1s, and CI is slower. */
const DEFAULT_LAUNCH_BUDGET_MS = 30_000;

/** Grace period between SIGTERM and SIGKILL when cleaning up a stuck child. */
const KILL_GRACE_MS = 2_000;

/** Minimal surface of a spawned child, so tests can supply a fake. */
export interface ChildLike {
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
) => ChildLike;

export interface BrowserLifecycleOptions {
  /** Defaults to the running node binary. */
  nodePath?: string;
  /** Defaults to the harness beside this module in `dist/`. */
  harnessPath?: string;
  spawn?: SpawnFn;
  launchBudgetMs?: number;
  killGraceMs?: number;
}

type Outcome =
  | { kind: "exited"; code: number | null; closed: boolean }
  | { kind: "hung-after-close" }
  | { kind: "timeout-before-close" }
  | { kind: "spawn-failed"; error: unknown };

interface RunReport {
  outcome: Outcome;
  phases: string[];
  sdkVersion: string | null;
  childError: { name: string; message: string } | undefined;
  stderr: string;
}

/** Consumes newline-delimited JSON from the child, ignoring anything else. */
function parsePhases(stdout: string): {
  phases: string[];
  sdkVersion: string | null;
  childError: { name: string; message: string } | undefined;
} {
  const phases: string[] = [];
  let sdkVersion: string | null = null;
  let childError: { name: string; message: string } | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;

    const record = parsed as { phase?: unknown; sdkVersion?: unknown; name?: unknown; message?: unknown };
    if (typeof record.phase !== "string") continue;
    phases.push(record.phase);

    if (record.phase === "loaded" && typeof record.sdkVersion === "string") {
      sdkVersion = record.sdkVersion;
    }
    if (record.phase === "error") {
      childError = {
        name: typeof record.name === "string" ? record.name : "Error",
        message: typeof record.message === "string" ? record.message : "",
      };
    }
  }

  return { phases, sdkVersion, childError };
}

/**
 * Spawns the harness and resolves once its fate is known.
 *
 * Never rejects, and always settles within
 * `launchBudgetMs + childExitMs + killGraceMs`. A stuck child is sent SIGTERM
 * and then SIGKILL rather than left behind.
 */
function runHarness(
  ctx: DoctorContext,
  options: Required<Pick<BrowserLifecycleOptions, "nodePath" | "harnessPath" | "spawn" | "launchBudgetMs" | "killGraceMs">>,
): Promise<RunReport> {
  return new Promise<RunReport>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildLike | undefined;

    // Grouped so the cleanup paths can see all of them at once.
    const timers: {
      launch?: NodeJS.Timeout;
      exit?: NodeJS.Timeout;
      kill?: NodeJS.Timeout;
    } = {};

    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.launch);
      clearTimeout(timers.exit);
      // `timers.kill` is deliberately left running: it is the SIGKILL fallback
      // for a child that ignored SIGTERM, and cancelling it here would leak
      // exactly the process this check was trying to clean up. It is unref'd,
      // so it cannot keep the parent alive.
      const { phases, sdkVersion, childError } = parsePhases(stdout);
      resolve({ outcome, phases, sdkVersion, childError, stderr });
    };

    const terminate = (): void => {
      try {
        child?.kill("SIGTERM");
      } catch {
        // The child may already be gone; nothing further to do.
      }
      const killTimer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Same.
        }
      }, options.killGraceMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
      timers.kill = killTimer;
    };

    try {
      child = options.spawn(
        options.nodePath,
        [options.harnessPath, ctx.projectRoot],
        {
          // The key reaches the child only through the environment, never argv,
          // where it would be visible in a process listing.
          env: { ...process.env, SOLARI_API_KEY: ctx.apiKey ?? "" },
          cwd: ctx.projectRoot,
        },
      );
    } catch (error) {
      finish({ kind: "spawn-failed", error });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (timers.exit === undefined && stdout.includes('"phase":"closed"')) {
        clearTimeout(timers.launch);
        // The browser is closed. The child now either exits or it does not.
        timers.exit = setTimeout(() => {
          terminate();
          finish({ kind: "hung-after-close" });
        }, ctx.deadlines.childExitMs);
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish({ kind: "spawn-failed", error });
    });

    child.on("exit", (code) => {
      clearTimeout(timers.kill);
      finish({ kind: "exited", code, closed: stdout.includes('"phase":"closed"') });
    });

    timers.launch = setTimeout(() => {
      terminate();
      finish({ kind: "timeout-before-close" });
    }, options.launchBudgetMs);
  });
}

/** Default harness location: beside this module in the built output. */
function defaultHarnessPath(): string {
  return fileURLToPath(new URL("./browser-lifecycle-harness.js", import.meta.url));
}

/**
 * Builds the check.
 *
 * The spawn seam is a factory argument rather than a `DoctorContext` field:
 * only this check spawns anything, and six other checks should not carry
 * plumbing they never use (finding F41).
 */
export function createBrowserLifecycleCheck(
  options: BrowserLifecycleOptions = {},
): DoctorCheck {
  const resolved = {
    nodePath: options.nodePath ?? process.execPath,
    harnessPath: options.harnessPath ?? defaultHarnessPath(),
    spawn: options.spawn ?? (nodeSpawn as unknown as SpawnFn),
    launchBudgetMs: options.launchBudgetMs ?? DEFAULT_LAUNCH_BUDGET_MS,
    killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
  };

  return {
    id: "browser-lifecycle",
    description: "Observes whether a process that opened a session exits on its own",
    costTier: "cheap",
    dependsOn: ["auth"],

    async run(ctx: DoctorContext): Promise<CheckResult> {
      const report = await runHarness(ctx, resolved);
      const base = {
        id: "browser-lifecycle",
        durationMs: 0,
        evidence: {
          deadlineMs: ctx.deadlines.childExitMs,
          phases: report.phases,
          sdkVersion: report.sdkVersion,
        } as Record<string, unknown>,
      };

      switch (report.outcome.kind) {
        case "spawn-failed": {
          const mapped = mapSdkError(report.outcome.error, "browser");
          return {
            ...base,
            status: "fail",
            message: "the lifecycle harness could not be started",
            details: mapped.evidence.sanitizedMessage,
            remediation:
              "solari-doctor could not spawn a child process to run this check. " +
              "This is an environment problem rather than an SDK one — check " +
              "that the node binary is executable and that the installed " +
              "solari-doctor package is complete.",
            evidence: { ...base.evidence, spawnFailed: true, ...mapped.evidence },
          };
        }

        case "hung-after-close":
          return {
            ...base,
            status: "fail",
            message: `the process did not exit within ${ctx.deadlines.childExitMs}ms of closing the browser`,
            remediation:
              "A process that opens a session should exit once the browser is " +
              "closed. On @solarisdk/browser below 0.1.3 the connection-retry " +
              "listener holds the event loop open; upgrade, or call " +
              "await solari.close() in a finally block.",
            issueRef: "solari-cookbook#README-gotcha-1",
            evidence: { ...base.evidence, closeReturned: true, processExited: false },
          };

        case "timeout-before-close":
          return {
            ...base,
            status: "fail",
            message: `the session did not reach a closed state within ${resolved.launchBudgetMs}ms`,
            ...(report.childError !== undefined
              ? { details: sanitizeErrorMessage(report.childError.message) }
              : {}),
            remediation:
              "The harness never got as far as closing the browser, so this is " +
              "not the documented hang. A slow or failing launch is the usual " +
              "cause; re-run with --report and check the recorded phases.",
            evidence: { ...base.evidence, closeReturned: false, processExited: false },
          };

        case "exited": {
          const { code, closed } = report.outcome;

          // The harness could not find the user's SDK. `sdk-version` reports
          // the same condition as a warning, and the two must agree: nothing is
          // broken, there is simply nothing here to measure.
          if (report.childError?.name === "SdkNotFound") {
            return {
              ...base,
              status: "warn",
              message: "@solarisdk/browser is not installed in this project",
              details: sanitizeErrorMessage(report.childError.message),
              remediation:
                "Install @solarisdk/browser here, or run solari-doctor from the " +
                "project whose environment you want checked. Nothing about the " +
                "session lifecycle can be observed without it.",
              evidence: { ...base.evidence, sdkFound: false },
            };
          }

          if (!closed) {
            return {
              ...base,
              status: "fail",
              message: report.childError
                ? `the harness failed: ${report.childError.name}`
                : `the harness exited early with code ${String(code)}`,
              details: sanitizeErrorMessage(report.childError?.message ?? report.stderr),
              remediation:
                "The child process ended before it closed a browser, so no " +
                "lifecycle conclusion can be drawn. The recorded phases show " +
                "how far it got.",
              evidence: { ...base.evidence, exitCode: code, closeReturned: false },
            };
          }

          return {
            ...base,
            status: "pass",
            message: "the process exited on its own after closing the browser",
            evidence: {
              ...base.evidence,
              exitCode: code,
              closeReturned: true,
              processExited: true,
            },
          };
        }
      }
    },
  };
}

export const browserLifecycleCheck: DoctorCheck = createBrowserLifecycleCheck();
