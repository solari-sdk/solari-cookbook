// SPDX-License-Identifier: AGPL-3.0-only
// A turn that raises a permission prompt, on a stream the test drives line by
// line: the prompt reaches the caller as an event, the answer goes back down
// the same stdin channel the CLI reads, the row closes once and only once, and
// a prompt whose process dies with it closes as cancelled rather than waiting.
// The same channel carries this host's own request in the other direction: a
// running turn moved to another access mode, settled on the CLI's own answer.
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { PERMISSION_ALLOW, PERMISSION_DENY, QUESTION_TOOL } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";
import { AGENT_A_CALL, AGENT_A_ID, subagentFixtureFrame } from "./subagent-fixture.js";

const SESSION = "6bb3cdb1-97af-4ad0-96ff-35160ba2bd0b";
const ASK = "d9aa99d3-be4e-4a2b-8766-1b9494cde4f6";

const initLine = JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: "claude-sonnet-5", cwd: "/root", permissionMode: "default" });
const askLine = JSON.stringify({
  type: "control_request",
  request_id: ASK,
  request: {
    subtype: "can_use_tool",
    tool_name: "Write",
    input: { file_path: "/root/out.txt", content: "hi" },
    description: "out.txt",
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    tool_use_id: "toolu_1",
  },
});
/** A second call the CLI asks about, so a turn already moved to the mode that asks nobody can be seen answering one
 * without a person. */
const NEXT_ASK = "b2f1d8c0-11d2-4f23-9a55-2d6a4a3f0e77";
const nextAskLine = JSON.stringify({
  type: "control_request",
  request_id: NEXT_ASK,
  request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "cat out.txt" }, description: "cat out.txt", tool_use_id: "toolu_2" },
});
const resultLine = JSON.stringify({ type: "result", subtype: "success", session_id: SESSION, result: "Done.", usage: { output_tokens: 3 }, total_cost_usd: 0.01 });

/** A stream the test feeds: `push` sends the CLI's next line, `end` exits the process, and `stdin` is every line the
 * adapter wrote back, which is where an answer to a prompt has to land. */
function driven(): { factory: ExecStreamFactory; push: (line: string) => void; end: (code?: number) => void; stdin: string[]; gone: () => void } {
  const stdin: string[] = [];
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let writable = true;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>(resolve => {
    resolveExit = resolve;
  });
  const factory: ExecStreamFactory = (_command, { input }) => {
    // The launch seeds the channel with its user message, as the real factory does; the answer follows it.
    for (const line of input ?? []) stdin.push(line);
    const stream: ExecStream = {
      lines: (async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>(resolve => {
            wake = resolve;
          });
        }
      })(),
      teardown: () => {},
      kill: () => {},
      write: async line => {
        if (!writable) return "gone";
        stdin.push(line);
        return "written";
      },
      closeInput: () => {},
      exited,
    };
    return stream;
  };
  const nudge = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    factory,
    stdin,
    push: line => {
      queue.push(line);
      nudge();
    },
    end: (code = 0) => {
      done = true;
      resolveExit(code);
      nudge();
    },
    gone: () => {
      writable = false;
    },
  };
}

function start(): { events: AdapterEvent[]; session: ReturnType<ReturnType<typeof createClaudeAdapter>["start"]>; io: ReturnType<typeof driven> } {
  const io = driven();
  const adapter = createClaudeAdapter({ exec: io.factory, configDir: "/root/.claude-cfg" });
  const events: AdapterEvent[] = [];
  const session = adapter.start({ prompt: "write it", permissionMode: "default", onEvent: e => events.push(e) });
  return { events, session, io };
}

/** Waits for the adapter's reader to drain what it was fed; the stream is a generator, so one tick per line. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

const QUESTION_INPUT = {
  questions: [
    {
      question: "Tabs or spaces?",
      header: "Indent",
      options: [
        { label: "Tabs", description: "Indent with tab characters." },
        { label: "Spaces", description: "Indent with space characters." },
      ],
      multiSelect: false,
    },
  ],
};
/** The shape measured on the harness's own channel: a question carries requires_user_interaction and is answered by
 * the input it hands back, never by an allow. */
const questionAskLine = JSON.stringify({
  type: "control_request",
  request_id: ASK,
  request: { subtype: "can_use_tool", tool_name: QUESTION_TOOL, input: QUESTION_INPUT, tool_use_id: "toolu_q", requires_user_interaction: true },
});

/** The two frames a prompt raised inside a subagent's run needs, off the recorded fixture rather than typed again:
 * the binding of the CLI's handle to the launching call, and a can_use_tool naming that handle. */
const launchFrame = subagentFixtureFrame(e => e["subtype"] === "task_started" && e["tool_use_id"] === AGENT_A_CALL);
const childAskFrame = subagentFixtureFrame(e => (e["request"] as Record<string, unknown> | undefined)?.["agent_id"] === AGENT_A_ID);

const asks = (events: readonly AdapterEvent[]) => events.filter(e => e.type === "permission.ask");
const closes = (events: readonly AdapterEvent[]) => events.filter(e => e.type === "permission.close");

describe("a turn that raises a permission prompt", () => {
  it("relays the prompt, writes the answer down the CLI's own channel and closes the row once", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();

    const ask = asks(events);
    expect(ask).toHaveLength(1);
    expect(ask[0]).toMatchObject({ type: "permission.ask", sessionId: SESSION, ask: { askId: ASK, toolName: "Write", detail: "out.txt", toolUseId: "toolu_1" } });
    expect(closes(events)).toHaveLength(0);
    // The launch's own user message is the first line on the channel; the answer is what follows it.
    expect(io.stdin).toHaveLength(1);

    expect(await session.answer(ASK, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "unused" })).toBe("answered");
    expect(JSON.parse(io.stdin[1]!)).toMatchObject({ type: "control_response", response: { subtype: "success", request_id: ASK, response: { behavior: "allow" } } });
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "allowed", optionId: PERMISSION_ALLOW }]);

    // A second answer has nothing to answer: the row is closed and the CLI would ignore the line.
    expect(await session.answer(ASK, { optionId: PERMISSION_DENY, outcome: "denied", denyMessage: "no" })).toBe("gone");
    expect(io.stdin).toHaveLength(2);
    expect(closes(events)).toHaveLength(1);

    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("puts a question's own choices on the prompt and sends the pick as the call's answer, with no allow in front", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(questionAskLine);
    await settle();

    const ask = asks(events);
    expect(ask).toHaveLength(1);
    const options = ask[0]!.type === "permission.ask" ? ask[0]!.ask.options : [];
    // Two choices, two buttons, and neither an allow nor a deny: there is no consent in a question to give.
    expect(options.map(o => o.label)).toEqual(["Tabs", "Spaces"]);
    expect(options.map(o => o.effect)).toEqual(["answer", "answer"]);
    expect(options.some(o => o.id === PERMISSION_ALLOW || o.id === PERMISSION_DENY)).toBe(false);

    expect(await session.answer(ASK, { optionId: options[1]!.id, outcome: "allowed", denyMessage: "unused" })).toBe("answered");
    const answer = JSON.parse(io.stdin[1]!);
    // The harness reads the pick off the input it gets back, keyed by the question's own text.
    expect(answer.response.response).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Tabs or spaces?": "Spaces" } } });
    expect(answer.response.response.updatedInput.questions).toEqual(QUESTION_INPUT.questions);
    expect(answer.response.response.behavior).not.toBe("deny");

    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("names the subagent a prompt came from by the call that launched it", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    // Both frames come off the recorded fixture: the CLI binds its own handle for a subagent to the launching call
    // once, in task_started, and a prompt its run raises names only that handle.
    io.push(launchFrame);
    io.push(childAskFrame);
    io.push(askLine);
    await settle();

    const relayed = asks(events).flatMap(e => (e.type === "permission.ask" ? [e.ask] : []));
    expect(relayed.map(a => a.parentToolUseId)).toEqual([AGENT_A_CALL, undefined]);
    // The launch itself is the CLI's own bookkeeping and is no line of the turn's.
    expect(events.filter(e => e.type === "turn.delta")).toHaveLength(0);

    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a deny carries the words the agent reads as the call's result", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    expect(await session.answer(ASK, { optionId: PERMISSION_DENY, outcome: "denied", denyMessage: "the person denied this in the chat" })).toBe("answered");
    expect(JSON.parse(io.stdin[1]!).response.response).toEqual({ behavior: "deny", message: "the person denied this in the chat" });
    expect(closes(events)[0]).toMatchObject({ outcome: "denied", optionId: PERMISSION_DENY });
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("the runtime's own answer for a prompt nobody came to closes the row as unanswered", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    expect(await session.answer(ASK, { optionId: PERMISSION_DENY, outcome: "unanswered", denyMessage: "nobody answered" })).toBe("answered");
    expect(closes(events)[0]).toMatchObject({ outcome: "unanswered", optionId: PERMISSION_DENY });
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a prompt the CLI withdraws closes as cancelled, and answering it afterwards answers nothing", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    io.push(JSON.stringify({ type: "control_cancel_request", request_id: ASK }));
    await settle();
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "cancelled" }]);
    expect(await session.answer(ASK, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "unused" })).toBe("gone");
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a prompt whose process ends under it closes as cancelled rather than waiting for an answer", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    expect(closes(events)).toHaveLength(0);
    io.gone();
    io.end(null as unknown as number);
    await session.finished.catch(() => {});
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "cancelled" }]);
    expect(await session.answer(ASK, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "unused" })).toBe("gone");
  });

  it("refuses an option the prompt never offered without writing anything to the CLI", async () => {
    const { session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    await expect(session.answer(ASK, { optionId: "mode:bypassPermissions", outcome: "allowed", denyMessage: "unused" })).rejects.toThrow(/not an option/);
    expect(io.stdin).toHaveLength(1);
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a control request of another subtype is refused down the channel, so the CLI stops waiting on it", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(JSON.stringify({ type: "control_request", request_id: "req_h", request: { subtype: "hook_callback" } }));
    await settle();
    expect(asks(events)).toHaveLength(0);
    expect(JSON.parse(io.stdin[1]!)).toEqual({ type: "control_response", response: { subtype: "error", request_id: "req_h", error: "wsp answers no hook_callback control request" } });
    io.push(resultLine);
    io.end();
    await session.finished;
  });
});

describe("a running turn moved to another access mode", () => {
  const answered = (line: string, error?: string): string =>
    JSON.stringify({
      type: "control_response",
      response: { subtype: error === undefined ? "success" : "error", request_id: JSON.parse(line).request_id, ...(error !== undefined ? { error } : {}) },
    });

  it("writes the CLI's own set_permission_mode down the channel and settles once the CLI answers it", async () => {
    const { session, io } = start();
    io.push(initLine);
    await settle();
    const moved = session.setAccess("bypassPermissions");
    await settle();
    expect(JSON.parse(io.stdin[1]!)).toMatchObject({ type: "control_request", request: { subtype: "set_permission_mode", mode: "bypassPermissions" } });
    io.push(answered(io.stdin[1]!));
    expect(await moved).toBe("set");
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a mode the CLI will not take comes back refused rather than reading as applied", async () => {
    const { session, io } = start();
    io.push(initLine);
    await settle();
    const moved = session.setAccess("sideways");
    await settle();
    io.push(answered(io.stdin[1]!, "invalid permission mode"));
    expect(await moved).toBe("refused");
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("the mode that asks nobody answers the prompt the turn is stopped on and every one it raises after", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    expect(asks(events)).toHaveLength(1);

    const moved = session.setAccess("bypassPermissions");
    await settle();
    // The request goes down the channel all the same, and this CLI refuses it: the mode is a launch flag on it.
    expect(JSON.parse(io.stdin[1]!)).toMatchObject({ type: "control_request", request: { subtype: "set_permission_mode", mode: "bypassPermissions" } });
    io.push(answered(io.stdin[1]!, "the session was not launched with --dangerously-skip-permissions"));
    // The prompt in front of the person is allowed by this host, so the turn goes on without a click.
    expect(await moved).toBe("set");
    expect(JSON.parse(io.stdin[2]!)).toMatchObject({ type: "control_response", response: { request_id: ASK, response: { behavior: "allow" } } });
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "allowed", optionId: PERMISSION_ALLOW }]);

    io.push(nextAskLine);
    await settle();
    // The next call is allowed the same way and no prompt is put to anyone.
    expect(asks(events)).toHaveLength(1);
    expect(JSON.parse(io.stdin[3]!)).toMatchObject({ type: "control_response", response: { request_id: NEXT_ASK, response: { behavior: "allow" } } });

    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a mode the CLI offered on the open prompt answers it as that option, and one it did not leaves it for the person", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();

    // The prompt is a write and the CLI suggested accept edits for it, so the pick allows this call and stops the
    // asking for the rest of the session in one answer.
    const edits = session.setAccess("acceptEdits");
    await settle();
    io.push(answered(io.stdin[1]!));
    expect(await edits).toBe("set");
    expect(JSON.parse(io.stdin[2]!).response.response).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "allowed", optionId: "mode:acceptEdits" }]);

    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a mode the open prompt carries no option for moves the turn and leaves that prompt standing", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    const moved = session.setAccess("plan");
    await settle();
    io.push(answered(io.stdin[1]!));
    expect(await moved).toBe("set");
    // Nothing was answered for the person: plan says nothing about the write in front of them.
    expect(io.stdin).toHaveLength(2);
    expect(closes(events)).toHaveLength(0);
    expect(await session.answer(ASK, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "unused" })).toBe("answered");

    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a turn that has not announced itself, and one whose channel is shut, take nothing and write nothing", async () => {
    const { session, io } = start();
    expect(await session.setAccess("plan")).toBe("gone");
    expect(io.stdin).toHaveLength(1);
    io.push(initLine);
    await settle();
    io.gone();
    expect(await session.setAccess("plan")).toBe("gone");
    expect(io.stdin).toHaveLength(1);
    io.end(null as unknown as number);
    await session.finished.catch(() => {});
  });

  it("a turn that replies with the request open settles it at the result, not minutes later when the process goes", async () => {
    const { session, io } = start();
    io.push(initLine);
    await settle();
    const moved = session.setAccess("plan");
    await settle();
    expect(io.stdin).toHaveLength(2);
    // The result closes the channel, so nothing can answer this any more; the caller hears at once rather than
    // waiting on a CLI that lingers past its reply.
    io.push(resultLine);
    expect(await moved).toBe("gone");
    io.end();
    await session.finished;
  });

  it("a process that dies with the request open settles it as gone rather than leaving the caller waiting", async () => {
    const { session, io } = start();
    io.push(initLine);
    await settle();
    const moved = session.setAccess("plan");
    await settle();
    expect(io.stdin).toHaveLength(2);
    io.end(null as unknown as number);
    expect(await moved).toBe("gone");
    await session.finished.catch(() => {});
  });
});
