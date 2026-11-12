import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  parseArgs,
  runCli,
  EXIT_OK,
  EXIT_CHECK_FAILED,
  EXIT_USAGE,
  REPORT_FILENAME,
  type CliIo,
} from "../src/cli.js";
import { createCheckRegistry } from "../src/checks/index.js";
import { createDoctorContext } from "../src/context.js";
import { DOCTOR_VERSION } from "../src/version.js";
import { fakeCheck } from "./fixtures/fake-check.js";

const ctx = createDoctorContext();

/** Captures every write the CLI makes, so nothing reaches the real process. */
function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const io: CliIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    writeFile: (path, contents) => void files.set(path, contents),
  };
  return {
    io,
    files,
    get stdout() {
      return out.join("");
    },
    get stderr() {
      return err.join("");
    },
  };
}

describe("parseArgs", () => {
  it("defaults every flag to off", () => {
    expect(parseArgs([])).toEqual({
      ok: true,
      options: { json: false, full: false, report: false },
    });
  });

  it("omits explain when absent, rather than setting it undefined", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok && "explain" in parsed.options).toBe(false);
  });

  it("accepts each of the four documented flags", () => {
    expect(parseArgs(["--json"])).toMatchObject({ options: { json: true } });
    expect(parseArgs(["--full"])).toMatchObject({ options: { full: true } });
    expect(parseArgs(["--report"])).toMatchObject({ options: { report: true } });
    expect(parseArgs(["--explain", "auth"])).toMatchObject({
      options: { explain: "auth" },
    });
  });

  it("accepts flags in combination and in any order", () => {
    expect(parseArgs(["--report", "--json", "--full"])).toEqual({
      ok: true,
      options: { json: true, full: true, report: true },
    });
  });

  it("rejects an unknown argument", () => {
    expect(parseArgs(["--fix"])).toEqual({
      ok: false,
      message: "unknown argument: --fix",
    });
  });

  it("rejects --explain with no id", () => {
    expect(parseArgs(["--explain"])).toMatchObject({ ok: false });
    // A following flag is not an id.
    expect(parseArgs(["--explain", "--json"])).toMatchObject({ ok: false });
  });

  it("rejects a bare positional argument — there are no subcommands", () => {
    expect(parseArgs(["diagnose"])).toMatchObject({ ok: false });
  });
});

describe("exit codes (design.md §9.1)", () => {
  it("exits 0 when every check passes", async () => {
    const registry = createCheckRegistry([fakeCheck("a"), fakeCheck("b")]);
    const io = captureIo();
    await expect(runCli([], { io: io.io, registry, context: ctx })).resolves.toBe(EXIT_OK);
  });

  it("exits 0 for a warn — exposure is not breakage", async () => {
    const registry = createCheckRegistry([
      fakeCheck("sdk-version", { result: { status: "warn", message: "0.1.2" } }),
    ]);
    const io = captureIo();
    await expect(runCli([], { io: io.io, registry, context: ctx })).resolves.toBe(EXIT_OK);
  });

  it("exits 0 for a skip", async () => {
    const registry = createCheckRegistry([
      fakeCheck("auth", { result: { status: "warn", message: "ok" } }),
      fakeCheck("dependent", { costTier: "cheap", dependsOn: ["auth"] }),
    ]);
    const io = captureIo();
    await expect(runCli([], { io: io.io, registry, context: ctx })).resolves.toBe(EXIT_OK);
  });

  it("exits 1 when any check fails", async () => {
    const registry = createCheckRegistry([
      fakeCheck("a"),
      fakeCheck("b", { result: { status: "fail", message: "broken" } }),
    ]);
    const io = captureIo();
    await expect(runCli([], { io: io.io, registry, context: ctx })).resolves.toBe(
      EXIT_CHECK_FAILED,
    );
  });

  it("exits 2 on a usage error and prints usage to stderr", async () => {
    const io = captureIo();
    await expect(runCli(["--fix"], { io: io.io })).resolves.toBe(EXIT_USAGE);
    expect(io.stderr).toContain("unknown argument");
    expect(io.stderr).toContain("usage: solari-doctor");
    expect(io.stdout).toBe("");
  });

  it("exits 0 for an empty registry", async () => {
    const io = captureIo();
    const registry = createCheckRegistry([]);
    await expect(runCli([], { io: io.io, registry, context: ctx })).resolves.toBe(EXIT_OK);
  });
});

describe("output routing", () => {
  it("writes the human report to stdout by default", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const io = captureIo();
    await runCli([], { io: io.io, registry, context: ctx });

    expect(io.stdout).toContain("solari-doctor");
    expect(io.stdout).toContain("auth");
    expect(io.stderr).toBe("");
  });

  it("writes JSON to stdout under --json", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const io = captureIo();
    await runCli(["--json"], { io: io.io, registry, context: ctx });

    const parsed = JSON.parse(io.stdout) as { schemaVersion: number; checks: unknown[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.checks).toHaveLength(1);
  });

  it("emits no colour unless asked", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const plain = captureIo();
    await runCli([], { io: plain.io, registry, context: ctx });
    expect(plain.stdout).not.toMatch(/\u001b\[/);

    const colored = captureIo();
    await runCli([], { io: colored.io, registry, context: ctx, color: true });
    expect(colored.stdout).toMatch(/\u001b\[/);
  });
});

describe("--report", () => {
  it("writes the bundle to ./solari-doctor-report.json", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const io = captureIo();
    await runCli(["--report"], { io: io.io, registry, context: ctx, cwd: "/tmp/x" });

    const [[path, contents]] = [...io.files.entries()] as [[string, string]];
    expect(path).toContain(REPORT_FILENAME);
    expect(JSON.parse(contents)).toMatchObject({
      schemaVersion: 1,
      environment: { doctorVersion: DOCTOR_VERSION },
    });
  });

  it("announces the path on stderr, keeping stdout pipeable", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const io = captureIo();
    await runCli(["--json", "--report"], {
      io: io.io,
      registry,
      context: ctx,
      cwd: "/tmp/x",
    });

    // The whole of stdout must still parse: the notice went to stderr.
    expect(() => JSON.parse(io.stdout)).not.toThrow();
    expect(io.stderr).toContain("report written to");
  });

  it("writes nothing without the flag", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const io = captureIo();
    await runCli([], { io: io.io, registry, context: ctx });
    expect(io.files.size).toBe(0);
  });
});

describe("--full", () => {
  it("omits expensive checks by default", async () => {
    const registry = createCheckRegistry([
      fakeCheck("cheap-one", { costTier: "cheap" }),
      fakeCheck("recording-lifecycle", { costTier: "expensive" }),
    ]);
    const io = captureIo();
    await runCli(["--json"], { io: io.io, registry, context: ctx });

    const parsed = JSON.parse(io.stdout) as { checks: Array<{ id: string }> };
    expect(parsed.checks.map((c) => c.id)).toEqual(["cheap-one"]);
  });

  it("includes them when asked", async () => {
    const registry = createCheckRegistry([
      fakeCheck("cheap-one", { costTier: "cheap" }),
      fakeCheck("recording-lifecycle", { costTier: "expensive" }),
    ]);
    const io = captureIo();
    await runCli(["--json", "--full"], { io: io.io, registry, context: ctx });

    const parsed = JSON.parse(io.stdout) as { checks: Array<{ id: string }> };
    expect(parsed.checks).toHaveLength(2);
  });
});

describe("--explain", () => {
  it("prints the stored finding for a known id", async () => {
    const io = captureIo();
    const code = await runCli(["--explain", "session-liveness"], { io: io.io });

    expect(code).toBe(EXIT_OK);
    expect(io.stdout).toContain("issue #25");
    expect(io.stdout).toContain("isConnected()");
  });

  it("runs no checks — the finding is never re-verified (design.md §6.7)", async () => {
    let ran = false;
    const registry = createCheckRegistry([
      fakeCheck("session-liveness", {
        onRun: () => {
          ran = true;
        },
      }),
    ]);
    const io = captureIo();
    await runCli(["--explain", "session-liveness"], { io: io.io, registry, context: ctx });
    expect(ran).toBe(false);
  });

  it("exits 2 and lists what is available for an unknown id", async () => {
    const io = captureIo();
    const code = await runCli(["--explain", "nope"], { io: io.io });

    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain("session-liveness");
    expect(io.stdout).toBe("");
  });
});

describe("diagnoses reach the output", () => {
  it("renders a correlated cause in the human report", async () => {
    const registry = createCheckRegistry([
      fakeCheck("sdk-version", { result: { status: "warn", message: "0.1.2 installed" } }),
      fakeCheck("browser-lifecycle", {
        costTier: "cheap",
        result: { status: "fail", message: "did not exit" },
      }),
    ]);
    const io = captureIo();
    await runCli([], { io: io.io, registry, context: ctx });

    expect(io.stdout).toContain("diagnosis");
    expect(io.stdout).toContain("older than 0.1.3");
  });

  it("includes them in --json too", async () => {
    const registry = createCheckRegistry([
      fakeCheck("auth", { result: { status: "fail", message: "no key" } }),
    ]);
    const io = captureIo();
    await runCli(["--json"], { io: io.io, registry, context: ctx });

    const parsed = JSON.parse(io.stdout) as { diagnoses: Array<{ cause: string }> };
    expect(parsed.diagnoses[0]?.cause).toContain("authentication failed");
  });
});

describe("version constant", () => {
  it("matches package.json, so a report cannot claim the wrong version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(DOCTOR_VERSION).toBe(manifest.version);
  });
});

describe("environment wiring", () => {
  it("passes SOLARI_API_KEY from the injected environment into the context", async () => {
    const io = captureIo();
    const registry = createCheckRegistry([
      fakeCheck("probe", {
        result: { status: "pass", message: "saw a key" },
      }),
    ]);
    // No context injected: runCli must build one from `env`.
    await runCli(["--json"], {
      io: io.io,
      registry,
      env: { SOLARI_API_KEY: "slr_live_from_env" },
    });
    expect(JSON.parse(io.stdout)).toMatchObject({ checks: [{ status: "pass" }] });
  });

  it("hands the environment's key to the context a check receives", async () => {
    let seen: string | undefined = "unset";
    const registry = createCheckRegistry([
      {
        id: "probe",
        description: "records the key it was given",
        costTier: "free",
        run: (ctx) => {
          seen = ctx.apiKey;
          return Promise.resolve({
            id: "probe",
            status: "pass" as const,
            message: "ok",
            durationMs: 0,
          });
        },
      },
    ]);

    await runCli(["--json"], {
      io: captureIo().io,
      registry,
      env: { SOLARI_API_KEY: "slr_live_from_env" },
    });

    expect(seen).toBe("slr_live_from_env");
  });

  it("defaults to an empty environment, so a test never reads the real shell", async () => {
    let seen: string | undefined = "unset";
    const registry = createCheckRegistry([
      {
        id: "probe",
        description: "records the key it was given",
        costTier: "free",
        run: (ctx) => {
          seen = ctx.apiKey;
          return Promise.resolve({
            id: "probe",
            status: "pass" as const,
            message: "ok",
            durationMs: 0,
          });
        },
      },
    ]);

    // No `env`, and the developer's own SOLARI_API_KEY must not leak in.
    await runCli(["--json"], { io: captureIo().io, registry });
    expect(seen).toBeUndefined();
  });
});

describe("a report that cannot be written", () => {
  const throwingIo = (io: CliIo): CliIo => ({
    ...io,
    writeFile: () => {
      throw new Error("EPERM: operation not permitted");
    },
  });

  it("keeps the exit code the checks produced", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const io = captureIo();

    // The diagnosis has already been printed; losing the file must not turn a
    // passing run into a usage error.
    const code = await runCli(["--report"], {
      io: throwingIo(io.io),
      registry,
      context: ctx,
    });
    expect(code).toBe(EXIT_OK);
  });

  it("still reports a real check failure as exit 1", async () => {
    const registry = createCheckRegistry([
      fakeCheck("auth", { result: { status: "fail", message: "no key" } }),
    ]);
    const io = captureIo();

    const code = await runCli(["--report"], {
      io: throwingIo(io.io),
      registry,
      context: ctx,
    });
    expect(code).toBe(EXIT_CHECK_FAILED);
  });

  it("warns on stderr and leaves stdout parseable", async () => {
    const registry = createCheckRegistry([fakeCheck("auth")]);
    const io = captureIo();

    await runCli(["--json", "--report"], {
      io: throwingIo(io.io),
      registry,
      context: ctx,
    });

    expect(() => JSON.parse(io.stdout)).not.toThrow();
    expect(io.stderr).toContain("could not write");
  });
});
