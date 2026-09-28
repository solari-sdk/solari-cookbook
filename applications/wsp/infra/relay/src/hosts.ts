// SPDX-License-Identifier: AGPL-3.0-only
// What a linked box and a person's own client ask of the relay: a tunnel to
// sit behind, a heartbeat saying where it landed and which key it proves, the
// listing that tells a client where a box answers and which key to pin, the
// add that puts a box on from a signed-in computer, and the delete that takes
// a box off the account. A host token names one box; a client token names one
// computer a person signed in from. No name a box sends is ever a name this
// relay acts on: what it writes and deletes under its zone is derived from the
// host id. The heartbeat's answer is the account's computers and the
// admissions signed for them, which the box verifies with keys it holds and
// the relay does not.
import { fingerprintField, jsonBody, nameOf, type Admission } from "./body.js";
import { createCname, createTunnel, deleteCname, deleteTunnel, setIngress, tunnelToken } from "./cloudflare.js";
import { accountOf, admissionsByClient, clientOf, clientsOf, deleteHost, hostNamed, hostOf, hostsOf, insertHost, seenClient, seenHost, setHostHostname, setHostKey, setHostTunnel, type HostRow } from "./db.js";
import { NO_ZONE_LINE, isQuickTunnel, managedHostname, zoneOf } from "./env.js";
import { newId } from "./ids.js";
import type { Ctx } from "./index.js";
import { refuse, type Refusal } from "./refusal.js";
import { mintToken, readToken, type TokenClaims } from "./tokens.js";

/** A person's sign-in stands a month, and then that computer signs in again. A box's token does not run out: a box
 * nobody is sitting at cannot open a browser, and wsp host unlink is how one is taken away. */
export const CLIENT_TOKEN_MS = 30 * 24 * 60 * 60_000;

/** The moment a sign-in has to be from to still stand now. A token issued before it has run out, and so has the
 * client row the poll minted with it, whose created_at is that same moment: a run-out row holds its key for nobody. */
export const signedInSince = (now: number): number => now - CLIENT_TOKEN_MS;

/** The token a request carries, read from the one header it may ride in. A bearer never rides a URL, where a log would keep it. */
export async function claimsOf(ctx: Ctx): Promise<TokenClaims> {
  const carried = /^Bearer\s+(\S+)$/i.exec(ctx.req.headers.get("authorization") ?? "")?.[1];
  const claims = carried === undefined ? undefined : await readToken(ctx.env.RELAY_SIGNING_KEY, carried);
  if (claims === undefined) throw refuse(401, "this route needs the token the link gave this computer");
  return claims;
}

/** The box a request is about, when the token is that box's own and the relay still holds it. */
async function hostFor(ctx: Ctx): Promise<HostRow> {
  const claims = await claimsOf(ctx);
  const id = ctx.params["id"]!;
  const row = await hostOf(ctx.env, id);
  // A token for a host this relay no longer holds opens nothing: unlinking is how a box is taken away for good.
  if (claims.kind !== "host" || claims.subject !== id || row === undefined || row.account_id !== claims.account) {
    throw refuse(row === undefined || claims.kind !== "host" ? 401 : 403, "that token does not name this host");
  }
  return row;
}

/** The computer a client token names: the account it is on, the sign-in the token holds, and the key that computer
 * signed in with, which is the one key an admission it posts may be signed by. */
export interface SignedIn {
  account: string;
  subject: string;
  fingerprint: string | null;
}

/** The person a client token names: a box's own token is refused, a sign-in this account took away opens nothing,
 * and one older than a month has run out. The one reading of a client token, which every route that takes one
 * comes through, so a check cannot be spelled twice and drift. Callers that already read the bearer hand in what
 * they read rather than reading it again. */
export async function clientFor(ctx: Ctx, read?: TokenClaims): Promise<SignedIn> {
  const claims = read ?? (await claimsOf(ctx));
  if (claims.kind !== "client") throw refuse(403, "that is a host's own token; this route is for the token wsp login holds on a person's computer");
  const row = await clientOf(ctx.env, claims.subject);
  if (row === undefined || row.account_id !== claims.account) throw refuse(401, "this computer's sign-in was taken away; run wsp login <url> to sign in again");
  if (claims.issuedAt < signedInSince(ctx.deps.now())) throw refuse(401, "this computer's sign-in has run out; run wsp login <url> to sign in again");
  await seenClient(ctx.env, row.id, new Date(ctx.deps.now()).toISOString());
  return { account: claims.account, subject: claims.subject, fingerprint: row.fingerprint };
}

/** An admission is signed with the bearer's own device key and no other: its signer has one legal value, the key
 * this computer signed in with, so no client token on the account can post bytes under another computer's name and
 * take the place of what that computer signed. */
export function signedByBearer(who: SignedIn, admission: Admission, page: string): Admission {
  if (who.fingerprint === null) throw refuse(400, `this computer signed in with no device key, so it can sign no admission; sign out with wsp logout, or from ${page} in your browser, and sign in again with wsp login`);
  if (admission.by !== who.fingerprint) throw refuse(400, `that admission is signed by ${admission.by}, and this computer signed in as ${who.fingerprint}`);
  return admission;
}

/** The tunnel a box sits behind. With no zone the relay makes nothing at all, and the box runs a quick tunnel instead. */
export async function hostTunnel(ctx: Ctx): Promise<Response> {
  const row = await hostFor(ctx);
  const body = await jsonBody(ctx);
  const asked = body["port"];
  const port = typeof asked === "number" && Number.isInteger(asked) && asked > 0 && asked < 65_536 ? asked : undefined;
  if (port === undefined) throw refuse(400, "a tunnel needs the port on the box this relay's traffic is carried to");
  const zone = zoneOf(ctx.env);
  if (zone === undefined) return Response.json({ tunnelToken: null, hostname: null, why: NO_ZONE_LINE });
  const hostname = managedHostname(row.id, zone);
  let tunnelId = row.tunnel_id;
  if (tunnelId === null) {
    tunnelId = await createTunnel(ctx.env, ctx.deps, `wsp-${row.id}`);
    // Written before anything else may fail: a tunnel no row points at is one nothing can delete through here.
    await setHostTunnel(ctx.env, row.id, tunnelId);
  }
  // The box may serve on another port than it did last time, so what the tunnel carries to is written every time.
  await setIngress(ctx.env, ctx.deps, tunnelId, hostname, port);
  if (row.hostname !== hostname) {
    await createCname(ctx.env, ctx.deps, zone, hostname, tunnelId);
    await setHostHostname(ctx.env, row.id, hostname);
  }
  return Response.json({ tunnelToken: await tunnelToken(ctx.env, ctx.deps, tunnelId), hostname });
}

/** One name, one box, per account: a computer asks for a box by its name, so two of them would be a line that
 * could go to either. Said the same on the page and at the add from a signed-in computer. */
export const boxNamedRefusal = (name: string): Refusal =>
  refuse(409, `you already have a box called ${name}; take it off with wsp host unlink there, or link this one under another name with wsp host link <url> --name <name>`);

/** A box saying it is there, where a quick tunnel put it and which key it proves. The hostname is a line in a
 * listing and nothing else: a managed name is this relay's own to write, so a box may not send one and may not
 * overwrite one. The key is written once, since every computer on the account pins it off the listing: a box
 * that proves another key is another box, and is refused until it is taken off and put back on. The answer is the
 * account's computers with the admissions signed for them, which the box reads to admit and to revoke. */
export async function hostHeartbeat(ctx: Ctx): Promise<Response> {
  const row = await hostFor(ctx);
  const body = await jsonBody(ctx);
  const said = body["hostname"];
  const hostname = typeof said === "string" && said !== "" ? said.toLowerCase() : undefined;
  if (hostname !== undefined && !isQuickTunnel(hostname)) {
    throw refuse(400, "a host may report the quick tunnel it was given and no other name; a managed hostname is the relay's own");
  }
  const hostKey = fingerprintField(body, "hostKey");
  if (hostKey !== undefined && !(await setHostKey(ctx.env, row.id, hostKey))) {
    // The row above was read before the write, so the key a racing beat landed is read again rather than named off it.
    const { host_key: held } = await hostFor(ctx);
    throw refuse(409, `${row.name} is on this account under the key ${held}, and this beat proves ${hostKey}; take it off with wsp host unlink there and put it back on with wsp host link`);
  }
  const version = typeof body["version"] === "string" && body["version"] !== "" ? body["version"] : undefined;
  const zone = zoneOf(ctx.env);
  // A box that has a managed name keeps it: what it reports about itself never replaces what this relay wrote.
  const managed = zone !== undefined && row.hostname === managedHostname(row.id, zone);
  await seenHost(ctx.env, row.id, new Date(ctx.deps.now()).toISOString(), {
    ...(hostname !== undefined && !managed ? { hostname } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  return Response.json({ ok: true, devices: await devicesOf(ctx, row.account_id) });
}

/** What a box reads about the account's computers: each one's key and the admissions signed for it, whole, so the
 * box can verify each signature with the public key it holds for that signer. A computer signed in before device
 * keys holds no fingerprint and no box could admit it, so it is not on this list. */
async function devicesOf(ctx: Ctx, accountId: string): Promise<{ id: string; name: string; fingerprint: string; admissions: { by: string; issuedAt: string; signature: string }[] }[]> {
  const [clients, admissions] = await Promise.all([clientsOf(ctx.env, accountId), admissionsByClient(ctx.env, accountId)]);
  return clients.flatMap(client =>
    client.fingerprint === null
      ? []
      : [
          {
            id: client.id,
            name: client.name,
            fingerprint: client.fingerprint,
            admissions: (admissions.get(client.id) ?? []).map(a => ({ by: a.signer, issuedAt: a.issued_at, signature: a.signature })),
          },
        ],
  );
}

/** One row per box on this person's account, and nobody else's. The key is the one a computer pins before its
 * first dial there, and null until the box has said it. */
export async function hostList(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const rows = await hostsOf(ctx.env, who.account);
  return Response.json({
    hosts: rows.map(row => ({
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      connectorVersion: row.connector_version,
      lastSeen: row.last_seen,
      hostKey: row.host_key,
    })),
  });
}

/** A box put on the account from a computer already signed in, with no code and no page: the computer names the
 * box and the key it proves, and takes the box's token back to it. A client token can already list and delete the
 * account's boxes, and this is the third thing it can do; the page says so before the person signs one in. */
export async function hostAdd(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const body = await jsonBody(ctx);
  const name = nameOf(body);
  if (name === "") throw refuse(400, "a box needs a name to show in the listing");
  const hostKey = fingerprintField(body, "hostKey");
  if (hostKey === undefined) throw refuse(400, "a box is put on the account under the fingerprint of the key it proves; this line sent none");
  if ((await hostNamed(ctx.env, who.account, name)) !== undefined) throw boxNamedRefusal(name);
  const id = newId("h", ctx.deps.random);
  const now = ctx.deps.now();
  await insertHost(ctx.env, { id, account_id: who.account, name, host_key: hostKey, created_at: new Date(now).toISOString() });
  const token = await mintToken(ctx.env.RELAY_SIGNING_KEY, { kind: "host", subject: id, account: who.account, issuedAt: now });
  const account = await accountOf(ctx.env, who.account);
  return Response.json({ hostId: id, name, token, ...(account === undefined ? {} : { login: account.login }) });
}

/** Taking a box off the account: the tunnel and the name under the zone go with it, so nothing is left billing or
 * resolving. The name deleted is the one derived from the host id, never the one the box last reported. */
export async function hostDelete(ctx: Ctx): Promise<Response> {
  const claims = await claimsOf(ctx);
  const id = ctx.params["id"]!;
  const row = await hostOf(ctx.env, id);
  if (row === undefined) throw refuse(404, "this relay holds no host by that name");
  const ownsIt = claims.kind === "client" ? (await clientFor(ctx, claims)).account === row.account_id : claims.subject === id && row.account_id === claims.account;
  if (!ownsIt) throw refuse(403, "that token does not name this host");
  const zone = zoneOf(ctx.env);
  if (row.tunnel_id !== null) {
    if (zone !== undefined) await deleteCname(ctx.env, ctx.deps, zone, managedHostname(row.id, zone));
    await deleteTunnel(ctx.env, ctx.deps, row.tunnel_id);
  }
  await deleteHost(ctx.env, id);
  return Response.json({ deleted: true });
}
