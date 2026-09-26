// SPDX-License-Identifier: AGPL-3.0-only
// Each agent's newest version, asked of its vendor by this host and never by
// a machine or the page: the npm registry's latest tag, a GitHub repository's
// latest release, or Claude Code's own latest file. Only the catalog's
// addresses are asked, all of them, whichever agents a computer has, so an ask
// says nothing about what is installed anywhere. An agents read asks what is
// older than a day, in the background once a number is kept; nothing asks on
// a timer. An answer counts only if it ended over https on the source's own
// host and is a whole strict semver. The answers live beside the state file,
// so a restart asks nothing, and a vendor that failed is not asked again for
// ten minutes. WSP_UPDATE_CHECK=0 turns every ask off, as it does the check
// for wsp's own release; the Privacy switch is the runtime's to read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CATALOG_AGENTS, type LatestSource } from "@wsp/catalog";
import { strictVersion } from "@wsp/protocol";
import { writeOwn } from "@wsp/own-file";
import { cappedText, updateChecksOff } from "./release.js";

export const LATEST_KEPT_MS = 24 * 60 * 60_000;
export const LATEST_FLOOR_MS = 10 * 60_000;
const LATEST_TIMEOUT_MS = 5_000;
const LATEST_FILE = "agent-latest.json";

export const latestFileFor = (statePath: string): string => join(dirname(statePath), LATEST_FILE);

/** How one kind of source is asked: its address, the most of an answer read, and the version the answer names. */
interface LatestModule<S extends LatestSource> {
  url(source: S): string;
  maxBytes: number;
  version(body: string): string | undefined;
}

const field = (name: string) => (body: string): string | undefined => {
  const said: unknown = JSON.parse(body);
  const value = typeof said === "object" && said !== null ? (said as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : undefined;
};

/** npm's latest document is a few KB and GitHub's release with its assets well under a megabyte. */
const LATEST_READERS: { [K in LatestSource["from"]]: LatestModule<Extract<LatestSource, { from: K }>> } = {
  npm: { url: s => `https://registry.npmjs.org/${s.package.replace("/", "%2f")}/latest`, maxBytes: 1024 * 1024, version: field("version") },
  github: { url: s => `https://api.github.com/repos/${s.repo}/releases/latest`, maxBytes: 1024 * 1024, version: field("tag_name") },
  text: { url: s => s.url, maxBytes: 256, version: body => body },
};

const readerOf = (s: LatestSource): LatestModule<LatestSource> => LATEST_READERS[s.from] as LatestModule<LatestSource>;
const urlOf = (s: LatestSource): string => readerOf(s).url(s);

/** Whether the answer ended where it was asked: https on the source's own host, after whatever redirects fetch took. */
function sameOrigin(asked: string, ended: string): boolean {
  try {
    const [a, e] = [new URL(asked), new URL(ended)];
    return e.protocol === "https:" && e.host === a.host;
  } catch {
    return false;
  }
}

const Reading = z.object({ version: z.string().refine(v => strictVersion(v) === v).optional(), checkedAt: z.number().optional(), triedAt: z.number().optional() }).strip();
type Reading = z.infer<typeof Reading>;

/** The file under the same rule as an answer: an address the catalog does not name, or an entry that fails it, is gone. */
function readKept(path: string, urls: ReadonlySet<string>): Record<string, Reading> {
  let said: unknown;
  try {
    said = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof said !== "object" || said === null || Array.isArray(said)) return {};
  return Object.fromEntries(Object.entries(said).flatMap(([url, entry]) => {
    const r = urls.has(url) ? Reading.safeParse(entry) : undefined;
    return r?.success === true ? [[url, r.data]] : [];
  }));
}

type LatestFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface AgentLatest {
  /** Each agent's newest version by id as kept; a stale source is asked in the background, and only a host that keeps
   * no number at all waits on the asks. */
  read(): Promise<Readonly<Record<string, string>>>;
  /** Settles once no ask is running. */
  idle(): Promise<void>;
}

export function agentLatest(o: { statePath: string; running: string; fetch?: LatestFetch; now?: () => number; env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number }): AgentLatest {
  const fetcher: LatestFetch = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const env = o.env ?? process.env;
  const path = latestFileFor(o.statePath);
  const sources = CATALOG_AGENTS.flatMap(a => (a.latest === undefined ? [] : [{ id: a.id, source: a.latest }]));
  const urls = new Set(sources.map(s => urlOf(s.source)));
  let kept = readKept(path, urls);
  let asking: Promise<void> | undefined;

  const ask = async (source: LatestSource, at: number): Promise<void> => {
    const url = urlOf(source);
    const reader = readerOf(source);
    let version: string | undefined;
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(o.timeoutMs ?? LATEST_TIMEOUT_MS), headers: { "user-agent": `wsp/${o.running}` } });
      if (res.ok && sameOrigin(url, res.url)) version = strictVersion(reader.version(await cappedText(res, reader.maxBytes)) ?? "");
      else await res.body?.cancel();
    } catch {
      // Offline, a timeout, an answer past the cap or not JSON: the last number stands.
    }
    kept = { ...kept, [url]: version === undefined ? { ...kept[url], triedAt: at } : { version, checkedAt: at, triedAt: at } };
  };

  const due = (url: string, at: number): boolean => {
    const r = kept[url];
    return (r?.checkedAt === undefined || at - r.checkedAt >= LATEST_KEPT_MS) && (r?.triedAt === undefined || at - r.triedAt >= LATEST_FLOOR_MS);
  };

  const refresh = async (): Promise<void> => {
    const at = now();
    const stale = [...new Map(sources.map(s => [urlOf(s.source), s.source])).entries()].filter(([url]) => due(url, at));
    if (stale.length === 0) return;
    await Promise.all(stale.map(([, source]) => ask(source, at)));
    if (updateChecksOff(o.statePath, env)) return;
    try {
      writeOwn(dirname(path), LATEST_FILE, `${JSON.stringify(kept)}\n`);
    } catch {
      // The file only carries the readings across a restart; this start answers from memory.
    }
  };

  const answer = (): Record<string, string> =>
    Object.fromEntries(sources.flatMap(s => {
      const version = kept[urlOf(s.source)]?.version;
      return version === undefined ? [] : [[s.id, version]];
    }));

  return {
    async read() {
      if (updateChecksOff(o.statePath, env)) return {};
      const none = Object.keys(answer()).length === 0;
      asking ??= refresh().finally(() => (asking = undefined));
      if (none) await asking;
      return answer();
    },
    idle: async () => {
      await asking;
    },
  };
}
