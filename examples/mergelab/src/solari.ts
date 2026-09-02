import { SolariClient } from "@solarisdk/sdk";
import { Solari, type BrowserSession } from "@solarisdk/browser";
import type { BrowserContext, Page } from "patchright-core";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  BrowserResult,
  Candidate,
  CommandResult,
  CommandStatus,
  MergeLabConfig,
  PullRequestRef,
} from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Sandbox = any;

export type Worker = {
  sandbox: Sandbox;
  sandboxId: string;
  candidate: Candidate;
  workDir: string;
  browser?: BrowserSession;
  resources: ResourceTracker;
};

type ResourceTracker = {
  files: string[];
};

export type WorkerContext = {
  repoUrl: string;
  baseSha: string;
  prs: PullRequestRef[];
  config: MergeLabConfig;
  outputDir: string;
  runId: string;
  keepSandboxes: boolean;
};

const LOG_LIMIT = 100_000;

function redactSecrets(input: string): string {
  return input
    .replace(/slr_(live|test)_[a-zA-Z0-9_]+/g, "[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]{36}/g, "[REDACTED]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED]");
}

function truncateLog(log: string): string {
  if (log.length <= LOG_LIMIT) return log;
  return `[truncated from ${log.length} bytes]\n${log.slice(-LOG_LIMIT)}`;
}

export function makeClient(): SolariClient {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is required");
  }
  return new SolariClient({ apiKey });
}

export async function provisionWorker(
  client: SolariClient,
  candidate: Candidate,
): Promise<Worker> {
  const sandbox = await client.sandboxes.create({
    template: "base",
    timeoutMs: 15 * 60_000,
  });
  await sandbox.connect();

  const workDir = `/home/user/mergelab-${candidate.id}-${randomBytes(4).toString("hex")}`;

  return {
    sandbox,
    sandboxId: sandbox.sandboxId,
    candidate,
    workDir,
    resources: { files: [] },
  };
}

type SandboxRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function runInSandbox(
  worker: Worker,
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<SandboxRunResult> {
  const merged = await worker.sandbox.commands.run(command, {
    args,
    cwd,
    timeoutMs,
  });

  return {
    exitCode: typeof merged.exitCode === "number" ? merged.exitCode : null,
    stdout: truncateLog(redactSecrets(String(merged.stdout ?? ""))),
    stderr: truncateLog(redactSecrets(String(merged.stderr ?? ""))),
    timedOut: typeof merged.exitCode !== "number",
  };
}

function shCommand(worker: Worker, script: string, timeoutMs = 60_000): Promise<SandboxRunResult> {
  return runInSandbox(worker, "sh", ["-c", script], timeoutMs, worker.workDir);
}

export async function prepareGitState(
  worker: Worker,
  ctx: WorkerContext,
): Promise<{ treeSha: string; mergeConflicts: string[] }> {
  await runInSandbox(worker, "mkdir", ["-p", worker.workDir], 10_000);

  // Configure git user for any merges that create commits.
  await runInSandbox(worker, "git", ["config", "--global", "user.email", "mergelab@example.com"], 10_000);
  await runInSandbox(worker, "git", ["config", "--global", "user.name", "MergeLab"], 10_000);

  // Clone the repository.
  const cloneRes = await runInSandbox(worker, "git", ["clone", ctx.repoUrl, worker.workDir], 120_000);
  if (cloneRes.exitCode !== 0) {
    throw new GitStateError("clone_failed", cloneRes.stderr);
  }

  // Fetch exact PR head SHAs as remote refs.
  const fetchRefs = ctx.prs.map((pr) => `+${pr.headSha}:refs/remotes/pr/${pr.number}`);
  const fetchRes = await runInSandbox(worker, "git", ["fetch", "origin", ...fetchRefs], 120_000, worker.workDir);
  if (fetchRes.exitCode !== 0) {
    throw new GitStateError("fetch_failed", fetchRes.stderr);
  }

  // Checkout pinned base.
  const checkoutRes = await runInSandbox(worker, "git", ["checkout", "-f", ctx.baseSha], 30_000, worker.workDir);
  if (checkoutRes.exitCode !== 0) {
    throw new GitStateError("checkout_failed", checkoutRes.stderr);
  }

  const mergeConflicts: string[] = [];

  // Apply PRs in ascending order.
  for (const prNumber of worker.candidate.applicationOrder) {
    const pr = ctx.prs.find((p) => p.number === prNumber);
    if (!pr) continue;

    const mergeRes = await runInSandbox(
      worker,
      "git",
      ["merge", "--no-commit", "--no-ff", `pr/${pr.number}`],
      60_000,
      worker.workDir,
    );

    if (mergeRes.exitCode !== 0) {
      // Check for conflicts.
      const statusRes = await runInSandbox(worker, "git", ["diff", "--name-only", "--diff-filter=U"], 10_000, worker.workDir);
      const conflicts = statusRes.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      mergeConflicts.push(...conflicts);
      throw new GitStateError("git_conflict", conflicts.join(", "));
    }
  }

  // Record combined tree SHA.
  const treeRes = await runInSandbox(worker, "git", ["rev-parse", "HEAD:"], 10_000, worker.workDir);
  const treeSha = treeRes.stdout.trim();

  // Ensure no unrelated changes remain staged/uncommitted beyond our merge.
  const statusRes = await runInSandbox(worker, "git", ["status", "--porcelain"], 10_000, worker.workDir);
  if (statusRes.exitCode !== 0) {
    throw new GitStateError("status_failed", statusRes.stderr);
  }

  return { treeSha, mergeConflicts };
}

export class GitStateError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "GitStateError";
  }
}

export async function runCheck(
  worker: Worker,
  name: string,
  command: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const started = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await runInSandbox(
    worker,
    "sh",
    ["-c", command],
    timeoutMs,
    worker.workDir,
  );
  const durationMs = Date.now() - started;

  const status: CommandStatus = timedOut
    ? "timed_out"
    : exitCode === 0
      ? "passed"
      : "failed";

  return {
    name,
    command,
    status,
    exitCode,
    durationMs,
    stdout,
    stderr,
  };
}

export async function runInstall(
  worker: Worker,
  config: MergeLabConfig,
): Promise<CommandResult> {
  return runCheck(worker, "install", config.install.command, config.install.timeoutMs);
}

export async function runChecks(
  worker: Worker,
  config: MergeLabConfig,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const check of config.checks) {
    const result = await runCheck(worker, check.name, check.command, check.timeoutMs);
    results.push(result);
    if (result.status !== "passed" && check.required) {
      break;
    }
  }
  return results;
}

async function waitForReady(
  baseUrl: string,
  readyPath: string,
  readyTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL(readyPath, baseUrl).toString(), { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function runBrowserVerification(
  worker: Worker,
  ctx: WorkerContext,
): Promise<BrowserResult> {
  const browserConfig = ctx.config.browser;
  if (!browserConfig || !browserConfig.enabled) {
    return {
      status: "skipped",
      durationMs: 0,
      stdout: "",
      stderr: "Browser verification disabled",
      screenshotPaths: [],
      consoleErrors: [],
      pageErrors: [],
    };
  }

  const client = new Solari({ apiKey: process.env.SOLARI_API_KEY! });
  const browser = await client.launch();
  worker.browser = browser;

  const started = Date.now();
  const screenshotPaths: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let status: CommandStatus = "failed";
  let stdout = "";
  let stderr = "";
  let tracePath: string | undefined;

  try {
    // Start the application in the background inside the sandbox.
    const startRes = await shCommand(
      worker,
      `nohup ${browserConfig.startCommand} > /tmp/mergelab-app-${worker.candidate.id}.log 2>&1 & echo $!`,
      30_000,
    );
    const pid = Number.parseInt(startRes.stdout.trim(), 10);
    if (Number.isNaN(pid)) {
      throw new Error(`Failed to start application: ${startRes.stderr}`);
    }

    // Expose the port and get a public URL.
    const { url: baseUrl } = await worker.sandbox.previewUrl(browserConfig.port);

    const ready = await waitForReady(baseUrl, browserConfig.readyPath, browserConfig.readyTimeoutMs);
    if (!ready) {
      throw new Error(`App did not become ready at ${browserConfig.readyPath} within ${browserConfig.readyTimeoutMs}ms`);
    }

    const context = await browser.newContext({
      viewport: browserConfig.viewport,
    });

    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // Run the user-provided verification function.
    const testFile = path.resolve(process.cwd(), browserConfig.testFile);
    const testModule = (await import(testFile)) as {
      default?: (args: {
        page: Page;
        context: BrowserContext;
        baseUrl: string;
      }) => Promise<void>;
    };
    if (typeof testModule.default !== "function") {
      throw new Error(`Browser test file must export a default async function: ${testFile}`);
    }

    await testModule.default({ page, context, baseUrl });

    // Screenshot the final state.
    const screenshotPath = path.join(
      ctx.outputDir,
      `screenshot-${worker.candidate.id}.png`,
    );
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    screenshotPaths.push(screenshotPath);

    status = "passed";
  } catch (err) {
    status = "failed";
    stderr = redactSecrets(err instanceof Error ? err.message : String(err));
    try {
      const failPath = path.join(ctx.outputDir, `screenshot-${worker.candidate.id}-failure.png`);
      await mkdir(path.dirname(failPath), { recursive: true });
      if (worker.browser) {
        const pages = worker.browser.contexts().flatMap((c) => c.pages());
        if (pages[0]) {
          await pages[0].screenshot({ path: failPath, fullPage: true });
          screenshotPaths.push(failPath);
        }
      }
    } catch {
      // Best-effort failure screenshot.
    }
  } finally {
    await browser.close();
    await client.close();
  }

  const durationMs = Date.now() - started;
  return {
    status,
    durationMs,
    stdout,
    stderr,
    screenshotPaths,
    tracePath,
    consoleErrors: consoleErrors.slice(0, 100),
    pageErrors: pageErrors.slice(0, 100),
  };
}

export async function cleanupWorker(worker: Worker, keep: boolean): Promise<"complete" | "incomplete" | "failed"> {
  if (keep) {
    return "incomplete";
  }

  try {
    await worker.sandbox.kill();
    return "complete";
  } catch (err) {
    return "failed";
  }
}

export async function ensureOutputDir(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
}

export async function writeArtifact(
  outputDir: string,
  candidateId: string,
  kind: ArtifactRef["kind"],
  filename: string,
  content: string | Buffer,
): Promise<ArtifactRef> {
  const dir = path.join(outputDir, "artifacts", candidateId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await writeFile(filePath, content);
  return {
    id: `${candidateId}-${kind}-${filename}`,
    kind,
    path: filePath,
    candidateId,
  };
}
