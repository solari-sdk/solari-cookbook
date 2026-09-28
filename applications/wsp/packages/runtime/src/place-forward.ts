// SPDX-License-Identifier: AGPL-3.0-only
// The road from this computer to the daemon on a computer joined as a place.
// That daemon binds its own loopback and nothing else, so nothing on somebody's
// own machine listens where a network can reach it; the host opens a port on
// its own loopback and carries every connection over the link the place dialled
// out on, by the tunnel road the sign-in callbacks already take. A pane's
// terminal, files and ports ride this; the commands a turn runs do not, since
// those are one exec frame each.

import { createServer, type Server, type Socket } from "node:net";
import { LOOPBACK, type DaemonEvent } from "@wsp/protocol";
import type { DaemonReach } from "./reach.js";
import { plumbTunnel, tunnelFrame } from "./tunnel.js";

export interface PlaceForward {
  /** The port on this computer's loopback that carries to the daemon on that one. */
  readonly port: number;
  /** A frame the place pushed, handed to the connection it belongs to; anything else is nobody's here. */
  event(e: DaemonEvent): void;
  close(): void;
}

/** Opens one such port for one place. Each connection becomes a tunnel on the link and is closed with it, so a
 * link that goes takes every connection riding it rather than leaving a browser waiting on bytes nothing carries. */
export function openPlaceForward(reach: DaemonReach, daemonPort: number): Promise<PlaceForward> {
  const conns = new Map<string, Socket>();
  let seq = 0;
  let closed = false;
  const server: Server = createServer(socket =>
    plumbTunnel((op, params) => reach.request(op, params), socket, { port: daemonPort, conns, tunnelId: `pl${++seq}` }),
  );
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, LOOPBACK, () => {
      const found = server.address();
      const port = typeof found === "object" && found !== null ? found.port : 0;
      if (port === 0) {
        server.close();
        fail(new Error("this computer offered no free port for the road to a place"));
        return;
      }
      // The port must not hold a host that is otherwise done open.
      server.unref();
      done({
        port,
        event: e => void tunnelFrame(conns, e),
        close() {
          if (closed) return;
          closed = true;
          server.close();
          for (const socket of conns.values()) socket.destroy();
          conns.clear();
        },
      });
    });
  });
}
