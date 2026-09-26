// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { refusalLine } from "@wsp/protocol";
import { DisconnectedError, RequestError } from "../src/protocol/client.js";
import { failureOf } from "../src/protocol/failure.js";

describe("failureOf", () => {
  it("splits a refusal that carries its fix into what happened and what to do", () => {
    const e = new RequestError(refusalLine("spoo names no user", "Type user@spoo."), "invalid", "Type user@spoo.");
    expect(failureOf(e)).toEqual({ said: "spoo names no user.", fix: "Type user@spoo.", kind: "invalid", disconnected: false });
  });

  it("keeps a refusal with no fix whole", () => {
    expect(failureOf(new RequestError("workspace is napping", "conflict"))).toEqual({ said: "workspace is napping", fix: undefined, kind: "conflict", disconnected: false });
  });

  it("keeps the whole sentence when the fix is not its tail", () => {
    expect(failureOf(new RequestError("the host is busy", undefined, "Try again."))).toEqual({ said: "the host is busy", fix: "Try again.", kind: undefined, disconnected: false });
  });

  it("marks a request no socket carried as disconnected", () => {
    expect(failureOf(new DisconnectedError("lost"))).toEqual({ said: "runtime connection lost", fix: undefined, kind: undefined, disconnected: true });
  });

  it("reads a plain Error and anything thrown that is not one", () => {
    expect(failureOf(new Error("boom"))).toEqual({ said: "boom", fix: undefined, kind: undefined, disconnected: false });
    expect(failureOf("a string")).toEqual({ said: "a string", fix: undefined, kind: undefined, disconnected: false });
  });

  it("reads a rejection with no reason as the host's no-reason sentence", () => {
    for (const e of [undefined, null]) expect(failureOf(e)).toEqual({ said: "The host answered with no reason. Try again.", fix: undefined, kind: undefined, disconnected: false });
  });
});
