// SPDX-License-Identifier: AGPL-3.0-only
// The session every frame in the window shares: the host's page and the
// preview pane's frames alike. A page a person previews is served by a process
// inside a workspace, on a loopback port the kernel picked and hands out again
// once the forward is dropped, and a service worker that page registers
// outlives both; the next page on that number, another workspace's preview or
// a host page with its token, would be that worker's to answer. So no frame on
// a loopback origin registers one, and a host page is never loaded into a
// session still holding one an earlier build let in. The cost is named where
// the person meets it: a preview in this window runs no service worker, and
// the chrome row's Open in browser is where one that needs one goes.
import { isLoopback } from "@wsp/protocol";

/** The request header a browser puts on a worker script fetch and on its update, and on nothing else; the filter's
 * own type list has no word for one, so the listener reads the header itself. */
const WORKER_SCRIPT = { name: "service-worker", value: "script" };

/** The part of Electron's Session this needs; a fake stands in for it under test. */
export interface PageSession {
  webRequest: {
    onBeforeSendHeaders(listener: (details: { url: string; requestHeaders: Record<string, string> }, callback: (response: { cancel?: boolean }) => void) => void): void;
  };
  clearStorageData(options: { storages: ["serviceworkers"] }): Promise<void>;
}

/** The part of a BrowserWindow this needs. */
export interface HostPage {
  webContents: { session: PageSession };
  loadURL(url: string): Promise<void>;
}

function onLoopback(url: string): boolean {
  try {
    return isLoopback(new URL(url).hostname);
  } catch {
    return false;
  }
}

function asksForWorkerScript(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(([name, value]) => name.toLowerCase() === WORKER_SCRIPT.name && value.toLowerCase() === WORKER_SCRIPT.value);
}

/** Installed on the window's session once, before the window's first load: a worker script fetch on a loopback
 * origin is cancelled, and every other request passes untouched. */
export function guardWorkers(session: PageSession): void {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback(onLoopback(details.url) && asksForWorkerScript(details.requestHeaders) ? { cancel: true } : {});
  });
}

/** How long the sweep before a load may take: on a profile another app holds open it never comes back, and the
 * window stayed shut behind it. */
export const SWEEP_BOUND_MS = 2_000;

/** The line logged when the sweep did not come back or failed: the page loads without it, and the person reads why. */
export const sweepFailedLine = (why: string): string => `service worker sweep skipped: ${why}; loading the page without it`;

/** Puts the window on a host's page, with the session's worker registrations swept first: a worker an earlier build
 * let in is gone before a page carrying this computer's token digest is loaded on an origin it could hold. The
 * sweep is bounded: a profile locked by another process holds it open for ever, and a window that never opens
 * says nothing, so the page loads once the bound passes and one line says the sweep was skipped. */
export async function loadHostPage(page: HostPage, url: string, o: { boundMs?: number; log?: (line: string) => void } = {}): Promise<void> {
  const bound = o.boundMs ?? SWEEP_BOUND_MS;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>(resolve => {
    timer = setTimeout(() => resolve(`not done in ${bound} ms`), bound);
  });
  const swept = page.webContents.session
    .clearStorageData({ storages: ["serviceworkers"] })
    .then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  const failed = await Promise.race([swept, late]);
  clearTimeout(timer);
  if (failed !== undefined) o.log?.(sweepFailedLine(failed));
  await page.loadURL(url);
}
