// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchRender, RENDER_ARGS, RENDER_DISK_DROP_LIMIT, stopRender, watchDiskFloor } from "./render-browser";

// The child prints once its script has run, so a signal never races its handler.
const started = (script: string) => {
  const c = spawn(process.execPath, ["-e", `${script}; process.stdout.write("ready")`], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise<typeof c>(done => c.stdout.once("data", () => done(c)));
};
/** A browser that closes at once, which is every case here that is not about a browser. */
const shut = { close: () => Promise.resolve() };
const GB = 1024 * 1024 * 1024;

it("stopRender stops vite when the browser throws on close, and rethrows", async () => {
  const c = await started("setInterval(() => {}, 1000)");
  const browser = { close: () => Promise.reject(new Error("browser gone")) };
  await expect(stopRender(browser, c)).rejects.toThrow("browser gone");
  expect(c.signalCode).toBe("SIGTERM");
});

it("stopRender stops vite when the browser never finishes closing", async () => {
  const c = await started("setInterval(() => {}, 1000)");
  const browser = { close: () => new Promise<void>(() => {}) };
  await stopRender(browser, c, 100);
  expect(c.signalCode).toBe("SIGTERM");
});

it("stopRender with no browser still stops vite", async () => {
  const c = await started("setInterval(() => {}, 1000)");
  await stopRender(undefined, c);
  expect(c.signalCode).toBe("SIGTERM");
});

it("launchRender hands Chromium the cap on its shared memory, which no render file may spend a whole disk on", async () => {
  let got: string[] | undefined;
  await launchRender(options => {
    got = options.args;
    return Promise.resolve({} as never);
  });
  expect(got).toEqual(RENDER_ARGS);
  expect(RENDER_ARGS).toContain("--enable-low-end-device-mode");
  await stopRender(shut, undefined);
});

// The law is the whole repo's, not this package's: a render file added under any package must come through the
// helper too. node_modules is pruned as the walk goes, since filtering a full recursive listing costs seconds.
function renderFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    if (e.isDirectory()) renderFiles(join(dir, e.name), out);
    else if (e.name.endsWith(".browser.test.ts")) out.push(join(dir, e.name));
  }
  return out;
}

it("every render file launches through launchRender, so the cap has one home", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const render = [...renderFiles(join(root, "packages")), ...renderFiles(join(root, "apps"))];
  expect(render.length).toBeGreaterThan(10);
  const bodies = render.map(f => [relative(root, f), readFileSync(f, "utf8")] as const);
  expect(bodies.filter(([, body]) => body.includes("chromium.launch(")).map(([f]) => f)).toEqual([]);
  expect(bodies.filter(([, body]) => !body.includes("launchRender(")).map(([f]) => f)).toEqual([]);
});

it("watchDiskFloor reports the deepest fall from where it started, not the last reading", async () => {
  const readings = [10 * GB, 4 * GB, 9 * GB];
  const floor = watchDiskFloor(() => readings.shift() ?? 9 * GB, 1);
  await new Promise(done => setTimeout(done, 30));
  expect(floor.stop()).toBe(6 * GB);
});

it("a render file whose browser spends the disk fails on its own teardown, with the number in the line", async () => {
  const readings = [10 * GB, 10 * GB - RENDER_DISK_DROP_LIMIT - 1024 * 1024];
  await launchRender(() => Promise.resolve({} as never), () => readings.shift() ?? 10 * GB);
  await new Promise(done => setTimeout(done, 30));
  await expect(stopRender(shut, undefined)).rejects.toThrow(/the root disk fell 2049 MB while this render file ran, over the 2048 MB/);
});

it("a render file that stays inside the bound is left alone, and one file's fall is not charged to the next", async () => {
  const readings = [10 * GB, 9.5 * GB];
  await launchRender(() => Promise.resolve({} as never), () => readings.shift() ?? 9.5 * GB);
  await new Promise(done => setTimeout(done, 30));
  await expect(stopRender(shut, undefined)).resolves.toBeUndefined();
  const c = await started("setInterval(() => {}, 1000)");
  await expect(stopRender(undefined, c)).resolves.toBeUndefined();
  expect(c.signalCode).toBe("SIGTERM");
});
