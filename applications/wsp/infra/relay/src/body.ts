// SPDX-License-Identifier: AGPL-3.0-only
// One reading of a request body for every route: a cap, a refusal a person can
// read, and no route left deciding for itself what a malformed body means.
import type { Ctx } from "./index.js";
import { refuse } from "./refusal.js";

/** Nothing this relay takes is larger than a name and a token; a body past this is refused unread. */
const BODY_MAX = 4096;

const TOO_LARGE = "that request body is larger than anything this route takes";

/** Every body this relay reads, the cap in front of the reading rather than behind it: a length the caller
 * declares past the cap is refused before a byte is asked for, and a body that declares none is refused at the
 * first byte past it, so what this Worker holds in memory is bounded whatever the caller says. */
export async function bodyText(ctx: Ctx): Promise<string> {
  if (Number(ctx.req.headers.get("content-length") ?? "") > BODY_MAX) throw refuse(413, TOO_LARGE);
  const body = ctx.req.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true || value === undefined) break;
    read += value.byteLength;
    if (read > BODY_MAX) {
      await reader.cancel();
      throw refuse(413, TOO_LARGE);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function jsonBody(ctx: Ctx): Promise<Record<string, unknown>> {
  const raw = await bodyText(ctx);
  try {
    const parsed: unknown = JSON.parse(raw === "" ? "{}" : raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw refuse(400, "that request body is not JSON");
  }
}

/** A name shown on the page and in the listings, as every route that takes one reads it: trimmed, capped, and
 * empty where none was sent. */
const NAME_MAX = 64;
export const nameOf = (body: Record<string, unknown>): string => (typeof body["name"] === "string" ? body["name"].trim().slice(0, NAME_MAX) : "");

/** The shape the keys package prints for a key's fingerprint: SHA256: and the hash base64 with its padding dropped,
 * 43 characters. A Worker and a command line share no module, so a change to one of these is a change to both. */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

const NOT_A_FINGERPRINT = "is not a key fingerprint: one reads SHA256: and then 43 characters of base64";

/** A field that names a key by its fingerprint, or nothing where the body carries none: the route says what absent
 * means there. Anything else in it is refused before a row is written. */
export function fingerprintField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !FINGERPRINT.test(value)) throw refuse(400, `${key} ${NOT_A_FINGERPRINT}`);
  return value;
}

/** What a signed-in wsp posts to let a computer onto the account's boxes: the key it admits, the key it signed
 * with, the time and the signature. The relay reads the shape and nothing more, since it holds no key to verify
 * with and every box does; what it stores is what the box gets, byte for byte. */
export interface Admission {
  device: string;
  by: string;
  issuedAt: string;
  signature: string;
}

const ADMISSION_SHAPE = "an admission is the fingerprint admitted, the signer's fingerprint, the time it was signed and the signature, made on a computer already in with wsp login";

const SIGNATURE_MAX = 512;

export function admissionOf(value: unknown): Admission {
  const body = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  if (body === undefined) throw refuse(400, ADMISSION_SHAPE);
  const device = fingerprintField(body, "device");
  const by = fingerprintField(body, "by");
  if (device === undefined || by === undefined) throw refuse(400, ADMISSION_SHAPE);
  const issuedAt = body["issuedAt"];
  if (typeof issuedAt !== "string" || issuedAt.length > 64 || !Number.isFinite(Date.parse(issuedAt))) throw refuse(400, "an admission's issuedAt is the time it was signed, written as a date");
  const signature = body["signature"];
  if (typeof signature !== "string" || signature === "" || signature.length > SIGNATURE_MAX || !/^[A-Za-z0-9+/]+=*$/.test(signature)) {
    throw refuse(400, `an admission's signature is base64 and under ${SIGNATURE_MAX} characters`);
  }
  return { device, by, issuedAt, signature };
}
