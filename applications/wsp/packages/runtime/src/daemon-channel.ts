// SPDX-License-Identifier: AGPL-3.0-only
// One dial of one daemon for one client of this host, with no redial and no
// subscribe ritual: the page that opened the channel owns the retry and asks
// for ports.watch and the rest itself. The host's own held links (reach.ts,
// the doctor's socket) keep a machine warm and re-dial it, which is a
// different concern and stays where it is.

import type { DaemonFrame, DaemonResponse } from "@wsp/protocol";
import WebSocket from "ws";
import { daemonWsUrl } from "./reach.js";

export interface DaemonChannelOptions {
  /** The road daemonReach answered: a minted route or a loopback url; the host turns http(s) into ws(s). */
  url: string;
  token: string;
  /** Every frame that is not the answer to a send, the hello included, in the order the daemon sent them. */
  onEvent(frame: Record<string, unknown>): void;
  connectTimeoutMs?: number;
}

export interface DaemonChannel {
  send(frame: DaemonFrame): Promise<DaemonResponse>;
  close(): void;
  /** Settles once, when the daemon socket ends for any reason, close() included. */
  readonly closed: Promise<{ code: number; reason: string }>;
}

/** The door answered the upgrade with a status: the socket never opened. kind is what the wire carries. The message
 * is shown under the pane's own sentence, so it carries the status and the door's words and none of ours: a person
 * never reads machine or daemon. */
export class DaemonDoorError extends Error {
  readonly kind = "refused";
  readonly status: number;
  constructor(status: number, body: string) {
    // One line of the body: a door that answers an HTML page must not become the pane's sentence.
    const line = body.split("\n", 1)[0]!.trim();
    super(line === "" ? `the connection was refused with ${status}` : `the connection was refused with ${status}: ${line}`);
    this.name = "DaemonDoorError";
    this.status = status;
  }
}

/** The daemon took the upgrade and closed 4401 before answering the auth frame. */
export class DaemonTokenError extends Error {
  readonly kind = "reauth";
  constructor(reason: string) {
    super(`the machine refused this host's daemon token (4401 ${reason})`);
    this.name = "DaemonTokenError";
  }
}

/** The dial, the auth frame and the reply that proves it, before a connect is given up. Named here rather than
 * imported from the host: the dependency arrows run runtime to host, never back. */
const CONNECT_TIMEOUT_MS = 15_000;

/** The bytes of a refusing door's body kept for its sentence; the first line is what a pane shows. */
const DOOR_BODY_CAP = 512;

interface Pending {
  resolve: (m: DaemonResponse) => void;
  reject: (e: Error) => void;
}

/** Dials once, sends the auth frame first, resolves on its reply. */
export function openDaemonChannel(o: DaemonChannelOptions): Promise<DaemonChannel> {
  const timeoutMs = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(daemonWsUrl(o.url));
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let settled = false;
    /** The door's own answer, kept so the close that follows it reads as a refusal rather than a dead machine. */
    let refusal: DaemonDoorError | undefined;
    let resolveClosed: (end: { code: number; reason: string }) => void = () => {};
    const closed = new Promise<{ code: number; reason: string }>(r => (resolveClosed = r));

    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error(`daemon connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const send = (frame: DaemonFrame): Promise<DaemonResponse> => {
      if (ws.readyState !== ws.OPEN) return Promise.reject(new Error("daemon unreachable"));
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ ...frame, id }));
      });
    };

    const channel: DaemonChannel = {
      send,
      close: () => ws.close(1000),
      closed,
    };

    // ws folds a non-101 answer into an error and a 1006 close without this listener, which is how a refusing door
    // and a machine that is not there would read the same. The response's body is the door's own sentence.
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        if (body.length < DOOR_BODY_CAP) body += chunk.toString("utf8");
      });
      const done = (): void => {
        refusal ??= new DaemonDoorError(res.statusCode ?? 0, body.slice(0, DOOR_BODY_CAP));
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(refusal);
      };
      res.on("end", done);
      res.on("error", done);
    });

    ws.on("open", () => {
      send({ op: "auth", token: o.token } as unknown as DaemonFrame).then(
        reply => {
          if (settled) return;
          settled = true;
          clearTimeout(connectTimer);
          if (reply.ok === true) resolve(channel);
          else reject(new Error(String((reply as { error?: unknown }).error ?? "the machine refused the daemon link")));
        },
        () => {}, // the close handler owns the rejection
      );
    });

    ws.on("message", raw => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = msg["id"];
      if (typeof id === "number" && pending.has(id)) {
        const p = pending.get(id)!;
        pending.delete(id);
        p.resolve(msg as DaemonResponse);
        return;
      }
      o.onEvent(msg);
    });

    ws.on("error", () => {}); // a close event always follows

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      clearTimeout(connectTimer);
      const reason = reasonBuf.toString("utf8");
      for (const p of pending.values()) p.reject(new Error("connection lost"));
      pending.clear();
      resolveClosed({ code, reason });
      if (settled) return;
      settled = true;
      if (refusal !== undefined) reject(refusal);
      else if (code === 4401) reject(new DaemonTokenError(reason));
      else reject(new Error(`the daemon link ended before it opened (${code}${reason === "" ? "" : ` ${reason}`})`));
    });
  });
}
