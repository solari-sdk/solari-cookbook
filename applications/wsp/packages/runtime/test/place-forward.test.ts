// SPDX-License-Identifier: AGPL-3.0-only
// The port this computer opens for a pane on a joined computer: every
// connection to it becomes one tunnel on that computer's own link, and what
// comes back on the link is written to the connection it belongs to.
import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK } from "@wsp/protocol";
import { openPlaceForward, type PlaceForward } from "../src/place-forward.js";
import type { DaemonReach } from "../src/reach.js";

let forward: PlaceForward | undefined;
let server: Server | undefined;

afterEach(async () => {
  forward?.close();
  forward = undefined;
  await new Promise<void>(done => (server === undefined ? done() : server.close(() => done())));
  server = undefined;
});

/** A link that answers the three tunnel ops and reports what it was asked, as a place's daemon does. */
function fakeLink(opts: { refuse?: boolean } = {}): { reach: DaemonReach; asked: { op: string; params: Record<string, unknown> }[] } {
  const asked: { op: string; params: Record<string, unknown> }[] = [];
  const reach = {
    ready: Promise.resolve(),
    request: async (op: string, params: Record<string, unknown> = {}) => {
      asked.push({ op, params });
      if (op === "tunnel.open" && opts.refuse === true) throw new Error("nothing answers on that port");
      return {};
    },
    status: () => "open" as const,
    stats: () => ({ pingsSent: 0, pongsReceived: 0, reconnects: 0 }),
    close: () => {},
  } as unknown as DaemonReach;
  return { reach, asked };
}

const dial = (port: number): Promise<ReturnType<typeof connect>> =>
  new Promise((done, fail) => {
    const socket = connect({ port, host: LOOPBACK }, () => done(socket));
    socket.once("error", fail);
  });

describe("the road a pane takes to a place", () => {
  it("opens one tunnel on the link per connection, on the port that computer said its daemon bound", async () => {
    const link = fakeLink();
    forward = await openPlaceForward(link.reach, 34567);
    expect(forward.port).toBeGreaterThan(0);
    const socket = await dial(forward.port);
    socket.write("hello");
    await new Promise(r => setTimeout(r, 50));
    expect(link.asked[0]).toMatchObject({ op: "tunnel.open", params: { port: 34567 } });
    const tunnelId = String(link.asked[0]!.params["tunnelId"]);
    expect(link.asked.find(a => a.op === "tunnel.write")?.params["data"]).toBe(Buffer.from("hello").toString("base64"));
    // What the far side sends comes back on the connection that opened the tunnel.
    forward.event({ type: "tunnel.data", tunnelId, data: Buffer.from("there").toString("base64") });
    const said = await new Promise<string>(done => socket.once("data", d => done(d.toString("utf8"))));
    expect(said).toBe("there");
    socket.destroy();
  });

  it("ends the connection when the far side ends its tunnel, and closes the tunnel when the connection goes", async () => {
    const link = fakeLink();
    forward = await openPlaceForward(link.reach, 1234);
    const socket = await dial(forward.port);
    socket.write("x");
    await new Promise(r => setTimeout(r, 50));
    const tunnelId = String(link.asked[0]!.params["tunnelId"]);
    const ended = new Promise<void>(done => socket.once("end", () => done()));
    forward.event({ type: "tunnel.end", tunnelId });
    await ended;
    socket.destroy();
    await new Promise(r => setTimeout(r, 50));
    expect(link.asked.some(a => a.op === "tunnel.close" && a.params["tunnelId"] === tunnelId)).toBe(true);
  });

  it("drops a connection the far side would not open a tunnel for, rather than holding it on nothing", async () => {
    const link = fakeLink({ refuse: true });
    forward = await openPlaceForward(link.reach, 1234);
    const socket = await dial(forward.port);
    const closed = new Promise<void>(done => socket.once("close", () => done()));
    socket.write("x");
    await closed;
    expect(link.asked.map(a => a.op)).toContain("tunnel.open");
  });

  it("stops answering once it is closed, so a link that went takes its port with it", async () => {
    const link = fakeLink();
    forward = await openPlaceForward(link.reach, 1234);
    const port = forward.port;
    forward.close();
    forward = undefined;
    await expect(dial(port)).rejects.toThrow();
  });
});
