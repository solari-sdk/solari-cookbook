// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { readToken } from "../src/tokens.js";
import { VERIFY_PAGE_URL, cfOk, fakeAdmission, fingerprintFor, linkedVia, relayHarness, TEST_ZONE, type RelayHarness } from "./relay.js";

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const count = async (relay: RelayHarness, table: string): Promise<number> => ((await relay.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()) as { n: number }).n;

/** The heartbeat a box of this build sends: its key, and what the relay hands back about the account's devices. */
const beat = (relay: RelayHarness, hostId: string, token: string, body: Record<string, unknown> = {}): Promise<Response> =>
  relay.fetch(`/hosts/${hostId}/heartbeat`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });

interface Device {
  id: string;
  name: string;
  fingerprint: string;
  admissions: { by: string; issuedAt: string; signature: string }[];
}

/** The three calls a tunnel takes on the Cloudflare account API, in the order the Worker makes them. */
function armTunnel(r: RelayHarness, tunnelId = "tun_1", token = "eyJhIjoiZmFrZSJ9"): void {
  r.answer("POST https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel", cfOk({ id: tunnelId }));
  r.answer(`PUT https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/${tunnelId}/configurations`, cfOk({}));
  r.answer(`GET https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/${tunnelId}/token`, cfOk(token));
  r.answer("POST https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", cfOk({ id: "dns_1" }));
}

describe("a tunnel for a linked host", () => {
  it("creates it on the account, points it at the loopback port, names it under the zone and answers the token", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    armTunnel(relay);

    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tunnelToken: "eyJhIjoiZmFrZSJ9", hostname: `${hostId}.${TEST_ZONE}` });

    const made = relay.calls.find(c => c.method === "POST" && c.url.endsWith("/cfd_tunnel"))!;
    expect(made.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel");
    expect(made.headers["authorization"]).toBe("Bearer cf-token-fake");
    expect(made.body).toMatchObject({ name: `wsp-${hostId}`, config_src: "cloudflare" });

    const ingress = relay.calls.find(c => c.method === "PUT")!;
    expect(ingress.body).toEqual({ config: { ingress: [{ hostname: `${hostId}.${TEST_ZONE}`, service: "http://127.0.0.1:4400" }, { service: "http_status:404" }] } });

    const dns = relay.calls.find(c => c.url.includes("/dns_records"))!;
    expect(dns.body).toMatchObject({ type: "CNAME", name: `${hostId}.${TEST_ZONE}`, content: "tun_1.cfargotunnel.com", proxied: true });

    const row = (await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(hostId).first()) as Record<string, string>;
    expect(row["tunnel_id"]).toBe("tun_1");
    expect(row["hostname"]).toBe(`${hostId}.${TEST_ZONE}`);
  });

  it("points the tunnel it already made at the port the box serves now, and asks for its token again", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    armTunnel(relay);
    await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    const made = relay.calls.length;

    relay.answer("PUT https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/configurations", cfOk({}));
    relay.answer("GET https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/token", cfOk("eyJhIjoiZmFrZSJ9"));
    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4500 }) });
    expect(await res.json()).toEqual({ tunnelToken: "eyJhIjoiZmFrZSJ9", hostname: `${hostId}.${TEST_ZONE}` });
    // No second tunnel and no second name under the zone: the one it has is pointed at wherever the box serves now.
    expect(relay.calls.slice(made).map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "PUT /client/v4/accounts/acct_test/cfd_tunnel/tun_1/configurations",
      "GET /client/v4/accounts/acct_test/cfd_tunnel/tun_1/token",
    ]);
    expect(relay.calls.slice(made).find(c => c.method === "PUT")!.body).toEqual({
      config: { ingress: [{ hostname: `${hostId}.${TEST_ZONE}`, service: "http://127.0.0.1:4500" }, { service: "http_status:404" }] },
    });
  });

  it("gives a box that ran a quick tunnel a name of its own once the relay has a zone", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    // What a heartbeat from a run with no zone leaves behind: a name that belongs to nobody's zone.
    await relay.fetch(`/hosts/${hostId}/heartbeat`, { method: "POST", headers: bearer(token), body: JSON.stringify({ hostname: "blue-sky-1234.trycloudflare.com" }) });
    armTunnel(relay);

    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    expect(await res.json()).toEqual({ tunnelToken: "eyJhIjoiZmFrZSJ9", hostname: `${hostId}.${TEST_ZONE}` });
    expect(relay.calls.find(c => c.url.includes("/dns_records"))!.body).toMatchObject({ name: `${hostId}.${TEST_ZONE}` });
    expect(relay.calls.find(c => c.method === "PUT")!.body).toEqual({
      config: { ingress: [{ hostname: `${hostId}.${TEST_ZONE}`, service: "http://127.0.0.1:4400" }, { service: "http_status:404" }] },
    });
  });

  it("makes nothing at all with no zone configured, so the host falls back to a quick tunnel", async () => {
    const relay = await relayHarness();
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    relay.calls.length = 0;
    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { tunnelToken: null; hostname: null; why: string };
    expect(answer.tunnelToken).toBe(null);
    expect(answer.hostname).toBe(null);
    expect(answer.why).toContain("no zone");
    expect(relay.calls).toEqual([]);
  });

  it("refuses one host's token on another host's tunnel, on another account and on the same one", async () => {
    const relay = await relayHarness({ zone: true });
    const mine = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const theirs = await linkedVia(relay, "host", "attic", { login: "sam", githubId: "7" });
    // The one that bites: two boxes of the same person, where the account check alone would let one drive the other.
    const alsoMine = await linkedVia(relay, "host", "cellar", { login: "maya", githubId: "4242", cookie: mine.cookie });
    relay.calls.length = 0;

    expect((await relay.fetch(`/hosts/${theirs.hostId}/tunnel`, { method: "POST", headers: bearer(mine.token), body: JSON.stringify({ port: 4400 }) })).status).toBe(403);
    expect((await relay.fetch(`/hosts/${alsoMine.hostId}/tunnel`, { method: "POST", headers: bearer(mine.token), body: JSON.stringify({ port: 4400 }) })).status).toBe(403);
    expect((await relay.fetch(`/hosts/${alsoMine.hostId}/heartbeat`, { method: "POST", headers: bearer(mine.token), body: JSON.stringify({ version: "1" }) })).status).toBe(403);
    expect((await relay.fetch(`/hosts/${alsoMine.hostId}`, { method: "DELETE", headers: bearer(mine.token) })).status).toBe(403);
    expect(relay.calls).toEqual([]);
    expect(await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(alsoMine.hostId).first()).not.toBe(null);
  });

  it("records the tunnel before the name, so a name that fails cannot leave a tunnel nothing points at", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    relay.answer("POST https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel", cfOk({ id: "tun_1" }));
    relay.answer("PUT https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/configurations", cfOk({}));
    relay.answer("POST https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", { success: false, errors: [{ code: 1004, message: "DNS Validation Error" }] }, 400);

    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    expect(res.status).toBe(502);
    const row = (await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(hostId).first()) as Record<string, string | null>;
    expect(row["tunnel_id"]).toBe("tun_1");
    expect(row["hostname"]).toBe(null);
  });

  it("says what a refusal that only mentions that code in its words really was", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    relay.answer("POST https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel", cfOk({ id: "tun_1" }));
    relay.answer("PUT https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/configurations", cfOk({}));
    // Another refusal entirely, with that number in its sentence: reading the words rather than the code would
    // send the Worker looking for a record and then hide what the zone actually said.
    relay.answer("POST https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", { success: false, errors: [{ code: 10000, message: "Authentication error (ref 81053)" }] }, 403);

    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    expect(res.status).toBe(502);
    const said = ((await res.json()) as { error: string }).error;
    expect(said).toContain("Authentication error");
    expect(said).not.toContain("will not say by what");
    expect(relay.calls.filter(c => c.method === "GET" && c.url.includes("/dns_records"))).toEqual([]);
  });

  it("adopts the name already standing for this tunnel rather than leaving the box with none", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    relay.answer("POST https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel", cfOk({ id: "tun_1" }));
    relay.answer("PUT https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/configurations", cfOk({}));
    // A run that wrote the name and never recorded it: the second ask must go through rather than 502 forever.
    relay.answer("POST https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", { success: false, errors: [{ code: 81053, message: "An A, AAAA, or CNAME record with that host already exists." }] }, 400);
    relay.answer("GET https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", cfOk([{ id: "dns_1", content: "tun_1.cfargotunnel.com" }]));
    relay.answer("GET https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/token", cfOk("eyJhIjoiZmFrZSJ9"));

    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tunnelToken: "eyJhIjoiZmFrZSJ9", hostname: `${hostId}.${TEST_ZONE}` });
    // Nothing was written over: the record already said what it should.
    expect(relay.calls.filter(c => c.method === "PUT" && c.url.includes("/dns_records"))).toEqual([]);
    expect(((await relay.db.prepare("SELECT hostname FROM hosts WHERE id = ?").bind(hostId).first()) as Record<string, string>)["hostname"]).toBe(`${hostId}.${TEST_ZONE}`);
  });

  it("points a name of its own that is aimed elsewhere back at this tunnel", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    relay.answer("POST https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel", cfOk({ id: "tun_2" }));
    relay.answer("PUT https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_2/configurations", cfOk({}));
    relay.answer("POST https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", { success: false, errors: [{ code: 81053, message: "An A, AAAA, or CNAME record with that host already exists." }] }, 400);
    relay.answer("GET https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", cfOk([{ id: "dns_1", content: "an-older-tunnel.cfargotunnel.com" }]));
    relay.answer("PUT https://api.cloudflare.com/client/v4/zones/zone_test/dns_records/dns_1", cfOk({ id: "dns_1" }));
    relay.answer("GET https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_2/token", cfOk("eyJhIjoiZmFrZSJ9"));

    expect((await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) })).status).toBe(200);
    const written = relay.calls.find(c => c.method === "PUT" && c.url.includes("/dns_records/dns_1"))!;
    // The only name it ever touches is the one it derived, and it now says this host's tunnel.
    expect(written.body).toMatchObject({ type: "CNAME", name: `${hostId}.${TEST_ZONE}`, content: "tun_2.cfargotunnel.com" });
    const looked = relay.calls.find(c => c.method === "GET" && c.url.includes("/dns_records"))!;
    expect(looked.url).toContain(encodeURIComponent(`${hostId}.${TEST_ZONE}`));
  });

  it("refuses a token this relay did not sign", async () => {
    const relay = await relayHarness({ zone: true });
    const { hostId, token } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const forged = `${token.slice(0, -4)}AAAA`;
    const res = await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(forged), body: JSON.stringify({ port: 4400 }) });
    expect(res.status).toBe(401);
  });
});

describe("the names the relay may touch", () => {
  it("never deletes a name it did not derive from the host's own id", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "eve", githubId: "66" });
    armTunnel(relay);
    await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });

    // A box saying it answers at somebody else's name: the relay may show it and may never act on it.
    await relay.fetch(`/hosts/${hostId}/heartbeat`, { method: "POST", headers: bearer(token), body: JSON.stringify({ hostname: `www.${TEST_ZONE}` }) });
    relay.calls.length = 0;

    relay.answer("GET https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", cfOk([{ id: "dns_1" }]));
    relay.answer("DELETE https://api.cloudflare.com/client/v4/zones/zone_test/dns_records/dns_1", cfOk({ id: "dns_1" }));
    relay.answer("DELETE https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/connections", cfOk(null));
    relay.answer("DELETE https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1", cfOk({ id: "tun_1" }));
    expect((await relay.fetch(`/hosts/${hostId}`, { method: "DELETE", headers: bearer(token) })).status).toBe(200);

    const asked = relay.calls.filter(c => c.url.includes("/dns_records")).map(c => c.url);
    expect(asked.some(url => url.includes(encodeURIComponent(`www.${TEST_ZONE}`)))).toBe(false);
    expect(asked[0]).toContain(encodeURIComponent(`${hostId}.${TEST_ZONE}`));
  });

  it("takes a quick tunnel's name from a heartbeat and refuses any other", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const say = (hostname: string): Promise<Response> => relay.fetch(`/hosts/${hostId}/heartbeat`, { method: "POST", headers: bearer(token), body: JSON.stringify({ hostname }) });

    expect((await say("blue-sky-1234.trycloudflare.com")).status).toBe(200);
    expect(((await relay.db.prepare("SELECT hostname FROM hosts WHERE id = ?").bind(hostId).first()) as Record<string, string>)["hostname"]).toBe("blue-sky-1234.trycloudflare.com");
    const refused = await say(`www.${TEST_ZONE}`);
    expect(refused.status).toBe(400);
    expect(((await relay.db.prepare("SELECT hostname FROM hosts WHERE id = ?").bind(hostId).first()) as Record<string, string>)["hostname"]).toBe("blue-sky-1234.trycloudflare.com");
  });
});

describe("a host that says where it is", () => {
  it("records the hostname it got, its version and when it was last seen", async () => {
    const relay = await relayHarness();
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    relay.tick(90_000);
    const res = await relay.fetch(`/hosts/${hostId}/heartbeat`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ hostname: "blue-sky-1234.trycloudflare.com", version: "2026.9.0" }),
    });
    expect(res.status).toBe(200);
    const row = (await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(hostId).first()) as Record<string, string>;
    expect(row["hostname"]).toBe("blue-sky-1234.trycloudflare.com");
    expect(row["connector_version"]).toBe("2026.9.0");
    expect(Date.parse(row["last_seen"]!)).toBe(Date.parse("2026-09-11T12:00:00.000Z") + 90_000);
  });
});

describe("the listing a person's own client reads", () => {
  it("names that account's hosts and nobody else's", async () => {
    const relay = await relayHarness();
    const mine = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    await linkedVia(relay, "host", "attic", { login: "maya", githubId: "4242", cookie: mine.cookie });
    await linkedVia(relay, "host", "theirs", { login: "sam", githubId: "7" });
    const client = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242", cookie: mine.cookie });

    const res = await relay.fetch("/hosts", { headers: bearer(client.token) });
    expect(res.status).toBe(200);
    const { hosts } = (await res.json()) as { hosts: { name: string; id: string }[] };
    expect(hosts.map(h => h.name).sort()).toEqual(["attic", "box"]);
  });

  it("refuses a host's own token, which names one box and not a person", async () => {
    const relay = await relayHarness();
    const { token } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    expect((await relay.fetch("/hosts", { headers: bearer(token) })).status).toBe(403);
  });

  it("refuses a request with no token at all", async () => {
    const relay = await relayHarness();
    expect((await relay.fetch("/hosts")).status).toBe(401);
  });
});

describe("unlinking", () => {
  it("takes the tunnel, the name under the zone and the row away", async () => {
    const relay = await relayHarness({ zone: true });
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    armTunnel(relay);
    await relay.fetch(`/hosts/${hostId}/tunnel`, { method: "POST", headers: bearer(token), body: JSON.stringify({ port: 4400 }) });
    relay.calls.length = 0;

    relay.answer("GET https://api.cloudflare.com/client/v4/zones/zone_test/dns_records", cfOk([{ id: "dns_1" }]));
    relay.answer("DELETE https://api.cloudflare.com/client/v4/zones/zone_test/dns_records/dns_1", cfOk({ id: "dns_1" }));
    relay.answer("DELETE https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1/connections", cfOk(null));
    relay.answer("DELETE https://api.cloudflare.com/client/v4/accounts/acct_test/cfd_tunnel/tun_1", cfOk({ id: "tun_1" }));
    const res = await relay.fetch(`/hosts/${hostId}`, { method: "DELETE", headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    // The connections go before the tunnel: one with connections still registered cannot be deleted at all.
    expect(relay.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /client/v4/zones/zone_test/dns_records",
      "DELETE /client/v4/zones/zone_test/dns_records/dns_1",
      "DELETE /client/v4/accounts/acct_test/cfd_tunnel/tun_1/connections",
      "DELETE /client/v4/accounts/acct_test/cfd_tunnel/tun_1",
    ]);
    expect(await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(hostId).first()).toBe(null);
  });

  it("refuses another account's host and leaves the row standing", async () => {
    const relay = await relayHarness();
    const mine = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const theirs = await linkedVia(relay, "host", "attic", { login: "sam", githubId: "7" });
    expect((await relay.fetch(`/hosts/${theirs.hostId}`, { method: "DELETE", headers: bearer(mine.token) })).status).toBe(403);
    expect(await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(theirs.hostId).first()).not.toBe(null);
  });

  it("lets the person's own client take a host away without that host being up", async () => {
    const relay = await relayHarness();
    const host = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const client = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242", cookie: host.cookie });
    expect((await relay.fetch(`/hosts/${host.hostId}`, { method: "DELETE", headers: bearer(client.token) })).status).toBe(200);
    expect(await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(host.hostId).first()).toBe(null);
  });

  it("refuses the token of a host that was already taken away", async () => {
    const relay = await relayHarness();
    const { token, hostId } = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    await relay.fetch(`/hosts/${hostId}`, { method: "DELETE", headers: bearer(token) });
    const res = await relay.fetch(`/hosts/${hostId}/heartbeat`, { method: "POST", headers: bearer(token), body: JSON.stringify({ version: "2026.9.0" }) });
    expect(res.status).toBe(401);
  });
});

describe("the computers a person signed in from", () => {
  it("lists them, marks this one, and takes one away so its token opens nothing", async () => {
    const relay = await relayHarness();
    const first = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const second = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242", cookie: first.cookie });

    const listed = (await (await relay.fetch("/clients", { headers: bearer(first.token) })).json()) as { clients: { id: string; name: string; thisOne: boolean }[] };
    expect(listed.clients.map(c => c.name).sort()).toEqual(["the Mac", "the laptop"]);
    expect(listed.clients.find(c => c.thisOne)!.name).toBe("the Mac");

    const gone = listed.clients.find(c => c.name === "the laptop")!;
    expect((await relay.fetch(`/clients/${gone.id}`, { method: "DELETE", headers: bearer(first.token) })).status).toBe(200);
    // The token that walked off with that computer opens nothing now, without rotating the key every box depends on.
    expect((await relay.fetch("/hosts", { headers: bearer(second.token) })).status).toBe(401);
    expect((await relay.fetch("/hosts", { headers: bearer(first.token) })).status).toBe(200);
  });

  it("refuses a sign-in older than a month, and one on another account", async () => {
    const relay = await relayHarness();
    const mine = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const theirs = await linkedVia(relay, "client", "their Mac", { login: "sam", githubId: "7" });
    const listed = (await (await relay.fetch("/clients", { headers: bearer(theirs.token) })).json()) as { clients: { id: string }[] };

    expect((await relay.fetch(`/clients/${listed.clients[0]!.id}`, { method: "DELETE", headers: bearer(mine.token) })).status).toBe(403);
    relay.tick(31 * 24 * 60 * 60_000);
    expect((await relay.fetch("/hosts", { headers: bearer(mine.token) })).status).toBe(401);
    expect((await relay.fetch("/clients", { headers: bearer(mine.token) })).status).toBe(401);
  });
});

describe("the key a box proves", () => {
  it("records it off the first heartbeat that names it, lists it to the account's computers, and refuses a beat that names another", async () => {
    const relay = await relayHarness();
    const box = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242", cookie: box.cookie });
    const first = fingerprintFor("box key");

    // A box of the build before this one names no key, and is taken as it always was.
    expect((await beat(relay, box.hostId!, box.token, { version: "2026.9.0" })).status).toBe(200);
    expect(((await relay.db.prepare("SELECT host_key FROM hosts WHERE id = ?").bind(box.hostId).first()) as { host_key: string | null }).host_key).toBe(null);

    expect((await beat(relay, box.hostId!, box.token, { hostKey: first })).status).toBe(200);
    expect(((await relay.db.prepare("SELECT host_key FROM hosts WHERE id = ?").bind(box.hostId).first()) as { host_key: string }).host_key).toBe(first);
    const listed = (await (await relay.fetch("/hosts", { headers: bearer(mac.token) })).json()) as { hosts: { id: string; hostKey: string | null }[] };
    expect(listed.hosts).toEqual([expect.objectContaining({ id: box.hostId, hostKey: first })]);

    // The same key again is the same box; another key is not, and the listing keeps the first.
    expect((await beat(relay, box.hostId!, box.token, { hostKey: first })).status).toBe(200);
    const other = await beat(relay, box.hostId!, box.token, { hostKey: fingerprintFor("a wiped state") });
    expect(other.status).toBe(409);
    const said = ((await other.json()) as { error: string }).error;
    expect(said).toContain("wsp host unlink");
    expect(said).toContain("wsp host link");
    expect(((await relay.db.prepare("SELECT host_key FROM hosts WHERE id = ?").bind(box.hostId).first()) as { host_key: string }).host_key).toBe(first);
  });

  it("names the key that stands when two first beats race, never the empty one it read before the write", async () => {
    const relay = await relayHarness();
    const box = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const keys = [fingerprintFor("first start"), fingerprintFor("second start")];

    // Both beats read a row holding no key; one write lands, and the other is refused against the key it never read.
    const answers = await Promise.all(keys.map(key => beat(relay, box.hostId!, box.token, { hostKey: key })));
    expect(answers.map(a => a.status).sort()).toEqual([200, 409]);
    const stored = ((await relay.db.prepare("SELECT host_key FROM hosts WHERE id = ?").bind(box.hostId).first()) as { host_key: string }).host_key;
    const lost = answers.findIndex(a => a.status === 409);
    expect(keys[lost]).not.toBe(stored);
    const said = ((await answers[lost]!.json()) as { error: string }).error;
    expect(said).toContain(stored);
    expect(said).toContain(keys[lost]!);
    expect(said).not.toContain("null");
  });

  it("puts a box on the account from a signed-in computer, under its key, and answers the token that box keeps", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const key = fingerprintFor("box key");

    const res = await relay.fetch("/hosts", { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ name: "box", hostKey: key }) });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { hostId: string; name: string; token: string; login: string };
    expect(answer.name).toBe("box");
    expect(answer.login).toBe("maya");
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    expect(claims).toMatchObject({ kind: "host", subject: answer.hostId });
    const row = (await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(answer.hostId).first()) as Record<string, string | null>;
    expect(row["name"]).toBe("box");
    expect(row["host_key"]).toBe(key);
    expect(row["account_id"]).toBe(claims!.account);
    // The token opens the box's own routes, as one collected off the page does.
    expect((await beat(relay, answer.hostId, answer.token, { hostKey: key })).status).toBe(200);
    expect((await beat(relay, answer.hostId, answer.token, { hostKey: fingerprintFor("another") })).status).toBe(409);

    // One name, one box, per account, as on the page; and nothing without a key or a name.
    expect((await relay.fetch("/hosts", { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ name: "box", hostKey: fingerprintFor("second") }) })).status).toBe(409);
    expect((await relay.fetch("/hosts", { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ name: "attic" }) })).status).toBe(400);
    expect((await relay.fetch("/hosts", { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ hostKey: key }) })).status).toBe(400);
    expect(await count(relay, "hosts")).toBe(1);
  });

  it("refuses to put a box on with a box's own token, and with no token", async () => {
    const relay = await relayHarness();
    const box = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    expect((await relay.fetch("/hosts", { method: "POST", headers: bearer(box.token), body: JSON.stringify({ name: "attic", hostKey: fingerprintFor("attic") }) })).status).toBe(403);
    expect((await relay.fetch("/hosts", { method: "POST", body: JSON.stringify({ name: "attic", hostKey: fingerprintFor("attic") }) })).status).toBe(401);
    expect(await count(relay, "hosts")).toBe(1);
  });
});

describe("the admissions a box reads off its heartbeat", () => {
  it("lists an admission posted for a computer already on the account, and refuses one for another account's", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const laptop = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242", cookie: mac.cookie });
    const sam = await linkedVia(relay, "client", "sam's Mac", { login: "sam", githubId: "7" });
    const admission = fakeAdmission(laptop.fingerprint!, mac.fingerprint!);

    const posted = await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify(admission) });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ recorded: true });
    const listed = (await (await relay.fetch("/clients", { headers: bearer(mac.token) })).json()) as { clients: { id: string; admissions: { by: string; issuedAt: string; byName?: string }[] }[] };
    expect(listed.clients.find(c => c.id === laptop.id)!.admissions).toEqual([{ by: mac.fingerprint, issuedAt: admission.issuedAt, byName: "the Mac" }]);
    expect(listed.clients.find(c => c.id === mac.id)!.admissions).toEqual([]);

    // Sam's token names Sam's account, and the laptop is not on it.
    expect((await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(sam.token), body: JSON.stringify(fakeAdmission(laptop.fingerprint!, sam.fingerprint!)) })).status).toBe(403);
    // An admission for a key that is not the one this computer signed in with is for nobody here.
    expect((await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify(fakeAdmission(fingerprintFor("somebody else"), mac.fingerprint!)) })).status).toBe(400);
    expect((await relay.fetch("/clients/c_nobody/admissions", { method: "POST", headers: bearer(mac.token), body: JSON.stringify(admission) })).status).toBe(404);
    expect(await count(relay, "admissions")).toBe(1);
  });

  it("keeps one admission per signer for a computer, the latest bytes standing", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const laptop = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242", cookie: mac.cookie });
    for (const at of ["2026-09-11T12:00:00.000Z", "2026-09-11T12:05:00.000Z", "2026-09-11T12:10:00.000Z"]) {
      expect((await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify(fakeAdmission(laptop.fingerprint!, mac.fingerprint!, at)) })).status).toBe(200);
    }
    expect(await count(relay, "admissions")).toBe(1);
    const kept = (await relay.db.prepare("SELECT issued_at FROM admissions").first()) as { issued_at: string };
    expect(kept.issued_at).toBe("2026-09-11T12:10:00.000Z");
  });

  it("takes an admission signed by the bearer alone, so another computer's token cannot stand in for the Mac's", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const laptop = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242", cookie: mac.cookie });
    const desk = await linkedVia(relay, "client", "the desk", { login: "maya", githubId: "4242", cookie: mac.cookie });
    const real = fakeAdmission(laptop.fingerprint!, mac.fingerprint!);
    expect((await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify(real) })).status).toBe(200);

    // The desk's token posts bytes naming the Mac as their signer, which would replace the Mac's own row for the laptop.
    const forged = { ...fakeAdmission(laptop.fingerprint!, mac.fingerprint!, "2026-09-11T13:00:00.000Z"), signature: "Z2FyYmFnZQ==" };
    const refused = await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(desk.token), body: JSON.stringify(forged) });
    expect(refused.status).toBe(400);
    const said = ((await refused.json()) as { error: string }).error;
    expect(said).toContain(mac.fingerprint!);
    expect(said).toContain(desk.fingerprint!);
    const kept = (await relay.db.prepare("SELECT signer, issued_at, signature FROM admissions WHERE client_id = ?").bind(laptop.id).first()) as Record<string, string>;
    expect(kept).toEqual({ signer: mac.fingerprint, issued_at: real.issuedAt, signature: real.signature });
    expect(await count(relay, "admissions")).toBe(1);

    // Signed as itself, the desk's admission stands beside the Mac's.
    expect((await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(desk.token), body: JSON.stringify(fakeAdmission(laptop.fingerprint!, desk.fingerprint!)) })).status).toBe(200);
    expect(await count(relay, "admissions")).toBe(2);

    // A computer signed in before device keys holds none, and can sign for nobody.
    await relay.db.prepare("UPDATE clients SET fingerprint = NULL WHERE id = ?").bind(desk.id).run();
    const keyless = await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(desk.token), body: JSON.stringify(fakeAdmission(laptop.fingerprint!, desk.fingerprint!)) });
    expect(keyless.status).toBe(400);
    const told = ((await keyless.json()) as { error: string }).error;
    expect(told).toContain("wsp logout");
    expect(told).toContain(`or from ${VERIFY_PAGE_URL} in your browser`);
    expect(told).toContain("wsp login");
    expect(await count(relay, "admissions")).toBe(2);

    // Nor can another computer admit a computer that holds none, whoever signs for it.
    await relay.db.prepare("UPDATE clients SET fingerprint = NULL WHERE id = ?").bind(laptop.id).run();
    const unkeyed = await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify(fakeAdmission(laptop.fingerprint!, mac.fingerprint!)) });
    expect(unkeyed.status).toBe(400);
    const named = ((await unkeyed.json()) as { error: string }).error;
    expect(named).toContain(`wsp logout ${laptop.id}, or from ${VERIFY_PAGE_URL} in your browser`);
    expect(named).toContain("wsp login");
    expect(await count(relay, "admissions")).toBe(2);
  });

  it("hands a box the account's devices with their admissions, and none of another account's", async () => {
    const relay = await relayHarness();
    const box = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242", cookie: box.cookie });
    const laptop = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242", cookie: box.cookie });
    const theirs = await linkedVia(relay, "host", "attic", { login: "sam", githubId: "7" });
    const sam = await linkedVia(relay, "client", "sam's Mac", { login: "sam", githubId: "7", cookie: theirs.cookie });
    const admission = fakeAdmission(laptop.fingerprint!, mac.fingerprint!);
    await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify(admission) });

    const res = await beat(relay, box.hostId!, box.token, { version: "2026.9.0" });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { ok: boolean; devices: Device[] };
    expect(answer.ok).toBe(true);
    expect(answer.devices.map(d => d.name).sort()).toEqual(["the Mac", "the laptop"]);
    expect(answer.devices.find(d => d.id === mac.id)).toEqual({ id: mac.id, name: "the Mac", fingerprint: mac.fingerprint, admissions: [] });
    // The bytes the signer made, whole, for the box to verify against the key it holds for that signer.
    expect(answer.devices.find(d => d.id === laptop.id)).toEqual({
      id: laptop.id,
      name: "the laptop",
      fingerprint: laptop.fingerprint,
      admissions: [{ by: mac.fingerprint, issuedAt: admission.issuedAt, signature: admission.signature }],
    });

    const samsBeat = (await (await beat(relay, theirs.hostId!, theirs.token)).json()) as { devices: Device[] };
    expect(samsBeat.devices.map(d => d.id)).toEqual([sam.id]);
  });

  it("drops a computer's admissions with it, and the next heartbeat no longer lists it", async () => {
    const relay = await relayHarness();
    const box = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242", cookie: box.cookie });
    const laptop = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242", cookie: box.cookie });
    await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify(fakeAdmission(laptop.fingerprint!, mac.fingerprint!)) });
    expect(await count(relay, "admissions")).toBe(1);

    expect((await relay.fetch(`/clients/${laptop.id}`, { method: "DELETE", headers: bearer(mac.token) })).status).toBe(200);
    expect(await count(relay, "admissions")).toBe(0);
    const answer = (await (await beat(relay, box.hostId!, box.token)).json()) as { devices: Device[] };
    expect(answer.devices.map(d => d.id)).toEqual([mac.id]);
  });

  it("refuses a fingerprint that is not one on every route that takes one, before a row is written", async () => {
    const relay = await relayHarness();
    const box = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242" });
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242", cookie: box.cookie });
    const laptop = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242", cookie: box.cookie });

    const badBeat = await beat(relay, box.hostId!, box.token, { hostKey: "ssh-ed25519 AAAA" });
    expect(badBeat.status).toBe(400);
    expect(((await badBeat.json()) as { error: string }).error).toContain("SHA256:");
    expect(((await relay.db.prepare("SELECT host_key FROM hosts WHERE id = ?").bind(box.hostId).first()) as { host_key: string | null }).host_key).toBe(null);

    expect((await relay.fetch("/hosts", { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ name: "attic", hostKey: "nope" }) })).status).toBe(400);
    expect(await count(relay, "hosts")).toBe(1);

    const badSigner = await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ ...fakeAdmission(laptop.fingerprint!, mac.fingerprint!), by: "nope" }) });
    expect(badSigner.status).toBe(400);
    const badSignature = await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ ...fakeAdmission(laptop.fingerprint!, mac.fingerprint!), signature: "not base64!" }) });
    expect(badSignature.status).toBe(400);
    const badTime = await relay.fetch(`/clients/${laptop.id}/admissions`, { method: "POST", headers: bearer(mac.token), body: JSON.stringify({ ...fakeAdmission(laptop.fingerprint!, mac.fingerprint!), issuedAt: "yesterday-ish" }) });
    expect(badTime.status).toBe(400);
    expect(await count(relay, "admissions")).toBe(0);
  });
});
