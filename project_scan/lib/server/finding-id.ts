import { createHash } from "node:crypto";

/** Stable, unique finding id — avoids URL truncation collisions. */
export function findingId(prefix: string, seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const slug = seed.toLowerCase().replace(/\W+/g, "-").slice(0, 32);
  return `${prefix}-${slug}-${hash}`;
}
