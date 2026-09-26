// SPDX-License-Identifier: AGPL-3.0-only
// A refused frame carries the fix apart from what happened, and the host that serves the runtime keeps one line of
// every refusal it sent: a refusal the page drops is still somewhere a person can read it.
import { afterEach, describe, expect, it } from "vitest";
import { refusal, refusalLine } from "@wsp/protocol";
import { createRuntime, type InitDoor } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { WsClient } from "./ws-client.js";
import { stubBackend } from "./stub-backend.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const rt = () => createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });

const KEY = "sk-ant-x-fake-refusal-key";
const ROW = "sk-ant-x-fake-row-login";

/** An init door whose key step refuses, echoing the key back the way a provider's own answer sometimes does. A key
 * with padding is echoed trimmed, since the real door trims what it reads before anything else touches it. */
function refusingDoor(): InitDoor {
  return {
    keys: async ({ key }: { key?: string }) => {
      if (key !== undefined && key !== key.trim()) throw refusal(`Box refused ${key.trim()}`, "Check it and paste it again.", "auth");
      throw refusal(`Box refused ${key ?? "that key"}\nits answer was 401`, "Check it and paste it again.", "auth");
    },
    on: () => () => {},
  } as unknown as InitDoor;
}

async function serving(): Promise<{ lines: string[]; client: WsClient }> {
  const lines: string[] = [];
  srv = await serveRuntime(rt(), { port: 0, authToken: "host-token", init: refusingDoor(), log: line => lines.push(line) });
  return { lines, client: await WsClient.connect(srv.port, { token: "host-token" }) };
}

describe("a refused frame", () => {
  it("carries the fix beside the sentence and the kind", async () => {
    const { client } = await serving();
    const got = await client.request("init.keys", { provider: "box", key: KEY });
    expect(got).toMatchObject({ ok: false, kind: "auth", fix: "Check it and paste it again." });
    expect(got["error"]).toBe(refusalLine(`Box refused ${KEY}\nits answer was 401`, "Check it and paste it again."));
    client.close();
  });

  it("is logged once, as the op, the kind and the first line of the sentence", async () => {
    const { client, lines } = await serving();
    await client.request("workspaces.get", { workspaceId: "nope" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^refused workspaces\.get kind=\S+: /);
    expect(lines[0]).not.toContain("\n");
    client.close();
  });

  it("never logs the key or a login row a refused init.keys carried, even when the refusal repeats it", async () => {
    const { client, lines } = await serving();
    await client.request("init.keys", { provider: "box", key: KEY, rows: { "logins/claude": ROW } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^refused init\.keys kind=auth: Box refused /);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).not.toContain(ROW);
    client.close();
  });

  it("never logs the token of a refused auth frame", async () => {
    const lines: string[] = [];
    srv = await serveRuntime(rt(), { port: 0, authToken: "host-token", log: line => lines.push(line) });
    const stranger = await WsClient.connect(srv.port);
    void stranger.request("auth", { token: "wrong-token-sk-ant-x" });
    await stranger.closed();
    expect(lines).toEqual([expect.stringMatching(/^refused auth kind=auth: /)]);
    expect(lines[0]).not.toContain("wrong-token-sk-ant-x");
  });

  it("cuts the message half at 400 characters and says it was cut, however long the request made it", async () => {
    const { client, lines } = await serving();
    await client.request("workspaces.get", { workspaceId: "w".repeat(3_000_000) });
    expect(lines).toHaveLength(1);
    const [prefix, ...rest] = lines[0]!.split(": ");
    expect(prefix).toMatch(/^refused workspaces\.get kind=\S+$/);
    const message = rest.join(": ");
    expect(message).toMatch(/ \(cut \d+ characters\)$/);
    expect(message.replace(/ \(cut \d+ characters\)$/, "")).toHaveLength(400);
    client.close();
  });

  it("logs a frame the schema refused as its issues on one line, while the wire keeps its own sentence", async () => {
    const { client, lines } = await serving();
    const got = await client.request("init.keys", { provider: 42 });
    expect(got).toMatchObject({ ok: false });
    expect(lines).toEqual(["refused init.keys kind=none: provider: Expected string, received number"]);
    client.close();
  });

  it("never logs a padded key, when the refusal repeats the key trimmed", async () => {
    const { client, lines } = await serving();
    await client.request("init.keys", { provider: "box", key: `  ${KEY}\n` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).toContain("<redacted>");
    client.close();
  });

  it("writes an op the protocol does not declare as frame, so a key sent as the op never names the line", async () => {
    const { client, lines } = await serving();
    await client.request(KEY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^refused frame kind=none: /);
    expect(lines[0]).not.toContain(KEY);
    client.close();
  });

  it("keeps the sentence readable when a secret field holds a stray space or a single letter", async () => {
    const { client, lines } = await serving();
    await client.request("init.keys", { provider: "box", key: " " });
    expect(lines[0]).toBe("refused init.keys kind=auth: Box refused. Check it and paste it again.");
    expect(lines[0]).not.toContain("<redacted>");
    client.close();
    const stranger = await WsClient.connect(srv!.port);
    void stranger.request("auth", { token: "u" });
    await stranger.closed();
    expect(lines[1]).toMatch(/^refused auth kind=auth: /);
    expect(lines[1]).not.toContain("<redacted>");
  });

  it("withholds the sentence of a frame carrying more secret values than any real one, and answers in the time of none", async () => {
    const { client, lines } = await serving();
    const env = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`V${i}`, `value-${i}-sk-ant-x`]));
    const started = Date.now();
    const got = await client.request("workspaces.get", { workspaceId: "w".repeat(8_000_000), env });
    const took = Date.now() - started;
    expect(got).toMatchObject({ ok: false });
    expect(took).toBeLessThan(1_500);
    expect(lines).toEqual([expect.stringMatching(/^refused workspaces\.get kind=\S+: \(sentence withheld, 20000 secret values\)$/)]);
    client.close();
  });

  it("a deeply nested secret field is refused and logged like any other frame, and the socket keeps answering", async () => {
    const { client, lines } = await serving();
    const frames: { id?: unknown; ok?: unknown }[] = [];
    client.onFrame(m => frames.push(m));
    client.ws.send(`{"id":90,"op":"init.keys","key":${"[".repeat(20_000)}"x"${"]".repeat(20_000)}}`);
    expect((await client.request("workspaces.list")).ok).toBe(true);
    expect(frames.find(f => f.id === 90)).toMatchObject({ ok: false });
    expect(lines).toEqual([expect.stringMatching(/^refused init\.keys kind=none: /)]);
    client.close();
  });

  it("on a socket let in on a ticket, carries kind ticket so a client tells not-yours-to-see from a fault", async () => {
    const lines: string[] = [];
    srv = await serveRuntime(rt(), { port: 0, authToken: "host-token", log: line => lines.push(line) });
    const host = await WsClient.connect(srv.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv.port, { ticket });
    for (const op of ["places.list", "account.get", "devices.list", "cost.spend"]) expect(await relayed.request(op), op).toMatchObject({ ok: false, kind: "ticket" });
    expect(await relayed.request("ticket.issue", { purpose: "relay" })).toMatchObject({ ok: false, kind: "ticket" });
    expect(lines.every(line => /^refused \S+ kind=ticket: /.test(line))).toBe(true);
    relayed.close();
  });
});
