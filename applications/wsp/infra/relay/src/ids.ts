// SPDX-License-Identifier: AGPL-3.0-only
// The names and secrets the relay mints. A host id becomes a label under the
// zone, so it is letters and digits and nothing else; a code is read off one
// terminal and typed into a browser, so its alphabet leaves out the symbols
// people confuse.

/** 32 symbols: no I, O, 0 or 1, so a code read aloud or off a screen has one spelling. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type Random = (bytes: number) => Uint8Array;

const hex = (bytes: Uint8Array): string => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A byte masked to five bits picks one symbol of the 32 with no bias. */
export function newCode(random: Random, length = 8): string {
  return [...random(length)].map(b => CODE_ALPHABET[b & 31]!).join("");
}

/** An id that may stand as a DNS label: the kind's letter and hex, never an underscore. */
export function newId(prefix: string, random: Random, bytes = 8): string {
  return `${prefix}${hex(random(bytes))}`;
}

/** A secret the holder proves itself by; only its hash is ever stored. */
export function newSecret(random: Random, bytes = 32): string {
  return base64url(random(bytes));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}
