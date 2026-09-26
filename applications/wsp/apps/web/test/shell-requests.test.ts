// SPDX-License-Identifier: AGPL-3.0-only
// The held composer-focus request: the switch selects and asks in one
// handler, so the ask has to outlive the handler and be taken once.
import { describe, expect, it } from "vitest";
import { onComposerFocusRequest, requestComposerFocus } from "../src/shell/shellRequests.js";

describe("composer focus requests", () => {
  it("hands a pending ask to the composer that subscribes for it, once", () => {
    const asks: string[] = [];
    requestComposerFocus("ws_a");
    const off = onComposerFocusRequest("ws_a", () => asks.push("first"));
    const offAgain = onComposerFocusRequest("ws_a", () => asks.push("second"));
    expect(asks).toEqual(["first"]);
    off();
    offAgain();
  });

  it("reaches only the workspace it names, and reaches a live composer", () => {
    const asks: string[] = [];
    const off = onComposerFocusRequest("ws_a", () => asks.push("a"));
    const offB = onComposerFocusRequest("ws_b", () => asks.push("b"));
    requestComposerFocus("ws_b");
    requestComposerFocus("ws_a");
    expect(asks).toEqual(["b", "a"]);
    off();
    offB();
    requestComposerFocus("ws_a");
    expect(asks).toEqual(["b", "a"]);
  });
});
