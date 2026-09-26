// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createServer, type Socket } from "node:net";

export interface TcpProxy {
  port: number;
  /** Destroy every live connection without stopping the listener, like an idle sweep. */
  cutAll(): void;
  /** Keep every socket open but forward nothing: a half-dead link only heartbeats can detect. */
  stall(): void;
  /** How many connections this road is holding, which is what a line still waiting on one looks like from outside. */
  live(): number;
  resume(): void;
  close(): Promise<void>;
}

export async function startTcpProxy(targetPort: number, listenPort = 0): Promise<TcpProxy> {
  const pairs = new Set<{ a: Socket; b: Socket }>();
  let stalled = false;
  const server = createServer(a => {
    const b = connect(targetPort, "127.0.0.1");
    const pair = { a, b };
    pairs.add(pair);
    a.on("data", chunk => {
      if (!stalled) b.write(chunk);
    });
    b.on("data", chunk => {
      if (!stalled) a.write(chunk);
    });
    const drop = () => {
      pairs.delete(pair);
      a.destroy();
      b.destroy();
    };
    a.on("close", drop);
    b.on("close", drop);
    a.on("error", () => {});
    b.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    live() {
      return pairs.size;
    },
    stall() {
      stalled = true;
    },
    resume() {
      stalled = false;
    },
    cutAll() {
      for (const { a, b } of pairs) {
        a.destroy();
        b.destroy();
      }
      pairs.clear();
    },
    close() {
      for (const { a, b } of pairs) {
        a.destroy();
        b.destroy();
      }
      pairs.clear();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}
