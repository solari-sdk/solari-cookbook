// SPDX-License-Identifier: AGPL-3.0-only
// The control channel Claude Code raises its permission prompts on, read and
// answered. The request and response shapes here are the ones a real 2.1.263
// binary sent and took on 2026-09-08, copied off that run.
import { describe, expect, it } from "vitest";
import { PERMISSION_ALLOW, PERMISSION_DENY } from "@wsp/protocol";
import { controlAnswerLine, controlErrorLine, controlLine, setModeLine } from "../src/permissions.js";

const REQUEST_ID = "d9aa99d3-be4e-4a2b-8766-1b9494cde4f6";

/** One can_use_tool request as the binary sent it. */
const askLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "control_request",
  request_id: REQUEST_ID,
  request: {
    subtype: "can_use_tool",
    tool_name: "Write",
    display_name: "Write",
    input: { file_path: "/tmp/probe/out.txt", content: "hi" },
    description: "out.txt",
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    tool_use_id: "toolu_014vmSNR2cP3TRB1tF86Nftp",
    ...overrides,
  },
});

const ask = (overrides?: Record<string, unknown>) => {
  const line = controlLine(askLine(overrides));
  if (line?.kind !== "ask") throw new Error(`expected an ask, got ${line?.kind}`);
  return line.ask;
};

describe("controlLine", () => {
  it("reads a can_use_tool request as the prompt a person answers", () => {
    expect(ask()).toEqual({
      askId: REQUEST_ID,
      toolName: "Write",
      toolUseId: "toolu_014vmSNR2cP3TRB1tF86Nftp",
      input: JSON.stringify({ file_path: "/tmp/probe/out.txt", content: "hi" }),
      detail: "out.txt",
      options: [
        { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
        { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
        { id: "mode:acceptEdits", label: "acceptEdits", effect: "mode", mode: "acceptEdits" },
      ],
    });
  });

  it("carries allow and deny even when the binary suggested nothing, and drops a suggestion it cannot act on", () => {
    expect(ask({ permission_suggestions: [] }).options.map(o => o.id)).toEqual([PERMISSION_ALLOW, PERMISSION_DENY]);
    expect(ask({ permission_suggestions: undefined }).options.map(o => o.id)).toEqual([PERMISSION_ALLOW, PERMISSION_DENY]);
    const odd = ask({ permission_suggestions: [{ type: "addRules", rules: [] }, { type: "setMode" }, { type: "setMode", mode: "acceptEdits" }, { type: "setMode", mode: "acceptEdits" }] });
    expect(odd.options.map(o => o.id)).toEqual([PERMISSION_ALLOW, PERMISSION_DENY, "mode:acceptEdits"]);
  });

  it("leaves out a detail the binary named as nothing", () => {
    expect(ask({ description: "" }).detail).toBeUndefined();
    expect(ask({ description: undefined }).detail).toBeUndefined();
  });

  it("reads a withdrawal of a request, and nothing at all from an ordinary event", () => {
    expect(controlLine({ type: "control_cancel_request", request_id: REQUEST_ID })).toEqual({ kind: "cancel", requestId: REQUEST_ID });
    expect(controlLine({ type: "assistant", message: {} })).toBeUndefined();
    expect(controlLine({ type: "control_request" })).toBeUndefined();
    expect(controlLine({ type: "control_cancel_request" })).toBeUndefined();
  });

  it("reads the CLI's answer to a request this host sent, and the words of one it would not take", () => {
    expect(controlLine({ type: "control_response", response: { subtype: "success", request_id: "set_1" } })).toEqual({ kind: "answer", requestId: "set_1" });
    expect(controlLine({ type: "control_response", response: { subtype: "error", request_id: "set_1", error: "no such mode" } })).toEqual({
      kind: "answer",
      requestId: "set_1",
      error: "no such mode",
    });
    // A refusal with no words of its own is still a refusal, never a silent success.
    expect(controlLine({ type: "control_response", response: { subtype: "error", request_id: "set_1" } })).toMatchObject({ kind: "answer", error: expect.any(String) });
    expect(controlLine({ type: "control_response", response: {} })).toBeUndefined();
  });

  it("reads a request of another subtype as one to refuse rather than one to answer", () => {
    expect(controlLine(askLine({ subtype: "hook_callback" }))).toEqual({ kind: "unknown", requestId: REQUEST_ID, subtype: "hook_callback" });
    expect(controlLine(askLine({ tool_name: undefined }))).toEqual({ kind: "unknown", requestId: REQUEST_ID, subtype: "can_use_tool" });
  });
});

describe("controlAnswerLine", () => {
  it("allows the call with the input the prompt carried, unchanged", () => {
    expect(JSON.parse(controlAnswerLine(ask(), PERMISSION_ALLOW, "unused"))).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: REQUEST_ID, response: { behavior: "allow", updatedInput: { file_path: "/tmp/probe/out.txt", content: "hi" } } },
    });
  });

  it("refuses the call with the words the agent reads as its result", () => {
    expect(JSON.parse(controlAnswerLine(ask(), PERMISSION_DENY, "the person denied this in the chat"))).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: REQUEST_ID, response: { behavior: "deny", message: "the person denied this in the chat" } },
    });
  });

  it("a mode option allows the call and carries the update that stops the asking", () => {
    expect(JSON.parse(controlAnswerLine(ask(), "mode:acceptEdits", "unused"))).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: REQUEST_ID,
        response: {
          behavior: "allow",
          updatedInput: { file_path: "/tmp/probe/out.txt", content: "hi" },
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      },
    });
  });

  it("refuses an option the prompt never offered", () => {
    expect(() => controlAnswerLine(ask(), "mode:bypassPermissions", "unused")).toThrow(/not an option/);
  });
});

describe("controlErrorLine", () => {
  it("tells the binary this host answers no such request, so it stops waiting", () => {
    expect(JSON.parse(controlErrorLine(REQUEST_ID, "hook_callback"))).toEqual({
      type: "control_response",
      response: { subtype: "error", request_id: REQUEST_ID, error: "wsp answers no hook_callback control request" },
    });
  });
});

describe("setModeLine", () => {
  it("asks the binary for the mode by its own slug, under the id its answer will carry", () => {
    expect(JSON.parse(setModeLine("set_1", "bypassPermissions"))).toEqual({
      type: "control_request",
      request_id: "set_1",
      request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
    });
  });
});
