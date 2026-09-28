// SPDX-License-Identifier: AGPL-3.0-only
// The exec op, which is the whole of what a host driving a place needs: every
// script the runtime already sends a machine rides one of these.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { NOT_ON_THIS_ROAD } from "@wsp/protocol";
import { daemonUnderTest, type DaemonUnderTest } from "./harness.js";

const TOKEN = "exec-token";
const root = mkdtempSync(join(tmpdir(), "wsp-exec-root-"));
const inboxDir = mkdtempSync(join(tmpdir(), "wsp-exec-inbox-"));
let handle: DaemonUnderTest | undefined;

afterAll(async () => {
  await handle?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(inboxDir, { recursive: true, force: true });
});

interface Frame {
  id?: number | null;
  ok?: boolean;
  [k: string]: unknown;
}

async function connect(port: number, auth: Record<string, unknown>): Promise<{ request: (op: string, params?: Record<string, unknown>) => Promise<Frame>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const pending = new Map<number, (f: Frame) => void>();
  let next = 1;
  ws.on("message", raw => {
    const f = JSON.parse(String(raw)) as Frame;
    if (typeof f.id === "number" && pending.has(f.id)) {
      pending.get(f.id)!(f);
      pending.delete(f.id);
    }
  });
  const request = (op: string, params: Record<string, unknown> = {}): Promise<Frame> => {
    const id = next++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, op, ...params }));
    });
  };
  ws.send(JSON.stringify({ id: 0, op: "auth", token: TOKEN, ...auth }));
  return { request, close: () => ws.close() };
}

describe("the exec op over the wire", () => {
  it("answers a command on an authed socket", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, {});
    try {
      const res = await client.request("exec", { cmd: "echo hello", timeoutMs: 5_000 });
      expect(res).toMatchObject({ ok: true, exitCode: 0, truncated: false });
      expect(String(res["stdout"])).toContain("hello");
    } finally {
      client.close();
    }
  });

  it("is refused on a socket scoped to one guest port, like every op but tunnel and ping", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, { port: 8123 });
    try {
      const res = await client.request("exec", { cmd: "echo hello" });
      expect(res.ok).toBe(false);
      expect(res["code"]).toBe("forbidden");
    } finally {
      client.close();
    }
  });

  it("refuses place.leave on an inbound socket: only the link this computer opened may take it out of a wsp", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, {});
    try {
      const res = await client.request("place.leave");
      expect(res.ok).toBe(false);
      expect(res["code"]).toBe("forbidden");
      // One sentence for one rule: the leave op and the machine ops are the link's, and no other socket takes them.
      expect(res["error"]).toBe(NOT_ON_THIS_ROAD);
    } finally {
      client.close();
    }
  });

  it("refuses a frame whose cmd is not a string, and one whose timeout is not a positive integer", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, {});
    try {
      expect((await client.request("exec", { cmd: 3 })).ok).toBe(false);
      expect((await client.request("exec", { cmd: "echo x", timeoutMs: -1 })).ok).toBe(false);
      expect((await client.request("exec", { cmd: "echo x", stdin: 3 })).ok).toBe(false);
    } finally {
      client.close();
    }
  });
});
