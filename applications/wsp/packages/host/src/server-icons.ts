// SPDX-License-Identifier: AGPL-3.0-only
// A remote MCP server's icon, asked of Google's favicon service by this host
// and never by the page, a machine or any address a config names. Only a
// public name leaves: publicIconHost is the one rule for what may, and a name
// that resolves to any address inside a network is kept here as well. What
// Google hands back is kept only as an image of a known kind under 64 KB, on
// disk under the wsp home for 30 days, a miss too, so a host is asked once.
// A lookup that fails is not kept, so an ask made offline is made again.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import type { ServerIcons } from "@wsp/runtime";
import { z } from "zod";
import { capped } from "./skills-sh.js";

/** One address a name resolves to. */
export interface Pin {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<readonly Pin[]>;

/** Every address the name resolves to, as this computer's resolver answers it. */
export const resolveAll: Resolver = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

const INTERNAL = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) INTERNAL.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 96], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2002::", 16]] as const) INTERNAL.addSubnet(net, bits, "ipv6");

/** The IPv4 address an IPv6 one carries, mapped (::ffff:a.b.c.d) or through NAT64 (64:ff9b::/96). */
function carriedV4(address: string): string | undefined {
  const tail = /^(?:::ffff:|64:ff9b::)(.+)$/i.exec(address)?.[1];
  if (tail === undefined) return undefined;
  if (isIP(tail) === 4) return tail;
  const [hi, lo] = tail.split(":").map(h => parseInt(h, 16));
  return hi === undefined || lo === undefined || Number.isNaN(hi) || Number.isNaN(lo) ? undefined : [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** Loopback, private, link-local, shared, multicast or reserved: an address this computer reaches that the
 * server's name must not lead an ask to. */
export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return INTERNAL.check(address, "ipv4");
  if (family !== 6) return true;
  const v4 = carriedV4(address);
  return v4 !== undefined ? INTERNAL.check(v4, "ipv4") : INTERNAL.check(address, "ipv6");
}

export type IconFetch = (url: string, init?: { signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<Response>;

export const ICON_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const ICON_MAX_BYTES = 64 * 1024;
const ASK_MS = 10_000;
const MAX_HOPS = 3;
const GOOGLE = "https://www.google.com/s2/favicons";
/** The hosts Google's answer moves to, as measured on 2026-09-25: a 301 to t<n>.gstatic.com/faviconV2. */
const GOOGLE_HOPS = /^(?:www\.google\.com|t\d+\.gstatic\.com)$/;
/** Names only a private network, this computer or an overlay knows. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "ts.net", "onion"];
const NAME = /^[a-z0-9.-]+$/;

/** The name a server's host is asked of Google by, or nothing where it may not leave this computer: an address
 * literal, a single label, a private suffix, or any character a public name does not hold. */
export function publicIconHost(host: string): string | null {
  const bare = host.startsWith("[") ? null : host.replace(/:\d*$/, "").toLowerCase().replace(/\.$/, "");
  if (bare === null || bare === "" || isIP(bare) !== 0 || !NAME.test(bare)) return null;
  const labels = bare.split(".");
  if (labels.length < 2 || labels.some(l => l === "")) return null;
  if (PRIVATE_SUFFIXES.some(s => bare === s || bare.endsWith(`.${s}`))) return null;
  return bare;
}

/** The name without a leading mcp. label, where that still has two labels: mcp.notion.com, then notion.com. No other
 * label is dropped, so foo.co.uk is never widened to a public suffix. */
const aboveOf = (name: string): string | undefined => (name.startsWith("mcp.") && name.split(".").length > 2 ? (publicIconHost(name.slice(4)) ?? undefined) : undefined);

const MAGIC: readonly { type: string; is: (b: Uint8Array) => boolean }[] = [
  { type: "image/png", is: b => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x) },
  { type: "image/x-icon", is: b => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
  { type: "image/gif", is: b => new TextDecoder().decode(b.slice(0, 4)) === "GIF8" },
  { type: "image/webp", is: b => new TextDecoder().decode(b.slice(0, 4)) === "RIFF" && new TextDecoder().decode(b.slice(8, 12)) === "WEBP" },
];

const Kept = z.object({ at: z.number(), icon: z.string().nullable() });

/** Whether Google has an icon for the name: the image as a data url, null for its placeholder or anything that is
 * not an image, undefined where it could not be asked, which is not kept. */
async function askGoogle(fetch: IconFetch, name: string): Promise<string | null | undefined> {
  const signal = AbortSignal.timeout(ASK_MS);
  let url = `${GOOGLE}?domain=${encodeURIComponent(name)}&sz=64`;
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, { signal, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location === null) {
        // Google answers a name it has no icon for with its 16 px globe and a 404.
        if (res.status !== 200) {
          await res.body?.cancel();
          return res.status >= 500 ? undefined : null;
        }
        const bytes = await capped(res, ICON_MAX_BYTES, "Google").catch(() => null);
        const type = bytes === null ? undefined : MAGIC.find(m => m.is(bytes))?.type;
        return bytes === null || type === undefined ? null : `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
      }
      await res.body?.cancel();
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.port !== "" || !GOOGLE_HOPS.test(next.hostname) || hop + 1 >= MAX_HOPS) return null;
      url = next.href;
    }
  } catch {
    return undefined;
  }
}

export function serverIcons(o: { dir: string; fetch?: IconFetch; resolve?: Resolver; now?: () => number }): ServerIcons {
  const fetch = o.fetch ?? globalThis.fetch;
  const resolve = o.resolve ?? resolveAll;
  const now = o.now ?? Date.now;
  const asking = new Map<string, Promise<string | null>>();
  // Bumped by forget, so an ask that was running when the person turned icons off keeps nothing.
  let generation = 0;
  const fileOf = (name: string): string => join(o.dir, `${createHash("sha256").update(name).digest("hex")}.json`);
  const keptAt = (file: string): z.infer<typeof Kept> | undefined => {
    try {
      const kept = Kept.parse(JSON.parse(readFileSync(file, "utf8")));
      return now() - kept.at < ICON_KEPT_MS ? kept : undefined;
    } catch {
      return undefined;
    }
  };
  /** Every entry past its 30 days, so a folder of hosts asked once does not grow for ever. */
  const sweep = (): void => {
    for (const f of readdirSync(o.dir)) if (f.endsWith(".json") && keptAt(join(o.dir, f)) === undefined) rmSync(join(o.dir, f), { force: true });
  };
  const keep = (name: string, icon: string | null): string | null => {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const file = fileOf(name);
    writeFileSync(`${file}.tmp`, JSON.stringify({ at: now(), icon }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    sweep();
    return icon;
  };
  /** Whether a name may be asked of Google by every address it resolves to; undefined where the lookup failed or
   * answered none, which is not kept. */
  const isPublic = async (name: string): Promise<boolean | undefined> => {
    const all = await resolve(name).catch(() => []);
    return all.length === 0 ? undefined : !all.some(a => isInternalAddress(a.address));
  };
  const lookUp = async (name: string, on: () => Promise<boolean>): Promise<string | null> => {
    const at = generation;
    const kept = async (icon: string | null): Promise<string | null> => ((await on()) && at === generation ? keep(name, icon) : null);
    const own = await isPublic(name);
    if (own === undefined) return null;
    if (!own) return kept(null);
    const icon = await askGoogle(fetch, name);
    if (icon !== null) return icon === undefined ? null : kept(icon);
    const above = aboveOf(name);
    if (above === undefined) return kept(null);
    const up = await isPublic(above);
    if (up === undefined) return null;
    if (!up) return kept(null);
    const parent = await askGoogle(fetch, above);
    return parent === undefined ? null : kept(parent);
  };
  return {
    folder: o.dir,
    icon(host, refresh = false, on = async () => true) {
      const name = publicIconHost(host);
      if (name === null) return Promise.resolve(null);
      const kept = refresh ? undefined : keptAt(fileOf(name));
      if (kept !== undefined) return Promise.resolve(kept.icon);
      const running = asking.get(name);
      if (running !== undefined) return running;
      const asked = lookUp(name, on).finally(() => {
        if (asking.get(name) === asked) asking.delete(name);
      });
      asking.set(name, asked);
      return asked;
    },
    forget() {
      generation += 1;
      asking.clear();
      rmSync(o.dir, { recursive: true, force: true });
    },
  };
}
