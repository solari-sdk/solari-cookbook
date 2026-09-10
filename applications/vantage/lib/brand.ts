/** Brand constants shared by metadata, icons, and share cards. */

export const SITE_NAME = "Vantage";
export const SITE_TAGLINE = "Know your competition. Before they know themselves.";
export const SITE_DESCRIPTION =
  "Drop in a competitor URL. An agent browses their site and the public web, then writes a structured teardown — positioning, pricing, tech stack, complaints, momentum, and the gaps you can exploit.";

/**
 * Absolute base for Open Graph and canonical URLs.
 *
 * Social crawlers reject relative image paths, so this has to resolve to a real
 * origin in production. Set `NEXT_PUBLIC_SITE_URL` on the deployment; Vercel's
 * own `VERCEL_URL` is used as a fallback so preview builds still render cards.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** The disc mark, as a data URI so `next/og` can draw it with a plain <img>. */
export const BRAND_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" width="25" height="25"><clipPath id="d"><circle cx="12.5" cy="12.5" r="12.5"/></clipPath><g clip-path="url(#d)"><rect width="25" height="25" fill="#ededed"/><path d="M12.5 0 L20 12.5 L12.5 25 L5 12.5 Z" fill="#050606"/><path d="M12.5 3.5 L17.4 12.5 L12.5 21.5 L7.6 12.5 Z" fill="#737778"/><path d="M12.5 6.5 L15.2 12.5 L12.5 18.5 L9.8 12.5 Z" fill="#fafafa"/><path d="M12.5 9.5 L13.8 12.5 L12.5 15.5 L11.2 12.5 Z" fill="#0a0b0b"/></g></svg>`;

export const BRAND_MARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(
  BRAND_MARK_SVG,
).toString("base64")}`;
