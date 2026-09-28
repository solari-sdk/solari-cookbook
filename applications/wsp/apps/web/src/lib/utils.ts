// Adapted from pingdotgg/t3code apps/web/src/lib/utils.ts at 57a66608 (MIT).
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** What a rejection reads as in a note: an Error's message, anything else as text. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
