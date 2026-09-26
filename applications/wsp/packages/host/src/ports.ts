// SPDX-License-Identifier: AGPL-3.0-only
// Whether the ports the app will bind are free on this computer, asked before
// a machine bills: an init that ends by serving the app learns of a clash
// before the build, not after it. A pair nobody named is stepped over rather
// than refused, so a second setup beside a running host is one command.
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { LOOPBACK } from "@wsp/runtime";
import { WS_PORT_OFFSET, type AppPorts, type PortHolder, type PortProcess, type PortsAsked } from "@wsp/protocol";
import { servingHost, type HostLock } from "./host-lock.js";

/** How many pairs above the one asked for a pick may step: a step of the whole offset would put the app port where
 * the pair below keeps its WebSocket port, so the window is the offset itself. */
const PAIR_TRIES = WS_PORT_OFFSET;

/** True when a bind on the port refuses with EADDRINUSE; any other bind error is thrown. Port 0 is always free. The
 * probe binds the address the host binds, so it fails the way the host would. */
export function portInUse(port: number, host = LOOPBACK): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(true) : reject(e)));
    server.listen(port, host, () => server.close(() => resolve(false)));
  });
}

/** The process listening on the port as lsof names it; nothing when lsof is missing, times out or names none. */
export function listenerOf(port: number): Promise<PortProcess | undefined> {
  return new Promise(resolve => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { timeout: 3_000 }, (_err, stdout) => {
      const pid = /^p(\d+)$/m.exec(stdout)?.[1];
      const command = /^c(.+)$/m.exec(stdout)?.[1];
      resolve(pid !== undefined && command !== undefined ? { command, pid: Number(pid) } : undefined);
    });
  });
}

export interface PortProbes {
  /** The state files a host on this computer could be serving. A live lock beside one naming the port makes its
   * host the holder, which lsof would name as a bare node process. */
  states?: readonly string[];
  probe?: (port: number) => Promise<boolean>;
  serving?: (statePath: string) => HostLock | undefined;
  listener?: (port: number) => Promise<PortProcess | undefined>;
}

/** Who holds a port: the wsp host whose lock names it, else the process lsof names, else nobody this computer can name. */
export async function portHolder(port: number, probes: PortProbes = {}): Promise<PortHolder> {
  const serving = probes.serving ?? servingHost;
  for (const statePath of probes.states ?? []) {
    const lock = serving(statePath);
    if (lock !== undefined && (lock.port === port || lock.wsPort === port)) return { statePath };
  }
  return (probes.listener ?? listenerOf)(port);
}

/** A pair a run may bind: `moved` names the port the pick stepped over and its holder, where it stepped. */
export type PortsPicked = { ports: AppPorts; moved?: { port: number; holder: PortHolder } };

/** The pair a run binds, or the port that stops it. */
export type PortsChosen = PortsPicked | { taken: { port: number; holder: PortHolder } };

/** Which pair a run binds: the one asked for when both ports are free; the next pair with both free when a pair
 * nobody named is taken; the taken port and its holder when a person named the pair, or when no pair inside the
 * window is free, since a run that keeps stepping would land somewhere nobody was told about. */
export async function choosePorts(asked: PortsAsked, probes: PortProbes = {}): Promise<PortsChosen> {
  const probe = probes.probe ?? portInUse;
  const takenIn = async (ports: AppPorts): Promise<number | undefined> => {
    for (const port of [ports.port, ports.wsPort]) if (await probe(port)) return port;
    return undefined;
  };
  const taken = await takenIn(asked);
  if (taken === undefined) return { ports: { port: asked.port, wsPort: asked.wsPort } };
  const holder = await portHolder(taken, probes);
  if (!asked.named) {
    for (let step = 1; step < PAIR_TRIES; step++) {
      const next = { port: asked.port + step, wsPort: asked.wsPort + step };
      if ((await takenIn(next)) === undefined) return { ports: next, moved: { port: taken, holder } };
    }
  }
  return { taken: { port: taken, holder } };
}
