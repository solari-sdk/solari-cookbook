// SPDX-License-Identifier: AGPL-3.0-only
// The login ids the collector can emit: the ones in its source, read off it so
// a row added there is seen by the table and matrix tests without a second
// list to keep, and the keys rows the catalog files beside a login.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOGIN_ROWS } from "@wsp/catalog";

export function collectorLogins(): string[] {
  const src = readFileSync(join(import.meta.dirname, "../../collect/src/detect/logins.ts"), "utf8");
  return [...new Set([...[...src.matchAll(/\bid: "(?:logins\/)?([a-z]+)"/g)].map(m => m[1]!), ...LOGIN_ROWS.filter(r => r.keys !== undefined).map(r => r.id)])];
}
