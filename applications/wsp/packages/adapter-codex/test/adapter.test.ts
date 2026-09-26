// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codexKeyRefusedLine, codexMissingEnvLine, codexNotSignedInLine, codexReconnectLine } from "@wsp/protocol";
import type { AdapterEvent, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createCodexAdapter, type CodexSession } from "../src/adapter.js";

const THREAD_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const FAILED_THREAD_ID = "01a07959-8db6-7590-bf71-c9561e1ddaa0";

function fixtureLines(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0);
}

/** What the guest calls the run every scripted stream stands for. */
const RUN_HANDLE = "/tmp/wsp-run/cd34";

interface ScriptedExec {
  factory: ExecStreamFactory;
  calls: { command: string; env: Record<string, string>; input: readonly string[] | undefined }[];
  order: string[];
}

/** Replays scripted log lines; in hang mode the stream only ends on kill(). */
function scriptedExec(lines: string[], opts: { exitCode?: number; hang?: boolean } = {}): ScriptedExec {
  const calls: ScriptedExec["calls"] = [];
  const order: string[] = [];
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      resolveExit = resolve;
    });
    const stream: ExecStream = {
      run: RUN_HANDLE,
      lines: (async function* () {
        yield* lines;
        if (opts.hang) await exited;
        else resolveExit(opts.exitCode ?? 0);
      })(),
      teardown: () => {
        order.push("teardown");
        if (!opts.hang) resolveExit(opts.exitCode ?? 0);
      },
      kill: () => {
        order.push("kill");
        resolveExit(null);
      },
      write: async () => {
        order.push("write");
        return "written" as const;
      },
      closeInput: () => {
        order.push("closeInput");
      },
      exited,
    };
    return stream;
  };
  return { factory, calls, order };
}

function collect(): { events: AdapterEvent[]; onEvent: (e: AdapterEvent) => void } {
  const events: AdapterEvent[] = [];
  return { events, onEvent: e => events.push(e) };
}

const LOGIN = "codex login --device-auth";
const NOT_SIGNED_IN = codexNotSignedInLine(LOGIN);
const adapterOver = (exec: ScriptedExec, graceMs?: number, stallMs?: number) =>
  createCodexAdapter({ exec: exec.factory, home: "/root/.codex", login: LOGIN, ...(graceMs !== undefined ? { interruptGraceMs: graceMs } : {}), ...(stallMs !== undefined ? { reconnectStallMs: stallMs } : {}) });
const started = `{"type":"thread.started","thread_id":"${THREAD_ID}"}`;
const reconnecting = '{"type":"error","message":"Reconnecting... waiting for network (Connection failed: error sending request)"}';

describe("CodexAdapter over a codex exec --json turn", () => {
  it("launches codex exec with the picks, under CODEX_HOME, with no stdin channel since the prompt rides the heredoc", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn"));
    const adapter = adapterOver(exec);
    const session = adapter.start({ prompt: "list the repo", model: "gpt-5.5", effort: "low", permissionMode: "workspace-write", cwd: "/root/app", onEvent: () => {} });
    await session.finished;
    const call = exec.calls[0]!;
    expect(call.command.startsWith("cd '/root/app' && codex exec --json --skip-git-repo-check")).toBe(true);
    expect(call.command).toContain("-m gpt-5.5");
    expect(call.command).toContain(`-c model_reasoning_effort='"low"'`);
    expect(call.command).toContain(`-c sandbox_mode='"workspace-write"'`);
    expect(call.command).toContain("list the repo");
    expect(call.input).toBeUndefined();
    expect(call.env).toEqual({ CODEX_HOME: "/root/.codex" });
    expect(adapter.env).toEqual({ CODEX_HOME: "/root/.codex" });
    expect(session.command).toBe(call.command);
  });

  it("a launched session carries the run its stream reported, and an attach re-opens that run with no channel", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn"));
    const attached: { run: string; input: boolean }[] = [];
    exec.factory.attach = async (run, options) => {
      attached.push({ run, input: options.input });
      return exec.factory("", { env: {} });
    };
    const adapter = adapterOver(exec);
    expect(adapter.start({ prompt: "go", onEvent: () => {} }).run).toBe(RUN_HANDLE);
    const { events, onEvent } = collect();
    const session = (await adapter.attach!({ run: RUN_HANDLE, sessionId: THREAD_ID, startedAt: 1, model: "gpt-5.5", cwd: "/root/app", onEvent })) as CodexSession;
    const result = await session.finished;
    expect(attached).toEqual([{ run: RUN_HANDLE, input: false }]);
    expect(session.command).toBeUndefined();
    expect(result.status).toBe("completed");
    // the CLI names its model and its folder once, so a reader that came later takes both off the row
    expect(events[0]).toMatchObject({ type: "session.start", sessionId: THREAD_ID, model: "gpt-5.5", cwd: "/root/app" });
    expect(events.slice(-2)).toMatchObject([{ type: "turn.done" }, { type: "session.end", exitCode: 0, sawResult: true }]);
  });

  it("normalizes the stream into session.start, one delta per item, turn.done and session.end", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn"));
    const { events, onEvent } = collect();
    const session = adapterOver(exec).start({ prompt: "list the repo", cwd: "/root/app", onEvent });
    const result = await session.finished;

    expect(events.map(e => e.type)).toEqual(["session.start", ...Array<string>(11).fill("turn.delta"), "turn.done", "session.end"]);
    expect(events[0]).toEqual({ type: "session.start", sessionId: THREAD_ID, cwd: "/root/app" });

    const deltas = events.filter((e): e is Extract<AdapterEvent, { type: "turn.delta" }> => e.type === "turn.delta");
    expect(deltas.map(d => [d.kind, d.toolName, d.toolUseId])).toEqual([
      ["thinking", undefined, undefined],
      ["tool_use", "command_execution", "item_1"],
      ["tool_result", undefined, "item_1"],
      ["tool_use", "file_change", "item_2"],
      ["tool_result", undefined, "item_2"],
      ["tool_use", "wsp.threads", "item_3"],
      ["tool_result", undefined, "item_3"],
      ["tool_use", "web_search", "item_4"],
      ["tool_result", undefined, "item_4"],
      ["note", undefined, undefined],
      ["text", undefined, undefined],
    ]);
    // Every tool_use has its tool_result, so no entry of the timeline is left running once the turn ended.
    const opened = deltas.filter(d => d.kind === "tool_use").map(d => d.toolUseId);
    const closed = deltas.filter(d => d.kind === "tool_result").map(d => d.toolUseId);
    for (const id of opened) expect(closed, id).toContain(id);
    expect(deltas[0]!.text).toBe("Listing the repository first.");
    expect(deltas[1]!.text).toBe(JSON.stringify({ command: "bash -lc ls" }));
    expect(deltas[2]).toMatchObject({ text: "docs\nsdk\nexamples\n", isError: false });
    expect(deltas[3]!.text).toBe(JSON.stringify({ changes: [{ path: "README.md", kind: "update" }, { path: "docs/new.md", kind: "add" }] }));
    expect(deltas[4]).toMatchObject({ text: "update README.md\nadd docs/new.md", isError: false });
    expect(deltas[5]!.text).toBe(JSON.stringify({ workspace: "first" }));
    expect(deltas[6]).toMatchObject({ text: JSON.stringify([{ type: "text", text: '{"threads":[]}' }]), isError: false });
    expect(deltas[7]!.text).toBe(JSON.stringify({ query: "codex exec json" }));
    expect(deltas[8]).toMatchObject({ text: "codex exec json", isError: false });
    expect(deltas[9]).toEqual({ type: "turn.delta", sessionId: THREAD_ID, kind: "note", text: "one MCP server did not answer" });
    expect(deltas[10]!.text).toBe("Repo contains docs, sdk, and examples directories.");
    for (const d of deltas) expect(d.sessionId).toBe(THREAD_ID);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Repo contains docs, sdk, and examples directories.");
    expect(result.usage).toEqual({ input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: THREAD_ID, exitCode: 0, sawResult: true });
    expect(session.threadId).toBe(THREAD_ID);
    expect(session.localId).not.toBe(THREAD_ID);
  });

  it("reads the CLI's own warning about itself as a note, not as a call that failed, and the turn still completes", async () => {
    const warning = "loading hooks from both /root/.codex/hooks.json and /root/.codex/config.toml; prefer a single representation for this layer";
    const exec = scriptedExec([started, `{"type":"item.completed","item":{"id":"item_0","type":"error","message":${JSON.stringify(warning)}}}`, '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ready"}}', '{"type":"turn.completed","usage":{"output_tokens":1}}']);
    const { events, onEvent } = collect();
    const result = await adapterOver(exec).start({ prompt: "say ready", onEvent }).finished;

    const deltas = events.filter((e): e is Extract<AdapterEvent, { type: "turn.delta" }> => e.type === "turn.delta");
    expect(deltas.map(d => [d.kind, d.text])).toEqual([["note", warning], ["text", "ready"]]);
    expect(deltas.some(d => d.isError === true)).toBe(false);
    expect(result.status).toBe("completed");
  });

  it("carries the CLI's own id for the message each reply came out of, so two replies of one turn read as two", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn"));
    const { events, onEvent } = collect();
    await adapterOver(exec).start({ prompt: "list the repo", onEvent }).finished;

    const deltas = events.filter((e): e is Extract<AdapterEvent, { type: "turn.delta" }> => e.type === "turn.delta");
    expect(deltas.filter(d => d.kind === "text").map(d => d.messageId)).toEqual(["item_7"]);
  });

  it("a turn.failed is a failed result carrying the CLI's own reason, and the stream's error lines are not deltas", async () => {
    const exec = scriptedExec([`{"type":"thread.started","thread_id":"${THREAD_ID}"}`, '{"type":"turn.started"}', '{"type":"error","message":"Reconnecting... 2/5 (stream disconnected)"}', '{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}'], { exitCode: 1 });
    const { events, onEvent } = collect();
    const result = await adapterOver(exec).start({ prompt: "x", onEvent }).finished;
    expect(events.map(e => e.type)).toEqual(["session.start", "turn.done", "session.end"]);
    expect(result).toMatchObject({ status: "failed", error: "stream disconnected before completion" });
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: THREAD_ID, exitCode: 1, sawResult: true });
  });

  it("a 401 the CLI retried and then failed the turn on is the sign-in line, in the protocol's words", async () => {
    const exec = scriptedExec(fixtureLines("failed-turn"), { exitCode: 1 });
    const { events, onEvent } = collect();
    const result = await adapterOver(exec).start({ prompt: "x", onEvent }).finished;
    expect(NOT_SIGNED_IN).toBe("Codex is not signed in where this workspace runs; run codex login --device-auth there");
    // The cause rides the result, as it does on the other CLI: a turn refused for want of a sign-in did no work.
    expect(result).toMatchObject({ status: "failed", error: NOT_SIGNED_IN, refusal: "sign-in" });
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: FAILED_THREAD_ID, exitCode: 1, sawResult: true });
  });

  it("a 401 on a turn that was handed the vault's key is said as a refused key, with the provider's own reason", async () => {
    const withKey = (exec: ScriptedExec) => createCodexAdapter({ exec: exec.factory, home: "/root/.codex", login: LOGIN, apiKey: "sk-ant-x-not-a-key", keyEnv: "OPENAI_API_KEY" });
    const said = '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: token expired)"}';
    const refused = await withKey(scriptedExec([started, said, '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: token expired"}}'], { exitCode: 1 })).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(refused).toMatchObject({ status: "failed", error: codexKeyRefusedLine("OPENAI_API_KEY", "token expired", LOGIN), refusal: "sign-in" });

    // A status the CLI said nothing after still names the key: what is wrong with it is the provider's to say.
    const bare = await withKey(scriptedExec([started, '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}'], { exitCode: 1 })).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(bare).toMatchObject({ status: "failed", error: codexKeyRefusedLine("OPENAI_API_KEY", "", LOGIN), refusal: "sign-in" });

    // No key was handed, so nothing was refused: the turn ran with no credential at all and the line says so.
    const none = await adapterOver(scriptedExec([started, '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: token expired"}}'], { exitCode: 1 })).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(none).toMatchObject({ status: "failed", error: NOT_SIGNED_IN, refusal: "sign-in" });
  });

  it("a fatal error event followed by an exit with no turn.failed keeps that event's message, not the stderr tail", async () => {
    const exec = scriptedExec([started, '{"type":"turn.started"}', "2026-09-07T01:10:02Z WARN codex_core: slow disk", '{"type":"error","message":"stream closed by the provider"}'], { exitCode: 1 });
    const result = await adapterOver(exec).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toEqual({ status: "failed", error: "codex exited with code 1 before its turn ended: stream closed by the provider" });
  });

  it("a 401 the CLI retried and then died on with exit 101 and no turn event, as codex-cli 0.153.0 does, is the sentence alone", async () => {
    const exec = scriptedExec(fixtureLines("no-login-0153"), { exitCode: 101 });
    const { events, onEvent } = collect();
    const result = await adapterOver(exec).start({ prompt: "x", onEvent }).finished;
    expect(result).toEqual({ status: "failed", error: NOT_SIGNED_IN, refusal: "sign-in" });
    // The CLI announced its session on thread.started, before it could know it had no sign-in, so the announce is
    // no sign that the turn worked: the cause is what says it did none.
    expect(events.map(e => e.type)).toEqual(["session.start", "turn.done", "session.end"]);
    expect(events.at(-1)).toMatchObject({ type: "session.end", exitCode: 101, sawResult: false });
  });

  it("an exit 101 with no 401 in sight is a death like any other: the exit code and the CLI's last lines, no guess at a login", async () => {
    const exec = scriptedExec([started, "thread 'main' panicked at core/src/rollout.rs"], { exitCode: 101 });
    const result = await adapterOver(exec).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toEqual({ status: "failed", error: "codex exited with code 101 before its turn ended: thread 'main' panicked at core/src/rollout.rs" });
  });

  it("the last failure seen wins: a 401 in an early reconnect line, then a turn that recovers and fails for another reason, names that reason", async () => {
    const exec = scriptedExec([started, '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: token expired)"}', '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"partway"}}', '{"type":"turn.failed","error":{"message":"Missing environment variable: `LATER_KEY`."}}'], { exitCode: 1 });
    const result = await adapterOver(exec).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toMatchObject({ status: "failed", error: codexMissingEnvLine("LATER_KEY") });
    // A missing variable is not a refusal wsp classes: the later failure's words win and they claim no cause.
    expect(result.refusal).toBeUndefined();
  });

  it("a process that dies after thread.started fails under the announced thread id with its last stderr lines", async () => {
    const exec = scriptedExec([`{"type":"thread.started","thread_id":"${THREAD_ID}"}`, "2026-09-07T00:51:50Z ERROR codex_core: sandbox unavailable"], { exitCode: 2 });
    const { events, onEvent } = collect();
    const result = await adapterOver(exec).start({ prompt: "x", onEvent }).finished;
    expect(result).toEqual({ status: "failed", error: "codex exited with code 2 before its turn ended: 2026-09-07T00:51:50Z ERROR codex_core: sandbox unavailable" });
    expect(events.map(e => [e.type, e.sessionId])).toEqual([["session.start", THREAD_ID], ["turn.done", THREAD_ID], ["session.end", THREAD_ID]]);
  });

  it("a transport that ends the turn itself makes its message the turn's error", async () => {
    const exec = scriptedExec([]);
    const failing: ExecStreamFactory = (command, options) => ({
      ...exec.factory(command, options),
      lines: (async function* () {
        yield `{"type":"thread.started","thread_id":"${THREAD_ID}"}`;
        throw new Error("turn cut: idle 10m");
      })(),
      exited: Promise.resolve(null),
    });
    const result = await createCodexAdapter({ exec: failing, home: "/root/.codex", login: LOGIN }).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toEqual({ status: "failed", error: "turn cut: idle 10m" });
  });

  it("resumes with the thread id as the registry key and the command's resume word; the thread.started a resume re-emits keeps that id", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn"));
    const adapter = adapterOver(exec);
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "next", resume: THREAD_ID, cwd: "/root/app", onEvent });
    await session.finished;
    expect(session.localId).toBe(THREAD_ID);
    expect(session.threadId).toBe(THREAD_ID);
    expect(adapter.sessions.get(THREAD_ID)).toBe(session);
    expect(exec.calls[0]!.command).toContain(`codex exec resume ${THREAD_ID} --json`);
    expect(events[0]).toEqual({ type: "session.start", sessionId: THREAD_ID, cwd: "/root/app" });
    expect(new Set(events.map(e => e.sessionId))).toEqual(new Set([THREAD_ID]));
  });

  it("reads a codex-cli 0.153.0 turn: the metadata warning item before turn.started, the message, and usage with its new field", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn-0153"));
    const { events, onEvent } = collect();
    const result = await adapterOver(exec).start({ prompt: "say hi", onEvent }).finished;
    expect(events.map(e => e.type)).toEqual(["session.start", "turn.delta", "turn.delta", "turn.done", "session.end"]);
    expect(events[1]).toMatchObject({ kind: "note", text: expect.stringContaining("Model metadata for `fake-model` not found") });
    expect(events[2]).toMatchObject({ kind: "text", text: "fake reply to: say hi" });
    expect(result).toMatchObject({ status: "completed", text: "fake reply to: say hi", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } });
  });

  it("a provider whose env_key variable is unset fails the turn naming that variable, in the protocol's words", async () => {
    const exec = scriptedExec([started, '{"type":"turn.started"}', '{"type":"error","message":"Missing environment variable: `FAKE_API_KEY`."}', '{"type":"turn.failed","error":{"message":"Missing environment variable: `FAKE_API_KEY`."}}'], { exitCode: 1 });
    const result = await adapterOver(exec).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(codexMissingEnvLine("FAKE_API_KEY")).toBe("Codex's model provider reads its key from the environment variable FAKE_API_KEY, which is not set on this machine");
    expect(result).toMatchObject({ status: "failed", error: codexMissingEnvLine("FAKE_API_KEY") });
  });

  it("a provider that never answers: the CLI reconnects forever, so the adapter ends the turn in words and kills the process", async () => {
    const exec = scriptedExec([started, '{"type":"turn.started"}', reconnecting, reconnecting], { hang: true });
    const { events, onEvent } = collect();
    const result = await adapterOver(exec, 10, 20).start({ prompt: "x", onEvent }).finished;
    expect(exec.order).toEqual(["teardown", "kill"]);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^stopped after \d+m \d\ds of Codex reconnecting to its model provider with no answer$/);
    expect(codexReconnectLine(90_000)).toBe("stopped after 1m 30s of Codex reconnecting to its model provider with no answer");
    expect(events.at(-1)).toMatchObject({ type: "session.end", exitCode: null, sawResult: false });
  });

  it("a reconnect run that recovers into a turn is not cut, and the clock starts over on the next run", async () => {
    const exec = scriptedExec([started, reconnecting, '{"type":"turn.started"}', reconnecting, '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"back"}}', '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}']);
    const result = await adapterOver(exec, 10, 20).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toMatchObject({ status: "completed", text: "back" });
    expect(exec.order).toEqual([]);
  });

  it("does not steer: sessions carry no steer and the adapter says so, so the runtime queues a second message", () => {
    const adapter = adapterOver(scriptedExec([]));
    expect(adapter.steers).toBe(false);
    expect("steer" in adapter.start({ prompt: "x", onEvent: () => {} })).toBe(false);
  });

  it("refuses a context window, which codex has no flag for", () => {
    expect(() => adapterOver(scriptedExec([])).start({ prompt: "x", contextWindow: "1m", onEvent: () => {} })).toThrow("codex takes no context window");
  });
});

describe("interrupt policy (teardown, then SIGKILL)", () => {
  it("escalates to kill when teardown does not end the process, and reports the turn interrupted", async () => {
    const exec = scriptedExec([`{"type":"thread.started","thread_id":"${THREAD_ID}"}`], { hang: true });
    const { events, onEvent } = collect();
    const session = adapterOver(exec, 15).start({ prompt: "loop forever", onEvent });
    await session.interrupt();
    const result = await session.finished;
    expect(exec.order).toEqual(["teardown", "kill"]);
    expect(result).toEqual({ status: "interrupted" });
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: THREAD_ID, exitCode: null, sawResult: false });
  });

  it("does not kill when teardown ends the process within the grace window", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn"));
    const session = adapterOver(exec, 5_000).start({ prompt: "x", onEvent: () => {} });
    await session.finished;
    await session.interrupt();
    expect(exec.order).toEqual(["teardown"]);
  });
});

describe("the process a finished turn leaves", () => {
  it("a CLI that does not go after its own turn.completed is ended with its tree, and the turn still reads as its reply", async () => {
    const exec = scriptedExec([started, '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}', '{"type":"turn.completed","usage":{"output_tokens":1}}'], { hang: true });
    const { events, onEvent } = collect();
    const adapter = createCodexAdapter({ exec: exec.factory, home: "/root/.codex", login: LOGIN, interruptGraceMs: 15, resultExitMs: 15 });

    const result = await adapter.start({ prompt: "x", onEvent }).finished;

    expect(exec.order).toEqual(["teardown", "kill"]);
    expect(result).toMatchObject({ status: "completed", text: "done" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
  });

  it("a CLI that ends its own process is left alone", async () => {
    const exec = scriptedExec(fixtureLines("exec-turn"));
    const adapter = createCodexAdapter({ exec: exec.factory, home: "/root/.codex", login: LOGIN, interruptGraceMs: 15, resultExitMs: 15 });
    expect((await adapter.start({ prompt: "x", onEvent: () => {} }).finished).status).toBe("completed");
    await new Promise(r => setTimeout(r, 60));
    expect(exec.order).toEqual([]);
  });
});
