// SPDX-License-Identifier: AGPL-3.0-only
import type { ChildProcess } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import { stopVite } from "./vite-child.js";

// Playwright's default --disable-dev-shm-usage puts Chromium's shared memory in
// files under /tmp, which on a 20 GB box is the root disk. Uncapped, one render
// file grew 1628 of them to 8 GB in 20 s, filled the disk and killed other
// threads' tests with ENOSPC (measured 2026-09-08). Low-end device mode caps
// the compositor's tile and image budgets, which holds a whole file under a
// gigabyte; /dev/shm cannot hold them instead, since it is 992 MB here and the
// same file needs over 3 GB.
export const RENDER_ARGS = ["--enable-low-end-device-mode"];

/** The cap lowers what Chromium asks for; nothing stops a later render file asking again, and the first
 * symptom would once more be another thread's ENOSPC. So the root disk is read while the browser lives and
 * the file fails if it fell this far. Capped files peak at 55 to 188 MB, uncapped one file took 7927 MB. */
export const RENDER_DISK_DROP_LIMIT = 2 * 1024 * 1024 * 1024;

export type ChromiumLauncher = (options: LaunchOptions) => Promise<Browser>;
/** Bytes free on the root filesystem. */
export type DiskReader = () => number;

const rootFree: DiskReader = () => {
  const s = statfsSync("/");
  return Number(s.bavail) * Number(s.bsize);
};

interface DiskFloor {
  stop(): number;
}

let floor: DiskFloor | undefined;

/** Watches the root disk from now until stop(), which returns the deepest fall from where it started. The
 * reading at stop() counts too, so a browser that lived less than one interval is still measured. */
export function watchDiskFloor(read: DiskReader = rootFree, everyMs = 500): DiskFloor {
  const start = read();
  let lowest = start;
  const sample = (): void => {
    const now = read();
    if (now < lowest) lowest = now;
  };
  const timer = setInterval(sample, everyMs);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return start - lowest;
    },
  };
}

/** The one launch every render file uses, so the cap has a single home. One browser at a time per file, which
 * is what every render file does; a second launch starts the disk reading over. */
export async function launchRender(launch: ChromiumLauncher = options => chromium.launch(options), read: DiskReader = rootFree): Promise<Browser> {
  floor = watchDiskFloor(read);
  return launch({ args: RENDER_ARGS });
}

/** Why a render file cannot run on this machine, or undefined when it can. The
 * files are asked for by name, and Playwright's Chromium is not everywhere. */
export const renderSkipped = ((): string | undefined => {
  const browser = ((): string | undefined => {
    try {
      return chromium.executablePath();
    } catch {
      return undefined;
    }
  })();
  if (process.env["WSP_RENDER"] !== "1") return "WSP_RENDER is not 1";
  return browser === undefined || !existsSync(browser) ? "Playwright's Chromium is not installed" : undefined;
})();

// Chromium under memory pressure can throw on close or never finish it; vite
// is stopped on every one of those paths.
export async function stopRender(browser: { close(): Promise<void> } | undefined, vite: ChildProcess | undefined, closeGraceMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const fell = floor?.stop() ?? 0;
  floor = undefined;
  try {
    if (browser !== undefined) await Promise.race([browser.close(), new Promise<void>(r => (timer = setTimeout(r, closeGraceMs)))]);
  } finally {
    clearTimeout(timer);
    await stopVite(vite);
  }
  // A file on the same disk can also spend this, so the number is in the line.
  if (fell > RENDER_DISK_DROP_LIMIT) throw new Error(`the root disk fell ${Math.round(fell / 1048576)} MB while this render file ran, over the ${Math.round(RENDER_DISK_DROP_LIMIT / 1048576)} MB a capped file may spend`);
}
