import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDoctorContext, type Clock } from "../src/context.js";

const FIXTURE_VERSION = "9.9.9-fixture";

/**
 * Builds a throwaway project that has its own `@solarisdk/browser` installed at
 * a version that could not possibly be solari-doctor's own.
 */
function makeFixtureProject(): string {
  const root = mkdtempSync(join(tmpdir(), "solari-doctor-fixture-"));
  const pkgDir = join(root, "node_modules", "@solarisdk", "browser");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@solarisdk/browser", version: FIXTURE_VERSION }),
  );
  return root;
}

function readSdkVersionUnder(projectRoot: string): string {
  const p = join(projectRoot, "node_modules", "@solarisdk", "browser", "package.json");
  return JSON.parse(readFileSync(p, "utf8")).version as string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("projectRoot (E1a)", () => {
  it("defaults to the caller's working directory", () => {
    expect(createDoctorContext().projectRoot).toBe(process.cwd());
  });

  it("anchors SDK resolution to the user's project, not solari-doctor's own", () => {
    const fixture = makeFixtureProject();
    cleanups.push(() => rmSync(fixture, { recursive: true, force: true }));

    const ctx = createDoctorContext({ projectRoot: fixture });

    // What the user's project has installed.
    expect(readSdkVersionUnder(ctx.projectRoot)).toBe(FIXTURE_VERSION);

    // What solari-doctor itself has installed. If these were ever the same,
    // this test would be proving nothing — so assert they genuinely differ.
    const ownVersion = readSdkVersionUnder(process.cwd());
    expect(ownVersion).not.toBe(FIXTURE_VERSION);
    expect(readSdkVersionUnder(ctx.projectRoot)).not.toBe(ownVersion);
  });

  it("the default follows a changed cwd, so it tracks the user, not the tool", () => {
    const fixture = makeFixtureProject();
    const originalCwd = process.cwd();
    cleanups.push(() => {
      process.chdir(originalCwd);
      rmSync(fixture, { recursive: true, force: true });
    });

    process.chdir(fixture);
    const ctx = createDoctorContext();

    // realpath: macOS/Windows temp dirs are commonly symlinked.
    expect(readSdkVersionUnder(ctx.projectRoot)).toBe(FIXTURE_VERSION);
    expect(ctx.projectRoot).not.toBe(originalCwd);
  });
});

describe("client laziness and memoisation", () => {
  it("constructs nothing at context-creation time", () => {
    // With no key, constructing a client throws. Creating the context must not,
    // which is only possible if neither client was built eagerly.
    expect(() => createDoctorContext({ apiKey: undefined })).not.toThrow();
  });

  it("throws only when an unusable client is actually requested", () => {
    const ctx = createDoctorContext({ apiKey: undefined });
    expect(() => ctx.browser()).toThrow(/SOLARI_API_KEY is not set/);
    expect(() => ctx.sandbox()).toThrow(/SOLARI_API_KEY is not set/);
  });

  it("memoises each client across calls", () => {
    const ctx = createDoctorContext({ apiKey: "slr_live_test_key" });
    expect(ctx.browser()).toBe(ctx.browser());
    expect(ctx.sandbox()).toBe(ctx.sandbox());
  });

  it("keeps the two clients independent", () => {
    const ctx = createDoctorContext({ apiKey: "slr_live_test_key" });
    expect(ctx.browser() as unknown).not.toBe(ctx.sandbox() as unknown);
  });
});

describe("clock", () => {
  it("now() returns a number", () => {
    expect(typeof createDoctorContext().clock.now()).toBe("number");
  });

  it("sleep() is awaitable and resolves", async () => {
    await expect(createDoctorContext().clock.sleep(1)).resolves.toBeUndefined();
  });

  it("uses an injected clock, so poll logic is testable without real waits", async () => {
    const slept: number[] = [];
    const fake: Clock = {
      now: () => 1_234,
      sleep: async (ms) => {
        slept.push(ms);
      },
    };
    const ctx = createDoctorContext({ clock: fake });

    expect(ctx.clock.now()).toBe(1_234);
    await ctx.clock.sleep(30_000);
    expect(slept).toEqual([30_000]);
  });
});

describe("deadlines and optional gateway overrides", () => {
  it("supplies both deadlines by default", () => {
    const { deadlines } = createDoctorContext();
    expect(deadlines.childExitMs).toBeGreaterThan(0);
    expect(deadlines.replayPollMs).toBeGreaterThan(0);
  });

  it("allows overriding one deadline without losing the other", () => {
    const { deadlines } = createDoctorContext({ deadlines: { childExitMs: 50 } });
    expect(deadlines.childExitMs).toBe(50);
    expect(deadlines.replayPollMs).toBeGreaterThan(0);
  });

  it("omits region and baseUrl entirely when not supplied", () => {
    const ctx = createDoctorContext();
    expect("region" in ctx).toBe(false);
    expect("baseUrl" in ctx).toBe(false);
  });

  it("carries region and baseUrl through when supplied", () => {
    const ctx = createDoctorContext({
      region: "us-west",
      baseUrl: "https://staging.example.invalid",
    });
    expect(ctx.region).toBe("us-west");
    expect(ctx.baseUrl).toBe("https://staging.example.invalid");
  });
});

describe("dispose (finding F43)", () => {
  it("is safe to call when nothing was ever constructed", async () => {
    await expect(createDoctorContext().dispose()).resolves.toBeUndefined();
  });

  it("is safe to call twice", async () => {
    const ctx = createDoctorContext({ apiKey: "slr_live_test_key" });
    ctx.sandbox();
    await ctx.dispose();
    await expect(ctx.dispose()).resolves.toBeUndefined();
  });

  it("drops the memoised clients, so a later call builds a fresh one", async () => {
    const ctx = createDoctorContext({ apiKey: "slr_live_test_key" });
    const first = ctx.sandbox();
    await ctx.dispose();
    expect(ctx.sandbox()).not.toBe(first);
  });
});
