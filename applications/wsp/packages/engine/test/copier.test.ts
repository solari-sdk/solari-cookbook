// SPDX-License-Identifier: AGPL-3.0-only
// The road to the daemon binary's copy verb: the argv it is run with, the one
// line it is read back through, and what a caller is told when it refused. No
// child process runs here; the runner is handed in, since what this module
// owns is the line and the parse and the verb's own tests own the copying.
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/machine.js";
import { COPY_TIMEOUT_MS, fakeCopier, verbCopier } from "../src/copier.js";

const BIN = "/opt/wsp/daemon/aarch64-apple-darwin/wsp-daemon";

const report = {
  road: "clonefile",
  path: "/Users/dev/repo-pricing-page",
  base: "1".repeat(40),
  branch: "main",
  fetched: true,
  carried: "deps-and-config",
  excluded: [".next", "node_modules/.cache"],
  bytes: 1024,
  ms: 4900,
};

/** A runner that records what it was asked to run and answers what the case wants. */
function runner(answer: Partial<ExecResult>): { calls: { file: string; args: readonly string[]; timeoutMs?: number }[]; run: (file: string, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<ExecResult> } {
  const calls: { file: string; args: readonly string[]; timeoutMs?: number }[] = [];
  return {
    calls,
    run: async (file, args, opts) => {
      calls.push({ file, args, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      return { exitCode: 0, stdout: "", stderr: "", ...answer };
    },
  };
}

describe("the copy verb as a child of this host", () => {
  it("is run with one word per exclusion and answers the report it printed", async () => {
    const asked = runner({ stdout: `${JSON.stringify(report)}\n` });
    const copier = verbCopier(BIN, asked.run as never);
    const answered = await copier.make({ from: "/Users/dev/repo", to: "/Users/dev/repo-pricing-page", exclude: [".venv", ".next"], sizeLineBytes: 21474836480 });
    expect(answered).toEqual(report);
    expect(asked.calls).toHaveLength(1);
    expect(asked.calls[0]!.file).toBe(BIN);
    expect(asked.calls[0]!.args).toEqual([
      "copy",
      "make",
      "--from",
      "/Users/dev/repo",
      "--to",
      "/Users/dev/repo-pricing-page",
      "--exclude",
      ".venv",
      "--exclude",
      ".next",
      "--size-line-bytes",
      "21474836480",
    ]);
    expect(asked.calls[0]!.timeoutMs).toBe(COPY_TIMEOUT_MS);
  });

  it("names the base and the road on the line only where the caller named them", async () => {
    const asked = runner({ stdout: JSON.stringify({ ...report, road: "worktree", branch: "" }) });
    const copier = verbCopier(BIN, asked.run as never);
    await copier.make({ from: "/a", to: "/b", base: "release", exclude: [], sizeLineBytes: 1, road: "worktree" });
    expect(asked.calls[0]!.args).toEqual(["copy", "make", "--from", "/a", "--to", "/b", "--base", "release", "--size-line-bytes", "1", "--road", "worktree"]);
  });

  it("throws the verb's own last line when it refused, so a person reads why the copy could not be made", async () => {
    const asked = runner({ exitCode: 1, stderr: "warming up\n/Users/dev/repo-pricing-page is already there; a copy is made at a path of its own\n" });
    const copier = verbCopier(BIN, asked.run as never);
    await expect(copier.make({ from: "/Users/dev/repo", to: "/Users/dev/repo-pricing-page", exclude: [], sizeLineBytes: 1 })).rejects.toThrow(
      "/Users/dev/repo-pricing-page is already there; a copy is made at a path of its own",
    );
  });

  it("turns any other exit into one sentence naming the verb, so a parse error's usage text never reaches a person", async () => {
    // What a QA persona read when the daemon staged beside the host predated the copy verb: clap answers an
    // unrecognised subcommand with its error line and then the whole usage, forty flags long, and the host passed
    // the last line of it through as the refusal for a second workspace.
    const stale = runner({ exitCode: 2, stderr: "error: unrecognized subcommand 'copy'\n\nUsage: wsp-daemon [OPTIONS] --root <ROOT>\n" });
    await expect(verbCopier(BIN, stale.run as never).make({ from: "/a", to: "/b", exclude: [], sizeLineBytes: 1 })).rejects.toThrow("the daemon's copy verb failed (exit 2); the host log has its output");
    await expect(verbCopier(BIN, stale.run as never).make({ from: "/a", to: "/b", exclude: [], sizeLineBytes: 1 })).rejects.not.toThrow(/Usage:/);
    // A child the deadline killed exits on a signal with nothing said at all, which is the same sentence.
    const killed = runner({ exitCode: -1, stderr: "" });
    await expect(verbCopier(BIN, killed.run as never).make({ from: "/a", to: "/b", exclude: [], sizeLineBytes: 1 })).rejects.toThrow("the daemon's copy verb failed (exit -1)");
    // Exit 1 is the exit the verb documents for its own refusals, and that sentence is the person's to read.
    const refused = runner({ exitCode: 1, stderr: "/b is already there; a copy is made at a path of its own\n" });
    await expect(verbCopier(BIN, refused.run as never).make({ from: "/a", to: "/b", exclude: [], sizeLineBytes: 1 })).rejects.toThrow("/b is already there; a copy is made at a path of its own");
  });

  it("refuses a line this host does not read rather than recording half a copy", async () => {
    const asked = runner({ stdout: JSON.stringify({ ...report, road: "rsync" }) });
    const copier = verbCopier(BIN, asked.run as never);
    await expect(copier.make({ from: "/a", to: "/b", exclude: [], sizeLineBytes: 1 })).rejects.toThrow("the copy verb answered something this host does not read");
  });

  it("takes a copy away by the road that made it", async () => {
    const asked = runner({});
    const copier = verbCopier(BIN, asked.run as never);
    await copier.remove("/Users/dev/repo", "/Users/dev/repo-pricing-page", "worktree");
    expect(asked.calls[0]!.args).toEqual(["copy", "remove", "--from", "/Users/dev/repo", "--to", "/Users/dev/repo-pricing-page", "--road", "worktree"]);
    const refused = runner({ exitCode: 1, stderr: "worktree is not a road this computer has\n" });
    await expect(verbCopier(BIN, refused.run as never).remove("/a", "/b", "worktree")).rejects.toThrow("worktree is not a road this computer has");
  });
});

describe("the stand-in every road above the daemon is driven through", () => {
  it("records what it was asked for and answers a report of the road it was told to take", async () => {
    const copier = fakeCopier();
    const made = await copier.make({ from: "/a", to: "/b", exclude: [".next"], sizeLineBytes: 99, road: "worktree" });
    expect(made.road).toBe("worktree");
    expect(made.path).toBe("/b");
    expect(made.excluded).toEqual([".next"]);
    expect(copier.asks).toEqual([{ from: "/a", to: "/b", exclude: [".next"], sizeLineBytes: 99, road: "worktree" }]);
    await copier.remove("/a", "/b", "clonefile");
    expect(copier.removed).toEqual([{ from: "/a", to: "/b", road: "clonefile" }]);
  });

  it("answers whatever a case scripts, so a fallback and a refusal are both drivable from above", async () => {
    const copier = fakeCopier(ask => ({
      road: "worktree",
      path: ask.to,
      base: "0".repeat(40),
      branch: "",
      fetched: false,
      carried: "config-only",
      excluded: [],
      bytes: 0,
      ms: 1,
      fellBack: "the folder is 21.0 GB and a clone above 20.0 GB is not taken",
    }));
    const made = await copier.make({ from: "/a", to: "/b", exclude: [], sizeLineBytes: 1 });
    expect(made.fellBack).toContain("20.0 GB");
    expect(made.carried).toBe("config-only");
  });
});
