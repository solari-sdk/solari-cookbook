// SPDX-License-Identifier: AGPL-3.0-only
// The computers a person signed in from. A client token lists, deletes and
// adds the boxes on the account, so a copy of one that walked off has to be
// stoppable without rotating the key every box depends on: taking the row
// away is what kills the token, and its admissions go with it. An admission
// is bytes a computer already in signed for another computer's key; the relay
// keeps them for the boxes to verify and holds no key that could make one.
// A computer whose token was lost is signed out from the relay's page instead.
import { admissionOf, bodyText, jsonBody } from "./body.js";
import { admissionsByClient, clientOf, clientsOf, deleteClient, insertAdmission, type ClientRow } from "./db.js";
import { clientFor, signedByBearer } from "./hosts.js";
import { newId } from "./ids.js";
import type { Ctx } from "./index.js";
import { SIGN_OUT_STAMP, VERIFY_PAGE_PATH, carriesBearer, signedIn, toSignIn, verifyPage } from "./link.js";
import { refuse } from "./refusal.js";
import { readStamp } from "./tokens.js";

/** The listing wsp login prints: which computers hold a token for this account, which key each signed in with,
 * and who admitted each to the boxes. The signer is named where the account holds a computer under that key. */
export async function clientList(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const [rows, admissions] = await Promise.all([clientsOf(ctx.env, who.account), admissionsByClient(ctx.env, who.account)]);
  const named = new Map(rows.flatMap(row => (row.fingerprint === null ? [] : [[row.fingerprint, row.name] as const])));
  return Response.json({
    clients: rows.map(row => ({
      id: row.id,
      name: row.name,
      signedInAt: row.created_at,
      lastSeen: row.last_seen,
      thisOne: row.id === who.subject,
      fingerprint: row.fingerprint,
      admissions: (admissions.get(row.id) ?? []).map(a => {
        const byName = named.get(a.signer);
        return { by: a.signer, issuedAt: a.issued_at, ...(byName === undefined ? {} : { byName }) };
      }),
    })),
  });
}

/** The computer a request names, when it is on the bearer's own account. */
async function clientOn(ctx: Ctx, accountId: string): Promise<ClientRow> {
  const row = await clientOf(ctx.env, ctx.params["id"]!);
  if (row === undefined) throw refuse(404, "this relay holds no sign-in by that name");
  if (row.account_id !== accountId) throw refuse(403, "that sign-in is not on this account");
  return row;
}

export async function clientDelete(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const row = await clientOn(ctx, who.account);
  await deleteClient(ctx.env, row.id);
  return Response.json({ deleted: true });
}

/** For a computer whose token is lost: the browser's GitHub session and the page's stamp gate it, never a device key. */
export async function clientSignOut(ctx: Ctx): Promise<Response> {
  if (carriesBearer(ctx.req)) throw refuse(400, "this is the page's sign-out, which takes the browser's sign-in and no token; with a token, wsp logout <id> signs a computer out");
  const who = await signedIn(ctx);
  // The stamp is bound to the account, not the session, so the same form still stands once the sign-in lands.
  if (who === undefined) return toSignIn(ctx);
  const id = ctx.params["id"]!;
  const stamped = await readStamp(ctx.env.RELAY_SIGNING_KEY, SIGN_OUT_STAMP, new URLSearchParams(await bodyText(ctx)).get("stamp") ?? undefined, ctx.deps.now(), who.id);
  if (stamped !== id) throw refuse(403, `that form did not come from this relay's page, or it is older than fifteen minutes; open ${verifyPage(ctx)} again`);
  const row = await clientOn(ctx, who.id);
  await deleteClient(ctx.env, row.id);
  // Back to the page's own address, so a reload reads the list rather than posting a spent stamp.
  return new Response(null, { status: 303, headers: { location: VERIFY_PAGE_PATH } });
}

/** An admission for a computer already on the account, which signed in on the page and was admitted by nobody, or
 * whose earlier admission a box no longer trusts. The relay holds the admission to the key that computer signed in
 * with and keeps the bytes; every box reads them off its next heartbeat and verifies them itself. */
export async function clientAdmit(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const row = await clientOn(ctx, who.account);
  const admission = signedByBearer(who, admissionOf(await jsonBody(ctx)), verifyPage(ctx));
  if (row.fingerprint === null) {
    throw refuse(400, `${row.name} signed in with no device key, so no box can admit it; sign it out with wsp logout ${row.id}, or from ${verifyPage(ctx)} in your browser, and sign it in again with wsp login there`);
  }
  if (admission.device !== row.fingerprint) throw refuse(400, `that admission is for ${admission.device}, and ${row.name} signed in as ${row.fingerprint}`);
  await insertAdmission(ctx.env, {
    id: newId("m", ctx.deps.random),
    account_id: who.account,
    client_id: row.id,
    signer: admission.by,
    issued_at: admission.issuedAt,
    signature: admission.signature,
    created_at: new Date(ctx.deps.now()).toISOString(),
  });
  return Response.json({ recorded: true });
}
