import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

import {
  createBrowserLifecycleCheck,
  browserLifecycleCheck,
  type ChildLike,
  type SpawnFn,
} from "../../src/checks/browser-lifecycle.js";
import { createDoctorContext } from "../../src/context.js";

const KEY = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

/** A controllable stand-in for a spawned child process. */
class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter() as unknown as ChildLike["stdout"];
  readonly stderr = new EventEmitter() as unknown as ChildLike["stderr"];
  readonly signals: string[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }

  say(payload: Record<string, unknown>): void {
    (this.stdout as unknown as EventEmitter).emit("data", `${JSON.stringify(payload)}\n`);
  }

  complain(text: string): void {
    (this.stderr as unknown as EventEmitter).emit("data", text);
  }

  finish(code: number | null = 0): void {
    this.emit("exit", code, null);
  }
}

interface Harness {
  check: ReturnType<typeof createBrowserLifecycleCheck>;
  child: FakeChild;
  spawnArgs: Array<{ command: string; args: readonly string[]; options: { env: NodeJS.ProcessEnv; cwd: string } }>;
}

function harness(options: { childExitMs?: number; launchBudgetMs?: number } = {}): Harness {
  const child = new FakeChild();
  const spawnArgs: Harness["spawnArgs"] = [];
  const spawn: SpawnFn = (command, args, opts) => {
    spawnArgs.push({ command, args, options: opts });
    return child;
  };

  const check = createBrowserLifecycleCheck({
    nodePath: "/fake/node",
    harnessPath: "/fake/harness.js",
    spawn,
    launchBudgetMs: options.launchBudgetMs ?? 10_000,
    killGraceMs: 5,
  });

  return { check, child, spawnArgs };
}

function contextWith(childExitMs = 50) {
  return createDoctorContext({
    apiKey: KEY,
    projectRoot: "/fake/project",
    deadlines: { childExitMs },
  });
}

describe("check metadata", () => {
  it("is cheap and depends on auth", () => {
    expect(browserLifecycleCheck.id).toBe("browser-lifecycle");
    expect(browserLifecycleCheck.costTier).toBe("cheap");
    expect(browserLifecycleCheck.dependsOn).toEqual(["auth"]);
  });
});

describe("spawn arguments", () => {
  it("runs the harness out-of-process, with no shell", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.say({ phase: "closed" });
    h.child.finish(0);
    await run;

    const [call] = h.spawnArgs;
    expect(call?.command).toBe("/fake/node");
    expect(call?.args).toEqual(["/fake/harness.js", "/fake/project"]);
  });

  it("passes the key through the environment, never through argv", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.say({ phase: "closed" });
    h.child.finish(0);
    await run;

    const [call] = h.spawnArgs;
    // argv is visible in a process listing; the environment is not.
    expect(JSON.stringify(call?.args)).not.toContain(KEY);
    expect(call?.options.env["SOLARI_API_KEY"]).toBe(KEY);
  });

  it("runs the child in the user's project directory", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.finish(0);
    await run;
    expect(h.spawnArgs[0]?.options.cwd).toBe("/fake/project");
  });
});

describe("the healthy path", () => {
  it("passes when the child exits after closing", async () => {
    const h = harness();
    const run = h.check.run(contextWith());

    h.child.say({ phase: "loaded", sdkVersion: "0.1.3" });
    h.child.say({ phase: "launched" });
    h.child.say({ phase: "closed" });
    h.child.finish(0);

    const result = await run;
    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      closeReturned: true,
      processExited: true,
      exitCode: 0,
      sdkVersion: "0.1.3",
    });
    expect(result.evidence).toMatchObject({ phases: ["loaded", "launched", "closed"] });
  });

  it("does not kill a child that exits on its own", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.say({ phase: "closed" });
    h.child.finish(0);
    await run;
    expect(h.child.signals).toEqual([]);
  });
});

describe("the hang path", () => {
  it("fails when the child does not exit within the deadline", async () => {
    const h = harness();
    const run = h.check.run(contextWith(20));
    h.child.say({ phase: "closed" });
    // Never finishes.

    const result = await run;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("did not exit within 20ms");
    expect(result.evidence).toMatchObject({ closeReturned: true, processExited: false });
    expect(result.issueRef).toBe("solari-cookbook#README-gotcha-1");
  });

  it("terminates the stuck child rather than leaking it", async () => {
    const h = harness();
    const run = h.check.run(contextWith(20));
    h.child.say({ phase: "closed" });
    await run;

    expect(h.child.signals).toContain("SIGTERM");
    // SIGKILL follows after the grace period.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.child.signals).toContain("SIGKILL");
  });

  it("measures the deadline from the close, not from spawn", async () => {
    // A slow launch must not be reported as a hang.
    const h = harness({ launchBudgetMs: 400 });
    const run = h.check.run(contextWith(200));

    await new Promise((resolve) => setTimeout(resolve, 250));
    h.child.say({ phase: "closed" });
    h.child.finish(0);

    expect((await run).status).toBe("pass");
  });
});

describe("failures that are not the documented hang", () => {
  it("fails distinctly when the child never reaches a close", async () => {
    const h = harness({ launchBudgetMs: 30 });
    const run = h.check.run(contextWith());
    h.child.say({ phase: "launched" });

    const result = await run;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("did not reach a closed state");
    expect(result.remediation).toContain("not the documented hang");
    expect(result.evidence).toMatchObject({ closeReturned: false });
  });

  it("reports a child that errors before closing", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.say({ phase: "error", name: "SolariError", message: "401 Unauthorized" });
    h.child.finish(1);

    const result = await run;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("SolariError");
    expect(result.details).toContain("401");
    expect(result.evidence).toMatchObject({ exitCode: 1, closeReturned: false });
  });

  it("reports an early exit with no diagnostic output", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.complain("node: bad option\n");
    h.child.finish(9);

    const result = await run;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("exited early with code 9");
    expect(result.details).toContain("bad option");
  });

  it("reports a spawn that throws synchronously", async () => {
    const check = createBrowserLifecycleCheck({
      nodePath: "/fake/node",
      harnessPath: "/fake/harness.js",
      spawn: () => {
        throw new Error("EACCES");
      },
    });

    const result = await check.run(contextWith());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("could not be started");
    expect(result.evidence).toMatchObject({ spawnFailed: true });
  });

  it("reports an asynchronous spawn error", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.emit("error", new Error("ENOENT"));

    const result = await run;
    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ spawnFailed: true });
  });
});

describe("robustness", () => {
  it("ignores non-JSON noise on stdout", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    (h.child.stdout as unknown as EventEmitter).emit("data", "npm warn something\n");
    h.child.say({ phase: "closed" });
    h.child.finish(0);

    expect((await run).status).toBe("pass");
  });

  it("handles output arriving split across chunks", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    (h.child.stdout as unknown as EventEmitter).emit("data", '{"phase":"clo');
    (h.child.stdout as unknown as EventEmitter).emit("data", 'sed"}\n');
    h.child.finish(0);

    expect((await run).status).toBe("pass");
  });

  it("settles once, even if the child exits after the deadline fired", async () => {
    const h = harness();
    const run = h.check.run(contextWith(20));
    h.child.say({ phase: "closed" });
    const result = await run;

    h.child.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.status).toBe("fail");
  });

  it("never throws, whatever the child does", async () => {
    const scenarios: Array<(c: FakeChild) => void> = [
      (c) => c.finish(null),
      (c) => c.finish(137),
      (c) => c.emit("error", new Error("x")),
      (c) => c.say({ phase: "closed" }),
      (c) => (c.stdout as unknown as EventEmitter).emit("data", Buffer.from("garbage")),
    ];

    for (const scenario of scenarios) {
      const h = harness({ launchBudgetMs: 30 });
      const run = h.check.run(contextWith(20));
      scenario(h.child);
      await expect(run).resolves.toMatchObject({ id: "browser-lifecycle" });
    }
  });
});

describe("the key never leaks (design.md §9)", () => {
  it("stays out of the result when the child echoes it in an error", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.say({ phase: "error", name: "SolariError", message: `bad key ${KEY}` });
    h.child.finish(1);

    expect(JSON.stringify(await run)).not.toContain(KEY);
  });

  it("stays out of the result when the child prints it on stderr", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.complain(`env dump: SOLARI_API_KEY=${KEY}\n`);
    h.child.finish(3);

    expect(JSON.stringify(await run)).not.toContain(KEY);
  });
});

describe("the parent is always bounded", () => {
  it("settles even when the child does nothing at all", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ launchBudgetMs: 50 });
      const run = h.check.run(contextWith(20));
      await vi.advanceTimersByTimeAsync(200);
      await expect(run).resolves.toMatchObject({ status: "fail" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a missing SDK is not a failure", () => {
  it("warns rather than fails, matching sdk-version's verdict", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.say({
      phase: "error",
      name: "SdkNotFound",
      message: "@solarisdk/browser is not installed under /some/project",
    });
    h.child.finish(2);

    const result = await run;
    // Nothing is broken; there is simply nothing to measure. Reporting `fail`
    // would make an unrelated directory exit 1.
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not installed");
    expect(result.evidence).toMatchObject({ sdkFound: false });
  });

  it("still fails for a genuine SDK error", async () => {
    const h = harness();
    const run = h.check.run(contextWith());
    h.child.say({ phase: "error", name: "SolariError", message: "401 Unauthorized" });
    h.child.finish(1);

    expect((await run).status).toBe("fail");
  });
});
