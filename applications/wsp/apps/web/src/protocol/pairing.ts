// SPDX-License-Identifier: AGPL-3.0-only
// Where this page dials the runtime and with what. No page carries the host's
// own token: in the desktop shell the page asks the shell, which holds it; a
// browser redeems a one time code for a token of its own, the one wsp init put
// in the address of the page it opened or one read off wsp host pair, and
// keeps it in this browser under that host's origin.
import type { BootPayload } from "@wsp/protocol";

/** Where the device token this browser was handed lives. Local storage is already scoped to the host's origin, so
 * two hosts a person reaches from one browser keep their own without a key that names them. */
export const DEVICE_TOKEN_KEY = "wsp:device-token";

export interface PageLocation {
  protocol: string;
  host: string;
}

/** The WebSocket URL this page dials: its own origin and the path the host serves the runtime on, which is the only
 * road a client that reached the page through one forwarded port or one tunnel hostname has, and works just as well
 * on loopback. The runtime's own port stays for the command line, which reads it off the lock. */
export function runtimeUrl(boot: BootPayload, at: PageLocation): string {
  const scheme = at.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${at.host}${boot.wsPath}`;
}

/** The device token this browser holds for the host that served this page, or nothing. */
export function storedDeviceToken(storage: Pick<Storage, "getItem">): string | undefined {
  try {
    const held = storage.getItem(DEVICE_TOKEN_KEY);
    return held === null || held === "" ? undefined : held;
  } catch {
    return undefined;
  }
}

/** A storage that throws costs the page a second pairing next load and nothing else. */
export function rememberDeviceToken(storage: Pick<Storage, "setItem">, token: string): void {
  try {
    storage.setItem(DEVICE_TOKEN_KEY, token);
  } catch {
    return;
  }
}

export function forgetDeviceToken(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    return;
  }
}

/** Spends a pairing code over a socket of its own: the redeem is the first frame an unauthed socket may send, and
 * the reply carries the token this browser keeps. The socket is dropped afterwards; the app dials its own. */
export function redeemPairingCode(url: string, code: string, name: string, Ctor: typeof WebSocket = globalThis.WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new Ctor(url);
    const fail = (message: string): void => {
      ws.close();
      reject(new Error(message));
    };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: "pair.redeem", code: code.trim().toUpperCase(), name }));
    ws.onerror = () => {}; // a close always follows, and it carries the reason
    ws.onmessage = e => {
      const frame = JSON.parse(String((e as MessageEvent).data)) as { ok?: boolean; error?: string; deviceToken?: string };
      if (frame.ok !== true || typeof frame.deviceToken !== "string") return fail(frame.error ?? "the host refused that code");
      ws.close();
      resolve(frame.deviceToken);
    };
    ws.onclose = () => reject(new Error("the host closed the connection before it answered"));
  });
}

/** What this browser calls itself to the host, which is what wsp host devices shows beside the id. */
export function deviceName(at: PageLocation, agent: string): string {
  const platform = /Mac/.test(agent) ? "a Mac" : /Windows/.test(agent) ? "a Windows computer" : /Linux/.test(agent) ? "a Linux computer" : "a computer";
  return `${platform} in a browser at ${at.host}`;
}
