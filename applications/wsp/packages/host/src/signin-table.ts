// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in rows the init terminal runs, read off the catalog by the login
// id the collector emits; a tool the catalog does not know gets a shell where
// the person types the tool's own command.
import { LOGIN_ROWS, hasLogin, mintsToken, type SignIn as CatalogSignIn } from "@wsp/catalog";

export type { LoginSource } from "@wsp/catalog";
export { AWS_STATUS, CLOUDFLARED_STATUS, GEMINI_STATUS, TOKEN_SOURCE, asksThePerson, claudeSource, geminiSource, hasLogin, keyEnvOf, livesOnComputer, loginWords, mintsToken, questionsOf, secretNamed, signsInByDefault } from "@wsp/catalog";

/** A catalog row, or a shell for a tool with no row. */
export type SignIn = CatalogSignIn | { kind: "shell" };

/** Every sign-in row the catalog files, by the login id the collector emits: an entry's own, and the keys row beside a login whose key files travel only by copy. */
export const SIGN_INS: Readonly<Record<string, CatalogSignIn>> = Object.fromEntries(LOGIN_ROWS.map(r => [r.id, r.signIn]));

/** The row for a tool by its name (the last segment of a manifest id). */
export function signInFor(name: string): SignIn {
  return SIGN_INS[name] ?? { kind: "shell" };
}

/** The words a step header shows for the row. */
export function signInWords(s: SignIn): string {
  if (hasLogin(s)) return s.login;
  if (mintsToken(s)) return s.mint;
  return s.kind === "shell" ? "sign in as the tool asks" : (s.note ?? "no sign-in");
}
