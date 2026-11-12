import { describe, it, expect } from "vitest";
import { ActionError, AuthError, NoCapacityError } from "@solarisdk/sdk";

import { sandboxCommandCheck } from "../../src/checks/sandbox-command.js";
import { fakeContext } from "../fixtures/fake-context.js";
import { fakeSandboxClient, type FakeSandboxOptions } from "../fixtures/fake-sandbox.js";

const KEY = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

/**
 * Runs the check against a scripted sandbox.
 *
 * Returns the calls alongside the result so every test can assert that the VM
 * was killed, including tests whose own assertions fail afterwards.
 */
async function runWith(script: FakeSandboxOptions = {}) {
  const { client, calls } = fakeSandboxClient(script);
  const { ctx } = fakeContext({ apiKey: KEY, sandboxClient: client });
  const result = await sandboxCommandCheck.run(ctx);
  return { result, calls };
}

/** The documented behaviour: the wrong form throws, the right form succeeds. */
const DOCUMENTED: FakeSandboxOptions = {
  run: (command) => {
    if (command === "ls -la") throw new ActionError("cmd.run", "no such file or directory");
    return { exitCode: 0, stdout: "total 8\ndrwxr-xr-x  2 root root\n", stderr: "" };
  },
};

describe("check metadata", () => {
  it("is cheap and depends on auth", () => {
    expect(sandboxCommandCheck.id).toBe("sandbox-command");
    expect(sandboxCommandCheck.costTier).toBe("cheap");
    expect(sandboxCommandCheck.dependsOn).toEqual(["auth"]);
  });
});

describe("the documented behaviour", () => {
  it("passes when the wrong form throws and the right form succeeds", async () => {
    const { result } = await runWith(DOCUMENTED);

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      wrongFormThrew: true,
      wrongFormErrorClass: "ActionError",
      rightFormExitCode: 0,
    });
  });

  it("runs the canary both ways, in order", async () => {
    const { calls } = await runWith(DOCUMENTED);

    expect(calls.ran).toEqual([
      ["ls -la", undefined],
      ["ls", ["-la", "/tmp"]],
    ]);
  });

  it("connects before running anything", async () => {
    const { calls } = await runWith(DOCUMENTED);
    expect(calls.created).toBe(1);
    expect(calls.connected).toBe(1);
  });

  it("accepts a non-zero exit as the documented failure too", async () => {
    // F20 observed a throw, but a future SDK could report it as an exit code.
    const { result } = await runWith({
      run: (command) =>
        command === "ls -la"
          ? { exitCode: 127, stdout: "", stderr: "ls -la: not found" }
          : { exitCode: 0, stdout: "ok", stderr: "" },
    });

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ wrongFormThrew: false, wrongFormExitCode: 127 });
  });

  it("mentions the documented shell escape hatch", async () => {
    const { result } = await runWith({
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(result.remediation).toContain('run("sh", { args: ["-c"');
  });
});

describe("behaviour that contradicts the documentation", () => {
  it("fails when the raw command string succeeds", async () => {
    const { result } = await runWith({
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("succeeded as a raw command string");
    expect(result.issueRef).toBe("solari-cookbook#README-gotcha-3");
  });

  it("fails when the args form does not work", async () => {
    const { result } = await runWith({
      run: (command) => {
        if (command === "ls -la") throw new ActionError("cmd.run", "not found");
        return { exitCode: 2, stdout: "", stderr: "ls: cannot access /tmp" };
      },
    });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("args-array form exited 2");
    expect(result.details).toContain("cannot access");
  });
});

describe("infrastructure failures are reported as themselves", () => {
  it("maps a creation failure through the shared error layer", async () => {
    const { result } = await runWith({
      create: () => {
        throw new NoCapacityError("no host");
      },
    });

    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/no host was available/i);
    expect(result.evidence).toMatchObject({ errorClass: "NoCapacityError", status: 503 });
  });

  it("maps a connect failure", async () => {
    const { result } = await runWith({
      connect: () => {
        throw new AuthError("Unauthorized");
      },
    });

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ status: 401 });
  });

  it("does not misreport an infrastructure failure as a semantics failure", async () => {
    const { result } = await runWith({
      create: () => {
        throw new NoCapacityError("no host");
      },
    });
    expect(result.message).not.toContain("raw command string");
  });
});

describe("the VM is always killed", () => {
  it("kills after a passing run", async () => {
    const { calls } = await runWith(DOCUMENTED);
    expect(calls.killed).toBe(1);
  });

  it("kills after a failing run", async () => {
    const { calls } = await runWith({ run: () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    expect(calls.killed).toBe(1);
  });

  it("kills when connect throws", async () => {
    const { calls } = await runWith({
      connect: () => {
        throw new AuthError("Unauthorized");
      },
    });
    expect(calls.killed).toBe(1);
  });

  it("kills when a command throws unexpectedly", async () => {
    const { calls } = await runWith({
      run: () => {
        throw new TypeError("something else entirely");
      },
    });
    expect(calls.killed).toBe(1);
  });

  it("still returns a result when kill itself fails", async () => {
    const { result, calls } = await runWith({
      ...DOCUMENTED,
      kill: () => {
        throw new Error("kill failed");
      },
    });

    // A failed cleanup must not replace the check's own finding.
    expect(result.status).toBe("pass");
    expect(calls.killed).toBe(1);
  });

  it("never kills a VM it did not create", async () => {
    const { calls } = await runWith({
      create: () => {
        throw new NoCapacityError("no host");
      },
    });
    expect(calls.killed).toBe(0);
  });
});

describe("evidence is safe for --report (design.md §9)", () => {
  it("redacts a key echoed in command output", async () => {
    const { result } = await runWith({
      run: (command) => {
        if (command === "ls -la") throw new ActionError("cmd.run", "not found");
        return { exitCode: 0, stdout: `env: SOLARI_API_KEY=${KEY}`, stderr: "" };
      },
    });

    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("redacts a key echoed on stderr", async () => {
    const { result } = await runWith({
      run: (command) =>
        command === "ls -la"
          ? { exitCode: 1, stdout: "", stderr: `failed with ${KEY}` }
          : { exitCode: 0, stdout: "", stderr: "" },
    });

    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("records a byte count rather than the whole of stdout", async () => {
    const { result } = await runWith({
      run: (command) => {
        if (command === "ls -la") throw new ActionError("cmd.run", "not found");
        return { exitCode: 0, stdout: "x".repeat(50_000), stderr: "" };
      },
    });

    expect(result.evidence).toMatchObject({ rightFormStdoutBytes: 50_000 });
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });

  it("keeps a stderr excerpt to one short line", async () => {
    const { result } = await runWith({
      run: (command) =>
        command === "ls -la"
          ? { exitCode: 127, stdout: "", stderr: `${"y".repeat(500)}\nsecond line` }
          : { exitCode: 0, stdout: "", stderr: "" },
    });

    const stderr = (result.evidence?.["wrongFormStderr"] ?? "") as string;
    expect(stderr.length).toBeLessThanOrEqual(120);
    expect(stderr).not.toContain("second line");
  });
});

describe("the check never throws", () => {
  it("returns a result for every failure shape", async () => {
    const shapes: unknown[] = [
      new ActionError("cmd.run", "x"),
      new AuthError("x"),
      new Error("x"),
      "a string",
      null,
      42,
    ];

    for (const shape of shapes) {
      const { result } = await runWith({
        create: () => {
          throw shape;
        },
      });
      expect(result.id).toBe("sandbox-command");
      expect(result.status).toBe("fail");
    }
  });
});
