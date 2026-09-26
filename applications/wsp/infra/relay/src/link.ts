// SPDX-License-Identifier: AGPL-3.0-only
// The device code flow, which is how a box and a person's computer are added
// to a relay account. A box asks for a code, a person opens the page and
// approves it as themselves, and the box collects a token of its own once. A
// computer signing in names the key it will prove to the boxes, and is approved
// either on the page, which signs it in and admits it to no box, or from a wsp
// on a computer already in, whose approval carries the admission it signed. The
// code is spent by the approval and the token by the first poll that takes it.
import { admissionOf, bodyText, fingerprintField, jsonBody, nameOf, type Admission } from "./body.js";
import { accountByProvider, accountOf, approveLink, clientKeyed, clientsOf, deleteLink, deleteRunOutClient, hostNamed, insertAccount, insertAdmission, insertClient, insertHost, insertLink, linkByCode, linkByPoll, linksFrom, renameAccount, spendLink, sweepLinks, type LinkRow } from "./db.js";
import { GITHUB_PROVIDER, authorizeUrl, githubUser } from "./github.js";
import { boxNamedRefusal, clientFor, signedByBearer, signedInSince } from "./hosts.js";
import { newCode, newId, newSecret, sha256Hex } from "./ids.js";
import type { Ctx } from "./index.js";
import { approvePage, approvedPage, codePage, gonePage } from "./page.js";
import { refuse, type Refusal } from "./refusal.js";
import { NONCE_COOKIE, SESSION_COOKIE, cookieOf, mintSession, mintStamp, mintToken, nonceCookie, readSession, readStamp, sessionCookie } from "./tokens.js";

/** A code stands a quarter of an hour: long enough to open a browser and sign in, short enough that a code left on a screen is dead. */
export const LINK_MS = 15 * 60_000;
/** How long a waiting box sleeps between polls, which it reads off the start answer rather than deciding for itself. */
export const POLL_AFTER_MS = 3_000;
/** A start takes no token, so what one caller can grow here is bounded twice: the codes of theirs still waiting,
 * and the starts they make in a minute. */
export const LINK_PENDING_PER_SOURCE = 5;
export const LINK_STARTS_PER_MINUTE = 10;
const STARTS_WINDOW_MS = 60_000;

const LINK_KINDS = ["host", "client"] as const;
type LinkKind = (typeof LINK_KINDS)[number];

/** What the sign-in stamp carries: the page the person came from and goes back to, whose address holds no code. */
const VERIFY_PAGE = "verify";

/** The page a person types a code and signs computers out on, spelled once for every sentence and redirect that names it. */
export const VERIFY_PAGE_PATH = "/link/verify";
export const verifyPage = (ctx: Ctx): string => `${ctx.url.origin}${VERIFY_PAGE_PATH}`;

/** Where GitHub sends the person back, which the redirect and the token exchange must spell the same or GitHub refuses it. */
const callbackUrl = (ctx: Ctx): string => `${ctx.url.origin}/link/callback`;

/** Each stamp has its own purpose word, so no approve stamp signs a computer out and no sign-out stamp approves a code. */
const SIGN_IN_STAMP = "sign-in";
const APPROVE_STAMP = "approve";
export const SIGN_OUT_STAMP = "sign-out";

const isExpired = (row: LinkRow, now: number): boolean => Date.parse(row.expires_at) <= now;

/** Who asked, as the connector in front of this Worker names them. A request it named nobody for shares the empty
 * source with every other such request, which holds them to one budget between them rather than to none. */
const sourceOf = (ctx: Ctx): string => ctx.req.headers.get("cf-connecting-ip") ?? "";

/** A box asks for a code. The poll token it gets back is the only thing that can collect the answer, and only its hash is kept. */
export async function linkStart(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx);
  const kind = body["kind"];
  if (typeof kind !== "string" || !LINK_KINDS.includes(kind as LinkKind)) throw refuse(400, `a link is for ${LINK_KINDS.join(" or ")}, not ${JSON.stringify(kind)}`);
  const name = nameOf(body);
  if (name === "") throw refuse(400, "a link needs the name to show the person on the page");
  // A computer signing in names the key it will prove to every box, so the page can show it and an approval can be
  // signed for it; a box names its key on its heartbeat, where its own token stands for it.
  const fingerprint = fingerprintField(body, "fingerprint");
  if (kind === "client" && fingerprint === undefined) throw refuse(400, "a sign-in starts with the fingerprint of this computer's device key, which wsp login sends; this wsp sent none");
  if (kind === "host" && fingerprint !== undefined) throw refuse(400, "a box's link carries no fingerprint: a box names its key on its heartbeat, and a person's computer names its own with wsp login");
  const now = ctx.deps.now();
  // A Worker has no clock of its own, so the one road anybody takes before a code exists is where the dead ones go.
  await sweepLinks(ctx.env, now);
  const source = sourceOf(ctx);
  const since = new Date(now - STARTS_WINDOW_MS).toISOString();
  const pollToken = newSecret(ctx.deps.random);
  const row: LinkRow = {
    code: newCode(ctx.deps.random),
    poll_hash: await sha256Hex(pollToken),
    kind: kind as LinkKind,
    name,
    state: "pending",
    account_id: null,
    host_id: null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + LINK_MS).toISOString(),
    source,
    fingerprint: fingerprint ?? null,
    admission: null,
  };
  // The caps are counted in the statement that writes the row, so starts racing from one address land as many
  // rows as the caps allow and no more; the counts are read again only to say which cap refused this one.
  if (!(await insertLink(ctx.env, row, { pending: LINK_PENDING_PER_SOURCE, recent: LINK_STARTS_PER_MINUTE, since }))) {
    const held = await linksFrom(ctx.env, source, since);
    throw refuse(
      429,
      held.pending >= LINK_PENDING_PER_SOURCE
        ? `there are already ${LINK_PENDING_PER_SOURCE} codes waiting from here; approve one on the page, or wait fifteen minutes for them to run out`
        : "too many links started from here; wait a minute and run the command again",
    );
  }
  return Response.json({
    code: row.code,
    verifyUrl: verifyPage(ctx),
    pollToken,
    expiresAt: row.expires_at,
    pollAfterMs: POLL_AFTER_MS,
  });
}

/** Whoever this browser is signed in as here, or nobody. */
export async function signedIn(ctx: Ctx): Promise<{ id: string; login: string } | undefined> {
  const account = await readSession(ctx.env.RELAY_SIGNING_KEY, cookieOf(ctx.req.headers.get("cookie"), SESSION_COOKIE), ctx.deps.now());
  return account === undefined ? undefined : await accountOf(ctx.env, account);
}

/** To GitHub, and back to this page afterwards. The state is bound to this browser: a callback URL handed to
 * somebody else carries a nonce their browser never got, so it cannot sign them in as whoever started the
 * sign-in. It carries no code, because the page it returns to asks the person for one. */
export async function toSignIn(ctx: Ctx): Promise<Response> {
  const nonce = newSecret(ctx.deps.random);
  const state = await mintStamp(ctx.env.RELAY_SIGNING_KEY, SIGN_IN_STAMP, VERIFY_PAGE, ctx.deps.now(), await sha256Hex(nonce));
  const sent = Response.redirect(authorizeUrl(ctx.env, callbackUrl(ctx), state), 302);
  return new Response(sent.body, { status: 302, headers: { location: sent.headers.get("location") ?? "/", "set-cookie": nonceCookie(nonce) } });
}

/** The page the person opens, which carries nothing of the link in its address: with nobody signed in it goes to
 * GitHub first, and otherwise it asks for the code the command line printed. A link forwarded to somebody else
 * opens this same page and approves nothing until that person types a code they were given. */
export async function linkVerify(ctx: Ctx): Promise<Response> {
  const who = await signedIn(ctx);
  return who === undefined ? toSignIn(ctx) : accountPage(ctx, who);
}

/** Each sign-out is stamped for its own id and this account, so a form handed on or pointed elsewhere signs nothing out. */
async function accountPage(ctx: Ctx, who: { id: string; login: string }): Promise<Response> {
  const now = ctx.deps.now();
  const rows = await clientsOf(ctx.env, who.id);
  const computers = await Promise.all(rows.map(async row => ({ ...row, stamp: await mintStamp(ctx.env.RELAY_SIGNING_KEY, SIGN_OUT_STAMP, row.id, now, who.id) })));
  return codePage(who.login, computers);
}

/** The code the person typed on that page. The approve form it renders is stamped for this account, so the
 * approval below takes it from this browser and from nobody it was handed to. */
export async function linkTyped(ctx: Ctx): Promise<Response> {
  const who = await signedIn(ctx);
  if (who === undefined) return toSignIn(ctx);
  const code = (new URLSearchParams(await bodyText(ctx)).get("code") ?? "").trim().toUpperCase();
  const row = await linkByCode(ctx.env, code);
  if (row === undefined || isExpired(row, ctx.deps.now()) || row.state !== "pending") return gonePage();
  const stamp = await mintStamp(ctx.env.RELAY_SIGNING_KEY, APPROVE_STAMP, code, ctx.deps.now(), who.id);
  return approvePage(row.name, who.login, code, stamp, row.kind, row.fingerprint);
}

/** GitHub sends the person back here. The state is one this relay signed, so a callback nobody started goes nowhere. */
export async function linkCallback(ctx: Ctx): Promise<Response> {
  const oauthCode = ctx.url.searchParams.get("code") ?? "";
  const state = ctx.url.searchParams.get("state") ?? undefined;
  const nonce = cookieOf(ctx.req.headers.get("cookie"), NONCE_COOKIE);
  const started = nonce === undefined ? undefined : await readStamp(ctx.env.RELAY_SIGNING_KEY, SIGN_IN_STAMP, state, ctx.deps.now(), await sha256Hex(nonce));
  if (started === undefined || oauthCode === "") throw refuse(400, "that sign-in did not start in this browser; open the page the command line printed again");
  const user = await githubUser(ctx.env, ctx.deps, oauthCode, callbackUrl(ctx));
  const now = ctx.deps.now();
  let account = await accountByProvider(ctx.env, GITHUB_PROVIDER, user.id);
  if (account === undefined) {
    account = { id: newId("a", ctx.deps.random), provider: GITHUB_PROVIDER, provider_id: user.id, login: user.login, created_at: new Date(now).toISOString() };
    await insertAccount(ctx.env, account);
  } else if (account.login !== user.login) {
    // A person may rename themselves on GitHub; the account is the same one, and the page has to say who they are now.
    await renameAccount(ctx.env, account.id, user.login);
    account = { ...account, login: user.login };
  }
  const session = await mintSession(ctx.env.RELAY_SIGNING_KEY, account.id, now);
  const headers = new Headers({ location: VERIFY_PAGE_PATH });
  headers.append("set-cookie", sessionCookie(session));
  // The nonce did its one job; it goes with the redirect that spends it.
  headers.append("set-cookie", nonceCookie("", 0));
  return new Response(null, { status: 302, headers });
}

/** The moment a client row has to be signed in from to hold its key: the same bound clientFor holds a token to,
 * as an ISO string beside created_at. */
const standingSince = (ctx: Ctx): string => new Date(signedInSince(ctx.deps.now())).toISOString();

/** A key is one computer's on an account, as a name is one box's: the refusal for a client code started under a
 * key a computer on the account signed in with and still stands under, naming that computer and the sign-out that
 * frees the key, and nothing where the key is free or held only by a sign-in that ran out. Both approval roads
 * read it, and the poll reads it where two codes approved under one key met the index. */
async function keyHeldRefusal(ctx: Ctx, accountId: string, fingerprint: string | null): Promise<Refusal | undefined> {
  const held = await clientKeyed(ctx.env, accountId, fingerprint, standingSince(ctx));
  return held === undefined
    ? undefined
    : refuse(409, `${held.name} is already signed in under that key; sign it out first with wsp logout ${held.id}, or from ${verifyPage(ctx)} in your browser, then run wsp login again`);
}

/** No form on the page carries a bearer, so a request with one is a program's and reads JSON on a page's road too. */
export const carriesBearer = (req: Request): boolean => req.headers.has("authorization");

/** The person says yes, on the page or from a wsp already in. The code is spent here, once, whichever gets there
 * first. */
export async function linkApprove(ctx: Ctx): Promise<Response> {
  if (carriesBearer(ctx.req)) return approveFromWsp(ctx);
  const form = new URLSearchParams(await bodyText(ctx));
  const who = await signedIn(ctx);
  if (who === undefined) throw refuse(401, "sign in first: open the page the command line printed");
  const code = form.get("code") ?? "";
  const stamped = await readStamp(ctx.env.RELAY_SIGNING_KEY, APPROVE_STAMP, form.get("stamp") ?? undefined, ctx.deps.now(), who.id);
  // The stamp names the code the page was rendered for, so a form posted from anywhere else approves nothing.
  if (stamped === undefined || stamped !== code) throw refuse(403, "that form did not come from this relay's page; open the page the command line printed again");
  const row = await linkByCode(ctx.env, code);
  if (row === undefined || isExpired(row, ctx.deps.now())) throw refuse(410, "that code is gone; run the command again for a fresh one");
  if (row.state !== "pending") throw refuse(409, "that code was already approved");
  // One name, one box, per account: a client asks for a box by the name on this page, so two of them would be a
  // line that could go to either.
  if (row.kind === "host" && (await hostNamed(ctx.env, who.id, row.name)) !== undefined) throw boxNamedRefusal(row.name);
  const held = row.kind === "client" ? await keyHeldRefusal(ctx, who.id, row.fingerprint) : undefined;
  if (held !== undefined) throw held;
  const hostId = row.kind === "host" ? newId("h", ctx.deps.random) : null;
  if (!(await approveLink(ctx.env, code, who.id, hostId))) throw refuse(409, "that code was already approved");
  if (hostId !== null) await insertHost(ctx.env, { id: hostId, account_id: who.id, name: row.name, created_at: new Date(ctx.deps.now()).toISOString() });
  return approvedPage(row.name, row.kind);
}

/** A wsp on a computer already in says yes for a computer waiting on a code: its own client token names the
 * account the code lands on, and the admission it signed for that computer's key rides the row to the poll. The
 * relay checks that the admission is for the key the code was started with and signed by the key the bearer signed
 * in with, and keeps the bytes; whether the signer is one a box trusts is the box's own reading, made with a key
 * the relay never holds. */
async function approveFromWsp(ctx: Ctx): Promise<Response> {
  const who = await clientFor(ctx);
  const body = await jsonBody(ctx);
  const code = typeof body["code"] === "string" ? body["code"].trim().toUpperCase() : "";
  const admission = signedByBearer(who, admissionOf(body["admission"]), verifyPage(ctx));
  const row = await linkByCode(ctx.env, code);
  if (row === undefined || isExpired(row, ctx.deps.now())) throw refuse(410, "that code is gone; run wsp login again there for a fresh one");
  if (row.state !== "pending") throw refuse(409, "that code was already approved");
  if (row.kind !== "client") throw refuse(400, "that code is a box's, and a box is approved on the page or put on the account with wsp host link from a signed-in computer; an admission is for a computer signing in");
  if (admission.device !== row.fingerprint) throw refuse(400, `that admission is for ${admission.device}, and the code was started by ${row.fingerprint ?? "a wsp that named no key"}`);
  const held = await keyHeldRefusal(ctx, who.account, row.fingerprint);
  if (held !== undefined) throw held;
  if (!(await approveLink(ctx.env, code, who.account, null, JSON.stringify(admission)))) throw refuse(409, "that code was already approved");
  return Response.json({ approved: true, name: row.name });
}

/** The box collects the answer. A token is handed over once and the row goes with it. */
export async function linkPoll(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx);
  const pollToken = body["pollToken"];
  if (typeof pollToken !== "string" || pollToken === "") throw refuse(400, "a poll needs the token the link started with");
  const row = await linkByPoll(ctx.env, await sha256Hex(pollToken));
  if (row === undefined) throw refuse(404, "this relay is waiting on no link with that token; run the link again");
  // A code runs out whether or not anybody approved it: an answer nobody collected in a quarter of an hour is one
  // the box that asked for it is no longer waiting on.
  if (isExpired(row, ctx.deps.now())) {
    await sweepLinks(ctx.env, ctx.deps.now());
    return Response.json({ state: "expired" });
  }
  if (row.state === "pending") return Response.json({ state: "pending" });
  // The row is spent before anything is minted, so two polls racing on one code make one token between them and
  // one client row, not two of each.
  if (!(await spendLink(ctx.env, row.code))) throw refuse(404, "this relay is waiting on no link with that token; run the link again");
  // One reading of the clock for the row and the token, so the row's created_at is the token's issuedAt.
  const now = ctx.deps.now();
  let subject = row.host_id;
  if (row.kind === "client") {
    subject = newId("c", ctx.deps.random);
    const at = new Date(now).toISOString();
    // A computer signing in again after its month meets its own dead row at the index unless that row goes first.
    await deleteRunOutClient(ctx.env, row.account_id!, row.fingerprint, standingSince(ctx));
    if (!(await insertClient(ctx.env, { id: subject, account_id: row.account_id!, name: row.name, fingerprint: row.fingerprint, created_at: at }))) {
      // Two codes approved under one key: the first poll took the key, and this one names the computer that holds it.
      throw (await keyHeldRefusal(ctx, row.account_id!, row.fingerprint)) ?? refuse(409, "the computer that held that key was signed out while this code waited; run wsp login again");
    }
    // The admission waited on the code for the id this row has now; the poll is where it becomes the computer's.
    if (row.admission !== null) {
      const admission = JSON.parse(row.admission) as Admission;
      await insertAdmission(ctx.env, { id: newId("m", ctx.deps.random), account_id: row.account_id!, client_id: subject, signer: admission.by, issued_at: admission.issuedAt, signature: admission.signature, created_at: at });
    }
  }
  const token = await mintToken(ctx.env.RELAY_SIGNING_KEY, { kind: row.kind, subject: subject!, account: row.account_id!, issuedAt: now });
  // Who approved it, so the box can say whose account it is on without holding a token that reads this relay back.
  const account = await accountOf(ctx.env, row.account_id!);
  return Response.json({
    state: "approved",
    token,
    name: row.name,
    ...(account === undefined ? {} : { login: account.login }),
    ...(row.host_id !== null ? { hostId: row.host_id } : {}),
  });
}
