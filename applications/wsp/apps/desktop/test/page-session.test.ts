// SPDX-License-Identifier: AGPL-3.0-only
// The window's session refuses a service worker on a loopback origin and
// carries none over into a host page: the two halves of the rule that keeps a
// worker a previewed page registered off the next page on that port.
import { describe, expect, it, vi } from "vitest";
import { guardWorkers, loadHostPage, sweepFailedLine, type PageSession } from "../src/page-session.js";

type Listener = (details: { url: string; requestHeaders: Record<string, string> }, callback: (response: { cancel?: boolean }) => void) => void;

function fakeSession(order: string[] = [], sweep: () => Promise<void> = async () => {}): PageSession & { listener(): Listener; cleared: { storages: string[] }[] } {
  let held: Listener | undefined;
  const cleared: { storages: string[] }[] = [];
  return {
    webRequest: {
      onBeforeSendHeaders: listener => {
        held = listener;
      },
    },
    clearStorageData: async options => {
      cleared.push(options);
      await sweep();
      order.push("cleared");
    },
    listener: () => {
      if (held === undefined) throw new Error("no listener was installed");
      return held;
    },
    cleared,
  };
}

/** What the guard answered for one request, as Electron reads the listener's callback. */
function answered(listener: Listener, url: string, requestHeaders: Record<string, string>): { cancel?: boolean } {
  let response: { cancel?: boolean } | undefined;
  listener({ url, requestHeaders }, r => (response = r));
  if (response === undefined) throw new Error("the listener answered nothing");
  return response;
}

const PAGE_HEADERS = { Accept: "text/html", "User-Agent": "wsp" };
const WORKER_HEADERS = { Accept: "*/*", "Service-Worker": "script" };

describe("guardWorkers", () => {
  it("cancels a worker script fetch on a loopback origin, in every spelling of one", () => {
    const session = fakeSession();
    guardWorkers(session);
    const listener = session.listener();
    for (const url of ["http://127.0.0.1:3000/sw.js", "http://localhost:3000/sw.js", "http://[::1]:3000/sw.js", "http://127.4.5.6:3000/nested/worker.js"]) {
      expect(answered(listener, url, WORKER_HEADERS)).toEqual({ cancel: true });
    }
    // The header's name and value are read however the browser spells them.
    expect(answered(listener, "http://127.0.0.1:3000/sw.js", { "service-worker": "Script" })).toEqual({ cancel: true });
  });

  it("passes a worker script on any other host, a request without the header, and the page load itself", () => {
    const session = fakeSession();
    guardWorkers(session);
    const listener = session.listener();
    // A provider's preview hostname is its own origin and never collides with a loopback port.
    expect(answered(listener, "https://ws-abc.preview.example/sw.js", WORKER_HEADERS)).toEqual({});
    expect(answered(listener, "http://127.evil.example/sw.js", WORKER_HEADERS)).toEqual({});
    expect(answered(listener, "http://127.0.0.1:3000/sw.js", PAGE_HEADERS)).toEqual({});
    expect(answered(listener, "http://127.0.0.1:4400/", PAGE_HEADERS)).toEqual({});
    expect(answered(listener, "http://127.0.0.1:4400/assets/app.js", PAGE_HEADERS)).toEqual({});
    expect(answered(listener, "not a url", WORKER_HEADERS)).toEqual({});
  });
});

describe("loadHostPage", () => {
  it("sweeps the session's worker registrations before the page is loaded, never after, and says nothing when the sweep is done", async () => {
    const order: string[] = [];
    const session = fakeSession(order);
    const loadURL = vi.fn(async () => {
      order.push("loaded");
    });
    const lines: string[] = [];
    await loadHostPage({ webContents: { session }, loadURL }, "http://127.0.0.1:4400", { log: line => lines.push(line) });
    expect(order).toEqual(["cleared", "loaded"]);
    expect(session.cleared).toEqual([{ storages: ["serviceworkers"] }]);
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:4400");
    expect(lines).toEqual([]);
  });

  it("does not hold the load past the bound behind a sweep that never comes back, and logs that it was skipped", async () => {
    // What a profile another app has open does: the database is locked, and the promise never settles.
    const order: string[] = [];
    const session = fakeSession(order, () => new Promise<void>(() => {}));
    const loadURL = vi.fn(async () => {
      order.push("loaded");
    });
    const lines: string[] = [];
    const started = Date.now();
    await loadHostPage({ webContents: { session }, loadURL }, "http://127.0.0.1:4400", { boundMs: 50, log: line => lines.push(line) });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(order).toEqual(["loaded"]);
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:4400");
    expect(lines).toEqual([sweepFailedLine("not done in 50 ms")]);
  });

  it("loads the page when the sweep fails, with the failure in the line", async () => {
    const order: string[] = [];
    const session = fakeSession(order, () => Promise.reject(new Error("Database IO error")));
    const loadURL = vi.fn(async () => {
      order.push("loaded");
    });
    const lines: string[] = [];
    await loadHostPage({ webContents: { session }, loadURL }, "http://127.0.0.1:4400", { log: line => lines.push(line) });
    expect(order).toEqual(["loaded"]);
    expect(lines).toEqual([sweepFailedLine("Database IO error")]);
  });
});
