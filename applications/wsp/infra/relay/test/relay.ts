// SPDX-License-Identifier: AGPL-3.0-only
// One relay for a test file: a real D1 with the repo's own migrations applied,
// the Worker's handler called in this process, and the one road out of the
// Worker (the Cloudflare account API and GitHub) answered from a table the
// test arms. Nothing here reaches a network.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
// The miniflare pin in package.json is the exact version wrangler bundles (4.130.0 depends on 5.20260908.0-alpha),
// so the D1 these tests run against is the one wrangler dev and wrangler deploy build with, not a second copy.
import { Miniflare } from "miniflare";
import { afterAll } from "vitest";
import type { Env } from "../src/env.js";
import { handle, type Deps } from "../src/index.js";
import { SESSION_COOKIE, readToken } from "../src/tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

/** Every migration in the folder, in the order wrangler applies them, split into statements. */
export function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith(".sql"))
    .sort()
    .flatMap(name => readFileSync(join(MIGRATIONS_DIR, name), "utf8").split(";"))
    .map(statement =>
      statement
        .split("\n")
        .filter(line => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(statement => statement !== "");
}

/** One call the Worker made to somebody else's API, as a test reads it back. */
export interface OutboundCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface RelayHarness {
  env: Env;
  db: D1Database;
  deps: Deps;
  /** Every call the Worker made out, oldest first. */
  calls: OutboundCall[];
  /** Answers the next call whose "<METHOD> <url>" holds this text; armed answers are spent in order. */
  answer(holds: string, body: unknown, status?: number): void;
  fetch(path: string, init?: { method?: string; body?: string | ReadableStream<Uint8Array>; headers?: Record<string, string> }): Promise<Response>;
  /** Moves the clock the Worker reads. */
  tick(ms: number): void;
}

export const RELAY_ORIGIN = "https://relay.example";
export const VERIFY_PAGE_URL = `${RELAY_ORIGIN}/link/verify`;
export const TEST_ZONE = "boxes.example";

/** The relay's own tables, apart from the bookkeeping D1 keeps in the same database. */
export const OWN_TABLES = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'";

/** The worker the test miniflare runs: every statement a test or the Worker hands in, against the D1 bound here. */
const D1_WORKER = `export default {
  async fetch(request, env) {
    const calls = await request.json();
    const answers = [];
    try {
      for (const { sql, params, kind } of calls) {
        const stmt = params.length === 0 ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(...params);
        answers.push(kind === "first" ? await stmt.first() : kind === "all" ? await stmt.all() : await stmt.run());
      }
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
    }
    return Response.json(answers);
  },
};`;

interface Call {
  sql: string;
  params: unknown[];
  kind: "first" | "all" | "run";
}

/** The D1 in the worker, reached one request at a time: what the relay asks of a database and no more, beside the
 * one road the harness itself needs for a list of statements. Every statement lands on the same database either
 * way; this is the road to it, not a second copy of it. The binding miniflare hands back to node charges about
 * 14 ms a statement, where a request into the worker charges 3 (measured on this Mac, 2026-09-11), and a case
 * here runs dozens of them. */
function d1Through(mf: Miniflare): { db: D1Database; runAll: (sql: string[]) => Promise<void> } {
  const send = async (calls: Call[]): Promise<unknown[]> => {
    // JSON carries an undefined through as null, where D1 itself throws: a bind the real database would refuse
    // has to be refused here too, or the shorter road writes a row the deployed Worker never could.
    const loose = calls.find(call => call.params.includes(undefined));
    if (loose !== undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (${loose.sql})`);
    const res = await mf.dispatchFetch("http://d1.test/", { method: "POST", body: JSON.stringify(calls) });
    if (!res.ok) throw new Error(`${await res.text()} (${calls.map(c => c.sql).join("; ")})`);
    return (await res.json()) as unknown[];
  };
  const statement = (sql: string, params: unknown[]): D1PreparedStatement =>
    ({
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => (await send([{ sql, params, kind: "first" }]))[0],
      all: async () => (await send([{ sql, params, kind: "all" }]))[0],
      run: async () => (await send([{ sql, params, kind: "run" }]))[0],
    }) as unknown as D1PreparedStatement;
  return {
    db: { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database,
    runAll: async sql => {
      await send(sql.map(one => ({ sql: one, params: [], kind: "run" as const })));
    },
  };
}

/** One miniflare with the repo's own migrations applied, and the way to empty what they made. */
async function bootRelay(): Promise<{ mf: Miniflare; db: D1Database; empty: () => Promise<void> }> {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "relay-test",
          compatibilityDate: "2026-09-01",
          env: { DB: { type: "d1", id: "relay-test" } },
          manifest: {
            modulesRoot: here,
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: D1_WORKER } },
          },
        },
      },
    ],
  });
  const { db, runAll } = d1Through(mf);
  await runAll(migrationStatements());
  const { results } = await db.prepare(OWN_TABLES).all<{ name: string }>();
  const tables = results.map(row => row.name);
  return { mf, db, empty: () => runAll(tables.map(name => `DELETE FROM ${name}`)) };
}

// The miniflare is booted while this file is being collected rather than inside the first case that asks for one.
// A workerd takes about half a second to come up and several times that when the Mac is building something else,
// and a case paying for it out of the five seconds a test is given went over whenever it landed in a busy moment
// (measured on this Mac, 2026-09-11). Collection is not on any test's clock, so the boot is no longer on one.
const { mf, db, empty } = await bootRelay();

afterAll(() => mf.dispose());

export async function relayHarness(opts: { zone?: boolean } = {}): Promise<RelayHarness> {
  // The rows go on the way in rather than on the way out, so a case that fails halfway through leaves nothing
  // behind for the next one.
  await empty();

  const zone = opts.zone === true;
  const env: Env = {
    DB: db,
    CLOUDFLARE_ACCOUNT_ID: "acct_test",
    CLOUDFLARE_API_TOKEN: "cf-token-fake",
    RELAY_ZONE: zone ? TEST_ZONE : "",
    RELAY_ZONE_ID: zone ? "zone_test" : "",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret-fake",
    RELAY_SIGNING_KEY: "signing-key-fake",
  };

  const calls: OutboundCall[] = [];
  const armed: { holds: string; body: unknown; status: number }[] = [];
  let clock = Date.parse("2026-09-11T12:00:00.000Z");
  let bytes = 0;

  const deps: Deps = {
    now: () => clock,
    random: (n: number) => Uint8Array.from({ length: n }, () => (bytes = (bytes + 37) % 251)),
    fetch: async (request: Request) => {
      const raw = await request.clone().text();
      calls.push({
        method: request.method,
        url: request.url,
        body: raw === "" ? undefined : (JSON.parse(raw) as unknown),
        headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v])),
      });
      const line = `${request.method} ${request.url}`;
      const at = armed.findIndex(a => line.includes(a.holds));
      if (at === -1) throw new Error(`no answer armed for ${line}`);
      const [answer] = armed.splice(at, 1);
      return new Response(JSON.stringify(answer!.body), { status: answer!.status, headers: { "content-type": "application/json" } });
    },
  };

  return {
    env,
    db,
    deps,
    calls,
    answer: (holds, body, status = 200) => armed.push({ holds, body, status }),
    fetch: (path, init = {}) =>
      handle(
        // duplex names a body that arrives as a stream, which is how a case reads what the routes pulled off one.
        new Request(`${RELAY_ORIGIN}${path}`, {
          method: init.method ?? "GET",
          ...(init.body !== undefined ? { body: init.body, duplex: "half" } : {}),
          headers: init.headers ?? {},
        } as RequestInit),
        env,
        deps,
      ),
    tick: ms => {
      clock += ms;
    },
  };
}

/** The Cloudflare API's own envelope, which every answer of theirs carries. */
export const cfOk = (result: unknown): unknown => ({ success: true, errors: [], messages: [], result });

/** A fingerprint in the shape the keys package prints for a key, made of nothing but a name: the relay reads the
 * shape and holds no key to check it against, so a test needs no key either. */
export const fingerprintFor = (name: string): string => `SHA256:${createHash("sha256").update(name).digest("base64").replace(/=+$/, "")}`;

/** What a signed-in wsp posts to admit a computer: the admitted key, the signer's key, the time and the signature.
 * The relay stores and forwards these bytes and verifies none of them, so the signature here is a marker a test
 * reads back rather than anything a key made. */
export function fakeAdmission(device: string, by: string, issuedAt = "2026-09-11T12:00:00.000Z"): { device: string; by: string; issuedAt: string; signature: string } {
  return { device, by, issuedAt, signature: Buffer.from(`${by} admits ${device}`).toString("base64") };
}

/** The whole device code flow for one host or one client, as the tests that start from a linked host need it:
 * the code, the sign in, the approval and the poll that hands the token over. `who.from` is the address the start
 * is made from, which the relay counts its caps under: a case that starts several links gives each its own. A
 * client's start carries the fingerprint of its device key, as wsp login sends one. */
export async function linkedVia(
  relay: RelayHarness,
  kind: "host" | "client",
  name: string,
  who: { login: string; githubId: string; cookie?: string; from?: string },
): Promise<{ token: string; id: string; hostId?: string; fingerprint?: string; cookie: string }> {
  const fingerprint = kind === "client" ? fingerprintFor(name) : undefined;
  const start = (await (
    await relay.fetch("/link/start", {
      method: "POST",
      body: JSON.stringify({ kind, name, ...(fingerprint !== undefined ? { fingerprint } : {}) }),
      ...(who.from !== undefined ? { headers: { "cf-connecting-ip": who.from } } : {}),
    })
  ).json()) as { code: string; pollToken: string };
  const cookie = who.cookie ?? (await signIn(relay, who.login, who.githubId));
  const page = await typeCode(relay, start.code, cookie);
  const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  await relay.fetch("/link/approve", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: start.code, stamp }).toString(),
  });
  const answer = (await (await relay.fetch("/link/poll", { method: "POST", body: JSON.stringify({ pollToken: start.pollToken }) })).json()) as { token: string; hostId?: string };
  const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
  return {
    token: answer.token,
    id: claims?.subject ?? "",
    ...(answer.hostId !== undefined ? { hostId: answer.hostId } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    cookie,
  };
}

/** The code typed on the verify page, which is what the relay renders the approve form for: the page's address
 * carries none, so this is the one road to that form. */
export const typeCode = (relay: RelayHarness, code: string, cookie: string): Promise<Response> =>
  relay.fetch("/link/verify", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code }).toString() });

/** Signs a person in the way the verify page does, and answers with the session cookie a later request carries. */
export async function signIn(relay: RelayHarness, login: string, githubId: string): Promise<string> {
  const start = await relay.fetch("/link/verify");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  // The sign-in is bound to this browser, so the callback carries back the nonce the redirect set.
  const nonce = firstCookie(start);
  relay.answer("POST https://github.com/login/oauth/access_token", { access_token: "gho_fake", token_type: "bearer" });
  relay.answer("GET https://api.github.com/user", { id: githubId, login });
  const back = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(state)}`, { headers: { cookie: nonce } });
  return firstCookie(back, SESSION_COOKIE);
}

/** The first cookie a redirect set, as a browser would send it back. */
export function firstCookie(res: Response, named?: string): string {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const wanted = named === undefined ? all[0] : all.find(line => line.startsWith(`${named}=`));
  return (wanted ?? "").split(";")[0] ?? "";
}
