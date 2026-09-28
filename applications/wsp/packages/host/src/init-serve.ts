// SPDX-License-Identifier: AGPL-3.0-only
// The two things every wsp init road ends with, whichever road it took: the
// port pair the app binds, settled before anything is built, and the address
// handed over once it serves. Both the golden road and the local one read
// these, so the port refusal and the opened line are written once.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { styleText } from "node:util";
import { cancel, log } from "@clack/prompts";
import { writeOwn } from "@wsp/own-file";
import { PORT_TAKEN_REFUSAL, authority, isLoopback, portTakenLine, portsPickedLine, stateFileLine, type AppPorts, type PortsAsked } from "@wsp/protocol";
import { dialAddress } from "./host-lock.js";
import { choosePorts, type PortProbes } from "./ports.js";
import type { InitIO } from "./init.js";

const dim = (s: string): string => styleText("dim", s);

/** The pair this run binds: the one asked for, or the next free pair with the step said out loud. Nothing when a
 * port a person named is held, which is the whole run's refusal: the three lines are printed here. */
export async function pickPorts(o: { ports: PortsAsked & PortProbes; statePath: string; output: Writable }): Promise<AppPorts | undefined> {
  const out = { output: o.output };
  const chosen = await choosePorts(o.ports, o.ports);
  if ("taken" in chosen) {
    log.error(portTakenLine(chosen.taken.port, chosen.taken.holder), out);
    log.step(stateFileLine(o.statePath), out);
    cancel(PORT_TAKEN_REFUSAL, out);
    return undefined;
  }
  if (chosen.moved !== undefined) log.step(portsPickedLine(chosen.ports, chosen.moved.port, chosen.moved.holder), out);
  return chosen.ports;
}

function overSsh(env: Record<string, string | undefined>): boolean {
  return env["SSH_CONNECTION"] !== undefined || env["SSH_TTY"] !== undefined || env["SSH_CLIENT"] !== undefined;
}

/** Where the app a run hands over is served. The address is named and not optional: a host handle carries the port
 * and no address, so a caller allowed to hand one over here leaves the forward hint reading loopback while the url
 * reads the address the host bound. */
export interface ServedAt {
  port: number;
  address: string | undefined;
}

/** What the browser is handed instead of the address: a page only this login can read, since the address carries
 * the code that lets that browser in and a process argument is every process's to read. */
const escaped = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const openingPage = (url: string): string => `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escaped(url)}"><title>wsp</title><a href="${escaped(url)}">Open wsp</a>\n`;

/** The app's address once the run has something to open: opened here on a terminal the person is at, printed (with
 * the ssh forward when that address answers on this computer alone) under --yes or over ssh. The forward follows
 * the address the url carries, so a host bound beyond this computer is offered as it stands and a wildcard, which
 * the url hands over at loopback, still gets one. The browser is opened on a page in the host's run folder that
 * sends it to the address, mode 0600 and gone at this run's exit, so the code in the address rides no process
 * argument; the printed line carries the address itself, into the person's own terminal. */
export async function openApp(url: string, at: ServedAt, io: Pick<InitIO, "output" | "env" | "open" | "atExit">, interactive: boolean, o: { runDir: string; logLine?: string }): Promise<void> {
  const out = { output: io.output };
  const under = o.logLine === undefined ? [] : [o.logLine];
  if (!interactive || overSsh(io.env)) {
    const dialed = dialAddress(at);
    const lines = [`Open ${url}`];
    if (overSsh(io.env) && isLoopback(dialed)) lines.push(dim(`loopback address; forward it first: ssh -L ${at.port}:${authority(dialed, at.port)} <this host>`));
    log.step([...lines, ...under].join("\n"), out);
    return;
  }
  const name = `open-${randomBytes(6).toString("hex")}.html`;
  writeOwn(o.runDir, name, openingPage(url));
  const page = join(o.runDir, name);
  io.atExit?.(() => rmSync(page, { force: true }));
  const opened = await io.open(page);
  log.step([`${opened ? "Opened" : "Open"} ${url}`, ...under].join("\n"), out);
}
