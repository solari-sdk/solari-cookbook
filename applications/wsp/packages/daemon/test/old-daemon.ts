// SPDX-License-Identifier: AGPL-3.0-only
import { WebSocketServer } from "ws";

// A daemon as every golden sealed before the hello carried a version answered:
// the auth frame, a hello naming only its root, ping, and "unknown op" for
// anything else (the sys and proc ops among them). It is what a workspace
// forked from such a golden still runs until its daemon is updated.

export interface OldDaemon {
  port: number;
  /** Every op asked after auth, in order. */
  ops: string[];
  close(): Promise<void>;
}

export function startOldDaemon(token: string, root = "/root"): Promise<OldDaemon> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const ops: string[] = [];
  wss.on("connection", ws => {
    let authed = false;
    ws.on("message", raw => {
      const msg = JSON.parse(String(raw)) as { id?: number; op?: string; token?: string };
      if (!authed) {
        if (msg.op !== "auth" || msg.token !== token) {
          ws.close(4401, "the first frame must be auth");
          return;
        }
        authed = true;
        ws.send(JSON.stringify({ id: msg.id, ok: true }));
        ws.send(JSON.stringify({ type: "daemon.hello", root }));
        return;
      }
      ops.push(String(msg.op));
      if (msg.op === "ping") ws.send(JSON.stringify({ id: msg.id, ok: true }));
      else ws.send(JSON.stringify({ id: msg.id, ok: false, error: `unknown op: ${String(msg.op)}` }));
    });
  });
  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        port,
        ops,
        close: () =>
          new Promise<void>((done, fail) => {
            for (const c of wss.clients) c.terminate();
            wss.close(err => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
