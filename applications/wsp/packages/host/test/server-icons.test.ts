// SPDX-License-Identifier: AGPL-3.0-only
// A remote MCP server's icon, asked of Google's favicon service by this host
// alone: only for a public name that resolves to public addresses, the
// server's own host first and then, for an mcp. host, the name without that
// label, kept on disk for 30 days, a miss as well, and only ever an image of a
// known kind under 64 KB.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ICON_KEPT_MS, isInternalAddress, publicIconHost, serverIcons, type IconFetch, type Pin, type Resolver } from "../src/server-icons.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wsp-icons-"));
  dirs.push(d);
  return d;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);
const HTML = new TextEncoder().encode("<!doctype html><title>hi</title>");
const googleAt = (name: string): string => `https://www.google.com/s2/favicons?domain=${name}&sz=64`;
const gstaticAt = (name: string): string => `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${name}&size=64`;

/** Google as measured on 2026-09-25: a 301 to gstatic, then the icon with 200 or its 16 px globe with 404. */
function google(icons: Record<string, { status?: number; bytes: Uint8Array; type?: string }>) {
  const asked: string[] = [];
  const fetch: IconFetch = async (url, init) => {
    asked.push(url);
    expect(init?.redirect).toBe("manual");
    const u = new URL(url);
    if (u.hostname === "www.google.com") return new Response(null, { status: 301, headers: { location: gstaticAt(u.searchParams.get("domain")!) } });
    const name = new URL(u.searchParams.get("url")!).hostname;
    const icon = icons[name] ?? { status: 404, bytes: PNG };
    return new Response(Buffer.from(icon.bytes), { status: icon.status ?? 200, headers: { "content-type": icon.type ?? "image/png" } });
  };
  return { asked, fetch };
}

function resolver(addresses: Record<string, readonly string[]>) {
  const looked: string[] = [];
  const resolve: Resolver = async name => {
    looked.push(name);
    const all = addresses[name];
    if (all === undefined) throw new Error(`ENOTFOUND ${name}`);
    return all.map((address): Pin => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { looked, resolve };
}

const PUBLIC = { "mcp.notion.com": ["208.103.161.1"], "notion.com": ["208.103.161.2"], "mcp.sentry.dev": ["2606:4700::1111"], "sentry.dev": ["1.1.1.1"] };
const dataUrl = (type: string, bytes: Uint8Array): string => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

describe("publicIconHost", () => {
  it("answers the bare lowercased name of a public host, its port gone", () => {
    expect(publicIconHost("MCP.Notion.com:443")).toBe("mcp.notion.com");
    expect(publicIconHost("mcp.sentry.dev")).toBe("mcp.sentry.dev");
    expect(publicIconHost("mcp.example.co.uk.")).toBe("mcp.example.co.uk");
  });

  it("answers nothing for an address literal, a name only a private network knows, one label, or any other character", () => {
    const refused = [
      "10.0.0.5",
      "93.184.215.14:8080",
      "[::1]:3000",
      "[2606:4700::1111]:443",
      "2606:4700::1111",
      "localhost:3001",
      "api.localhost",
      "printer.local",
      "mcp.internal",
      "mcp.corp.internal",
      "nas.lan",
      "router.home.arpa",
      "box.tail1234.ts.net",
      "hidden.onion",
      "intranet",
      "mcp_x.example.com",
      "mcp.exa mple.com",
      "mcp.example.com\u0000",
      "",
      ":443",
    ];
    for (const host of refused) expect(publicIconHost(host), host).toBeNull();
  });
});

describe("serverIcons", () => {
  it("asks for the server's own host, then the name above it on Google's placeholder, and answers the icon as a data url", async () => {
    const g = google({ "notion.com": { bytes: PNG } });
    const icons = serverIcons({ dir: scratch(), fetch: g.fetch, resolve: resolver(PUBLIC).resolve, now: () => 0 });
    expect(await icons.icon("mcp.notion.com")).toBe(dataUrl("image/png", PNG));
    expect(g.asked).toEqual([googleAt("mcp.notion.com"), gstaticAt("mcp.notion.com"), googleAt("notion.com"), gstaticAt("notion.com")]);
  });

  it("keeps an icon and a miss on disk for 30 days, asks again after them or on refresh, and asks once for two at once", async () => {
    const dir = scratch();
    const g = google({ "mcp.sentry.dev": { bytes: ICO, type: "image/x-icon" } });
    const r = resolver(PUBLIC);
    let now = 0;
    const icons = serverIcons({ dir, fetch: g.fetch, resolve: r.resolve, now: () => now });
    const [a, b] = await Promise.all([icons.icon("mcp.sentry.dev"), icons.icon("mcp.sentry.dev")]);
    expect(a).toBe(dataUrl("image/x-icon", ICO));
    expect(b).toBe(a);
    expect(g.asked).toHaveLength(2);
    expect(await icons.icon("mcp.notion.com")).toBeNull();
    const asked = g.asked.length;
    const again = serverIcons({ dir, fetch: g.fetch, resolve: r.resolve, now: () => now });
    expect(await again.icon("mcp.sentry.dev")).toBe(a);
    expect(await again.icon("mcp.notion.com")).toBeNull();
    expect(g.asked).toHaveLength(asked);
    expect(readdirSync(dir).every(f => /^[0-9a-f]{64}\.json$/.test(f))).toBe(true);
    await again.icon("mcp.sentry.dev", true);
    expect(g.asked).toHaveLength(asked + 2);
    now = ICON_KEPT_MS + 1;
    await again.icon("mcp.notion.com");
    expect(g.asked.length).toBeGreaterThan(asked + 2);
  });

  it("never asks Google for a name that resolves anywhere private, nor for one that resolves nowhere, and keeps that answer", async () => {
    const g = google({ "corp.example.com": { bytes: PNG } });
    const r = resolver({ "mcp.corp.example.com": ["10.1.2.3"], "wiki.example.com": ["93.184.215.14", "192.168.1.9"], "v6.example.com": ["fd00::1"], "mapped.example.com": ["::ffff:127.0.0.1"] });
    const icons = serverIcons({ dir: scratch(), fetch: g.fetch, resolve: r.resolve, now: () => 0 });
    for (const host of ["mcp.corp.example.com", "wiki.example.com", "v6.example.com", "mapped.example.com", "gone.example.com", "localhost:3001", "10.0.0.5"]) expect(await icons.icon(host), host).toBeNull();
    expect(g.asked).toEqual([]);
    expect(r.looked).toEqual(["mcp.corp.example.com", "wiki.example.com", "v6.example.com", "mapped.example.com", "gone.example.com"]);
    await icons.icon("mcp.corp.example.com");
    await icons.icon("gone.example.com");
    expect(r.looked).toEqual(["mcp.corp.example.com", "wiki.example.com", "v6.example.com", "mapped.example.com", "gone.example.com", "gone.example.com"]);
  });

  it("keeps nothing when a lookup fails or answers no address, so the next ask looks again", async () => {
    const dir = join(scratch(), "icons");
    const g = google({ "notion.com": { bytes: PNG } });
    let online = false;
    const looked: string[] = [];
    const resolve: Resolver = async name => {
      looked.push(name);
      if (!online) throw new Error(`EAI_AGAIN ${name}`);
      return name === "empty.example.com" ? [] : [{ address: "208.103.161.2", family: 4 }];
    };
    const icons = serverIcons({ dir, fetch: g.fetch, resolve, now: () => 0 });
    expect(await icons.icon("notion.com")).toBeNull();
    online = true;
    expect(await icons.icon("empty.example.com")).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(await icons.icon("notion.com")).toBe(dataUrl("image/png", PNG));
    expect(await icons.icon("empty.example.com")).toBeNull();
    expect(looked).toEqual(["notion.com", "empty.example.com", "notion.com", "empty.example.com"]);
  });

  it("keeps nothing when the name without mcp. cannot be looked up, and asks again next time", async () => {
    const dir = join(scratch(), "icons");
    const g = google({ "notion.com": { bytes: PNG } });
    let online = false;
    const resolve: Resolver = async name => {
      if (name === "notion.com" && !online) throw new Error("EAI_AGAIN notion.com");
      return [{ address: "208.103.161.2", family: 4 }];
    };
    const icons = serverIcons({ dir, fetch: g.fetch, resolve, now: () => 0 });
    expect(await icons.icon("mcp.notion.com")).toBeNull();
    expect(existsSync(dir)).toBe(false);
    online = true;
    expect(await icons.icon("mcp.notion.com")).toBe(dataUrl("image/png", PNG));
  });

  it("climbs only from a leading mcp. label: api.linear.app and foo.co.uk are asked as themselves alone", async () => {
    const g = google({});
    const at = ["93.184.215.14"];
    const r = resolver({ "api.linear.app": at, "linear.app": at, "foo.co.uk": at, "co.uk": at, "mcp.notion.com": at, "notion.com": at });
    const icons = serverIcons({ dir: scratch(), fetch: g.fetch, resolve: r.resolve, now: () => 0 });
    for (const host of ["api.linear.app", "foo.co.uk", "mcp.notion.com"]) expect(await icons.icon(host), host).toBeNull();
    expect(g.asked.filter(u => u.startsWith("https://www.google.com"))).toEqual([googleAt("api.linear.app"), googleAt("foo.co.uk"), googleAt("mcp.notion.com"), googleAt("notion.com")]);
    expect(r.looked).toEqual(["api.linear.app", "foo.co.uk", "mcp.notion.com", "notion.com"]);
  });

  it("sweeps every entry past its 30 days when it writes one", async () => {
    const dir = scratch();
    const g = google({});
    const at = ["93.184.215.14"];
    const r = resolver({ "old.example.com": at, "recent.example.com": at, "new.example.com": at });
    let now = 0;
    const icons = serverIcons({ dir, fetch: g.fetch, resolve: r.resolve, now: () => now });
    await icons.icon("old.example.com");
    now = 1000;
    await icons.icon("recent.example.com");
    expect(readdirSync(dir)).toHaveLength(2);
    now = ICON_KEPT_MS + 1;
    await icons.icon("new.example.com");
    expect(readdirSync(dir)).toHaveLength(2);
    const asked = g.asked.length;
    await icons.icon("recent.example.com");
    expect(g.asked).toHaveLength(asked);
    await icons.icon("old.example.com");
    expect(g.asked.length).toBeGreaterThan(asked);
  });

  it("forgets every kept icon, and an ask still running when it does keeps nothing", async () => {
    const dir = join(scratch(), "icons");
    const g = google({ "notion.com": { bytes: PNG } });
    let hold: (() => void) | undefined;
    const resolve: Resolver = async name => {
      if (name === "held.example.com") await new Promise<void>(res => (hold = res));
      return [{ address: "208.103.161.2", family: 4 }];
    };
    const icons = serverIcons({ dir, fetch: g.fetch, resolve, now: () => 0 });
    expect(await icons.icon("notion.com")).toBe(dataUrl("image/png", PNG));
    expect(readdirSync(dir)).toHaveLength(1);
    const running = icons.icon("held.example.com");
    await new Promise(res => setImmediate(res));
    icons.forget();
    expect(existsSync(dir)).toBe(false);
    hold!();
    expect(await running).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps nothing from an ask whose switch went off while it ran, even one that started after the forget", async () => {
    const dir = join(scratch(), "icons");
    const g = google({ "held.example.com": { bytes: PNG } });
    let hold: (() => void) | undefined;
    const resolve: Resolver = async () => {
      await new Promise<void>(res => (hold = res));
      return [{ address: "208.103.161.2", family: 4 }];
    };
    let on = true;
    const icons = serverIcons({ dir, fetch: g.fetch, resolve, now: () => 0 });
    expect(icons.folder).toBe(dir);
    icons.forget();
    const running = icons.icon("held.example.com", false, async () => on);
    await new Promise(res => setImmediate(res));
    on = false;
    hold!();
    expect(await running).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("never asks Google for the name above when that name is one publicIconHost refuses", async () => {
    const asked: string[] = [];
    // Google's own globe at 404, with no hop: a URL of the gstatic form will not parse a name ending in a number.
    const fetch: IconFetch = async url => (asked.push(url), new Response(Buffer.from(PNG), { status: 404 }));
    const r = resolver({ "mcp.8.8.8.8": ["8.8.8.8"], "8.8.8.8": ["8.8.8.8"] });
    const icons = serverIcons({ dir: scratch(), fetch, resolve: r.resolve, now: () => 0 });
    expect(await icons.icon("mcp.8.8.8.8")).toBeNull();
    expect(asked).toEqual([googleAt("mcp.8.8.8.8")]);
    expect(r.looked).toEqual(["mcp.8.8.8.8"]);
  });

  it("asks for the name above only where it too is public, and never climbs to one label", async () => {
    const g = google({});
    const r = resolver({ "mcp.acme.com": ["93.184.215.14"], "acme.com": ["10.0.0.1"], "notion.com": ["208.103.161.2"] });
    const icons = serverIcons({ dir: scratch(), fetch: g.fetch, resolve: r.resolve, now: () => 0 });
    expect(await icons.icon("mcp.acme.com")).toBeNull();
    expect(await icons.icon("notion.com")).toBeNull();
    expect(g.asked.filter(u => u.startsWith("https://www.google.com"))).toEqual([googleAt("mcp.acme.com"), googleAt("notion.com")]);
  });

  it("keeps only an image of a known kind under 64 KB, and follows a redirect only to Google's own icon hosts", async () => {
    const big = new Uint8Array(64 * 1024 + 1);
    big.set(PNG);
    const r = resolver({ "a.example.com": ["93.184.215.14"], "b.example.com": ["93.184.215.14"] });
    const g = google({ "a.example.com": { bytes: HTML, type: "image/png" }, "b.example.com": { bytes: big } });
    const icons = serverIcons({ dir: scratch(), fetch: g.fetch, resolve: r.resolve, now: () => 0 });
    expect(await icons.icon("a.example.com")).toBeNull();
    expect(await icons.icon("b.example.com")).toBeNull();
    const elsewhere: string[] = [];
    const away: IconFetch = async url => {
      elsewhere.push(url);
      return new Response(null, { status: 302, headers: { location: "https://tracker.example.net/icon.png" } });
    };
    expect(await serverIcons({ dir: scratch(), fetch: away, resolve: r.resolve, now: () => 0 }).icon("a.example.com")).toBeNull();
    expect(elsewhere).toEqual([googleAt("a.example.com")]);
    const port: string[] = [];
    const otherPort: IconFetch = async url => {
      port.push(url);
      return new Response(null, { status: 301, headers: { location: "https://www.google.com:8443/s2/favicons?domain=a.example.com" } });
    };
    expect(await serverIcons({ dir: scratch(), fetch: otherPort, resolve: r.resolve, now: () => 0 }).icon("a.example.com")).toBeNull();
    expect(port).toEqual([googleAt("a.example.com")]);
  });

  it("answers nothing, and keeps nothing, when Google cannot be reached", async () => {
    const r = resolver(PUBLIC);
    let up = false;
    const flaky: IconFetch = async (url, init) => {
      if (!up) throw new Error("ENETUNREACH");
      return google({ "notion.com": { bytes: PNG } }).fetch(url, init);
    };
    const icons = serverIcons({ dir: scratch(), fetch: flaky, resolve: r.resolve, now: () => 0 });
    expect(await icons.icon("mcp.notion.com")).toBeNull();
    up = true;
    expect(await icons.icon("mcp.notion.com")).toBe(dataUrl("image/png", PNG));
  });
});

describe("an internal address", () => {
  it("is loopback, private, link-local, shared, multicast or reserved, in either family and mapped", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "::7f00:1", "::a00:1", "64:ff9b:1::1", "64:ff9b:1:ffff::5db8:d70e"])
      expect(isInternalAddress(a), a).toBe(true);
    for (const a of ["93.184.215.14", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) expect(isInternalAddress(a), a).toBe(false);
  });
});
