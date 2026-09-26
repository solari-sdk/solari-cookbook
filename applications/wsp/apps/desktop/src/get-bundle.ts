// SPDX-License-Identifier: AGPL-3.0-only
// The shell's road to a newer release. The page hands over a version and no
// URL: this builds the answer's and the download's URLs off the repo, reads
// the sha256 GitHub publishes for the asset, and keeps the bytes only where
// they match. Opening what was kept quits the app, since the running host
// serves the page and the daemon binaries out of the bundle by path.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { RELEASE_BODY_MAX_BYTES, RELEASE_TIMEOUT_MS, cappedText, releaseAssetUrl, releaseTagUrl } from "@wsp/host";
import { RELEASE_API_ENV, compareVersions, type BundleOutcome } from "@wsp/protocol";
import { RELEASE_TAG, bundleNames } from "../../../packages/wspx/scripts/bundles.mjs";

export const BUNDLE_WORDS = {
  notAVersion: "not a release version",
  notNewer: (version: string): string => `${version} is not a release above this app`,
  noBundle: (platform: string): string => `no wsp bundle is built for ${platform}`,
  noDigest: (asset: string): string => `the release publishes no sha256 and size for ${asset}`,
  mismatch: (asset: string): string => `${asset} did not match the release's sha256 and was deleted`,
  tooBig: (asset: string): string => `${asset} ran past the size the release publishes and was deleted`,
  unsaved: (asset: string): string => `${asset} could not be saved in Downloads`,
  unreached: (asset: string, why: string): string => `${asset} was not downloaded: ${why}`,
  changed: (asset: string): string => `${asset} changed after it was checked and was not opened`,
  nothingKept: "no verified download to open",
} as const;

type Env = Readonly<Record<string, string | undefined>>;

/** How long a download may go without a byte before it is given up, so a stalled connection never holds Downloading. */
export const BUNDLE_STALL_MS = 30_000;

/** What opens a kept bundle: the system's opener, which answers an empty string or its own reason, and the folder view. */
export interface BundleOpeners {
  open(file: string): Promise<string>;
  reveal(file: string): void;
}

/** One platform's bundle: which asset of a release it is, the words over Get, and what makes it the person's next
 * step once kept. */
interface BundleRoad {
  asset(version: string): string;
  hover: string;
  open(file: string, openers: BundleOpeners): Promise<string>;
}

const BUNDLE_ROADS: Partial<Record<NodeJS.Platform, BundleRoad>> = {
  // Mounting the disk image opens its drag window.
  darwin: {
    asset: version => bundleNames(version).mac,
    hover: "Downloads the disk image and checks its sha256. Unsigned builds need Privacy & Security, Open Anyway, once.",
    open: (file, o) => o.open(file),
  },
  linux: {
    asset: version => bundleNames(version).appImage,
    hover: "Downloads the AppImage into Downloads and checks its sha256. The app you run is not replaced.",
    open: async (file, o) => {
      await chmod(file, 0o755);
      o.reveal(file);
      return "";
    },
  },
};

/** The words over Get on this platform, or nothing where no bundle is built for it. */
export const bundleHover = (platform: NodeJS.Platform): string | undefined => BUNDLE_ROADS[platform]?.hover;

/** The version out of the page's ask, only where it is one the release workflow would tag. */
export function askedVersion(raw: unknown): string | undefined {
  const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  return typeof version === "string" && RELEASE_TAG.exec(`v${version}`)?.[1] === version ? version : undefined;
}

export interface BundleDeps {
  platform: NodeJS.Platform;
  /** Where the download lands: the person's Downloads folder. */
  dir: string;
  env: Env;
  userAgent: string;
  fetch: typeof fetch;
  stallMs?: number;
}

interface Published {
  sum: string;
  size: number;
}

/** The hex sha256 and the byte size GitHub publishes for this asset of the release, or nothing unless it lists both. */
async function published(tag: string, asset: string, deps: BundleDeps): Promise<Published | undefined> {
  const res = await deps.fetch(releaseTagUrl(deps.env, tag), { headers: { accept: "application/vnd.github+json", "user-agent": deps.userAgent }, signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const answer = JSON.parse(await cappedText(res, RELEASE_BODY_MAX_BYTES)) as { assets?: unknown };
  const row = Array.isArray(answer.assets) ? (answer.assets as unknown[]).find(a => (a as { name?: unknown } | null)?.name === asset) : undefined;
  const { digest, size } = (row ?? {}) as { digest?: unknown; size?: unknown };
  const sum = typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1] : undefined;
  return sum !== undefined && Number.isSafeInteger(size) && (size as number) >= 0 ? { sum, size: size as number } : undefined;
}

async function sumOf(file: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    await pipeline(createReadStream(file), hash);
  } catch {
    return undefined;
  }
  return hash.digest("hex");
}

class PastSize extends Error {}

/** Streams the download beside its final name, hashing as it writes and stopping past the published size; renamed
 * into place on a match, deleted otherwise. */
async function download(url: string, file: string, want: Published, asset: string, deps: BundleDeps): Promise<BundleOutcome> {
  const part = `${file}.part`;
  const hash = createHash("sha256");
  const stallMs = deps.stallMs ?? BUNDLE_STALL_MS;
  const stalled = new AbortController();
  let timer = setTimeout(() => stalled.abort(), stallMs);
  let bytes = 0;
  const tee = new Transform({
    transform(chunk: Buffer, _enc, done) {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), stallMs);
      bytes += chunk.length;
      if (bytes > want.size) return done(new PastSize());
      hash.update(chunk);
      done(null, chunk);
    },
  });
  let failed: string | undefined;
  try {
    const res = await deps.fetch(url, { headers: { "user-agent": deps.userAgent }, signal: stalled.signal });
    if (!res.ok || res.body === null) return { ok: false, error: BUNDLE_WORDS.unreached(asset, `GitHub answered ${res.status}`) };
    await rm(part, { force: true });
    // Exclusive create refuses a link planted at the name between the removal and the open.
    await pipeline(Readable.fromWeb(res.body as ReadableStream), tee, createWriteStream(part, { flags: "wx" }), { signal: stalled.signal });
    if (hash.digest("hex") !== want.sum) failed = BUNDLE_WORDS.mismatch(asset);
    else await rename(part, file);
  } catch (e) {
    failed =
      e instanceof PastSize ? BUNDLE_WORDS.tooBig(asset)
      : stalled.signal.aborted ? BUNDLE_WORDS.unreached(asset, `no bytes for ${stallMs / 1000} s`)
      : e instanceof Error && "path" in e ? BUNDLE_WORDS.unsaved(asset)
      : BUNDLE_WORDS.unreached(asset, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  if (failed === undefined) return { ok: true };
  await rm(part, { force: true });
  return { ok: false, error: failed };
}

/** This release's bundle for this platform in the download folder, verified against the published sha256. */
export async function getBundle(version: string, deps: BundleDeps): Promise<{ ok: true; file: string; sum: string } | { ok: false; error: string }> {
  const road = BUNDLE_ROADS[deps.platform];
  if (road === undefined) return { ok: false, error: BUNDLE_WORDS.noBundle(deps.platform) };
  const tag = `v${version}`;
  const asset = road.asset(version);
  let want: Published | undefined;
  try {
    want = await published(tag, asset, deps);
  } catch (e) {
    return { ok: false, error: BUNDLE_WORDS.unreached(asset, e instanceof Error ? e.message : String(e)) };
  }
  if (want === undefined) return { ok: false, error: BUNDLE_WORDS.noDigest(asset) };
  const file = join(deps.dir, asset);
  if ((await sumOf(file)) === want.sum) return { ok: true, file, sum: want.sum };
  const got = await download(releaseAssetUrl(deps.env, tag, asset), file, want, asset, deps);
  return got.ok ? { ok: true, file, sum: want.sum } : got;
}

/** Hands a kept bundle to the person's next step on its platform. */
export async function openBundle(kept: { file: string; platform: NodeJS.Platform }, openers: BundleOpeners): Promise<BundleOutcome> {
  const road = BUNDLE_ROADS[kept.platform];
  if (road === undefined) return { ok: false, error: BUNDLE_WORDS.noBundle(kept.platform) };
  const said = await road.open(kept.file, openers);
  return said === "" ? { ok: true } : { ok: false, error: said };
}

export interface BundleShell {
  get(raw: unknown): Promise<BundleOutcome>;
  open(): Promise<BundleOutcome>;
}

export interface BundleShellDeps extends BundleDeps, BundleOpeners {
  quit(): void;
  /** This app's own version: only a release above it, and never a prerelease, is fetched. */
  running: string;
  /** A packaged app reads the release off GitHub alone, whatever the smoke's variable says. */
  packaged: boolean;
}

/** The two bridge channels' state: asks that overlap share one download, and open reaches only what a get kept,
 * with the sum it matched when it was kept. */
export function bundleShell(shellDeps: BundleShellDeps): BundleShell {
  const deps: BundleShellDeps = shellDeps.packaged ? { ...shellDeps, env: Object.fromEntries(Object.entries(shellDeps.env).filter(([key]) => key !== RELEASE_API_ENV)) } : shellDeps;
  let kept: { file: string; sum: string } | undefined;
  const getting = new Map<string, Promise<BundleOutcome>>();
  return {
    get: raw => {
      const version = askedVersion(raw);
      if (version === undefined) return Promise.resolve({ ok: false, error: BUNDLE_WORDS.notAVersion });
      if (version.includes("-") || compareVersions(version, deps.running) <= 0) return Promise.resolve({ ok: false, error: BUNDLE_WORDS.notNewer(version) });
      const running = getting.get(version);
      if (running !== undefined) return running;
      kept = undefined;
      const asked = getBundle(version, deps)
        .then((got): BundleOutcome => {
          if (!got.ok) return got;
          kept = { file: got.file, sum: got.sum };
          return { ok: true };
        })
        .finally(() => getting.delete(version));
      getting.set(version, asked);
      return asked;
    },
    open: async () => {
      if (kept === undefined) return { ok: false, error: BUNDLE_WORDS.nothingKept };
      const { file, sum } = kept;
      if ((await sumOf(file)) !== sum) {
        kept = undefined;
        return { ok: false, error: BUNDLE_WORDS.changed(basename(file)) };
      }
      const opened = await openBundle({ file, platform: deps.platform }, deps);
      if (opened.ok) deps.quit();
      return opened;
    },
  };
}
