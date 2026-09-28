// SPDX-License-Identifier: AGPL-3.0-only
// The address that opens the app on one workspace, on one thread of it, or on
// the screen its next thread is written on: wsp init writes the workspace form
// after its first fork, the app writes the others as the person moves, and the
// app's store reads all three back.
import { describe, expect, it } from "vitest";
import { addressFromHash, appHash, openingHash, pairingCodeOf, workspaceHash } from "../src/index.js";

describe("the workspace a page opens on", () => {
  it("round-trips an id through the hash", () => {
    expect(workspaceHash("ws_a1b2")).toBe("#w/ws_a1b2");
    expect(appHash({ workspaceId: "ws_a1b2" })).toBe("#w/ws_a1b2");
    expect(addressFromHash(workspaceHash("ws_a1b2"))).toEqual({ workspaceId: "ws_a1b2" });
  });

  it("names no workspace for the app's own hashes, an empty one, or no hash at all", () => {
    expect(addressFromHash("#gallery")).toBeUndefined();
    expect(addressFromHash("")).toBeUndefined();
    expect(addressFromHash("#w/")).toBeUndefined();
  });
});

describe("the thread a page opens on", () => {
  it("round-trips a workspace and a thread, and the workspace reads out of the same hash", () => {
    expect(appHash({ workspaceId: "ws_a1b2", threadId: "thr_9" })).toBe("#w/ws_a1b2/t/thr_9");
    expect(addressFromHash("#w/ws_a1b2/t/thr_9")).toEqual({ workspaceId: "ws_a1b2", threadId: "thr_9" });
  });

  it("names no thread for a workspace hash, an empty thread, or an unrelated hash", () => {
    expect(addressFromHash("#w/ws_a1b2")?.threadId).toBeUndefined();
    expect(addressFromHash("#w/ws_a1b2/t/")).toEqual({ workspaceId: "ws_a1b2" });
    expect(addressFromHash("#gallery")).toBeUndefined();
  });

  it("escapes what an id carries", () => {
    expect(addressFromHash(appHash({ workspaceId: "ws a", threadId: "t/1" }))).toEqual({ workspaceId: "ws a", threadId: "t/1" });
  });
});

describe("the screen a workspace's next thread is written on", () => {
  it("has an address of its own, which names no thread", () => {
    expect(appHash({ workspaceId: "ws_a1b2", fresh: true })).toBe("#w/ws_a1b2/new");
    expect(addressFromHash("#w/ws_a1b2/new")).toEqual({ workspaceId: "ws_a1b2", fresh: true });
  });

  it("is not read into a workspace whose own id ends that way, and a thread address is never fresh", () => {
    expect(addressFromHash("#w/new")).toEqual({ workspaceId: "new" });
    expect(addressFromHash(appHash({ workspaceId: "ws/new" }))).toEqual({ workspaceId: "ws/new" });
    expect(addressFromHash("#w/ws_a1b2/t/thr_9/new")).toEqual({ workspaceId: "ws_a1b2", threadId: "thr_9/new" });
  });
});

describe("the code wsp init puts in the address of the page it opens", () => {
  it("rides the end of the hash beside the workspace, and alone when there is no workspace", () => {
    expect(openingHash("7K3MQP2X", "ws_a1b2")).toBe("#w/ws_a1b2/c/7K3MQP2X");
    expect(openingHash("7K3MQP2X")).toBe("#c/7K3MQP2X");
    expect(pairingCodeOf("#w/ws_a1b2/c/7K3MQP2X")).toEqual({ code: "7K3MQP2X", rest: "#w/ws_a1b2" });
    expect(pairingCodeOf("#c/7K3MQP2X")).toEqual({ code: "7K3MQP2X", rest: "" });
  });

  it("is not part of what the address names, so the workspace and the thread read as they would without it", () => {
    expect(addressFromHash("#w/ws_a1b2/c/7K3MQP2X")).toEqual({ workspaceId: "ws_a1b2" });
    expect(addressFromHash("#w/ws_a1b2/t/thr_9/c/7K3MQP2X")).toEqual({ workspaceId: "ws_a1b2", threadId: "thr_9" });
    expect(addressFromHash("#w/ws_a1b2/new/c/7K3MQP2X")).toEqual({ workspaceId: "ws_a1b2", fresh: true });
    expect(addressFromHash("#c/7K3MQP2X")).toBeUndefined();
  });

  it("reads no code off a hash carrying none, an empty one, or the app's own hashes", () => {
    expect(pairingCodeOf("#w/ws_a1b2")).toBeUndefined();
    expect(pairingCodeOf("#w/ws_a1b2/c/")).toBeUndefined();
    expect(pairingCodeOf("#c/")).toBeUndefined();
    expect(pairingCodeOf("#gallery")).toBeUndefined();
    expect(pairingCodeOf("")).toBeUndefined();
  });
});
