// SPDX-License-Identifier: AGPL-3.0-only
// A turn whose agent replied while a command it started is still running: the
// runtime holds the turn's idle clock open for that work the way it holds it
// open under a question nobody has answered, since both say the turn is
// waiting on something its own process is not doing. The box the turn's exec
// stream reads is the one fact, and this is what moves it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERE_PLACE_ID, PERMISSION_ALLOW, PERMISSION_DENY, type AdapterEvent, type PermissionAsk, type TurnResult } from "@wsp/protocol";
import { LocalBackend } from "@wsp/engine";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { copyingFake, createOn, stubBackend, testPlatform } from "./stub-backend.js";

const ASK: PermissionAsk = {
  askId: "ask_1",
  toolName: "Bash",
  toolUseId: "toolu_1",
  input: '{"command":"pnpm test"}',
  options: [
    { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
    { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
  ],
};

/** An adapter whose turn says nothing by itself: the case emits the lines a harness would. */
function drivenAdapter(said: ((event: AdapterEvent) => void)[]): HarnessAdapterFactory {
  return () => ({
    steers: true,
    start: ({ onEvent }) => {
      const sessionId = randomUUID();
      let settle: ((result: TurnResult) => void) | undefined;
      const finished = new Promise<TurnResult>(resolve => {
        settle = resolve;
      });
      onEvent({ type: "session.start", sessionId });
      said.push(event => onEvent({ ...event, sessionId } as AdapterEvent));
      return {
        localId: sessionId,
        finished,
        interrupt: async () => settle?.({ status: "interrupted" }),
      };
    },
  });
}

describe("what holds a turn's idle clock", () => {
  let root: string;
  let store: Store;
  let rt: Runtime;
  let said: ((event: AdapterEvent) => void)[];
  /** The box the runtime handed this turn's exec factory, read as the stream's every poll reads it. */
  let waiting: (() => boolean) | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-held-"));
    store = memoryStore();
    said = [];
    const wiring: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: (o, isWaiting) => {
        if (isWaiting !== undefined) waiting = isWaiting;
        return localExecStream({ root, runDir: join(root, "runs"), ...o });
      },
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: drivenAdapter(said) }, local: wiring });
  });
  afterEach(async () => {
    await rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a background task the harness reports alive holds it, as an open prompt does, and the two are one box", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await rt.sessions.start(ws.id, { prompt: "run the gate in the background" });
    await vi.waitFor(() => expect(said).toHaveLength(1));
    const emit = said[0]!;
    // A turn working on its own: nothing outside its process is holding it, so its stream's quiet is its own.
    expect(waiting?.()).toBe(false);

    emit({ type: "turn.tasks", running: 1 } as AdapterEvent);
    expect(waiting?.()).toBe(true);
    emit({ type: "turn.tasks", running: 0 } as AdapterEvent);
    expect(waiting?.()).toBe(false);

    // The prompt road is unchanged, and a task still running holds the box past the prompt's close: one box, two
    // reasons, so closing one does not say the turn is idle while the other stands.
    emit({ type: "permission.ask", ask: ASK } as AdapterEvent);
    expect(waiting?.()).toBe(true);
    emit({ type: "turn.tasks", running: 1 } as AdapterEvent);
    emit({ type: "permission.close", askId: ASK.askId, outcome: "allowed", optionId: PERMISSION_ALLOW } as AdapterEvent);
    expect(waiting?.()).toBe(true);
    emit({ type: "turn.tasks", running: 0 } as AdapterEvent);
    expect(waiting?.()).toBe(false);
  });
});
