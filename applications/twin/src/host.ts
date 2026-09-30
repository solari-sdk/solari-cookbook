import { readFile } from 'node:fs/promises';
import { arch, homedir, platform, release } from 'node:os';
import { type Exec, execProcess } from './util/exec.ts';

/**
 * Everything twin reads from the machine it runs on. Commands receive a Host instead of touching
 * `process` or `os` directly, which keeps them deterministic under test.
 */
export interface Host {
  exec: Exec;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  homeDir: string;
  now: () => Date;
  readTextFile: (path: string) => Promise<string>;
  /** Downloads capsules given as URLs. */
  fetch: typeof globalThis.fetch;
  /** glibc version of the running Node binary, or null on non-glibc systems. */
  glibcVersion: () => string | null;
  /** The time zone and locale the command's process would resolve (Intl defaults). */
  intlDefaults: () => { timeZone: string | null; locale: string | null };
}

export function realHost(): Host {
  return {
    exec: execProcess,
    env: process.env,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    homeDir: homedir(),
    now: () => new Date(),
    readTextFile: (path) => readFile(path, 'utf8'),
    fetch: globalThis.fetch,
    glibcVersion: () => {
      const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
      return report.header?.glibcVersionRuntime ?? null;
    },
    intlDefaults: () => {
      const options = new Intl.DateTimeFormat().resolvedOptions();
      return { timeZone: options.timeZone ?? null, locale: options.locale ?? null };
    },
  };
}
