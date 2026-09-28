// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export interface ViteChild {
  child: ChildProcess;
  base: string;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`vite did not serve ${url} in time`);
}

/** Spawns the web dev server on a free port and resolves once it serves `path`. */
export async function startVite(webDir: string, path: string): Promise<ViteChild> {
  // Vite answers a missing page with the app's index and a 200, so a deleted harness would only show as timeouts.
  if (!existsSync(join(webDir, path))) throw new Error(`${path} is not a file under ${webDir}`);
  const port = await freePort();
  const child = spawn(join(webDir, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort", "--logLevel", "silent"], { cwd: webDir, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}${path}`, child);
  } catch (error) {
    await stopVite(child);
    throw error;
  }
  return { child, base };
}

// Vite's SIGTERM handler waits on a dependency prebundle it cancelled, so a
// plain kill can leave the server alive at ppid 1; only the recorded handle
// is ever signalled.
export async function stopVite(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once("exit", () => done()));
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await exited;
  clearTimeout(timer);
}
