// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERE_PLACE_ID, UPDATE_CHECK_ENV } from "@wsp/protocol";
import { LATEST_FLOOR_MS, LATEST_KEPT_MS, agentLatest, latestFileFor } from "../src/agent-latest.js";
import { CLI_VERBS, runVerb, type HostClient } from "../src/verbs.js";
import { captured } from "./verbs-fixture.js";

const NPM = "https://registry.npmjs.org";
const GITHUB = "https://api.github.com/repos";

/** Every vendor answer the catalog's agents name, as each vendor words it. */
const ANSWERS: Record<string, string> = {
  "https://downloads.claude.ai/claude-code-releases/latest": "2.1.283\n",
  [`${NPM}/@openai%2fcodex/latest`]: JSON.stringify({ name: "@openai/codex", version: "0.157.0" }),
  [`${NPM}/@google%2fgemini-cli/latest`]: JSON.stringify({ version: "0.59.0" }),
  [`${NPM}/opencode-ai/latest`]: JSON.stringify({ version: "1.19.0" }),
  [`${NPM}/@earendil-works%2fpi-coding-agent/latest`]: JSON.stringify({ version: "0.85.0" }),
  [`${NPM}/@qwen-code%2fqwen-code/latest`]: JSON.stringify({ version: "0.25.0" }),
  [`${NPM}/@ampcode%2fcli/latest`]: JSON.stringify({ version: "0.0.1790399999-g1a2b3c" }),
  [`${GITHUB}/charmbracelet/crush/releases/latest`]: JSON.stringify({ tag_name: "v0.97.0", draft: false, prerelease: false }),
  [`${GITHUB}/aaif-goose/goose/releases/latest`]: JSON.stringify({ tag_name: "v1.53.0", draft: false, prerelease: false }),
};

const READ = { claude: "2.1.283", codex: "0.157.0", gemini: "0.59.0", opencode: "1.19.0", pi: "0.85.0", crush: "0.97.0", qwen: "0.25.0", goose: "1.53.0", amp: "0.0.1790399999-g1a2b3c" };
const CLAUDE = "https://downloads.claude.ai/claude-code-releases/latest";
const CODEX = `${NPM}/@openai%2fcodex/latest`;

/** A reply as fetch hands it back, from the address it ended at after any redirect. */
function answered(body: string, o: { status?: number; url: string }): Response {
  const res = new Response(body, { status: o.status ?? 200 });
  Object.defineProperty(res, "url", { value: o.url });
  return res;
}

type Reply = Error | ((url: string, signal?: AbortSignal) => Response | Promise<Response>);

/** The vendors, answering from ANSWERS unless a url is given its own reply, and keeping every url asked and the
 * headers it was asked with. */
function vendors(over: Record<string, Reply> = {}) {
  const asked: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetch = async (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }): Promise<Response> => {
    asked.push(url);
    headers.push(init.headers ?? {});
    const own = over[url];
    if (own instanceof Error) throw own;
    if (own !== undefined) return own(url, init.signal);
    const body = ANSWERS[url];
    return answered(body ?? "not found", { status: body === undefined ? 404 : 200, url });
  };
  return { asked, headers, fetch };
}

const body = (text: string): Reply => url => answered(text, { url });

const homes: string[] = [];
function stateIn(): string {
  const home = mkdtempSync(join(tmpdir(), "wsp-latest-"));
  homes.push(home);
  return join(home, "state.json");
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const on = (statePath: string, v: { fetch: ReturnType<typeof vendors>["fetch"] }, now: () => number, over: { timeoutMs?: number } = {}) => agentLatest({ statePath, fetch: v.fetch, env: {}, now, running: "0.9.0", ...over });

describe("each agent's newest version, read by this host", () => {
  it("asks each vendor once at its public address as wsp, and answers every agent's number, Hermes none", async () => {
    const v = vendors();
    expect(await on(stateIn(), v, () => 0).read()).toEqual(READ);
    expect([...v.asked].sort()).toEqual(Object.keys(ANSWERS).sort());
    expect(v.headers.every(h => h["user-agent"] === "wsp/0.9.0")).toBe(true);
  });

  it("keeps an answer a day, across a restart, and asks again once the day is past", async () => {
    const statePath = stateIn();
    let clock = Date.parse("2026-09-26T12:00:00.000Z");
    const v = vendors();
    const first = on(statePath, v, () => clock);
    await first.read();
    v.asked.length = 0;
    clock += LATEST_KEPT_MS - 1;
    expect(await first.read()).toEqual(READ);
    expect(await on(statePath, v, () => clock).read()).toEqual(READ);
    expect(v.asked).toEqual([]);
    expect(statSync(latestFileFor(statePath)).mode & 0o077).toBe(0);
    clock += 1;
    await first.read();
    await first.idle();
    expect(v.asked).toHaveLength(Object.keys(ANSWERS).length);
  });

  it("answers the numbers it keeps at once and lets the next read carry the fresh ones, waiting only when it keeps none", async () => {
    const statePath = stateIn();
    let clock = 0;
    await on(statePath, vendors(), () => clock).read();
    clock += LATEST_KEPT_MS;
    const hang: Reply = (_url, signal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const slow = vendors({ [CLAUDE]: hang });
    const latest = on(statePath, slow, () => clock, { timeoutMs: 60_000 });
    const started = Date.now();
    expect(await latest.read()).toEqual(READ);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slow.asked).toContain(CLAUDE);
  });

  it("keeps the last number where a vendor fails, and does not ask that vendor again for ten minutes", async () => {
    const statePath = stateIn();
    let clock = 0;
    await on(statePath, vendors(), () => clock).read();
    clock += LATEST_KEPT_MS;
    const v = vendors({ [CLAUDE]: url => answered("down", { status: 503, url }), [CODEX]: new Error("offline") });
    const latest = on(statePath, v, () => clock);
    await latest.read();
    await latest.idle();
    expect(await latest.read()).toEqual(READ);
    v.asked.length = 0;
    clock += LATEST_FLOOR_MS - 1;
    await latest.read();
    expect(v.asked).toEqual([]);
    clock += 1;
    await latest.read();
    await latest.idle();
    expect([...v.asked].sort()).toEqual([CLAUDE, CODEX].sort());
  });

  it("takes a version only where the answer is exactly one: nothing lifted out of a page, a wrapped number or one past the cap", async () => {
    const pi = `${NPM}/@earendil-works%2fpi-coding-agent/latest`;
    const crush = `${GITHUB}/charmbracelet/crush/releases/latest`;
    const goose = `${GITHUB}/aaif-goose/goose/releases/latest`;
    const qwen = `${NPM}/@qwen-code%2fqwen-code/latest`;
    const cases: [string, Reply][] = [
      [CLAUDE, body("\x1b[31m2.1.283\x07")],
      [CODEX, body(JSON.stringify({ version: "<script>alert(1)</script>1.2.3" }))],
      [CLAUDE, body("<html><body><center>nginx/1.18.0</center></body></html>")],
      [CLAUDE, body(`${"9".repeat(100_000)}.0.0`)],
      [qwen, body(JSON.stringify({ version: `1.0.0-${"a".repeat(60)}` }))],
      [crush, body(JSON.stringify({ tag_name: 7 }))],
      [goose, body(JSON.stringify({ tag_name: "release 1.53.0" }))],
      [pi, body(JSON.stringify({ version: "1.0.0", pad: "x".repeat(2 * 1024 * 1024) }))],
    ];
    for (const [url, reply] of cases) {
      const read = await on(stateIn(), vendors({ [url]: reply }), () => 0).read();
      expect(Object.keys(read), url).toHaveLength(Object.keys(READ).length - 1);
    }
  });

  it("refuses an answer that ended anywhere but the source's own host over https, and keeps the last number", async () => {
    const statePath = stateIn();
    let clock = 0;
    await on(statePath, vendors(), () => clock).read();
    for (const moved of ["https://evil.example/latest", "http://downloads.claude.ai/claude-code-releases/latest"]) {
      clock += LATEST_KEPT_MS;
      const latest = on(statePath, vendors({ [CLAUDE]: () => answered("9.9.9", { url: moved }) }), () => clock);
      await latest.read();
      await latest.idle();
      expect((await latest.read()).claude, moved).toBe("2.1.283");
    }
    const fresh = await on(stateIn(), vendors({ [CODEX]: () => answered(JSON.stringify({ version: "9.9.9" }), { url: "https://registry.npmjs.org.evil.example/x" }) }), () => 0).read();
    expect(fresh).not.toHaveProperty("codex");
  });

  it("reads its file through the same rule: a tampered number is no number, and an address the catalog does not name is dropped", async () => {
    const statePath = stateIn();
    writeFileSync(latestFileFor(statePath), JSON.stringify({ [CLAUDE]: { version: "\x1b[31mpwned\x1b[0m", checkedAt: 0, triedAt: 0 }, "https://evil.example/anything": { version: "1.0.0", checkedAt: 0, triedAt: 0 } }));
    const v = vendors({ [CLAUDE]: new Error("offline") });
    const latest = on(statePath, v, () => 0);
    const read = await latest.read();
    await latest.idle();
    expect(read).not.toHaveProperty("claude");
    expect(Object.keys(JSON.parse(readFileSync(latestFileFor(statePath), "utf8")) as object)).not.toContain("https://evil.example/anything");
  });

  it("gives up on a vendor that does not answer in time and still answers the rest", async () => {
    const goose = `${GITHUB}/aaif-goose/goose/releases/latest`;
    const hang: Reply = (_url, signal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const read = await on(stateIn(), vendors({ [goose]: hang }), () => 0, { timeoutMs: 50 }).read();
    expect(read).not.toHaveProperty("goose");
    expect(read.crush).toBe("0.97.0");
  });

  it("shares one round of asks among reads made while it runs", async () => {
    const v = vendors();
    const latest = on(stateIn(), v, () => 0);
    const [a, b] = await Promise.all([latest.read(), latest.read()]);
    expect(a).toEqual(b);
    expect(v.asked).toHaveLength(Object.keys(ANSWERS).length);
  });

  it("asks nothing and answers nothing with the update check off, in the environment or the saved file", async () => {
    const v = vendors();
    const statePath = stateIn();
    expect(await agentLatest({ statePath, fetch: v.fetch, env: { [UPDATE_CHECK_ENV]: "0" }, now: () => 0, running: "0.9.0" }).read()).toEqual({});
    writeFileSync(join(statePath, "..", ".env"), `${UPDATE_CHECK_ENV}=0\n`);
    expect(await on(statePath, v, () => 0).read()).toEqual({});
    expect(v.asked).toEqual([]);
    expect(existsSync(latestFileFor(statePath))).toBe(false);
  });

  it("writes nothing from a round still asking when the update check goes off", async () => {
    let letGo: () => void = () => {};
    const gate = new Promise<void>(r => (letGo = r));
    const v = vendors();
    const statePath = stateIn();
    const env: Record<string, string | undefined> = {};
    const fetch: typeof v.fetch = async (url, init) => {
      await gate;
      return v.fetch(url, init);
    };
    const reading = agentLatest({ statePath, fetch, env, now: () => 0, running: "0.9.0" }).read();
    env[UPDATE_CHECK_ENV] = "0";
    letGo();
    await reading;
    expect(existsSync(latestFileFor(statePath))).toBe(false);
  });

  it("keeps the readings beside the state file by address, with no other field", async () => {
    const statePath = stateIn();
    await on(statePath, vendors(), () => 0).read();
    const kept = JSON.parse(readFileSync(latestFileFor(statePath), "utf8")) as Record<string, unknown>;
    expect(Object.keys(kept).sort()).toEqual(Object.keys(ANSWERS).sort());
    expect(kept[CODEX]).toEqual({ version: "0.157.0", checkedAt: 0, triedAt: 0 });
  });
});

describe("wsp agents", () => {
  it("prints the newest version beside the one that stands, and a dash where none was read", async () => {
    const row = { road: "own", signIn: "signed-in", signInRoad: "token", wspTools: false } as const;
    const report = {
      target: { placeId: HERE_PLACE_ID },
      home: "/Users/ada",
      user: "ada",
      readAt: "2026-09-26T12:00:00.000Z",
      agents: [
        { ...row, id: "claude", name: "Claude Code", installed: true, version: "2.1.281", latest: "2.1.283", pinned: "2.1.280" },
        { ...row, id: "hermes", name: "Hermes", installed: true, version: "0.20.0" },
      ],
      skills: [],
      servers: [],
      refused: [],
    };
    const client = {
      request: async (op: string) => (op === "places.list" ? { places: [{ id: HERE_PLACE_ID, kind: "computer", name: "adas-mac", default: true }] } : { report }),
      close: () => {},
    } as unknown as HostClient;
    const io = captured();
    const agents = CLI_VERBS.find(v => v.name === "agents")!;
    expect(await runVerb(agents, [], io, () => stateIn(), { env: {}, dial: async () => client })).toBe(0);
    const [head, claude, hermes] = io.lines.join("\n").split("\n");
    expect(head).toMatch(/^AGENT\s+VERSION\s+LATEST\s+SIGN-IN/);
    expect(claude).toMatch(/^Claude Code\s+2\.1\.281\s+2\.1\.283\s+signed in/);
    expect(hermes).toMatch(/^Hermes\s+0\.20\.0\s+-\s+signed in/);
  });
});
