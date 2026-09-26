// SPDX-License-Identifier: AGPL-3.0-only
// Everything a detector may ask the laptop. Detectors are pure over this
// interface; unit tests hand in a fake and the live script hands in node.
export type Platform = "darwin" | "linux";

export interface Stat {
  kind: "file" | "dir";
  /** Size of the file, or of every regular file under the dir. */
  bytes: number;
  /** When it was last written, milliseconds since the epoch: with the size, what says a file a reader already read
   * has changed since. */
  mtimeMs: number;
}

export interface HostFs {
  stat(path: string): Promise<Stat | undefined>;
  /** Names directly under dir; empty when dir is missing. */
  list(dir: string): Promise<string[]>;
  /** Only for files whose content is configuration, never a credential. */
  readText(path: string): Promise<string | undefined>;
  /** Every regular file under dir, absolute and sorted, links and the dependency trees under it left out; empty when dir is missing. */
  walk(dir: string): Promise<string[]>;
  /** The file one line at a time, for a reader that keeps names and counts and drops the line; nothing when it cannot be opened. */
  lines(path: string): AsyncIterable<string>;
}

export interface RunOptions {
  /** Variables added to the collector's own environment for this child. */
  env?: Readonly<Record<string, string>>;
  /** How long the child may run before it is killed; two minutes when unset. */
  timeoutMs?: number;
}

export interface HostExec {
  which(bin: string): Promise<boolean>;
  /** stdout when the command exits 0, otherwise undefined. Every child reads end of file on stdin. */
  run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<string | undefined>;
}

export interface Host {
  platform: Platform;
  home: string;
  /** SHELL of the process running the collector: the login shell of whoever started it. */
  shell?: string;
  /** TERM_PROGRAM of the process running the collector: the terminal whoever started it types in. */
  terminal?: string;
  /** XDG_CONFIG_HOME of the process running the collector; unset, the XDG config dir is ~/.config. */
  xdgConfigHome?: string;
  fs: HostFs;
  exec: HostExec;
}

/** Absolute path for a `~/`-relative one. */
export function expand(host: Pick<Host, "home">, path: string): string {
  if (path === "~") return host.home;
  return path.startsWith("~/") ? `${host.home}/${path.slice(2)}` : path;
}

/** `~`-relative form of an absolute path under home; other paths come back unchanged. */
export function tilde(home: string, path: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
