// SPDX-License-Identifier: AGPL-3.0-only
// A laptop described as data: files with sizes or text, dirs as a trailing
// slash with a total size, binaries on PATH, and canned command output.
import type { Host, HostExec, HostFs, Platform, Stat } from "../src/host.js";

export interface FakeLaptop {
  platform?: Platform;
  /** `~/.zshrc: 3000` is a file of 3000 bytes; a string is its text; `~/.config/nvim/: 120000` is a dir. */
  files?: Record<string, number | string>;
  which?: string[];
  /** Keyed by `cmd arg arg`, led by `NAME=value` for each variable the run adds; a value is stdout of a successful run. */
  exec?: Record<string, string>;
  /** When each file was last written, milliseconds since the epoch; a file with no entry reads as MTIME. */
  mtimes?: Record<string, number>;
  /** SHELL of the process running the collector. */
  shell?: string;
  /** TERM_PROGRAM of the process running the collector. */
  terminal?: string;
  /** XDG_CONFIG_HOME of the process running the collector. */
  xdgConfigHome?: string;
}

const HOME = "/Users/dev";
/** The modification time every file has unless the laptop names another. */
export const MTIME = 1_000;

export function fakeHost(laptop: FakeLaptop = {}): Host & { calls: string[] } {
  const files = new Map<string, number | string>();
  for (const [k, v] of Object.entries(laptop.files ?? {})) files.set(k.replace(/^~/, HOME), v);
  const mtimes = new Map<string, number>();
  for (const [k, v] of Object.entries(laptop.mtimes ?? {})) mtimes.set(k.replace(/^~/, HOME), v);
  const calls: string[] = [];

  const fileBytes = (v: number | string): number => (typeof v === "number" ? v : Buffer.byteLength(v));
  const mtimeMs = (path: string): number => mtimes.get(path) ?? MTIME;

  const fs: HostFs = {
    async stat(path): Promise<Stat | undefined> {
      const dir = files.get(`${path}/`);
      if (dir !== undefined) return { kind: "dir", bytes: fileBytes(dir), mtimeMs: mtimeMs(path) };
      const own = files.get(path);
      if (own !== undefined) return { kind: "file", bytes: fileBytes(own), mtimeMs: mtimeMs(path) };
      let bytes = 0;
      let found = false;
      for (const [k, v] of files) {
        if (k.startsWith(`${path}/`)) {
          found = true;
          bytes += fileBytes(v);
        }
      }
      return found ? { kind: "dir", bytes, mtimeMs: mtimeMs(path) } : undefined;
    },
    async list(dir) {
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(`${dir}/`)) continue;
        const rest = k.slice(dir.length + 1);
        const name = rest.split("/")[0];
        if (name !== undefined && name !== "") names.add(name);
      }
      return [...names].sort();
    },
    async readText(path) {
      calls.push(`read ${path}`);
      const v = files.get(path);
      return typeof v === "string" ? v : undefined;
    },
    async walk(dir) {
      return [...files.keys()].filter(k => k.startsWith(`${dir}/`) && !k.endsWith("/")).sort();
    },
    async *lines(path) {
      calls.push(`lines ${path}`);
      const v = files.get(path);
      if (typeof v !== "string") return;
      for (const line of v.split("\n")) yield line;
    },
  };

  const which = new Set(laptop.which ?? []);
  const exec: HostExec = {
    async which(bin) {
      return which.has(bin);
    },
    async run(cmd, args, opts = {}) {
      const key = [...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`), cmd, ...args].join(" ");
      calls.push(`run ${key}${opts.timeoutMs === undefined ? "" : ` (${opts.timeoutMs} ms)`}`);
      return laptop.exec?.[key];
    },
  };

  return { platform: laptop.platform ?? "darwin", home: HOME, ...(laptop.shell !== undefined ? { shell: laptop.shell } : {}), ...(laptop.terminal !== undefined ? { terminal: laptop.terminal } : {}), ...(laptop.xdgConfigHome !== undefined ? { xdgConfigHome: laptop.xdgConfigHome } : {}), fs, exec, calls };
}
