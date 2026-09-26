import { HERE_PLACE_ID } from "@wsp/protocol";
// SPDX-License-Identifier: AGPL-3.0-only
// The one title question a thread on this computer costs, read off a fake
// binary on the person's own PATH that records the store it was pointed at and
// the flags it was handed. What is under test is the whole road: the wiring
// this computer's workspace is built from, the adapter the runtime picks for
// its kind, and the line that reaches the shell.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ADAPTERS, createRuntime, memoryStore, type HarnessAdapterFactory, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localWiring } from "../src/cli.js";
import { stubBackend } from "./stub-backend.js";
import { copyingFake, createOn, fakeDaemonStart, projectOn } from "./verbs-fixture.js";

const SESSION = "44444444-4444-4444-8444-444444444444";
const MADE = "Named through the store a shell reads";

/** The real Claude Code adapter with a scripted turn in place of its launch: the reply lands without a binary to run
 * it, while the title question is the adapter's own and reaches the machine as it does on any workspace. */
const titlingClaude: HarnessAdapterFactory = ctx => {
  const claude = HARNESS_ADAPTERS.claude(ctx);
  return {
    ...claude,
    start: ({ onEvent }) => {
      const result = { status: "completed", text: "ok" } as const;
      const finished = (async () => {
        onEvent({ type: "session.start", sessionId: SESSION });
        onEvent({ type: "turn.done", sessionId: SESSION, result });
        onEvent({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: SESSION, finished, interrupt: async () => {} };
    },
  };
};

describe("the title a thread on this computer gets", () => {
  let dir: string;
  let home: string;
  /** Where the person's store variable puts their sign-in: not the default under their home, so a call that read
   * the default rather than their environment is a call this case can see. */
  let store: string;
  let bin: string;
  let record: string;
  const runtimes: Runtime[] = [];

  /** Every call the fake binary took, in order: the store it saw, whether it was told it is in a sandbox, and the
   * argv it was handed. */
  const calls = (): { store: string; sandbox: string; argv: string }[] =>
    readFileSync(record, "utf8")
      .split("\n")
      .filter(line => line !== "")
      .map(line => {
        const [seen = "", sandbox = "", argv = ""] = line.split("|");
        return { store: seen, sandbox, argv };
      });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-local-title-"));
    home = join(dir, "user");
    store = join(dir, "elsewhere", "claude-cfg");
    bin = join(dir, "bin");
    record = join(dir, "asked");
    for (const path of [home, bin, store]) mkdirSync(path, { recursive: true });
    writeFileSync(record, "");
    // Nothing here reads stdin: the shell that launches it holds a pipe nobody closes, and a read would wait on it
    // for ever. The prompt is small enough that the write into that pipe never blocks either.
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$CLAUDE_CONFIG_DIR" "$IS_SANDBOX" "$*" >> ${JSON.stringify(record)}\nprintf '%s' '{"type":"result","is_error":false,"result":"${MADE}"}'\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
  });
  afterEach(async () => {
    for (const rt of runtimes.splice(0)) await rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is asked of the binary under the store the person's own shell would read, in the mode that still reads their sign-in", async () => {
    const wiring = localWiring(home, { HOME: home, PATH: `${bin}:${process.env["PATH"] ?? ""}`, CLAUDE_CONFIG_DIR: store }, fakeDaemonStart, undefined, copyingFake());
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: titlingClaude }, local: wiring });
    runtimes.push(rt);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(ws.id, { prompt: "read the daemon's reconnect path" })).finished;

    await vi.waitFor(async () => expect((await rt.sessions.list(ws.id))[0]?.harnessTitle).toBe(MADE), { timeout: 10_000 });
    expect((await rt.sessions.list(ws.id))[0]?.titleSource).toBe("auto");

    // The question is the one call that allows no tool; the others on this road are the catalog probe's.
    const asked = calls().find(call => call.argv.includes("--allowed-tools"));
    if (asked === undefined) throw new Error(`no title question reached the binary: ${JSON.stringify(calls())}`);
    expect(asked.store).toBe(store);
    expect(asked.store).not.toBe(join(home, ".claude"));
    // --safe-mode leaves the person's hooks and CLAUDE.md out of a question and their sign-in in; --bare reads
    // neither OAuth nor the keychain, so under it a signed-in person's every thread is named by an auth error.
    expect(asked.argv).toContain("--safe-mode");
    expect(asked.argv).not.toContain("--bare");
    // And every call this road made saw that same store, the probe the question's model comes from included.
    expect([...new Set(calls().map(call => call.store))]).toEqual([store]);
  }, 20_000);

  it("names no store and no sandbox when the person's shell names none, so the binary reads its own default and their Keychain login", async () => {
    // Claude keys its Keychain item by whether CLAUDE_CONFIG_DIR is set, so setting it to the default folder hides a
    // claude.ai login (measured on 2.1.257); IS_SANDBOX is a machine's fact and this computer is not one.
    const wiring = localWiring(home, { HOME: home, PATH: `${bin}:${process.env["PATH"] ?? ""}` }, fakeDaemonStart, undefined, copyingFake());
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: titlingClaude }, local: wiring });
    runtimes.push(rt);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(ws.id, { prompt: "read the daemon's reconnect path" })).finished;

    await vi.waitFor(async () => expect((await rt.sessions.list(ws.id))[0]?.harnessTitle).toBe(MADE), { timeout: 10_000 });
    expect(calls().length).toBeGreaterThan(0);
    expect([...new Set(calls().map(call => call.store))]).toEqual([""]);
    expect([...new Set(calls().map(call => call.sandbox))]).toEqual([""]);
  }, 20_000);
});
