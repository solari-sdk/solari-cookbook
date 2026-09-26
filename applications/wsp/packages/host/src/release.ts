// SPDX-License-Identifier: AGPL-3.0-only
// The host's reading of the newest release: GitHub's releases/latest, which
// the release workflow moves last, after npm and both bundles have landed.
// Asked 30 s after the host starts and every six hours after, and when About
// opens, never twice in ten minutes. The last answer lives in release.json
// beside the state file, so a host that starts offline still shows it, and
// wsp status and wsp doctor read it without asking any host.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeOwn } from "@wsp/own-file";
import { HOST_NO_RESTART_LINE, RELEASE_API_ENV, ReleaseLatest, UPDATE_CHECK_ENV, releaseAbove, releaseWord, type HostShape, type ReleaseChangedEvent, type ReleaseView } from "@wsp/protocol";
import type { ReleaseDoor } from "@wsp/runtime";
import { RELEASES, REPO, RELEASE_TAG } from "../../wspx/scripts/bundles.mjs";
import { keyIn, savedEnv } from "./env-keys.js";

export const RELEASE_API = "https://api.github.com";
export const RELEASE_FIRST_MS = 30_000;
export const RELEASE_EVERY_MS = 6 * 60 * 60_000;
/** Unauthenticated, GitHub allows 60 asks an hour per address and a 304 counts (measured 2026-09-24). */
export const RELEASE_FLOOR_MS = 10 * 60_000;
export const RELEASE_TIMEOUT_MS = 5_000;
/** Eight times GitHub's own body limit with every asset row beside it; the timeout bounds time, not size. */
export const RELEASE_BODY_MAX_BYTES = 1024 * 1024;
const RELEASE_FILE = "release.json";

type Env = Readonly<Record<string, string | undefined>>;

const repoPath = new URL(REPO).pathname;
const apiBase = (env: Env): string => (keyIn(env, RELEASE_API_ENV) ?? RELEASE_API).replace(/\/+$/, "");

export const releaseUrl = (env: Env): string => `${apiBase(env)}/repos${repoPath}/releases/latest`;

/** One release's answer and one of its downloads. The override moves both, so a smoke serves the two from one place. */
export const releaseTagUrl = (env: Env, tag: string): string => `${apiBase(env)}/repos${repoPath}/releases/tags/${tag}`;
export const releaseAssetUrl = (env: Env, tag: string, asset: string): string =>
  `${keyIn(env, RELEASE_API_ENV) === undefined ? REPO : `${apiBase(env)}${repoPath}`}/releases/download/${tag}/${asset}`;

export const releaseFileFor = (statePath: string): string => join(dirname(statePath), RELEASE_FILE);

const Answer = z.object({ tag_name: z.string(), published_at: z.string(), draft: z.boolean().optional(), prerelease: z.boolean().optional() });

/** GitHub's answer as a release, refused where it is a draft, a prerelease or a tag the release workflow never cuts.
 * The page is named off the repo and the tag, never off the answer, so a link drawn from it reaches the repo alone. */
export function parseRelease(body: unknown): ReleaseLatest {
  const answer = Answer.parse(body);
  const version = RELEASE_TAG.exec(answer.tag_name)?.[1];
  if (answer.draft === true || answer.prerelease === true || version === undefined) throw new Error(`not a published release: ${answer.tag_name}`);
  return { version, tag: answer.tag_name, url: `${RELEASES}/tag/${answer.tag_name}`, publishedAt: answer.published_at };
}

/** The body as text, the stream cancelled once it passes the cap. */
export async function cappedText(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`the answer is over ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const Kept = z.object({ latest: ReleaseLatest.optional(), checkedAt: z.string().optional(), triedAt: z.string().optional(), etag: z.string().optional() });
type Kept = z.infer<typeof Kept>;

function readKept(path: string): Kept {
  try {
    return Kept.safeParse(JSON.parse(readFileSync(path, "utf8"))).data ?? {};
  } catch {
    return {};
  }
}

/** Whether the person turned off every check for a newer version, in the environment or the saved file. */
export const updateChecksOff = (statePath: string, env: Env): boolean => env[UPDATE_CHECK_ENV] === "0" || savedEnv(statePath)[UPDATE_CHECK_ENV] === "0";

/** What a line that asks no host reads: the switch, then release.json. Nothing where no ask was ever kept. */
export type ReleaseReading = Pick<ReleaseView, "state" | "latest">;
export function releaseReading(statePath: string, env: Env = process.env): ReleaseReading | undefined {
  if (updateChecksOff(statePath, env)) return { state: "off" };
  const kept = readKept(releaseFileFor(statePath));
  if (kept.latest !== undefined) return { state: "read", latest: kept.latest };
  return kept.triedAt === undefined ? undefined : { state: "unreached" };
}

/** The command line's words for a reading: the road to the release beside the number where this wsp is behind it. */
export function latestWords(reading: ReleaseReading, running: string, fix: (version: string) => string): string {
  const word = releaseWord(reading);
  return releaseAbove(reading, running) ? `${word}; this is ${running}, ${fix(word)} gets it` : word;
}

export interface ReleaseWatchOptions {
  statePath: string;
  shape: HostShape;
  /** The version this process runs. */
  running: string;
  /** The version the files it was started from carry now. */
  installed: () => string;
  /** The road host.restart takes, whose refusal the view carries; absent, the host has none. */
  restart?: { refusal?: string };
  /** The line that moves this host onto a release, on the road it was installed by. */
  update?: (version: string) => string;
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where a timer's check that failed is said, since nothing awaits it. */
  log?: (line: string) => void;
}

export interface ReleaseWatch extends ReleaseDoor {
  start(): void;
  close(): void;
}

export function releaseWatch(opts: ReleaseWatchOptions): ReleaseWatch {
  const env = opts.env ?? process.env;
  const fetcher = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const path = releaseFileFor(opts.statePath);
  const listeners = new Set<(e: ReleaseChangedEvent) => void>();
  let kept = readKept(path);
  let answered: "read" | "unreached" | undefined;
  // npm rewrites the files in place, so a read mid-install can fail; the last reading stands until one succeeds.
  const readInstalled = (last: string): string => {
    try {
      return opts.installed();
    } catch {
      return last;
    }
  };
  let installed = readInstalled(opts.running);
  let asking: Promise<ReleaseView> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  let every: ReturnType<typeof setInterval> | undefined;
  const closer = new AbortController();

  const off = (): boolean => updateChecksOff(opts.statePath, env);

  const view = (): ReleaseView => {
    const restartRefusal = opts.restart === undefined ? HOST_NO_RESTART_LINE : opts.restart.refusal;
    const own = { shape: opts.shape, ...(restartRefusal !== undefined ? { restartRefusal } : {}), ...(installed !== opts.running ? { installed } : {}) };
    if (off()) return { state: "off", ...own };
    const update = opts.update !== undefined && kept.latest !== undefined && releaseAbove(kept, opts.running) ? opts.update(kept.latest.version) : undefined;
    return {
      state: answered ?? "checking",
      ...(kept.latest !== undefined ? { latest: kept.latest } : {}),
      ...(update !== undefined ? { update } : {}),
      ...(kept.checkedAt !== undefined ? { checkedAt: kept.checkedAt } : {}),
      ...(kept.triedAt !== undefined ? { triedAt: kept.triedAt } : {}),
      ...own,
    };
  };

  const told = (before: string, after: ReleaseView): ReleaseView => {
    if (JSON.stringify(after) !== before) for (const fn of [...listeners]) fn({ type: "release.changed", release: after });
    return after;
  };

  const ask = async (): Promise<void> => {
    const at = new Date(now()).toISOString();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), RELEASE_TIMEOUT_MS);
    const cut = (): void => timeout.abort();
    closer.signal.addEventListener("abort", cut);
    try {
      const res = await fetcher(releaseUrl(env), {
        headers: { accept: "application/vnd.github+json", "user-agent": `wsp/${opts.running}`, ...(kept.latest !== undefined && kept.etag !== undefined ? { "if-none-match": kept.etag } : {}) },
        signal: timeout.signal,
      });
      if (res.status === 304 && kept.latest !== undefined) kept = { ...kept, checkedAt: at, triedAt: at };
      else if (res.ok) {
        const etag = res.headers.get("etag");
        kept = { latest: parseRelease(JSON.parse(await cappedText(res, RELEASE_BODY_MAX_BYTES))), checkedAt: at, triedAt: at, ...(etag !== null ? { etag } : {}) };
      } else throw new Error(`GitHub answered ${res.status}`);
      answered = "read";
    } catch {
      kept = { ...kept, triedAt: at };
      answered = "unreached";
    } finally {
      clearTimeout(timer);
      closer.signal.removeEventListener("abort", cut);
    }
    if (closer.signal.aborted) return;
    try {
      writeOwn(dirname(path), RELEASE_FILE, `${JSON.stringify(kept)}\n`);
    } catch {
      // The file only carries the reading across a restart; this start answers from memory.
    }
  };

  const check = async (): Promise<ReleaseView> => {
    if (asking !== undefined) return asking;
    const before = JSON.stringify(view());
    installed = readInstalled(installed);
    const since = kept.triedAt === undefined ? undefined : now() - Date.parse(kept.triedAt);
    if (off() || (since !== undefined && since >= 0 && since < RELEASE_FLOOR_MS)) return told(before, view());
    asking = ask()
      .then(() => told(before, view()))
      .finally(() => (asking = undefined));
    return asking;
  };

  return {
    get: view,
    check,
    on: fn => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    start: () => {
      const timed = (): void => void check().catch((e: unknown) => opts.log?.(`release: the check failed (${e instanceof Error ? e.message : String(e)})`));
      first ??= setTimeout(() => {
        timed();
        every = setInterval(timed, RELEASE_EVERY_MS);
      }, RELEASE_FIRST_MS);
    },
    close: () => {
      clearTimeout(first);
      clearInterval(every);
      closer.abort();
      listeners.clear();
    },
  };
}
