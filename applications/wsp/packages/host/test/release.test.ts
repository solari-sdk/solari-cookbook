// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_NO_RESTART_LINE, RELEASE_API_ENV, UP_RESTART_LINE, UPDATE_CHECK_ENV, releaseAbove, type ReleaseChangedEvent } from "@wsp/protocol";
import { RELEASE_BODY_MAX_BYTES, RELEASE_EVERY_MS, RELEASE_FIRST_MS, RELEASE_FLOOR_MS, RELEASE_TIMEOUT_MS, latestWords, parseRelease, releaseFileFor, releaseAssetUrl, releaseReading, releaseTagUrl, releaseUrl, releaseWatch, type ReleaseWatchOptions } from "../src/release.js";

const ANSWER = JSON.parse(readFileSync(new URL("./release-latest.json", import.meta.url), "utf8")) as Record<string, unknown>;
const ETAG = 'W/"405c3ada"';
const LATEST = "https://api.github.com/repos/Zingzy/wsp/releases/latest";

interface Asked {
  url: string;
  headers: Record<string, string>;
}

/** A GitHub that answers from a script of replies and records every ask; a reply that is a function runs on the ask. */
function fakeGithub(replies: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const asked: Asked[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    asked.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const next = replies.shift();
    if (next === undefined) throw new Error("the fake GitHub has no reply left");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(init) : next;
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

const ok = (body: unknown = ANSWER): Response => new Response(JSON.stringify(body), { status: 200, headers: { etag: ETAG } });
const notModified = (): Response => new Response(null, { status: 304, headers: { etag: ETAG } });

const homes: string[] = [];
function stateIn(): string {
  const home = mkdtempSync(join(tmpdir(), "wsp-release-"));
  homes.push(home);
  return join(home, "state.json");
}

afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function watchOn(statePath: string, over: Partial<ReleaseWatchOptions> & Pick<ReleaseWatchOptions, "fetch">) {
  let clock = Date.parse("2026-09-24T12:00:00.000Z");
  const watch = releaseWatch({ statePath, shape: "service", running: "0.2.0", installed: () => "0.2.0", env: {}, now: () => clock, ...over });
  return { watch, tick: (ms: number) => (clock += ms) };
}

describe("the release GitHub names latest", () => {
  it("reads today's real answer as the version, its tag, its page and when it was published", () => {
    expect(parseRelease(ANSWER)).toEqual({ version: "0.2.0", tag: "v0.2.0", url: "https://github.com/Zingzy/wsp/releases/tag/v0.2.0", publishedAt: "2026-09-10T16:06:44Z" });
  });

  it("names the release page off the repo and the tag, whatever page the answer names", () => {
    for (const html_url of ["javascript:alert(1)", "https://evil.example/x"]) {
      expect(parseRelease({ ...ANSWER, html_url }).url).toBe("https://github.com/Zingzy/wsp/releases/tag/v0.2.0");
    }
    const { html_url: _dropped, ...bare } = ANSWER;
    expect(parseRelease(bare).url).toBe("https://github.com/Zingzy/wsp/releases/tag/v0.2.0");
  });

  it("takes nothing that is not a published release tag", () => {
    expect(() => parseRelease({ ...ANSWER, prerelease: true })).toThrow();
    expect(() => parseRelease({ ...ANSWER, draft: true })).toThrow();
    expect(() => parseRelease({ ...ANSWER, tag_name: "preview" })).toThrow();
    expect(() => parseRelease({ message: "Not Found" })).toThrow();
  });

  it("is asked of GitHub's API unless the smoke's variable moves the base", () => {
    expect(releaseUrl({})).toBe(LATEST);
    expect(releaseUrl({ [RELEASE_API_ENV]: "http://127.0.0.1:9911/" })).toBe("http://127.0.0.1:9911/repos/Zingzy/wsp/releases/latest");
  });

  it("names one release's answer on the API and its download on the repo, and the smoke's variable moves both", () => {
    expect(releaseTagUrl({}, "v0.3.0")).toBe("https://api.github.com/repos/Zingzy/wsp/releases/tags/v0.3.0");
    expect(releaseAssetUrl({}, "v0.3.0", "wsp-0.3.0-mac.dmg")).toBe("https://github.com/Zingzy/wsp/releases/download/v0.3.0/wsp-0.3.0-mac.dmg");
    const smoke = { [RELEASE_API_ENV]: "http://127.0.0.1:9911/" };
    expect(releaseTagUrl(smoke, "v9.9.9")).toBe("http://127.0.0.1:9911/repos/Zingzy/wsp/releases/tags/v9.9.9");
    expect(releaseAssetUrl(smoke, "v9.9.9", "wsp-9.9.9.AppImage")).toBe("http://127.0.0.1:9911/Zingzy/wsp/releases/download/v9.9.9/wsp-9.9.9.AppImage");
  });
});

describe("the host's reading of the newest release", () => {
  it("asks once with its own version as the client, keeps the answer beside the state file and tells every listener", async () => {
    const statePath = stateIn();
    const github = fakeGithub([ok()]);
    const { watch } = watchOn(statePath, { fetch: github.fetch });
    const heard: ReleaseChangedEvent[] = [];
    watch.on(e => heard.push(e));
    expect(watch.get()).toEqual({ state: "checking", shape: "service", restartRefusal: HOST_NO_RESTART_LINE });

    const view = await watch.check();
    expect(github.asked).toHaveLength(1);
    expect(github.asked[0]!.url).toBe(LATEST);
    expect(github.asked[0]!.headers["user-agent"]).toBe("wsp/0.2.0");
    expect(github.asked[0]!.headers["if-none-match"]).toBeUndefined();
    expect(view).toEqual({
      state: "read",
      latest: parseRelease(ANSWER),
      checkedAt: "2026-09-24T12:00:00.000Z",
      triedAt: "2026-09-24T12:00:00.000Z",
      shape: "service",
      restartRefusal: HOST_NO_RESTART_LINE,
    });
    expect(heard).toEqual([{ type: "release.changed", release: view }]);
    expect(JSON.parse(readFileSync(releaseFileFor(statePath), "utf8"))).toMatchObject({ latest: parseRelease(ANSWER), etag: ETAG });
    // A host running a build level with the newest release reads level; one built ahead of it reads level too.
    expect(releaseAbove(view, "0.2.0")).toBe(false);
    expect(releaseAbove(view, "0.3.0")).toBe(false);
  });

  it("sends the tag it holds, keeps the reading on a 304 and moves when it was read", async () => {
    const github = fakeGithub([ok(), notModified()]);
    const { watch, tick } = watchOn(stateIn(), { fetch: github.fetch });
    await watch.check();
    tick(RELEASE_FLOOR_MS + 1);
    const view = await watch.check();
    expect(github.asked[1]!.headers["if-none-match"]).toBe(ETAG);
    expect(view.state).toBe("read");
    expect(view.latest).toEqual(parseRelease(ANSWER));
    expect(view.checkedAt).toBe(new Date(Date.parse("2026-09-24T12:00:00.000Z") + RELEASE_FLOOR_MS + 1).toISOString());
  });

  it("keeps the last reading through a failed ask, and says unreached only where it never read one", async () => {
    const statePath = stateIn();
    const github = fakeGithub([ok(), new Error("getaddrinfo ENOTFOUND api.github.com"), new Response("{}", { status: 500 })]);
    const { watch, tick } = watchOn(statePath, { fetch: github.fetch });
    const read = await watch.check();
    tick(RELEASE_FLOOR_MS + 1);
    const failed = await watch.check();
    expect(failed.state).toBe("unreached");
    expect(failed.latest).toEqual(read.latest);
    expect(failed.checkedAt).toBe(read.checkedAt);
    expect(failed.triedAt).not.toBe(read.triedAt);
    tick(RELEASE_FLOOR_MS + 1);
    expect((await watch.check()).latest).toEqual(read.latest);

    // A host that starts offline shows what it last read before it asks at all.
    const again = watchOn(statePath, { fetch: fakeGithub([]).fetch }).watch;
    expect(again.get()).toMatchObject({ state: "checking", latest: read.latest, checkedAt: read.checkedAt });

    const never = watchOn(stateIn(), { fetch: fakeGithub([new Error("offline")]).fetch }).watch;
    const none = await never.check();
    expect(none.state).toBe("unreached");
    expect(none.latest).toBeUndefined();
  });

  it("asks at most once in ten minutes however many windows open About, and once for asks that overlap", async () => {
    const github = fakeGithub([ok(), notModified()]);
    const { watch, tick } = watchOn(stateIn(), { fetch: github.fetch });
    await Promise.all([watch.check(), watch.check(), watch.check()]);
    for (let i = 0; i < 20; i++) {
      tick(RELEASE_FLOOR_MS / 20 - 1);
      await watch.check();
    }
    expect(github.asked).toHaveLength(1);
    tick(RELEASE_FLOOR_MS);
    await watch.check();
    expect(github.asked).toHaveLength(2);
  });

  it("the floor counts a failed ask, so a host offline for a day is not asking all day", async () => {
    const github = fakeGithub([new Error("offline")]);
    const { watch, tick } = watchOn(stateIn(), { fetch: github.fetch });
    await watch.check();
    tick(RELEASE_FLOOR_MS - 1);
    await watch.check();
    expect(github.asked).toHaveLength(1);
  });

  it("asks nothing and shows no number under the switch, from the environment or from the .env beside the state file", async () => {
    const statePath = stateIn();
    const first = watchOn(statePath, { fetch: fakeGithub([ok()]).fetch }).watch;
    await first.check();

    const github = fakeGithub([]);
    const fromEnv = watchOn(statePath, { fetch: github.fetch, env: { [UPDATE_CHECK_ENV]: "0" } }).watch;
    expect(await fromEnv.check()).toEqual({ state: "off", shape: "service", restartRefusal: HOST_NO_RESTART_LINE });
    expect(fromEnv.get()).toEqual({ state: "off", shape: "service", restartRefusal: HOST_NO_RESTART_LINE });

    writeFileSync(join(statePath, "..", ".env"), `${UPDATE_CHECK_ENV}=0\n`);
    const fromFile = watchOn(statePath, { fetch: github.fetch }).watch;
    expect((await fromFile.check()).state).toBe("off");
    expect(github.asked).toHaveLength(0);
  });

  it("says which version the installed files carry once they differ from the running host, read again at every check", async () => {
    let installed = "0.2.0";
    const github = fakeGithub([ok(), notModified()]);
    const { watch, tick } = watchOn(stateIn(), { fetch: github.fetch, installed: () => installed });
    expect((await watch.check()).installed).toBeUndefined();
    installed = "0.3.0";
    tick(RELEASE_FLOOR_MS + 1);
    expect((await watch.check()).installed).toBe("0.3.0");
    // Under the floor too: the files are this computer's and reading them asks nobody.
    installed = "0.3.1";
    tick(1);
    expect((await watch.check()).installed).toBe("0.3.1");
    expect(github.asked).toHaveLength(2);
  });

  it("carries the restart road's own refusal, nothing where the road brings the host back, and one line where no road exists", async () => {
    const github = fakeGithub([]);
    expect(watchOn(stateIn(), { fetch: github.fetch, restart: { refusal: UP_RESTART_LINE } }).watch.get().restartRefusal).toBe(UP_RESTART_LINE);
    expect(watchOn(stateIn(), { fetch: github.fetch, restart: {} }).watch.get()).not.toHaveProperty("restartRefusal");
    expect(watchOn(stateIn(), { fetch: github.fetch }).watch.get().restartRefusal).toBe(HOST_NO_RESTART_LINE);
  });

  it("carries the line that moves this host onto the release only while the release is above it, and none under the switch", async () => {
    const lines: string[] = [];
    const update = (version: string): string => {
      lines.push(version);
      return `npm i -g @zingzy/wsp@${version}`;
    };
    const statePath = stateIn();
    const behind = watchOn(statePath, { fetch: fakeGithub([ok()]).fetch, running: "0.1.9", update });
    expect(behind.watch.get().update).toBeUndefined();
    expect((await behind.watch.check()).update).toBe("npm i -g @zingzy/wsp@0.2.0");
    expect(lines).toEqual(["0.2.0"]);
    expect((await watchOn(stateIn(), { fetch: fakeGithub([ok()]).fetch, update }).watch.check()).update).toBeUndefined();
    writeFileSync(join(statePath, "..", ".env"), `${UPDATE_CHECK_ENV}=0\n`);
    expect(behind.watch.get().update).toBeUndefined();
  });

  it("keeps its last reading of the installed files while a reinstall has them half written", async () => {
    let installed = (): string => "0.3.0";
    const { watch, tick } = watchOn(stateIn(), { fetch: fakeGithub([ok()]).fetch, installed: () => installed() });
    await watch.check();
    installed = () => {
      throw new Error("ENOENT: no such file or directory, open '/usr/local/lib/node_modules/@zingzy/wsp/package.json'");
    };
    tick(1);
    expect((await watch.check()).installed).toBe("0.3.0");
  });

  it("answers what it read when the file beside the state cannot be written", async () => {
    const statePath = stateIn();
    mkdirSync(releaseFileFor(statePath));
    const { watch } = watchOn(statePath, { fetch: fakeGithub([ok()]).fetch });
    expect((await watch.check()).latest).toEqual(parseRelease(ANSWER));
  });

  it("asks again when the last ask it kept is stamped ahead of this computer's clock", async () => {
    const statePath = stateIn();
    writeFileSync(releaseFileFor(statePath), JSON.stringify({ triedAt: "2027-01-01T00:00:00.000Z" }));
    const github = fakeGithub([ok()]);
    await watchOn(statePath, { fetch: github.fetch }).watch.check();
    expect(github.asked).toHaveLength(1);
  });

  it("reads an answer past a megabyte as unreached and keeps what it had", async () => {
    const huge = JSON.stringify({ ...ANSWER, body: "x".repeat(RELEASE_BODY_MAX_BYTES) });
    const github = fakeGithub([ok(), new Response(huge, { status: 200, headers: { etag: 'W/"other"' } })]);
    const { watch, tick } = watchOn(stateIn(), { fetch: github.fetch });
    const read = await watch.check();
    tick(RELEASE_FLOOR_MS + 1);
    const over = await watch.check();
    expect(over.state).toBe("unreached");
    expect(over.latest).toEqual(read.latest);
  });

  it("a check never throws where it is called, even when the .env beside the state cannot be read", async () => {
    const statePath = stateIn();
    mkdirSync(join(statePath, "..", ".env"));
    const { watch } = watchOn(statePath, { fetch: fakeGithub([ok()]).fetch });
    let called: Promise<unknown> | undefined;
    expect(() => {
      called = watch.check();
    }).not.toThrow();
    await expect(called).rejects.toThrow(/EISDIR/);
  });

  it("a timer's check that fails is said in the log and never leaves a rejection nobody holds", async () => {
    vi.useFakeTimers();
    const statePath = stateIn();
    mkdirSync(join(statePath, "..", ".env"));
    const lines: string[] = [];
    const watch = releaseWatch({ statePath, shape: "app", running: "0.2.0", installed: () => "0.2.0", env: {}, fetch: fakeGithub([]).fetch, log: line => lines.push(line) });
    watch.start();
    await vi.advanceTimersByTimeAsync(RELEASE_FIRST_MS);
    watch.close();
    expect(lines).toEqual([expect.stringMatching(/^release: the check failed \(EISDIR/)]);
  });

  it("gives up on an ask after five seconds and keeps what it had", async () => {
    vi.useFakeTimers();
    const hang = (init: RequestInit): Promise<Response> =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const { watch } = watchOn(stateIn(), { fetch: fakeGithub([hang]).fetch });
    const view = watch.check();
    await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS);
    expect((await view).state).toBe("unreached");
  });

  it("asks thirty seconds after the host starts, then every six hours, and never after it closes", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-24T12:00:00.000Z") });
    const github = fakeGithub([ok(), notModified(), notModified()]);
    const watch = releaseWatch({ statePath: stateIn(), shape: "app", running: "0.2.0", installed: () => "0.2.0", env: {}, fetch: github.fetch });
    watch.start();
    await vi.advanceTimersByTimeAsync(RELEASE_FIRST_MS - 1);
    expect(github.asked).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(github.asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RELEASE_EVERY_MS);
    expect(github.asked).toHaveLength(2);
    watch.close();
    await vi.advanceTimersByTimeAsync(RELEASE_EVERY_MS * 2);
    expect(github.asked).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes nothing when it never read anything", async () => {
    const statePath = stateIn();
    const { watch } = watchOn(statePath, { fetch: fakeGithub([]).fetch, env: { [UPDATE_CHECK_ENV]: "0" } });
    await watch.check();
    expect(existsSync(releaseFileFor(statePath))).toBe(false);
  });
});

describe("what the command line reads off release.json, with no host asked", () => {
  it("is nothing before any ask, the number once one was read, unreached where every ask failed, and off under either switch", async () => {
    const statePath = stateIn();
    expect(releaseReading(statePath, {})).toBeUndefined();
    await watchOn(statePath, { fetch: fakeGithub([ok()]).fetch }).watch.check();
    expect(releaseReading(statePath, {})).toEqual({ state: "read", latest: parseRelease(ANSWER) });
    expect(releaseReading(statePath, { [UPDATE_CHECK_ENV]: "0" })).toEqual({ state: "off" });
    writeFileSync(join(statePath, "..", ".env"), `${UPDATE_CHECK_ENV}=0\n`);
    expect(releaseReading(statePath, {})).toEqual({ state: "off" });
    const failed = stateIn();
    await watchOn(failed, { fetch: fakeGithub([new Error("offline")]).fetch }).watch.check();
    expect(releaseReading(failed, {})).toEqual({ state: "unreached" });
    expect(releaseReading(stateIn(), { [UPDATE_CHECK_ENV]: "0" })).toEqual({ state: "off" });
  });

  it("words the row: the number alone when this wsp is level or ahead, the road to it when behind, else the state", () => {
    const latest = parseRelease(ANSWER);
    const fix = (version: string): string => `npm i -g @zingzy/wsp@${version}`;
    expect(latestWords({ state: "read", latest }, "0.2.0", fix)).toBe("0.2.0");
    expect(latestWords({ state: "read", latest }, "0.3.0-rc.1", fix)).toBe("0.2.0");
    expect(latestWords({ state: "read", latest }, "0.1.9", fix)).toBe("0.2.0; this is 0.1.9, npm i -g @zingzy/wsp@0.2.0 gets it");
    expect(latestWords({ state: "unreached", latest }, "0.2.0", fix)).toBe("0.2.0");
    expect(latestWords({ state: "unreached" }, "0.2.0", fix)).toBe("unreached");
    expect(latestWords({ state: "off" }, "0.2.0", fix)).toBe("off");
  });
});
