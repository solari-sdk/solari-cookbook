// SPDX-License-Identifier: AGPL-3.0-only
// A path the process may not touch, refused here and not by chmod: root reads and makes anything, so a mode of 0o000 refuses nobody on a wsp workspace.
// Only the sync named reads readdirSync, readFileSync and mkdirSync are guarded; fs.promises and node:fs/promises are the real module.
import type * as fs from "node:fs";

const refused = new Set<string>();

function denied(path: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, ${syscall} '${path}'`), { code: "EACCES", syscall, path });
}

export function refusingFs(real: typeof fs): typeof fs & { default: typeof fs } {
  const guarded = <F extends (path: fs.PathLike, ...rest: never[]) => unknown>(fn: F, syscall: string): F =>
    ((path: fs.PathLike, ...rest: never[]) => {
      if (refused.has(String(path))) throw denied(String(path), syscall);
      return fn(path, ...rest);
    }) as F;
  const guardedFs: typeof fs = { ...real, readdirSync: guarded(real.readdirSync, "scandir"), readFileSync: guarded(real.readFileSync, "open"), mkdirSync: guarded(real.mkdirSync, "mkdir") };
  return { ...guardedFs, default: guardedFs };
}

export async function withRefused<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  refused.add(path);
  try {
    return await fn();
  } finally {
    refused.delete(path);
  }
}
