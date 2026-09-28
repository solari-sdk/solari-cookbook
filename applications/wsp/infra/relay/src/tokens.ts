// SPDX-License-Identifier: AGPL-3.0-only
// Everything the relay signs: the token a host or a person's client opens its
// routes with, the cookie the verify page carries a sign-in in, and the stamp
// that takes a link code through GitHub and back. Nothing signed here opens a
// host: a host is opened by a pairing code redeemed against the host itself,
// which the relay never sees.
import { base64url } from "./ids.js";

export type TokenKind = "host" | "client";

export interface TokenClaims {
  kind: TokenKind;
  /** The host id for a host token, the account id for a person's client. */
  subject: string;
  account: string;
  issuedAt: number;
}

/** A signed-in browser stands for seven days; a stamp only has to survive one trip through GitHub. */
export const SESSION_MS = 7 * 24 * 60 * 60_000;
export const STAMP_MS = 15 * 60_000;
/** Both cookies carry the __Host- prefix, which a browser only accepts with Secure, Path=/ and no Domain, and
 * which no other host under the same registrable domain can write. The relay may one day be served beside the
 * boxes it names (relay.example.com next to h....example.com), and without the prefix any of those boxes could
 * set a session cookie for it. */
export const SESSION_COOKIE = "__Host-wsp_relay_session";
/** The one-trip cookie that ties a sign-in to the browser that started it. */
export const NONCE_COOKIE = "__Host-wsp_relay_sign_in";

const encoder = new TextEncoder();

async function keyFor(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(key: string, message: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await keyFor(key), encoder.encode(message))));
}

/** The signature is checked by the runtime's own verify, which compares in constant time. */
async function signed(key: string, message: string, signature: string): Promise<boolean> {
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  try {
    return await crypto.subtle.verify("HMAC", await keyFor(key), bytes, encoder.encode(message));
  } catch {
    return false;
  }
}

const encode = (value: unknown): string => base64url(encoder.encode(JSON.stringify(value)));

function decode(part: string): unknown {
  try {
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
  } catch {
    return undefined;
  }
}

export async function mintToken(key: string, claims: TokenClaims): Promise<string> {
  const payload = encode({ k: claims.kind, s: claims.subject, a: claims.account, t: claims.issuedAt });
  return `${payload}.${await sign(key, payload)}`;
}

export async function readToken(key: string, token: string): Promise<TokenClaims | undefined> {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) return undefined;
  if (!(await signed(key, payload, signature))) return undefined;
  const claims = decode(payload) as { k?: unknown; s?: unknown; a?: unknown; t?: unknown } | undefined;
  if (claims === undefined || (claims.k !== "host" && claims.k !== "client")) return undefined;
  if (typeof claims.s !== "string" || typeof claims.a !== "string" || typeof claims.t !== "number") return undefined;
  return { kind: claims.k, subject: claims.s, account: claims.a, issuedAt: claims.t };
}

export async function mintSession(key: string, account: string, at: number): Promise<string> {
  const payload = encode({ a: account, t: at });
  return `${payload}.${await sign(key, `session:${payload}`)}`;
}

export async function readSession(key: string, session: string | undefined, at: number): Promise<string | undefined> {
  if (session === undefined) return undefined;
  const [payload, signature, extra] = session.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) return undefined;
  if (!(await signed(key, `session:${payload}`, signature))) return undefined;
  const claims = decode(payload) as { a?: unknown; t?: unknown } | undefined;
  if (typeof claims?.a !== "string" || typeof claims.t !== "number" || at - claims.t > SESSION_MS) return undefined;
  return claims.a;
}

/** A short-lived signed value for one purpose: the link code carried through GitHub, and the approve form's own.
 * `bound` ties the stamp to whoever it was made for, the browser's nonce on the way to GitHub and the account on
 * the approval form, so a stamp handed to somebody else is refused in their hands. */
export async function mintStamp(key: string, purpose: string, value: string, at: number, bound?: string): Promise<string> {
  const payload = encode({ v: value, t: at, ...(bound !== undefined ? { b: bound } : {}) });
  return `${payload}.${await sign(key, `${purpose}:${payload}`)}`;
}

export async function readStamp(key: string, purpose: string, stamp: string | undefined, at: number, bound?: string): Promise<string | undefined> {
  if (stamp === undefined) return undefined;
  const [payload, signature, extra] = stamp.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) return undefined;
  if (!(await signed(key, `${purpose}:${payload}`, signature))) return undefined;
  const claims = decode(payload) as { v?: unknown; t?: unknown; b?: unknown } | undefined;
  if (typeof claims?.v !== "string" || typeof claims.t !== "number" || at - claims.t > STAMP_MS) return undefined;
  if ((claims.b ?? undefined) !== bound) return undefined;
  return claims.v;
}

/** One cookie out of a Cookie header, or nothing when it carries none by that name. */
export function cookieOf(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The session cookie as it is set: this host alone, no script, and not sent from another site's form. */
export function sessionCookie(session: string): string {
  return `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
}

/** The nonce cookie, set on the way to GitHub and cleared by the callback that spends it. Path is the whole site
 * because the __Host- prefix takes no other. */
export function nonceCookie(nonce: string, maxAgeSeconds = Math.floor(STAMP_MS / 1000)): string {
  return `${NONCE_COOKIE}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
