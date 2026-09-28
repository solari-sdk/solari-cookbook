// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";

export interface RefusingDoor {
  port: number;
  close(): Promise<void>;
}

/** A door like the provider edge that started this: it answers every upgrade with a status and a body, so no socket
 * ever opens behind it. The default is the 403 and the sentence measured on a Box machine. */
export async function startRefusingDoor(status = 403, body = "cross-origin websocket denied"): Promise<RefusingDoor> {
  const server: Server = createServer((_req, res) => res.writeHead(status, { "content-type": "text/plain" }).end(body));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr !== null ? addr.port : 0,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}
