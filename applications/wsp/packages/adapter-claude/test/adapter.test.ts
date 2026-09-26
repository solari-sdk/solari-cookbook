import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { signInRefusalLine } from "@wsp/protocol";
import type { AdapterEvent, ExecStream, ExecStreamFactory, TurnResult } from "@wsp/protocol";
import { createClaudeAdapter, type ClaudeSession } from "../src/adapter.js";
import { CLAUDE_SCREEN_COMMANDS } from "../src/catalog.js";
import { userMessageLine } from "../src/landmines.js";
import { AGENT_A_CALL, AGENT_B_CALL, subagentFixtureLines } from "./subagent-fixture.js";

const FIXTURE_SESSION_ID = "e16ed170-8257-4668-879e-fe836341633c";

function fixtureLines(): string[] {
  const raw = readFileSync(new URL("./fixtures/stream-session.jsonl", import.meta.url), "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}


/** What the guest calls the run every scripted stream stands for. */
const RUN_HANDLE = "/tmp/wsp-run/ab12";
/** A guest's login environment as the runtime hands it: the store variable and the sandbox flag are the machine's own. */
const GUEST_ENV = { HOME: "/root", CLAUDE_CONFIG_DIR: "/root/.claude-cfg", IS_SANDBOX: "1" };

interface ScriptedExec {
  factory: ExecStreamFactory;
  calls: { command: string; env: Record<string, string>; input: readonly string[] | undefined }[];
  order: string[];
}

/** Replays scripted stdout lines; in hang mode the stream only ends on kill(). */
function scriptedExec(lines: string[], opts: { exitCode?: number | null; hang?: boolean; signalled?: string } = {}): ScriptedExec {
  const calls: ScriptedExec["calls"] = [];
  const order: string[] = [];
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const stream: ExecStream = {
      run: RUN_HANDLE,
      lines: (async function* () {
        yield* lines;
        if (opts.hang) await exited;
        else resolveExit(opts.exitCode === undefined ? 0 : opts.exitCode);
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
      ...(opts.signalled !== undefined ? { signalled: opts.signalled } : {}),
    };
    return stream;
  };
  return { factory, calls, order };
}

/** A stream the test feeds line by line and ends by hand, with every write recorded; beforeWrite runs inside write() before the line lands, gone makes the guest report the process over so no line lands, and slowTeardown leaves the process up after teardown, as a CLI held by background tasks is. */
function manualExec(opts: { beforeWrite?: () => Promise<void>; gone?: boolean; slowTeardown?: boolean } = {}) {
  const calls: ScriptedExec["calls"] = [];
  const writes: string[] = [];
  const order: string[] = [];
  let push: (line: string) => void = () => {};
  let end: (code: number | null) => void = () => {};
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const exited = new Promise<number | null>((resolve) => {
      end = (code) => {
        ended = true;
        resolve(code);
        wake?.();
      };
    });
    push = (line) => {
      queue.push(line);
      wake?.();
    };
    const lines = (async function* () {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    })();
    return {
      lines,
      exited,
      teardown: () => {
        order.push("teardown");
        if (opts.slowTeardown !== true) end(143);
      },
      kill: () => {
        order.push("kill");
        end(null);
      },
      write: async (line) => {
        order.push("write");
        await opts.beforeWrite?.();
        if (opts.gone === true) return "gone";
        writes.push(line);
        return "written";
      },
      closeInput: () => {
        order.push("closeInput");
      },
    };
  };
  return { factory, calls, writes, order, push: (line: string) => push(line), end: (code: number | null) => end(code) };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!check()) throw new Error("condition never held");
}

function collect(): { events: AdapterEvent[]; onEvent: (e: AdapterEvent) => void } {
  const events: AdapterEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe("the commands this CLI runs only in its own terminal", () => {
  it("are one table the adapter declares, by name without a slash, each with the wsp control that serves it", () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    expect(adapter.screenCommands).toBe(CLAUDE_SCREEN_COMMANDS);
    // A headless turn answers each of these with "isn't available in this environment" (seen from wsp 0.2.0, 2026-09-10).
    expect(CLAUDE_SCREEN_COMMANDS.map(c => c.name)).toEqual(["login", "logout", "model", "permissions", "config", "help"]);
    expect(CLAUDE_SCREEN_COMMANDS.map(c => c.control)).toEqual(["sign-in", "sign-in", "model", "access", "settings", "docs"]);
    for (const c of CLAUDE_SCREEN_COMMANDS) expect(c.name).not.toMatch(/^\//);
    expect(new Set(CLAUDE_SCREEN_COMMANDS.map(c => c.name)).size).toBe(CLAUDE_SCREEN_COMMANDS.length);
  });
});

describe("ClaudeAdapter over the recorded fixture", () => {
  it("launches with the picked model, effort and permission mode", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", model: "claude-opus-5", effort: "low", permissionMode: "plan", onEvent: () => {} });
    await session.finished;
    expect(exec.calls[0]?.command).toContain("--model 'claude-opus-5'");
    expect(exec.calls[0]?.command).toContain("--effort 'low'");
    expect(exec.calls[0]?.command).toContain("--permission-mode 'plan'");
  });

  it("a launched session carries the run its stream reported, so a later host can re-open it", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", onEvent: () => {} });
    await session.finished;
    expect(session.run).toBe(RUN_HANDLE);
  });

  it("attaches to a run an earlier process launched: the run's own lines settle the turn and no command is launched", async () => {
    const exec = scriptedExec(fixtureLines());
    const attached: { run: string; input: boolean }[] = [];
    exec.factory.attach = async (run, options) => {
      attached.push({ run, input: options.input });
      return exec.factory("", { env: {} });
    };
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = await adapter.attach!({ run: RUN_HANDLE, sessionId: "e16ed170-8257-4668-879e-fe836341633c", startedAt: 1, onEvent });
    expect(session).not.toBe("gone");
    const result = await (session as ClaudeSession).finished;
    expect(attached).toEqual([{ run: RUN_HANDLE, input: true }]);
    expect((session as ClaudeSession).command).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(events[0]).toMatchObject({ type: "session.start", sessionId: "e16ed170-8257-4668-879e-fe836341633c" });
    expect(events.filter(e => e.type === "turn.delta").length).toBeGreaterThan(0);
    expect(events.slice(-2)).toMatchObject([{ type: "turn.done" }, { type: "session.end", exitCode: 0, sawResult: true }]);
  });

  it("a machine that no longer holds the run is passed through as gone, with no session and no event", async () => {
    const exec = scriptedExec(fixtureLines());
    exec.factory.attach = async () => "gone";
    const { events, onEvent } = collect();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    expect(await adapter.attach!({ run: RUN_HANDLE, sessionId: "s", startedAt: 1, onEvent })).toBe("gone");
    expect(events).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it("an adapter whose exec cannot attach has no attach of its own", () => {
    const exec = scriptedExec([]);
    delete exec.factory.attach;
    expect(createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" }).attach).toBeUndefined();
  });

  it("probes the catalog through the exec it is handed, under the session's config dir, and reads the answer", async () => {
    const adapter = createClaudeAdapter({ exec: scriptedExec([]).factory, configDir: "/root/.claude-cfg", baseEnv: GUEST_ENV });
    const ran: string[] = [];
    const probe = await adapter.probeCatalog(async command => {
      ran.push(command);
      return readFileSync(new URL("./fixtures/catalog-probe.txt", import.meta.url), "utf8");
    });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain("CLAUDE_CONFIG_DIR='/root/.claude-cfg'");
    expect(probe?.version).toBe("2.1.257");
    expect(probe?.models.map(m => m.slug)).toContain("claude-opus-5");
    expect(await adapter.probeCatalog(async () => "garbage\n")).toBeNull();
  });

  it("normalizes the stream into session.start / turn.delta / turn.done / session.end", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "write a hello world server", onEvent });
    const result = await session.finished;

    expect(events.map((e) => e.type)).toEqual([
      "session.start",
      "turn.delta",
      "turn.delta",
      "turn.delta",
      "turn.delta",
      "turn.delta",
      "turn.done",
      "session.end",
    ]);

    const start = events[0];
    if (start?.type !== "session.start") throw new Error("expected session.start");
    expect(start.sessionId).toBe(FIXTURE_SESSION_ID);
    expect(start.model).toBe("claude-sonnet-4-5");
    expect(start.cwd).toBe("/root");
    expect(start.tools).toContain("Bash");

    const deltas = events.filter((e) => e.type === "turn.delta");
    expect(deltas.map((d) => d.kind)).toEqual([
      "text",
      "tool_use",
      "tool_result",
      "thinking",
      "text",
    ]);
    const toolUse = deltas[1];
    expect(toolUse?.toolName).toBe("Bash");
    expect(toolUse?.toolUseId).toBe("toolu_01WspFixBash1");
    expect(toolUse?.text).toContain("curl -s http://localhost:3000");
    const toolResult = deltas[2];
    expect(toolResult?.text).toBe("Hello, World!");
    expect(toolResult?.isError).toBe(false);
    expect(deltas[3]?.text).toContain("server is live");

    expect(result.status).toBe("completed");
    expect(result.durationMs).toBe(10458);
    expect(result.costUsd).toBe(0.0187);
    expect(result.text).toBe("Server is live at :3000 and answered: Hello, World!");

    const end = events.at(-1);
    if (end?.type !== "session.end") throw new Error("expected session.end");
    expect(end.exitCode).toBe(0);
    expect(end.sawResult).toBe(true);
    expect(session.claudeSessionId).toBe(FIXTURE_SESSION_ID);
  });

  it("carries the CLI's own id for each message its text came out of, so two replies of one turn read as two", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    await adapter.start({ prompt: "write a hello world server", onEvent }).finished;

    const deltas = events.filter(e => e.type === "turn.delta");
    expect(deltas.filter(d => d.kind === "text").map(d => d.messageId)).toEqual(["msg_01WspFixA1", "msg_01WspFixA4"]);
  });

  it("stamps every line a subagent wrote with the call that launched it, and leaves the thread's own unstamped", async () => {
    const exec = scriptedExec(subagentFixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    await adapter.start({ prompt: "fan out", onEvent }).finished;

    const deltas = events.filter(e => e.type === "turn.delta");
    // The parent's own lines carry nothing; a child's carries the call that launched it, and the two children's
    // identical sentences are told apart by that alone.
    expect(deltas.map(d => d.parentToolUseId)).toEqual([
      undefined, undefined, undefined,
      AGENT_A_CALL, AGENT_B_CALL, AGENT_A_CALL, AGENT_B_CALL, AGENT_B_CALL, AGENT_A_CALL,
      undefined, undefined,
    ]);
    const [saidA, saidB] = [deltas[3], deltas[4]];
    expect(saidA?.text).toBe(saidB?.text);
    expect(saidA?.parentToolUseId).not.toBe(saidB?.parentToolUseId);
    // The frame that binds the CLI's handle for a subagent to its launching call is bookkeeping, not a line of
    // the turn's: nothing is drawn for it.
    expect(deltas.some(d => d.text.includes("task_started"))).toBe(false);
  });

  it("forwards system/init's slash_commands, permissionMode and agents as harness", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    await adapter.start({ prompt: "write a hello world server", onEvent }).finished;

    const start = events[0];
    if (start?.type !== "session.start") throw new Error("expected session.start");
    expect(start.harness).toEqual({
      slashCommands: ["compact", "context", "cost", "init", "review"],
      permissionMode: "bypassPermissions",
      agents: ["general-purpose"],
    });
  });

  it("leaves harness unset when system/init carries none of its fields", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init]);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    await adapter.start({ prompt: "x", onEvent }).finished;

    const start = events[0];
    if (start?.type !== "session.start") throw new Error("expected session.start");
    expect(start.harness).toBeUndefined();
    expect("harness" in start).toBe(false);
  });

  it("spawns with the landmine-safe command and env", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({
      exec: exec.factory,
      configDir: "/root/.claude-cfg",
      baseEnv: { ...GUEST_ENV, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/usr/bin", HOME: "/Users/z" },
    });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "say ok", onEvent });
    await session.finished;

    const call = exec.calls[0];
    if (!call) throw new Error("exec never called");
    expect(call.command).toContain("--output-format stream-json");
    expect(call.command).toContain("--input-format stream-json");
    expect(call.command).toContain("--verbose");
    expect(call.command).toContain("--dangerously-skip-permissions");
    expect(call.command).toContain(`--session-id ${session.localId}`);
    // The prompt is the first line of the stdin channel, seeded at launch; the shell never sees it.
    expect(call.command).not.toContain("</dev/null");
    expect(call.command).not.toContain("say ok");
    expect(call.input).toEqual([userMessageLine("say ok", session.localId)]);
    expect(call.env.CLAUDECODE).toBeUndefined();
    expect(call.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(call.env.CLAUDE_CONFIG_DIR).toBe("/root/.claude-cfg");
    expect(call.env.IS_SANDBOX).toBe("1");
    expect(call.env.HOME).toBe("/Users/z");
  });

  it("on a person's own computer exports no config dir and no sandbox flag, and reads the store under their home", async () => {
    // Their shell sets neither, so a launch sets neither: Claude keys its Keychain login by whether the variable is
    // set, and the flag is a machine's fact. The transcript and the session store are still read under ~/.claude.
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/Users/z/.claude", baseEnv: { PATH: "/usr/bin", HOME: "/Users/z" } });
    const { onEvent } = collect();
    await adapter.start({ prompt: "say ok", onEvent }).finished;
    const call = exec.calls[0];
    if (!call) throw new Error("exec never called");
    expect(call.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(call.env.IS_SANDBOX).toBeUndefined();
    expect(adapter.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    const ran: string[] = [];
    await adapter.sessionTitle(FIXTURE_SESSION_ID, async command => (ran.push(command), ""));
    await adapter.probeCatalog(async command => (ran.push(command), ""));
    expect(ran[0]).toContain("'/Users/z/.claude/projects'");
    expect(ran[1]).not.toContain("CLAUDE_CONFIG_DIR");
    expect(ran[1]).not.toContain("IS_SANDBOX");
  });

  it("refuses a relative config dir, since every transcript and title read is built on it", () => {
    expect(() => createClaudeAdapter({ exec: scriptedExec([]).factory, configDir: ".claude-cfg" })).toThrow(/absolute/);
  });

  it("on a person's own computer whose shell names a store, exports theirs unchanged", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/Users/z/elsewhere", baseEnv: { PATH: "/usr/bin", HOME: "/Users/z", CLAUDE_CONFIG_DIR: "/Users/z/elsewhere" } });
    const { onEvent } = collect();
    await adapter.start({ prompt: "say ok", onEvent }).finished;
    expect(exec.calls[0]?.env.CLAUDE_CONFIG_DIR).toBe("/Users/z/elsewhere");
    expect(exec.calls[0]?.env.IS_SANDBOX).toBeUndefined();
  });

  it("starts claude in the guest home unless a cwd is named", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    await adapter.start({ prompt: "say ok", onEvent }).finished;
    await adapter.start({ prompt: "say ok", cwd: "/root/app", onEvent }).finished;

    expect(exec.calls[0]?.command.startsWith("cd ~ && claude -p")).toBe(true);
    expect(exec.calls[1]?.command.startsWith("cd '/root/app' && claude -p")).toBe(true);
  });

  it("self-generates the session UUID and registers the session before any output", () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "say ok", onEvent });

    expect(session.localId).toMatch(/^[0-9a-f-]{36}$/);
    expect(adapter.sessions.get(session.localId)).toBe(session);
  });

  it("resumes with the prior session id as the registry key", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "next turn", resume: FIXTURE_SESSION_ID, onEvent });
    await session.finished;

    expect(session.localId).toBe(FIXTURE_SESSION_ID);
    expect(exec.calls[0]?.command).toContain(`--resume ${FIXTURE_SESSION_ID}`);
  });
});

describe("interrupt policy (teardown, then SIGKILL)", () => {
  it("escalates to kill when teardown does not end the process, and reports the turn interrupted", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init], { hang: true });
    const adapter = createClaudeAdapter({
      exec: exec.factory,
      configDir: "/root/.claude-cfg",
      interruptGraceMs: 15,
    });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "loop forever", onEvent });
    await session.interrupt();
    const result = await session.finished;

    expect(exec.order).toEqual(["teardown", "kill"]);
    expect(result.status).toBe("interrupted");
    const end = events.at(-1);
    if (end?.type !== "session.end") throw new Error("expected session.end");
    expect(end.sawResult).toBe(false);
    expect(end.exitCode).toBeNull();
  });

  it("does not kill when teardown ends the process within the grace window", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({
      exec: exec.factory,
      configDir: "/root/.claude-cfg",
      interruptGraceMs: 5_000,
    });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "say ok", onEvent });
    await session.finished;
    await session.interrupt();

    expect(exec.order).toEqual(["closeInput", "teardown"]);
  });
});

describe("the process a finished turn leaves", () => {
  const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
  const result = `{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":5,"usage":{"output_tokens":3},"session_id":"${FIXTURE_SESSION_ID}"}`;

  it("a CLI that does not go on the EOF its result closed the channel with is ended with its tree, and the turn still reads as its reply", async () => {
    const exec = manualExec({ slowTeardown: true });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 15, interruptGraceMs: 15 });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    exec.push(result);
    const turn = await session.finished;

    expect(exec.order).toEqual(["closeInput", "teardown", "kill"]);
    expect(turn).toMatchObject({ status: "completed", text: "ok" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
  });

  it("a CLI that goes on its own is left alone: nothing is signalled after the channel closed", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 15, interruptGraceMs: 15 });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    exec.push(result);
    await until(() => events.some(e => e.type === "turn.done"));
    exec.end(0);
    expect((await session.finished).status).toBe("completed");
    await new Promise(r => setTimeout(r, 60));

    expect(exec.order).toEqual(["closeInput"]);
  });
});

describe("steer over the stdin channel", () => {
  const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
  const result = `{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":5,"session_id":"${FIXTURE_SESSION_ID}"}`;

  it("declares that its sessions take a message mid-turn", () => {
    expect(createClaudeAdapter({ exec: manualExec().factory, configDir: "/root/.claude-cfg" }).steers).toBe(true);
  });

  it("before system/init answers not-running and writes nothing", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", onEvent: () => {} });
    expect(await session.steer("also this")).toBe("not-running");
    expect(exec.writes).toEqual([]);
    exec.end(0);
    await session.finished;
  });

  it("between init and result writes one user line under the CLI's session id and answers accepted", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    expect(await session.steer("also this")).toBe("accepted");
    expect(exec.writes).toEqual([userMessageLine("also this", FIXTURE_SESSION_ID)]);
    expect(exec.order).toEqual(["write"]);
    exec.push(result);
    exec.end(0);
    expect((await session.finished).status).toBe("completed");
  });

  it("after result answers not-running, and result closed the channel once", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    exec.push(result);
    await until(() => events.some((e) => e.type === "turn.done"));
    expect(exec.order).toEqual(["closeInput"]);
    expect(await session.steer("too late")).toBe("not-running");
    expect(exec.writes).toEqual([]);
    exec.end(0);
    await session.finished;
    expect(exec.order).toEqual(["closeInput"]);
  });

  it("after the process exited without a result answers not-running", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", onEvent: () => {} });
    exec.push(init);
    exec.end(1);
    await session.finished;
    expect(await session.steer("too late")).toBe("not-running");
    expect(exec.writes).toEqual([]);
  });

  it("when the guest says the process is already gone, before the poll saw it, answers not-running and no line landed", async () => {
    const exec = manualExec({ gone: true });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    expect(await session.steer("after exit")).toBe("not-running");
    expect(exec.order).toEqual(["write"]);
    expect(exec.writes).toEqual([]);
    exec.end(1);
    expect((await session.finished).status).toBe("failed");
  });

  it("once interrupt was asked answers not-running and writes nothing, before the process is seen to exit", async () => {
    const exec = manualExec({ slowTeardown: true });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", interruptGraceMs: 30 });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    const interrupting = session.interrupt();
    expect(exec.order).toEqual(["teardown"]);
    expect(await session.steer("into a stopping turn")).toBe("not-running");
    expect(exec.writes).toEqual([]);
    await interrupting;
    expect(exec.order).toEqual(["teardown", "kill"]);
    expect((await session.finished).status).toBe("interrupted");
  });

  it("a write that lands after the turn ended answers not-running: the line sits unread and the caller starts a turn instead", async () => {
    const { events, onEvent } = collect();
    let turnEnds: () => void = () => {};
    const exec = manualExec({
      beforeWrite: async () => {
        turnEnds();
        await until(() => events.some((e) => e.type === "turn.done"));
      },
    });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    turnEnds = () => exec.push(result);
    expect(await session.steer("racing")).toBe("not-running");
    expect(exec.writes).toHaveLength(1);
    exec.end(0);
    await session.finished;
  });
});

describe("a reply while the process keeps running", () => {
  it("emits the reply at the result but leaves the turn open until the process exits, and a later line lands in the same turn", async () => {
    const m = manualExec();
    const adapter = createClaudeAdapter({ exec: m.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "x", onEvent });
    let settled = false;
    void session.finished.then(() => {
      settled = true;
    });

    m.push(`{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`);
    m.push(`{"type":"result","subtype":"success","result":"the reply","duration_ms":1000,"usage":{"output_tokens":5},"session_id":"${FIXTURE_SESSION_ID}"}`);
    await until(() => events.some((e) => e.type === "turn.done"));
    // The reply is in, but the process has not exited: finished waits for it.
    expect(settled).toBe(false);

    // A line the harness prints after its result lands as a delta of the same turn, not a new one.
    m.push(`{"type":"assistant","message":{"content":[{"type":"text","text":"still tidying up"}]},"session_id":"${FIXTURE_SESSION_ID}"}`);
    await until(() => events.some((e) => e.type === "turn.delta" && e.text === "still tidying up"));
    expect(settled).toBe(false);

    m.end(0);
    const result = await session.finished;
    expect(result).toMatchObject({ status: "completed", text: "the reply" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
  });
});

describe("result classification", () => {
  function resultRun(resultLine: string): Promise<{ events: AdapterEvent[]; result: TurnResult }> {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init, resultLine]);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "x", onEvent });
    return session.finished.then((result) => ({ events, result }));
  }

  it("maps aborted_streaming to interrupted", async () => {
    const { result } = await resultRun(
      `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","errors":["[ede_diagnostic] stream abort trace"],"duration_ms":812,"session_id":"${FIXTURE_SESSION_ID}"}`,
    );
    expect(result.status).toBe("interrupted");
    expect(result.error).toBeUndefined();
  });

  it("maps other execution errors to failed and hides [ede_diagnostic] noise", async () => {
    const { result } = await resultRun(
      `{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["[ede_diagnostic] internal","MCP server exploded"],"duration_ms":900,"session_id":"${FIXTURE_SESSION_ID}"}`,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("MCP server exploded");
  });

  it("fails the turn when the process dies without a result event", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init], { exitCode: 1 });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "x", onEvent });
    const result = await session.finished;

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code 1/);
    const end = events.at(-1);
    if (end?.type !== "session.end") throw new Error("expected session.end");
    expect(end.sawResult).toBe(false);
  });

  it("a run killed by a signal says the agent was killed and names the signal, never a bare code", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init], { exitCode: null, signalled: "SIGKILL" });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    const result = await adapter.start({ prompt: "x", onEvent }).finished;

    expect(result).toEqual({ status: "failed", error: "claude was killed (SIGKILL) before it answered" });
  });

  it("a launch nothing of the agent ever came back from says so, rather than naming a code the person cannot act on", async () => {
    const exec = scriptedExec([], { exitCode: null });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    const result = await adapter.start({ prompt: "x", onEvent }).finished;

    expect(result).toEqual({ status: "failed", error: "the launch never reached claude: its run ended before the agent said a word" });
  });

  it("exit 127 before any event is reported in words: the binary the shell could not find and the PATH it searched", async () => {
    const exec = scriptedExec(["bash: line 2: claude: command not found"], { exitCode: 127 });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", baseEnv: { PATH: "/root/.local/bin:/usr/bin:/bin" } });
    const { events, onEvent } = collect();

    const result = await adapter.start({ prompt: "x", onEvent }).finished;

    expect(result).toEqual({ status: "failed", error: "claude was not found on PATH (exit 127); PATH searched: /root/.local/bin:/usr/bin:/bin" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", exitCode: 127, sawResult: false });
    // The PATH the line quotes is the one the launch exported.
    expect(exec.calls[0]?.env.PATH).toBe("/root/.local/bin:/usr/bin:/bin");
  });

  it("exit 127 from a launch that exported no PATH says so instead of quoting one", async () => {
    const exec = scriptedExec([], { exitCode: 127 });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    const result = await adapter.start({ prompt: "x", onEvent }).finished;

    expect(result.error).toBe("claude was not found on PATH (exit 127); the launch exported no PATH, the machine's own was searched");
  });

  it("when the transport ends the turn itself, its line is the turn's error, word for word", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const cut = "stopped after 15m 00s with no output for 10m";
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const factory: ExecStreamFactory = () => ({
      lines: (async function* () {
        yield init;
        resolveExit(null);
        throw new Error(cut);
      })(),
      exited,
      teardown: () => {},
      kill: () => {},
      write: async () => "written" as const,
      closeInput: () => {},
    });
    const adapter = createClaudeAdapter({ exec: factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const result = await adapter.start({ prompt: "x", onEvent }).finished;

    expect(result).toEqual({ status: "failed", error: cut });
    const end = events.at(-1);
    if (end?.type !== "session.end") throw new Error("expected session.end");
    expect(end.exitCode).toBeNull();
    expect(end.sawResult).toBe(false);
  });

  it("a result with no text and no usage is a failed turn whose reason is the process's stderr tail, stderr after the result included", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, service_tier: "standard" };
    const empty = `{"type":"result","subtype":"success","is_error":false,"duration_ms":26,"result":"","session_id":"${FIXTURE_SESSION_ID}","total_cost_usd":0,"usage":${JSON.stringify(usage)}}`;
    const exec = scriptedExec([init, "No conversation found with session ID: e16ed170", empty, "", "Error: transcript ended mid-turn"], { exitCode: 1 });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const result = await adapter.start({ prompt: "x", resume: FIXTURE_SESSION_ID, onEvent }).finished;

    expect(result).toEqual({
      status: "failed",
      durationMs: 26,
      costUsd: 0,
      usage,
      text: "",
      error: "claude answered with no output and no usage after 26ms: No conversation found with session ID: e16ed170\nError: transcript ended mid-turn",
    });
    expect(events.map((e) => e.type)).toEqual(["session.start", "turn.done", "session.end"]);
    expect(events[1]).toMatchObject({ type: "turn.done", result });
    expect(events[2]).toMatchObject({ type: "session.end", exitCode: 1, sawResult: true });
    expect(exec.order).toEqual(["closeInput"]);
  });

  it("a result with no text and no usage and a quiet stderr fails with the duration alone; the tail keeps the last five lines", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const empty = `{"type":"result","subtype":"success","is_error":false,"duration_ms":1500,"result":"","session_id":"${FIXTURE_SESSION_ID}","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}`;
    const quiet = await resultRun(empty);
    expect(quiet.result.status).toBe("failed");
    expect(quiet.result.error).toBe("claude answered with no output and no usage after 1.5s");

    const noisy = scriptedExec([init, ...["one", "two", "three", "four", "five", "six"].map((n) => `line ${n}`), empty]);
    const adapter = createClaudeAdapter({ exec: noisy.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();
    const result = await adapter.start({ prompt: "x", onEvent }).finished;
    expect(result.error).toBe("claude answered with no output and no usage after 1.5s: line two\nline three\nline four\nline five\nline six");
  });

  it("the CLI's refusal for want of a sign-in is a failed turn carrying its sentence once: the line it wrote itself is no delta and no reply", async () => {
    // The three lines a home with no login gave on 2.1.257 (measured 2026-09-12), trimmed to the fields read here.
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}","model":"claude-opus-5[1m]"}`;
    const refusal = `{"type":"assistant","message":{"id":"m1","model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"session_id":"${FIXTURE_SESSION_ID}","error":"authentication_failed","is_api_error_message":true}`;
    const result = `{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","num_turns":1,"result":"Not logged in · Please run /login","duration_ms":88,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init, refusal, result], { exitCode: 1 });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", signInRefusal: signInRefusalLine({ kind: "local" }) });
    const { events, onEvent } = collect();

    const turn = await adapter.start({ prompt: "say hi", onEvent }).finished;

    expect(turn).toEqual({
      status: "failed",
      durationMs: 88,
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: "Not logged in · Please run /login; sign in from a terminal on this computer, then send again",
      refusal: "sign-in",
    });
    expect(turn.text).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["session.start", "turn.done", "session.end"]);
    expect(events[1]).toMatchObject({ type: "turn.done", result: turn });

    // The road is the caller's, from the one rule every door reads, so the same refusal on a machine sends the
    // person to the Machine tab rather than to a terminal that is not theirs.
    const onMachine = scriptedExec([init, refusal, result], { exitCode: 1 });
    const there = createClaudeAdapter({ exec: onMachine.factory, configDir: "/root/.claude-cfg", signInRefusal: signInRefusalLine({ kind: "cloud" }) });
    const away = await there.start({ prompt: "say hi", onEvent: () => {} }).finished;
    expect(away).toMatchObject({ status: "failed", refusal: "sign-in", error: "Not logged in · Please run /login; sign this workspace in from the Workspace panel, then send again" });

    // A caller that handed no road leaves the CLI's own sentence to stand alone; the cause still classes the turn.
    const bare = scriptedExec([init, refusal, result], { exitCode: 1 });
    const alone = await createClaudeAdapter({ exec: bare.factory, configDir: "/root/.claude-cfg" }).start({ prompt: "say hi", onEvent: () => {} }).finished;
    expect(alone).toMatchObject({ status: "failed", refusal: "sign-in", error: "Not logged in · Please run /login" });
  });

  it("a user abort is read before the error flag: a success stamped aborted_streaming is interrupted, not a refusal", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const abortedSuccess = `{"type":"result","subtype":"success","is_error":true,"terminal_reason":"aborted_streaming","duration_ms":812,"result":"stopped","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init, abortedSuccess]);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", signInRefusal: signInRefusalLine({ kind: "local" }) });

    const turn = await adapter.start({ prompt: "x", onEvent: () => {} }).finished;

    expect(turn).toMatchObject({ status: "interrupted", text: "stopped" });
    expect(turn.error).toBeUndefined();
    expect(turn.refusal).toBeUndefined();
  });

  it("a refusal the CLI named no cause wsp knows keeps its own sentence alone; a turn that did work and exited 0 still reads completed", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const overloaded = `{"type":"assistant","message":{"id":"m1","model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"API Error: 529 overloaded"}]},"session_id":"${FIXTURE_SESSION_ID}","error":"overloaded","is_api_error_message":true}`;
    const errored = `{"type":"result","subtype":"success","is_error":true,"result":"API Error: 529 overloaded","duration_ms":40,"session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init, overloaded, errored], { exitCode: 1 });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", signInRefusal: signInRefusalLine({ kind: "local" }) });
    const refused = await adapter.start({ prompt: "x", onEvent: () => {} }).finished;
    expect(refused).toMatchObject({ status: "failed", error: "API Error: 529 overloaded" });
    expect(refused.refusal).toBeUndefined();

    const worked = scriptedExec(fixtureLines());
    const second = createClaudeAdapter({ exec: worked.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const done = await second.start({ prompt: "x", onEvent }).finished;
    expect(done).toMatchObject({ status: "completed", text: "Server is live at :3000 and answered: Hello, World!", costUsd: 0.0187 });
    expect(done.error).toBeUndefined();
    expect(events.filter((e) => e.type === "turn.delta").length).toBeGreaterThan(0);
  });

  it("a completed result with text keeps its status whatever its usage says; one with usage keeps it whatever its text says", async () => {
    const withText = await resultRun(`{"type":"result","subtype":"success","is_error":false,"duration_ms":30,"result":"ok","session_id":"${FIXTURE_SESSION_ID}","usage":{"input_tokens":0,"output_tokens":0}}`);
    expect(withText.result).toMatchObject({ status: "completed", text: "ok" });
    const withUsage = await resultRun(`{"type":"result","subtype":"success","is_error":false,"duration_ms":30,"result":"","session_id":"${FIXTURE_SESSION_ID}","usage":{"input_tokens":12,"output_tokens":0}}`);
    expect(withUsage.result).toMatchObject({ status: "completed", text: "" });
    expect(withUsage.result.error).toBeUndefined();
  });

  it("a background task that ended before the result leaves the turn completed; an interrupted result keeps its status", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const one = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a","task_type":"local_bash","description":"sleep 5"}],"session_id":"${FIXTURE_SESSION_ID}"}`;
    const none = `{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"${FIXTURE_SESSION_ID}"}`;
    const success = `{"type":"result","subtype":"success","is_error":false,"duration_ms":30,"result":"done","session_id":"${FIXTURE_SESSION_ID}","usage":{"input_tokens":1,"output_tokens":1}}`;
    const aborted = `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","duration_ms":812,"session_id":"${FIXTURE_SESSION_ID}"}`;
    const run = async (lines: string[]) => {
      const exec = scriptedExec(lines);
      const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
      return adapter.start({ prompt: "x", onEvent: () => {} }).finished;
    };

    const finishedFirst = await run([init, one, none, success]);
    expect(finishedFirst).toMatchObject({ status: "completed", text: "done" });
    expect(finishedFirst.error).toBeUndefined();
    const interrupted = await run([init, one, aborted]);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.error).toBeUndefined();
  });

  it("skips lines that are not stream-json events", async () => {
    const lines = [
      "not json at all",
      "42",
      '{"type":123}',
      `{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":5,"session_id":"${FIXTURE_SESSION_ID}"}`,
    ];
    const exec = scriptedExec(lines);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "x", onEvent });
    const result = await session.finished;

    expect(result.status).toBe("completed");
    expect(events.map((e) => e.type)).toEqual(["turn.done", "session.end"]);
  });
});

// Every line of this block but the two-task ones is a line the CLI printed on this Mac (2.1.257, print mode with the
// channel held open past the reply): the agent ran one command in the background, replied, and the CLI kept the
// command alive, reported its end and woke the agent with it.
describe("a reply given while the agent's background work runs", () => {
  const SID = "8ba924b7-5641-4448-a153-9b11d4675297";
  const TASK = "bv4027ti3";
  const CALL = "toolu_01R1kAQuvHmCcYjmDNFfpsCg";
  const init = `{"type":"system","subtype":"init","session_id":"${SID}"}`;
  const running = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"${TASK}","task_type":"local_bash","description":"Sleep 20 seconds then echo done"}],"uuid":"5007fb59-c70a-4259-9056-e6427fbbf60c","session_id":"${SID}"}`;
  const startedTask = `{"type":"system","subtype":"task_started","task_id":"${TASK}","tool_use_id":"${CALL}","description":"Sleep 20 seconds then echo done","is_backgrounded":true,"task_type":"local_bash","session_id":"${SID}"}`;
  const handedBack = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"${CALL}","type":"tool_result","content":"Command running in background with ID: ${TASK}. Output is being written to: /private/tmp/claude-501/tasks/${TASK}.output. You will be notified when it completes.","is_error":false}],"role":"user"},"parent_tool_use_id":null,"session_id":"${SID}"}`;
  const reply = `{"type":"result","subtype":"success","is_error":false,"duration_ms":10657,"total_cost_usd":0.26918,"result":"Waiting for the background sleep to finish.","session_id":"${SID}","usage":{"input_tokens":58,"output_tokens":188}}`;
  const none = `{"type":"system","subtype":"background_tasks_changed","tasks":[],"uuid":"e6b61619-0394-459a-ad13-d748543abaf0","session_id":"${SID}"}`;
  const updated = `{"type":"system","subtype":"task_updated","task_id":"${TASK}","patch":{"status":"completed","end_time":1789828771480},"session_id":"${SID}"}`;
  const notified = `{"type":"system","subtype":"task_notification","task_id":"${TASK}","tool_use_id":"${CALL}","status":"completed","output_file":"/private/tmp/claude-501/tasks/${TASK}.output","summary":"Background command \\"Sleep 20 seconds then echo done\\" completed (exit code 0)","session_id":"${SID}"}`;
  const woke = `{"type":"assistant","message":{"model":"claude-fable-5-1","role":"assistant","content":[{"type":"text","text":"The background sleep finished with exit code 0 and printed \`done\`."}]},"parent_tool_use_id":null,"session_id":"${SID}"}`;
  const second = `{"type":"result","subtype":"success","is_error":false,"duration_ms":3600,"total_cost_usd":0.28360375,"result":"The background sleep finished with exit code 0 and printed \`done\`.","origin":{"kind":"task-notification"},"session_id":"${SID}","usage":{"input_tokens":4,"output_tokens":23}}`;
  /** A second task beside it, for the counting and the two-task hold: this CLI reported one, so the pair is written. */
  const two = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"${TASK}","task_type":"local_bash","description":"Sleep 20 seconds then echo done"},{"task_id":"b","task_type":"local_agent","description":"review"}],"session_id":"${SID}"}`;
  const onlyB = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b","task_type":"local_agent","description":"review"}],"session_id":"${SID}"}`;
  const notifiedB = `{"type":"system","subtype":"task_notification","task_id":"b","tool_use_id":"toolu_02","status":"completed","summary":"review completed","session_id":"${SID}"}`;

  const dones = (events: readonly AdapterEvent[]) => events.filter((e): e is Extract<AdapterEvent, { type: "turn.done" }> => e.type === "turn.done");

  /** Long enough for every line pushed so far to have been read, and for a turn that ended at its reply to have
   * closed its channel and ended its process: what a case waits before reading that nothing was delivered. */
  const drained = (): Promise<unknown> => new Promise(r => setTimeout(r, 80));

  /** A turn whose stream the case feeds, on the exit window every case here runs with. `graceMs` is how long the
   * process gets after the teardown, which a case that goes on feeding lines past the reply gives itself. */
  function held(opts: { slowTeardown?: boolean; graceMs?: number } = {}) {
    const m = manualExec(opts);
    const adapter = createClaudeAdapter({ exec: m.factory, configDir: "/root/.claude-cfg", resultExitMs: 40, interruptGraceMs: opts.graceMs ?? 15 });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "run it in the background and say you are waiting", onEvent });
    return { m, events, session };
  }

  it("is held: nothing is closed, ended or delivered until the task is done", async () => {
    const { m, events, session } = held({ slowTeardown: true });
    for (const line of [init, running, startedTask, handedBack, reply]) m.push(line);
    // Past the window a finished turn's process gets: the turn is working, so nothing was delivered and the channel
    // the agent takes a message on is still open.
    await drained();
    expect(dones(events)).toEqual([]);
    expect(m.order).toEqual([]);
    // The channel is open, so the turn takes a message: what a person or a parent thread sends lands in it.
    expect(await session.steer("still there?")).toBe("accepted");

    // The task ends and the CLI does not wake its agent: the words it already said are the turn's, with the task's
    // end under them.
    for (const line of [none, updated, notified]) m.push(line);
    await until(() => dones(events).length === 1);
    const result = dones(events)[0]!.result;
    expect(result.status).toBe("completed");
    expect(result.text).toMatch(/^Waiting for the background sleep to finish\.\n\n`Sleep 20 seconds then echo done` completed, \d+m?s after the reply$/);
    expect(result).toMatchObject({ durationMs: 10657, costUsd: 0.26918 });
    expect(await session.finished).toBe(result);
    expect(m.order).toEqual(["write", "closeInput", "teardown", "kill"]);
  });

  it("ends when the task wakes the agent, and the agent's own next reply is the turn's", async () => {
    const { m, events, session } = held();
    for (const line of [init, running, startedTask, reply, none, updated, notified, woke, second] as const) m.push(line);
    await until(() => dones(events).length === 1);
    m.end(0);
    const result = await session.finished;
    expect(result).toMatchObject({ status: "completed", text: "The background sleep finished with exit code 0 and printed `done`.", durationMs: 3600, costUsd: 0.28360375 });
    // One reply, and the woken agent's words reached the pane before it.
    expect(dones(events)).toHaveLength(1);
    const texts = events.filter(e => e.type === "turn.delta" && e.kind === "text").map(e => (e.type === "turn.delta" ? e.text : ""));
    expect(texts).toEqual(["The background sleep finished with exit code 0 and printed `done`."]);
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
  });

  it("delivered once: a reply the CLI wakes its agent for after the hold is over is not a second reply", async () => {
    const { m, events, session } = held({ slowTeardown: true, graceMs: 5_000 });
    for (const line of [init, running, startedTask, reply, none, updated, notified]) m.push(line);
    // Nothing woke the agent inside the window, so the words it gave are the turn's and the reply is out.
    await until(() => dones(events).length === 1);
    const delivered = dones(events)[0]!.result;

    // The CLI wakes its agent anyway, later. Its words reach the pane; the turn's reply does not change.
    m.push(woke);
    m.push(second);
    await until(() => events.some(e => e.type === "turn.delta" && e.kind === "text" && e.text.startsWith("The background sleep finished")));
    await drained();
    expect(dones(events)).toHaveLength(1);
    expect(dones(events)[0]!.result).toBe(delivered);
    expect(delivered.costUsd).toBe(0.26918);

    m.end(0);
    expect(await session.finished).toBe(delivered);
    expect(events.filter(e => e.type === "session.end")).toHaveLength(1);
  });

  it("takes a message: a send during the hold steers the agent, and its next reply ends the hold", async () => {
    const { m, events, session } = held();
    for (const line of [init, running, startedTask, reply]) m.push(line);
    await drained();
    expect(dones(events)).toEqual([]);
    expect(await session.steer("also say ok")).toBe("accepted");
    expect(m.writes).toContain(userMessageLine("also say ok", SID));
    expect(dones(events)).toEqual([]);

    m.push(none);
    m.push(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"session_id":"${SID}"}`);
    m.push(`{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"result":"ok","session_id":"${SID}","usage":{"input_tokens":2,"output_tokens":2}}`);
    await until(() => dones(events).length === 1);
    expect(dones(events)[0]!.result).toMatchObject({ status: "completed", text: "ok" });
  });

  it("reports the CLI's own count to the runtime on every change", async () => {
    const { m, events, session } = held();
    for (const line of [init, running, two, none]) m.push(line);
    await until(() => events.filter(e => e.type === "turn.tasks").length === 3);
    m.push(`{"type":"result","subtype":"success","is_error":false,"duration_ms":5,"result":"done","session_id":"${SID}","usage":{"input_tokens":1,"output_tokens":1}}`);
    m.end(0);
    await session.finished;
    expect(events.filter(e => e.type === "turn.tasks").map(e => (e.type === "turn.tasks" ? e.running : -1))).toEqual([1, 2, 0]);
    // The count rides its own event and no client's: nothing about it reaches the reply.
    expect(dones(events)[0]!.result).toMatchObject({ status: "completed", text: "done" });
  });

  it("is held until the last task is gone, and every task that finished is under the reply", async () => {
    const { m, events, session } = held();
    for (const line of [init, two, reply, notified, onlyB]) m.push(line);
    await drained();
    expect(dones(events)).toEqual([]);

    m.push(notifiedB);
    m.push(none);
    await until(() => dones(events).length === 1);
    m.end(0);
    const result = await session.finished;
    expect(result.text?.split("\n").slice(2)).toEqual([
      expect.stringMatching(/^`Sleep 20 seconds then echo done` completed, \d+m?s after the reply$/) as unknown as string,
      expect.stringMatching(/^`review` completed, \d+m?s after the reply$/) as unknown as string,
    ]);
  });

  it("cut with its process reads failed with the count and keeps the reply", async () => {
    const { m, events, session } = held();
    for (const line of [init, running, startedTask, reply]) m.push(line);
    await drained();
    expect(dones(events)).toEqual([]);
    m.end(null);
    const result = await session.finished;
    expect(result).toMatchObject({ status: "failed", error: "ended with 1 background task running", text: "Waiting for the background sleep to finish." });
    expect(dones(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
  });

  it("stopped by the person reads interrupted and keeps the reply", async () => {
    const { m, events, session } = held({ slowTeardown: true });
    for (const line of [init, running, startedTask, reply]) m.push(line);
    await drained();
    expect(dones(events)).toEqual([]);
    await session.interrupt();
    const result = await session.finished;
    expect(result).toMatchObject({ status: "interrupted", text: "Waiting for the background sleep to finish." });
    expect(m.order).toEqual(["teardown", "kill"]);
    expect(dones(events)).toHaveLength(1);
  });
});

describe("ClaudeAdapter follows the agent's tool shell", () => {
  const SID = "e16ed170-8257-4668-879e-fe836341633c";
  const init = JSON.stringify({ type: "system", subtype: "init", cwd: "/root", session_id: SID, tools: ["Bash", "Write"], model: "claude-sonnet-4-5" });
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const toolResult = (id: string) =>
    JSON.stringify({ type: "user", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1, result: "done", session_id: SID });

  async function run(lines: string[]) {
    const exec = scriptedExec(lines);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    await adapter.start({ prompt: "go", onEvent }).finished;
    return events.filter((e) => e.type === "turn.delta").map((e) => (e.type === "turn.delta" ? [e.kind, e.toolName, e.cwd] : []));
  }

  it("stamps the shell's folder on the tool_use that moves it, and nothing else", async () => {
    const deltas = await run([
      init,
      toolUse("t1", "Bash", { command: "ls" }),
      toolResult("t1"),
      toolUse("t2", "Bash", { command: "cd /root/2048 && npm test" }),
      toolResult("t2"),
      toolUse("t3", "Write", { file_path: "/root/2048/src/game.js", content: "" }),
      toolResult("t3"),
      toolUse("t4", "Bash", { command: "cd /root/2048" }),
      toolResult("t4"),
      result,
    ]);
    expect(deltas).toEqual([
      ["tool_use", "Bash", undefined],
      ["tool_result", undefined, undefined],
      ["tool_use", "Bash", "/root/2048"],
      ["tool_result", undefined, undefined],
      ["tool_use", "Write", undefined],
      ["tool_result", undefined, undefined],
      ["tool_use", "Bash", undefined],
      ["tool_result", undefined, undefined],
    ]);
  });

  it("takes a Write under the harness folder as the shell's folder when no cd came first", async () => {
    const deltas = await run([
      init,
      toolUse("t1", "Write", { file_path: "/root/2048/index.html", content: "" }),
      toolResult("t1"),
      toolUse("t2", "Edit", { file_path: "/root/2048/style.css", old_string: "a", new_string: "b" }),
      toolResult("t2"),
      toolUse("t3", "Write", { file_path: "/etc/motd", content: "" }),
      toolResult("t3"),
      result,
    ]);
    expect(deltas.filter(([kind]) => kind === "tool_use")).toEqual([
      ["tool_use", "Write", "/root/2048"],
      ["tool_use", "Edit", undefined],
      ["tool_use", "Write", undefined],
    ]);
  });
});
