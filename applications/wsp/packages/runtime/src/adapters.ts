// SPDX-License-Identifier: AGPL-3.0-only
// One adapter factory per agent wsp can drive, keyed by catalog id, for every
// client that embeds the runtime: the app and the dev CLI read this table
// rather than wiring adapters of their own. Adding an agent is its id in
// THREAD_AGENTS and its factory here; the type ties the two together. Each
// adapter gets its agent's words from the catalog: its home on the guest, the
// folder the golden's sign-in wrote into, and the command that signs in on a
// machine; the adapter packages carry no catalog rows of their own.
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { createCodexAdapter } from "@wsp/adapter-codex";
import { CATALOG_AGENTS, keyEnvOf, mintsToken, type ThreadAgent } from "@wsp/catalog";
import type { HarnessAdapterFactory } from "./runtime.js";

/** The sign-in command a person runs on a machine: the row's headless fallback when it has one, else its login. */
const machineLogin = (id: ThreadAgent): string => {
  const signIn = CATALOG_AGENTS.find(a => a.id === id)?.signIn;
  if (signIn === undefined || !("login" in signIn)) throw new Error(`the catalog has no sign-in for ${id}`);
  return signIn.fallback ?? signIn.login;
};

/** What the vault holds for one agent, under the variables that agent's own row declares: its token, else its key,
 * never both. Inside Claude Code an API key outranks the token, so handing both would bill the key on every turn
 * and the token the person minted would never be used. One reader for every agent, so a new one is a row and not
 * a branch here.
 *
 * `loginStands` is whether a login of that agent's own stands where the turn runs. A harness reads a key in its
 * environment ahead of the login on its disk, so a key handed there would bill the key and leave the sign-in the
 * person made unused: the key goes only where no login stands. The variable it would travel under comes back
 * beside it, since the sentence for a key the provider turns down has to name it. */
export function secretsOf(
  vault: Readonly<Record<string, string>>,
  id: ThreadAgent,
  loginStands = false,
): { oauthToken?: string; apiKey?: string; keyEnv?: string } {
  const signIn = CATALOG_AGENTS.find(a => a.id === id)?.signIn;
  if (signIn === undefined) return {};
  const token = mintsToken(signIn) ? vault[signIn.tokenEnv] : undefined;
  if (token !== undefined) return { oauthToken: token };
  const keyEnv = keyEnvOf(signIn);
  if (keyEnv === undefined || loginStands) return {};
  const key = vault[keyEnv];
  return key === undefined ? {} : { apiKey: key, keyEnv };
}

export const HARNESS_ADAPTERS: Readonly<Record<ThreadAgent, HarnessAdapterFactory>> = {
  claude: ctx =>
    createClaudeAdapter({
      exec: ctx.execStream,
      configDir: ctx.home("claude"),
      baseEnv: ctx.env,
      signInRefusal: ctx.signInRefusal,
      ...(ctx.projectKey !== undefined ? { projectDirName: ctx.projectKey } : {}),
      // Claude Code keeps no login where a workspace runs: its sign-in is the token this computer minted, so
      // nothing stands there for the vault to give way to.
      ...secretsOf(ctx.vault, "claude", ctx.loginStands("claude")),
    }),
  codex: ctx =>
    createCodexAdapter({ exec: ctx.execStream, home: ctx.home("codex"), login: machineLogin("codex"), baseEnv: ctx.env, ...secretsOf(ctx.vault, "codex", ctx.loginStands("codex")) }),
};
