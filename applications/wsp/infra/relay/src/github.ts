// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in the verify page uses, at its boundary. The relay learns one
// thing about a person from GitHub, the account that is theirs, and keeps
// neither the code it exchanged nor the access token it got back.
import type { Env } from "./env.js";
import type { Deps } from "./index.js";
import { refuse } from "./refusal.js";

export interface GithubUser {
  id: string;
  login: string;
}

export const GITHUB_PROVIDER = "github";

/** Where a person is sent to sign in. No scope is asked for: the relay only needs to know who they are. */
export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function githubUser(env: Env, deps: Deps, code: string, redirectUri: string): Promise<GithubUser> {
  const exchange = await deps.fetch(
    new Request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    }),
  );
  const token = (await exchange.json().catch(() => undefined)) as { access_token?: unknown; error_description?: unknown } | undefined;
  if (typeof token?.access_token !== "string") {
    throw refuse(502, `GitHub did not complete the sign-in: ${typeof token?.error_description === "string" ? token.error_description : "no access token came back"}`);
  }
  const who = await deps.fetch(
    new Request("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "wsp-relay" },
    }),
  );
  const user = (await who.json().catch(() => undefined)) as { id?: unknown; login?: unknown } | undefined;
  if (user === undefined || (typeof user.id !== "number" && typeof user.id !== "string") || typeof user.login !== "string") {
    throw refuse(502, "GitHub did not say who signed in");
  }
  return { id: String(user.id), login: user.login };
}
