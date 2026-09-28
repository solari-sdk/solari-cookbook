// SPDX-License-Identifier: AGPL-3.0-only
// What a thread runs at when nobody names an access, per kind of workspace. On
// this computer and on a machine wsp forked it runs every action without
// asking; on a computer somebody already owns and works on it asks. One table
// answers it and every road reads that answer, so the composer's picker and the
// start itself cannot part.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, markedDefault, OVER_SSH, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { fakeSsh } from "./fake-ssh.js";
import { stubBackend, copyingFake, createOn, projectOn, testPlatform } from "./stub-backend.js";

/** A harness that answers at once and keeps every start it was handed, so a case reads the access the runtime
 * resolved rather than what it asked for. */
function recording(): { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

describe("the access a thread starts at, on each kind of workspace", () => {
  let root: string;
  let claude: ReturnType<typeof recording>;
  let codex: ReturnType<typeof recording>;
  let rt: Runtime | undefined;
  let localWiring: LocalWiring;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-access-"));
    claude = recording();
    codex = recording();
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
  });
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const runtime = (ssh?: Parameters<typeof createRuntime>[0]["ssh"]): Runtime => {
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: claude.adapter, codex: codex.adapter }, local: localWiring, ...(ssh !== undefined ? { ssh } : {}) });
    return rt;
  };

  /** The access a thread that named none ran at, and what the composer's picker shows beside it. */
  const ran = async (workspaceId: string, harness: "claude" | "codex", permissionMode?: string): Promise<{ start?: string; picker?: string }> => {
    const opened = await rt!.sessions.start(workspaceId, { prompt: "go", harness, ...(permissionMode !== undefined ? { permissionMode } : {}) });
    await opened.finished;
    const shown = (await rt!.harnesses.list(workspaceId)).find(c => c.harness === harness);
    const starts = harness === "claude" ? claude.starts : codex.starts;
    return { start: starts.at(-1)?.permissionMode, picker: markedDefault(shown?.permissionModes ?? [])?.value };
  };

  it("a thread on this computer that names no access runs every action without asking, whichever agent it is on", async () => {
    const rt = runtime();
    const mac = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect(await ran(mac.id, "claude")).toEqual({ start: "bypassPermissions", picker: "bypassPermissions" });
    expect(await ran(mac.id, "codex")).toEqual({ start: "danger-full-access", picker: "danger-full-access" });
  });

  it("a thread on this computer that names an access runs at that one, so every other mode stays a choice", async () => {
    const rt = runtime();
    const mac = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect((await ran(mac.id, "claude", "plan")).start).toBe("plan");
    expect((await ran(mac.id, "claude", "default")).start).toBe("default");
    expect((await ran(mac.id, "codex", "read-only")).start).toBe("read-only");
    // Named or not, a mode the agent does not take is refused with its list; the pick is not silently dropped.
    await expect(rt.sessions.start(mac.id, { prompt: "go", harness: "claude", permissionMode: "yolo" })).rejects.toThrow(/not one claude takes/);
    // A start that names no agent runs the one the last thread on this project used, so the refusal is that one's.
    await expect(rt.sessions.start(mac.id, { prompt: "go", permissionMode: "yolo" })).rejects.toThrow(/not one codex takes/);
  });

  it("a thread on a machine wsp forked runs every action without asking, as it did", async () => {
    const rt = runtime();
    const fork = await createOn(rt, { golden: "snap_g", name: "a" });
    expect(await ran(fork.id, "claude")).toEqual({ start: "bypassPermissions", picker: "bypassPermissions" });
    expect(await ran(fork.id, "codex")).toEqual({ start: "danger-full-access", picker: "danger-full-access" });
    // Nothing of the person's is handed over by that pick there, so the menu names no computer on it.
    const shown = (await rt.harnesses.list(fork.id)).find(c => c.harness === "claude");
    expect(shown?.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe("Bypass");
  });

  it("the picker on a workspace whose machine is not up still reads what its next thread would run", async () => {
    const rt = runtime();
    const fork = await createOn(rt, { golden: "snap_g", name: "a" });
    expect((await rt.workspaces.nap(fork.id)).phase).toBe("napping");
    const shown = (await rt.harnesses.list(fork.id)).find(c => c.harness === "claude");
    expect(markedDefault(shown?.permissionModes ?? [])?.value).toBe("bypassPermissions");
  });

  it("the menu says in one sentence what each mode does, on every kind and in the same words", async () => {
    const rt = runtime();
    const mac = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const fork = await createOn(rt, { golden: "snap_g", name: "a" });
    const sentences = async (id: string): Promise<(string | undefined)[]> =>
      ((await rt.harnesses.list(id)).find(c => c.harness === "claude")?.permissionModes ?? []).map(o => o.description);
    const here = await sentences(mac.id);
    expect(here).toEqual([
      "Asks in the chat about each action that needs permission",
      "Edits files without asking; asks about commands that need permission",
      "Reads and plans only; changes nothing",
      "Runs every action without asking",
      "The agent decides which actions to ask about; where the account has no such mode it asks as Default does",
      "Asks before every action",
      "Refuses any action that needs permission, without asking",
    ]);
    expect(await sentences(fork.id)).toEqual(here);
  });
});
