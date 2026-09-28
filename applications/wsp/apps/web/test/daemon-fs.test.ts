// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootsPathIn } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemonLink, type DaemonLink } from "../src/terminal/daemon-link.js";
import { DaemonOpError, fsList, fsRead, gitDiff, gitStatus } from "../src/terminal/daemon-fs.js";
import type { TerminalWire } from "../src/terminal/link.js";
import { startRelayHarness, type RelayHarness } from "./relay-harness.js";

function fakeWire(replies: Record<string, Record<string, unknown>>): TerminalWire & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    request: (op, params = {}) => {
      calls.push([op, params]);
      const r = replies[op];
      return r ? Promise.resolve({ id: 1, ok: true, ...r }) : Promise.reject(new Error(`unknown op: ${op}`));
    },
  };
}

describe("daemon-fs wrapper over a wire", () => {
  it("sends only the params given and returns the parsed reply", async () => {
    const w = fakeWire({
      "fs.list": { entries: [{ name: "src", type: "dir", size: 0, mtime: 1 }], truncated: false, total: 1 },
      "fs.read": { content: "hi", size: 2, truncated: false },
      "git.status": { branch: { oid: "a", head: "main", ahead: 0, behind: 0 }, entries: [], root: "/root/repo" },
      "git.diff": { base: null, files: [], truncated: false },
    });
    const list = await fsList(w, "repo");
    expect(list.entries[0]?.type).toBe("dir");
    expect(w.calls[0]).toEqual(["fs.list", { path: "repo" }]);

    await fsList(w, "repo", { gitignore: true });
    expect(w.calls[1]).toEqual(["fs.list", { path: "repo", gitignore: true }]);

    const read = await fsRead(w, "repo/a.txt", "base64");
    expect(read.content).toBe("hi");
    expect(w.calls[2]).toEqual(["fs.read", { path: "repo/a.txt", encoding: "base64" }]);
    await fsRead(w, "repo/a.txt");
    expect(w.calls[3]).toEqual(["fs.read", { path: "repo/a.txt" }]);

    const status = await gitStatus(w, "repo");
    expect(status.branch.head).toBe("main");
    expect(w.calls[4]).toEqual(["git.status", { cwd: "repo" }]);

    const diff = await gitDiff(w, "repo", "staged");
    expect(diff.files).toEqual([]);
    expect(w.calls[5]).toEqual(["git.diff", { cwd: "repo", scope: "staged" }]);
    await gitDiff(w, "repo", "branch", "src");
    expect(w.calls[6]).toEqual(["git.diff", { cwd: "repo", scope: "branch", path: "src" }]);
  });

  it("refuses a malformed reply instead of passing it through", async () => {
    const w = fakeWire({ "fs.read": { content: 7, size: "2" } });
    await expect(fsRead(w, "x")).rejects.toThrow();
  });

  it("wraps a wire refusal as DaemonOpError, keeping a code when the wire carries one", async () => {
    const coded: TerminalWire = {
      request: () => Promise.reject(Object.assign(new Error("path escapes the workspace root"), { code: "outside-root" })),
    };
    const err = await fsList(coded, "..").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonOpError);
    expect((err as DaemonOpError).code).toBe("outside-root");
    expect((err as DaemonOpError).message).toBe("path escapes the workspace root");

    const plain: TerminalWire = { request: () => Promise.reject(new Error("not inside a git repository")) };
    const err2 = await gitStatus(plain, ".").catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(DaemonOpError);
    expect((err2 as DaemonOpError).code).toBeUndefined();
  });
});

let relay: RelayHarness | undefined;
let link: DaemonLink | undefined;
let root: string | undefined;

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

afterEach(async () => {
  link?.close();
  link = undefined;
  await relay?.close();
  relay = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("daemon-fs over a real daemon link through the host", () => {
  it("lists, reads, reports status and diffs a repo inside the root", async () => {
    root = mkdtempSync(join(tmpdir(), "wsp-web-fs-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
      });
    git("init", "-q", "-b", "main");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "a.txt"), "two\n");

    // Its roots file goes beside its own root: the option's default names the guest's /root, another user's folder here.
    relay = await startRelayHarness({ daemonArgs: { root, rootsPath: rootsPathIn(root) } });
    const statuses: string[] = [];
    link = connectDaemonLink({
      daemon: relay.api.daemon,
      target: { workspaceId: relay.workspaceId },
      onEvent: () => {},
      onStatus: s => statuses.push(s),
    });
    await until(() => statuses.includes("live"));

    const list = await fsList(link, "repo");
    expect(list.entries.map(e => e.name)).toEqual([".git", "a.txt"]);
    const read = await fsRead(link, "repo/a.txt");
    expect(read).toEqual({ content: "two\n", size: 4, truncated: false });
    const status = await gitStatus(link, "repo");
    expect(status.branch.head).toBe("main");
    expect(status.entries).toEqual([{ xy: ".M", path: "a.txt" }]);
    const diff = await gitDiff(link, "repo", "unstaged");
    expect(diff.files.map(f => f.path)).toEqual(["a.txt"]);
    expect(diff.files[0]!.patch).toContain("+two");

    const err = await fsRead(link, "../outside.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonOpError);
    expect((err as Error).message).toMatch(/outside the workspace root/);
  });
});
