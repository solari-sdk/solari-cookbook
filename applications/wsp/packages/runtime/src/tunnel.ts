// SPDX-License-Identifier: AGPL-3.0-only
// One connection on this computer carried over a daemon link as a tunnel: the
// three ops the daemon answers for it and the two frames it pushes back, in one
// place. Both roads that carry a socket to a machine read this, the host's
// sign-in callbacks and printed local URLs and the pane road to a computer
// joined as a place, so neither can drift on when the connection is paused,
// when the tunnel is closed or how the bytes are spelled. What differs between
// them is what a refused tunnel hears and what each counts as traffic, which
// the caller hands in.

import type { Socket } from "node:net";
import type { DaemonEvent } from "@wsp/protocol";

/** How one op reaches the far side, settling when it answers. */
export type TunnelLink = (op: string, params: Record<string, unknown>) => Promise<unknown>;

export interface TunnelOptions {
  /** The port on the far side this connection is carried to. */
  port: number;
  /** Every connection this road is carrying, by the id it opened under: the frames coming back are handed to it. */
  conns: Map<string, Socket>;
  /** The id this connection takes; the caller mints it, since its own log names it. */
  tunnelId: string;
  /** Called on every chunk moved either way, for a road that closes on quiet. */
  touched?: () => void;
  /** The far side would not open the tunnel. The caller says what the connection hears; without one it is dropped. */
  refused?: (socket: Socket) => void;
  /** Called once the far side holds it open. */
  opened?: () => void;
}

/** Carries one connection over the link: open, then every chunk as a write, and closed when the connection goes. */
export function plumbTunnel(link: TunnelLink, socket: Socket, opts: TunnelOptions): void {
  const { conns, tunnelId } = opts;
  conns.set(tunnelId, socket);
  opts.touched?.();
  // Paused until the far side has the tunnel open: bytes read before that would have nowhere to go.
  socket.pause();
  socket.on("error", () => {});
  socket.once("close", () => {
    conns.delete(tunnelId);
    void link("tunnel.close", { tunnelId }).catch(() => undefined);
  });
  void link("tunnel.open", { tunnelId, port: opts.port }).then(
    () => {
      opts.opened?.();
      socket.on("data", (d: Buffer) => {
        opts.touched?.();
        void link("tunnel.write", { tunnelId, data: d.toString("base64") }).catch(() => socket.destroy());
      });
      socket.resume();
    },
    () => (opts.refused === undefined ? socket.destroy() : opts.refused(socket)),
  );
}

/** A frame the far side pushed, handed to the connection that opened the tunnel it names; true when it was one of
 * these connections, so a caller holding several maps stops at the one that owns it. */
export function tunnelFrame(conns: Map<string, Socket>, event: DaemonEvent, touched?: () => void): boolean {
  if (event.type !== "tunnel.data" && event.type !== "tunnel.end") return false;
  const socket = conns.get(event.tunnelId);
  if (socket === undefined) return false;
  if (event.type === "tunnel.end") {
    socket.end();
    return true;
  }
  touched?.();
  socket.write(Buffer.from(event.data, "base64"));
  return true;
}
