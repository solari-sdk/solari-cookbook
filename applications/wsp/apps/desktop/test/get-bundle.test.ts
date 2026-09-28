// SPDX-License-Identifier: AGPL-3.0-only
// The shell's road to a newer release: a version is all the page hands over,
// the URL is built from the repo, and only bytes whose sha256 matches the
// digest GitHub publishes are kept. Opening what was kept quits the app.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_API_ENV } from "@wsp/protocol";
import { BUNDLE_WORDS, askedVersion, bundleHover, bundleShell, getBundle, openBundle, type BundleDeps } from "../src/get-bundle.js";

const BYTES = Buffer.from("a disk image, as far as this test is concerned");
const SUM = createHash("sha256").update(BYTES).digest("hex");
const TAG_URL = "https://api.github.com/repos/Zingzy/wsp/releases/tags/v0.3.0";
const DMG_URL = "https://github.com/Zingzy/wsp/releases/download/v0.3.0/wsp-0.3.0-mac.dmg";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const downloads = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-get-bundle-"));
  dirs.push(dir);
  return dir;
};

const answer = (assets: unknown[]): Response => new Response(JSON.stringify({ tag_name: "v0.3.0", assets }));
const asset = (name: string, digest: string | null = `sha256:${SUM}`, size: number | string | null = BYTES.length): Record<string, unknown> => ({ name, ...(size === null ? {} : { size }), ...(digest === null ? {} : { digest }) });

/** A GitHub that answers the tag with these assets and serves these bytes for any download, logging every URL. */
function github(assets: unknown[] = [asset("wsp-0.3.0-mac.dmg"), asset("wsp-0.3.0.AppImage")], bytes: Buffer = BYTES, status = 200) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request): Promise<Response> => {
    const at = String(url);
    asked.push(at);
    if (at.includes("/releases/tags/")) return answer(assets);
    return new Response(status === 200 ? new Uint8Array(bytes) : "Not Found", { status });
  });
  return { asked, fetch: fetcher as unknown as typeof fetch };
}

const deps = (over: Partial<BundleDeps> = {}): BundleDeps => ({ platform: "darwin", dir: downloads(), env: {}, userAgent: "wsp/0.2.0", fetch: github().fetch, ...over });

describe("what the page may ask for", () => {
  it("is a version the release workflow would tag, and nothing else", () => {
    expect(askedVersion({ version: "0.3.0" })).toBe("0.3.0");
    expect(askedVersion({ version: "1.2.3-rc.1" })).toBe("1.2.3-rc.1");
    for (const raw of [{ version: "v0.3.0" }, { version: "0.3.0/../../x" }, { version: "0.3.0\n" }, { version: "0.3" }, { version: 3 }, { url: "https://evil.example/x.dmg" }, "0.3.0", null, undefined]) expect(askedVersion(raw)).toBeUndefined();
  });
});

describe("the download", () => {
  it("asks the release's answer for the digest, downloads the mac disk image from the repo, and keeps it under its own name", async () => {
    const hub = github();
    const d = deps({ fetch: hub.fetch });
    const got = await getBundle("0.3.0", d);
    expect(got).toEqual({ ok: true, file: join(d.dir, "wsp-0.3.0-mac.dmg"), sum: SUM });
    expect(hub.asked).toEqual([TAG_URL, DMG_URL]);
    expect(readFileSync(join(d.dir, "wsp-0.3.0-mac.dmg"))).toEqual(BYTES);
    expect(readdirSync(d.dir)).toEqual(["wsp-0.3.0-mac.dmg"]);
  });

  it("names itself to GitHub", async () => {
    const hub = github();
    await getBundle("0.3.0", deps({ fetch: hub.fetch }));
    const init = (hub.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("user-agent")).toBe("wsp/0.2.0");
  });

  it("takes the AppImage on linux, and on a platform with no bundle refuses before asking anything", async () => {
    const hub = github();
    const d = deps({ platform: "linux", fetch: hub.fetch });
    expect(await getBundle("0.3.0", d)).toEqual({ ok: true, file: join(d.dir, "wsp-0.3.0.AppImage"), sum: SUM });
    expect(hub.asked.at(-1)).toBe("https://github.com/Zingzy/wsp/releases/download/v0.3.0/wsp-0.3.0.AppImage");
    const none = github();
    expect(await getBundle("0.3.0", deps({ platform: "win32", fetch: none.fetch }))).toEqual({ ok: false, error: BUNDLE_WORDS.noBundle("win32") });
    expect(none.asked).toEqual([]);
  });

  it("follows the smoke's variable for the answer and the download both", async () => {
    const hub = github();
    await getBundle("0.3.0", deps({ fetch: hub.fetch, env: { [RELEASE_API_ENV]: "http://127.0.0.1:9911" } }));
    expect(hub.asked).toEqual(["http://127.0.0.1:9911/repos/Zingzy/wsp/releases/tags/v0.3.0", "http://127.0.0.1:9911/Zingzy/wsp/releases/download/v0.3.0/wsp-0.3.0-mac.dmg"]);
  });

  it("keeps nothing whose sha256 is not the published one, and says so", async () => {
    const d = deps({ fetch: github(undefined, Buffer.from("something else")).fetch });
    expect(await getBundle("0.3.0", d)).toEqual({ ok: false, error: BUNDLE_WORDS.mismatch("wsp-0.3.0-mac.dmg") });
    expect(readdirSync(d.dir)).toEqual([]);
  });

  it("downloads nothing for an asset the release does not list, or lists with no sha256 or no size", async () => {
    for (const assets of [[asset("wsp-0.3.0.AppImage")], [asset("wsp-0.3.0-mac.dmg", null)], [asset("wsp-0.3.0-mac.dmg", "md5:abc")], [asset("wsp-0.3.0-mac.dmg", undefined, null)], [asset("wsp-0.3.0-mac.dmg", undefined, "47")]]) {
      const hub = github(assets);
      const d = deps({ fetch: hub.fetch });
      expect(await getBundle("0.3.0", d)).toEqual({ ok: false, error: BUNDLE_WORDS.noDigest("wsp-0.3.0-mac.dmg") });
      expect(hub.asked).toEqual([TAG_URL]);
      expect(readdirSync(d.dir)).toEqual([]);
    }
  });

  it("refuses an answer past the cap and a download GitHub refuses, leaving no file", async () => {
    const huge = vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024))) as unknown as typeof fetch;
    const big = deps({ fetch: huge });
    const refused = await getBundle("0.3.0", big);
    expect(refused.ok).toBe(false);
    expect(readdirSync(big.dir)).toEqual([]);
    const gone = deps({ fetch: github(undefined, BYTES, 404).fetch });
    expect(await getBundle("0.3.0", gone)).toEqual({ ok: false, error: BUNDLE_WORDS.unreached("wsp-0.3.0-mac.dmg", "GitHub answered 404") });
    expect(readdirSync(gone.dir)).toEqual([]);
  });

  it("gives up a download that stops sending bytes, leaving no file", async () => {
    const stalls = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).includes("/releases/tags/")) return answer([asset("wsp-0.3.0-mac.dmg")]);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(BYTES.subarray(0, 8)));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const d = deps({ fetch: stalls, stallMs: 50 });
    expect(await getBundle("0.3.0", d)).toEqual({ ok: false, error: BUNDLE_WORDS.unreached("wsp-0.3.0-mac.dmg", "no bytes for 0.05 s") });
    expect(readdirSync(d.dir)).toEqual([]);
  });

  it("stops a download that runs past the size the release publishes, leaving no file", async () => {
    const endless = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).includes("/releases/tags/")) return answer([asset("wsp-0.3.0-mac.dmg")]);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (init?.signal?.aborted === true || sent > 64 * 1024 * 1024) return controller.close();
          sent += 64 * 1024;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const d = deps({ fetch: endless });
    expect(await getBundle("0.3.0", d)).toEqual({ ok: false, error: BUNDLE_WORDS.tooBig("wsp-0.3.0-mac.dmg") });
    expect(readdirSync(d.dir)).toEqual([]);
  });

  it("answers one sentence with no path where the file cannot be put in place, and leaves no partial file", async () => {
    const d = deps();
    mkdirSync(join(d.dir, "wsp-0.3.0-mac.dmg"));
    const got = await getBundle("0.3.0", d);
    expect(got).toEqual({ ok: false, error: BUNDLE_WORDS.unsaved("wsp-0.3.0-mac.dmg") });
    expect(readdirSync(d.dir)).toEqual(["wsp-0.3.0-mac.dmg"]);
  });

  it("writes through no link planted at the partial file's name", async () => {
    const d = deps();
    const elsewhere = join(downloads(), "someone-elses-file");
    writeFileSync(elsewhere, "keep me");
    symlinkSync(elsewhere, join(d.dir, "wsp-0.3.0-mac.dmg.part"));
    expect(await getBundle("0.3.0", d)).toEqual({ ok: true, file: join(d.dir, "wsp-0.3.0-mac.dmg"), sum: SUM });
    expect(readFileSync(elsewhere, "utf8")).toBe("keep me");
    expect(readFileSync(join(d.dir, "wsp-0.3.0-mac.dmg"))).toEqual(BYTES);
    expect(readdirSync(d.dir)).toEqual(["wsp-0.3.0-mac.dmg"]);
  });

  it("fetches a bundle already there with the published sha256 no second time, and replaces one that differs", async () => {
    const hub = github();
    const d = deps({ fetch: hub.fetch });
    writeFileSync(join(d.dir, "wsp-0.3.0-mac.dmg"), BYTES);
    expect(await getBundle("0.3.0", d)).toEqual({ ok: true, file: join(d.dir, "wsp-0.3.0-mac.dmg"), sum: SUM });
    expect(hub.asked).toEqual([TAG_URL]);
    writeFileSync(join(d.dir, "wsp-0.3.0-mac.dmg"), "a half download from before");
    expect((await getBundle("0.3.0", d)).ok).toBe(true);
    expect(hub.asked).toEqual([TAG_URL, TAG_URL, DMG_URL]);
    expect(readFileSync(join(d.dir, "wsp-0.3.0-mac.dmg"))).toEqual(BYTES);
  });
});

describe("the words over Get", () => {
  it("come from the platform's own row: the disk image and Open Anyway on a mac, the AppImage on linux, none elsewhere", () => {
    expect(bundleHover("darwin")).toBe("Downloads the disk image and checks its sha256. Unsigned builds need Privacy & Security, Open Anyway, once.");
    expect(bundleHover("linux")).toBe("Downloads the AppImage into Downloads and checks its sha256. The app you run is not replaced.");
    expect(bundleHover("win32")).toBeUndefined();
  });
});

describe("opening what was kept", () => {
  it("opens the disk image on a mac, and says the system's words when it will not open", async () => {
    const open = vi.fn(async () => "");
    expect(await openBundle({ file: "/d/wsp-0.3.0-mac.dmg", platform: "darwin" }, { open, reveal: vi.fn() })).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith("/d/wsp-0.3.0-mac.dmg");
    expect(await openBundle({ file: "/d/wsp-0.3.0-mac.dmg", platform: "darwin" }, { open: async () => "no application", reveal: vi.fn() })).toEqual({ ok: false, error: "no application" });
  });

  it("marks the AppImage runnable on linux and shows it in its folder", async () => {
    const dir = downloads();
    const file = join(dir, "wsp-0.3.0.AppImage");
    writeFileSync(file, BYTES, { mode: 0o644 });
    const reveal = vi.fn();
    expect(await openBundle({ file, platform: "linux" }, { open: vi.fn(), reveal })).toEqual({ ok: true });
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(reveal).toHaveBeenCalledWith(file);
  });
});

describe("the shell's two channels", () => {
  const shellWith = (over: Partial<BundleDeps & { running: string; packaged: boolean }> = {}) => {
    const quit = vi.fn();
    const open = vi.fn(async () => "");
    const d = deps(over);
    return { d, quit, open, shell: bundleShell({ ...d, open, reveal: vi.fn(), quit, running: "0.2.0", packaged: false, ...over }) };
  };

  it("refuses an ask that is not a version before anything is fetched", async () => {
    const hub = github();
    const { shell } = shellWith({ fetch: hub.fetch });
    expect(await shell.get({ url: "https://evil.example/x.dmg" })).toEqual({ ok: false, error: BUNDLE_WORDS.notAVersion });
    expect(hub.asked).toEqual([]);
  });

  it("refuses a version that is not above its own, and any prerelease, before anything is fetched", async () => {
    const hub = github();
    const { shell } = shellWith({ fetch: hub.fetch, running: "0.3.0" });
    for (const version of ["0.3.0", "0.2.9", "0.0.1", "0.4.0-rc.1"]) expect(await shell.get({ version })).toEqual({ ok: false, error: BUNDLE_WORDS.notNewer(version) });
    expect(hub.asked).toEqual([]);
    expect(await shell.get({ version: "0.3.1" })).toEqual({ ok: false, error: BUNDLE_WORDS.noDigest("wsp-0.3.1-mac.dmg") });
  });

  it("checks the kept file's sha256 again at open, and opens nothing and stays up where it changed", async () => {
    const { shell, quit, open, d } = shellWith();
    expect(await shell.get({ version: "0.3.0" })).toEqual({ ok: true });
    writeFileSync(join(d.dir, "wsp-0.3.0-mac.dmg"), "swapped after the check");
    expect(await shell.open()).toEqual({ ok: false, error: BUNDLE_WORDS.changed("wsp-0.3.0-mac.dmg") });
    expect(open).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(await shell.open()).toEqual({ ok: false, error: BUNDLE_WORDS.nothingKept });
  });

  it("in a packaged app asks GitHub whatever the release variable says", async () => {
    const hub = github();
    const { shell } = shellWith({ fetch: hub.fetch, packaged: true, env: { [RELEASE_API_ENV]: "http://127.0.0.1:9911" } });
    expect(await shell.get({ version: "0.3.0" })).toEqual({ ok: true });
    expect(hub.asked).toEqual([TAG_URL, DMG_URL]);
  });

  it("opens only what a get kept, then quits; a refused open does not quit", async () => {
    const { shell, quit, open, d } = shellWith();
    expect(await shell.open()).toEqual({ ok: false, error: BUNDLE_WORDS.nothingKept });
    expect(quit).not.toHaveBeenCalled();
    expect(await shell.get({ version: "0.3.0" })).toEqual({ ok: true });
    expect(await shell.open()).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith(join(d.dir, "wsp-0.3.0-mac.dmg"));
    expect(quit).toHaveBeenCalledTimes(1);
    open.mockResolvedValueOnce("the disk image is damaged");
    expect(await shell.open()).toEqual({ ok: false, error: "the disk image is damaged" });
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("shares one download between asks that overlap, and a failed get keeps nothing to open", async () => {
    const hub = github();
    const { shell } = shellWith({ fetch: hub.fetch });
    const [a, b] = await Promise.all([shell.get({ version: "0.3.0" }), shell.get({ version: "0.3.0" })]);
    expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
    expect(hub.asked).toEqual([TAG_URL, DMG_URL]);
    const bad = shellWith({ fetch: github(undefined, Buffer.from("tampered")).fetch });
    expect((await bad.shell.get({ version: "0.3.0" })).ok).toBe(false);
    expect(await bad.shell.open()).toEqual({ ok: false, error: BUNDLE_WORDS.nothingKept });
    expect(existsSync(join(bad.d.dir, "wsp-0.3.0-mac.dmg"))).toBe(false);
  });
});
