// SPDX-License-Identifier: AGPL-3.0-only
// Approval and user-input prompts, fixture-driven until the wire carries them.
import { describe, expect, it } from "vitest";
import { derivePendingApprovals, derivePendingUserInputs, type PromptEvent } from "../src/adapt/index.js";

const scope = { workspaceId: "ws_p", sessionId: "sess_p" };
const approval = (requestId: string, at: string, extra: Partial<Extract<PromptEvent, { type: "approval.requested" }>> = {}): PromptEvent => ({
  type: "approval.requested", ...scope, requestId, at, requestKind: "command", detail: "rm -rf build", ...extra,
});
const question = (requestId: string, at: string, options = [{ label: "Yes", description: "go" }]): PromptEvent => ({
  type: "user-input.requested", ...scope, requestId, at,
  questions: [{ id: "q1", header: "Deploy", question: "Ship it?", options, multiSelect: false }],
});

describe("derivePendingApprovals", () => {
  it.each<[string, PromptEvent[], string[]]>([
    ["one open request", [approval("r1", "t1")], ["r1"]],
    ["resolved requests close", [approval("r1", "t1"), { type: "approval.resolved", ...scope, requestId: "r1", at: "t2" }], []],
    ["a stale respond failure closes the prompt", [approval("r1", "t1"), { type: "prompt.respond.failed", ...scope, requestId: "r1", at: "t2", reason: "stale" }], []],
    ["another respond failure keeps it open", [approval("r1", "t1"), { type: "prompt.respond.failed", ...scope, requestId: "r1", at: "t2", reason: "other" }], ["r1"]],
    ["ordered by creation, not arrival", [approval("r2", "t2"), approval("r1", "t1")], ["r1", "r2"]],
    ["a repeated request replaces itself", [approval("r1", "t1"), approval("r1", "t3", { detail: "again" })], ["r1"]],
    ["user-input events do not touch approvals", [question("q1", "t1"), approval("r1", "t2")], ["r1"]],
  ])("%s", (_name, events, open) => {
    expect(derivePendingApprovals(events).map(a => a.requestId)).toEqual(open);
  });

  it("carries detail, appName and non-empty options through, dropping empty ones", () => {
    const [a] = derivePendingApprovals([approval("r1", "t1", { appName: "gh", options: [{ decision: "accept", label: "Allow" }] })]);
    expect(a).toEqual({ requestId: "r1", requestKind: "command", createdAt: "t1", detail: "rm -rf build", appName: "gh", options: [{ decision: "accept", label: "Allow" }] });
    const [b] = derivePendingApprovals([approval("r2", "t1", { options: [] })]);
    expect(b).not.toHaveProperty("options");
  });
});

describe("derivePendingUserInputs", () => {
  it.each<[string, PromptEvent[], string[]]>([
    ["one open question", [question("q1", "t1")], ["q1"]],
    ["resolved closes", [question("q1", "t1"), { type: "user-input.resolved", ...scope, requestId: "q1", at: "t2" }], []],
    ["a question with no options is not a prompt", [question("q1", "t1", [])], []],
    ["unknown respond failure closes", [question("q1", "t1"), { type: "prompt.respond.failed", ...scope, requestId: "q1", at: "t2", reason: "unknown" }], []],
    ["approvals do not touch questions", [approval("r1", "t1"), question("q1", "t2")], ["q1"]],
  ])("%s", (_name, events, open) => {
    expect(derivePendingUserInputs(events).map(q => q.requestId)).toEqual(open);
  });
});
