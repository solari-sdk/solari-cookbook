// SPDX-License-Identifier: AGPL-3.0-only
// The per-CLI table: every login the collector can emit has a row, the flags
// are the measured ones, and each status check reads fixture output the way
// the tool prints it (fake names, masked tokens; nothing real).
import { describe, expect, it } from "vitest";
import { SignInFinish } from "@wsp/protocol";
import { AWS_STATUS, CLOUDFLARED_STATUS, GEMINI_STATUS, SIGN_INS, TOKEN_SOURCE, claudeSource, geminiSource, hasLogin, asksThePerson, livesOnComputer, loginWords, mintsToken, questionsOf, secretNamed, signInFor, signInWords, signsInByDefault, type SignIn } from "../src/signin-table.js";
import { collectorLogins } from "./collector-logins.js";
import { ASKED, REACHED } from "./signin-questions.js";

/** The catalog's status check on a row, whichever kind it is. */
const statusOf = (s: SignIn) => (s.kind === "shell" ? undefined : s.status);

function command(name: string): Extract<SignIn, { login: string }> {
  const s = signInFor(name);
  if (!hasLogin(s)) throw new Error(`${name} is not a login row`);
  return s;
}

const check = (name: string, output: string, exitCode: number): boolean => {
  const status = statusOf(signInFor(name));
  if (status === undefined) throw new Error(`${name} has no status command`);
  return status.signedIn(output, exitCode);
};

describe("sign-in table", () => {
  it("covers every login the collector emits, and none of them falls through to a bare shell", () => {
    const ids = collectorLogins();
    expect(ids).toEqual(expect.arrayContaining(["gh", "claude", "gcloud", "wrangler", "cloudflared", "vercel", "aws", "kube", "codex", "gemini", "opencode", "pi", "hermes", "hermes-keys", "op"]));
    for (const id of ids) expect(signInFor(id).kind, id).not.toBe("shell");
    expect(signInFor("some-new-tool")).toEqual({ kind: "shell" });
  });

  it("carries the corrected flags: device code or paste code where the callback flow cannot land, none where the tool has only one flow", () => {
    expect(command("gh").fallback).toBeUndefined();
    // gcloud, gemini and railway already take their paste or device flow under the daemon pty (DISPLAY unset), so no second variant.
    for (const name of ["gcloud", "gemini", "railway"]) expect(command(name).fallback, name).toBeUndefined();
    expect(command("aws").login).toBe("aws configure sso");
    expect(command("aws").fallback).toBe("aws configure sso --use-device-code");
    expect(command("aws").note).toMatch(/every configured profile/);
    // The profile aws configure sso writes is named {role}-{account}, so the check walks every profile in a subshell (its exits stay inside).
    expect(command("aws").status?.command).toBe(AWS_STATUS);
    expect(AWS_STATUS).toMatch(/^sh -c '.*aws configure list-profiles.*--profile "\$p".*exit 1'$/);
    expect(AWS_STATUS.replace(/^sh -c '|'$/g, "")).not.toMatch(/'/);
    // wrangler's --browser=false still binds the callback port, so it is no way around the callback.
    expect(command("wrangler").fallback).toBeUndefined();
    expect(command("wrangler").note).toMatch(/CLOUDFLARE_API_TOKEN/);
    expect(command("vercel").fallback).toBeUndefined();
    expect(command("codex").fallback).toBe("codex login --device-auth");
    expect(command("supabase").fallback).toBe("supabase login --no-browser");
    // Claude Code has no sign-in command on a machine at all: its row mints a token on this computer.
    const claude = signInFor("claude");
    expect(mintsToken(claude) && claude.mint).toBe("claude setup-token");
    expect(hasLogin(claude)).toBe(false);
    expect(signInWords(claude)).toBe("claude setup-token");
    expect(command("opencode").note).toMatch(/1\.3\.0/);
    // pi signs in only through /login inside its TUI and hermes through its auth menu; both run in the machine's pty.
    expect(command("pi").login).toBe("pi");
    expect(command("pi").note).toMatch(/\/login/);
    expect(command("hermes").login).toBe("hermes auth");
    expect(command("hermes").fallback).toBeUndefined();
  });

  it("settles every question each tool is known to ask: a flag in the login command, a line the relay types, or the person's own choice", () => {
    // Which of the three settles a question is the type's to hold; what the table has to get right is that a flag
    // it names is really in the command, and that no shape is global.
    for (const [name, s] of Object.entries(SIGN_INS)) {
      if (!hasLogin(s)) {
        // A row with no login command is either a tool with no sign-in or one whose token is minted here; neither
        // ever runs in a pty, so neither declares a question.
        expect(["none", "token"], name).toContain(s.kind);
        expect(questionsOf(s), name).toEqual([]);
        continue;
      }
      for (const q of questionsOf(s)) {
        // A global shape carries lastIndex from one chunk to the next, so a question printed twice would be missed.
        expect(q.asks.global, `${name}: ${q.asks.source}`).toBe(false);
        if ("flag" in q) expect(s.login.split(" "), `${name}: ${q.asks.source}`).toContain(q.flag);
      }
    }
  });

  it("runs gh without questions: the four flags answer its pickers and the relay presses the Enter it waits on", () => {
    expect(command("gh").login).toBe("gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key");
    const asked = (line: string): string | undefined => {
      const q = questionsOf(signInFor("gh")).find(x => x.asks.test(line));
      return q === undefined ? undefined : "flag" in q ? q.flag : "answer" in q ? q.answer : "yours";
    };
    expect(asked(ASKED.ghBare)).toBe("--hostname");
    expect(asked(ASKED.ghProtocol)).toBe("--git-protocol");
    expect(asked(ASKED.ghHow)).toBe("--web");
    expect(asked(ASKED.ghSshKey)).toBe("--skip-ssh-key");
    expect(asked(ASKED.ghWeb)).toBe("\r");
    expect(asked(ASKED.ghCredentials)).toBe("\r");
    // The line the flags leave standing is the only one the relay answers before the person is through.
    expect(questionsOf(signInFor("gh")).filter(q => "answer" in q && q.asks.test(ASKED.ghWeb))).toHaveLength(1);
    expect(asksThePerson(signInFor("gh"))).toBe(false);
  });

  it("runs supabase, doppler and gemini without questions, by a flag or by the relay's own Enter", () => {
    const answers = (name: string, line: string) => questionsOf(signInFor(name)).flatMap(q => ("answer" in q && q.asks.test(line) ? [q.answer] : []));
    expect(answers("supabase", ASKED.supabase)).toEqual(["\r"]);
    expect(command("doppler").login).toBe("doppler login --yes");
    expect(questionsOf(signInFor("doppler")).map(q => [q.asks.test(ASKED.dopplerBare), "flag" in q ? q.flag : undefined])).toEqual([[true, "--yes"]]);
    // The code is read off the line under its label, so another underscored word in the same output is not taken for it.
    expect(command("doppler").code?.exec(ASKED.dopplerYes)?.[0]).toBe("arugula_backpack_termite_sea_lannister");
    expect(command("doppler").code?.test("waiting for a device_code_grant\n")).toBe(false);
    expect(command("gemini").login).toBe("gemini --skip-trust");
    expect(questionsOf(signInFor("gemini")).map(q => [q.asks.test(ASKED.geminiTrust), "flag" in q ? q.flag : undefined])).toEqual([[true, "--skip-trust"], [false, undefined]]);
    expect(answers("gemini", ASKED.geminiAuth)).toEqual(["\r"]);
  });

  it("leaves the rows whose next answer is the person's own to the machine's terminal, and declares no question for the rows that reach their page on their own", () => {
    const theirs = Object.entries(SIGN_INS).filter(([, s]) => asksThePerson(s)).map(([k]) => k);
    expect(theirs.sort()).toEqual(["aws", "hermes", "opencode", "pi"]);
    expect(command("aws").questions?.[0]?.asks.test(ASKED.awsSso)).toBe(true);
    expect(command("opencode").questions?.[0]?.asks.test(ASKED.opencode)).toBe(true);
    expect(command("pi").questions?.[0]?.asks.test(ASKED.pi)).toBe(true);
    expect(command("hermes").questions?.[0]?.asks.test(ASKED.hermes)).toBe(true);
    // Each of these printed a page and then waited on the browser, so there is nothing for the relay to answer.
    for (const name of ["gcloud", "wrangler", "vercel", "netlify", "fly", "railway", "codex", "cloudflared"]) {
      expect(command(name).questions, name).toBeUndefined();
      expect(questionsOf(signInFor(name)), name).toEqual([]);
      expect(asksThePerson(signInFor(name)), name).toBe(false);
    }
    expect(questionsOf({ kind: "shell" })).toEqual([]);
    expect(asksThePerson({ kind: "shell" })).toBe(false);
    expect(questionsOf(signInFor("kube"))).toEqual([]);
    // No shape is loose enough to read one of those pages as a question, which would type into a tool that is waiting
    // on the browser instead.
    for (const [tool, printed] of Object.entries(REACHED)) {
      for (const [name, s] of Object.entries(SIGN_INS)) {
        for (const q of questionsOf(s)) expect(q.asks.test(printed), `${name}: ${q.asks.source} on ${tool}`).toBe(false);
      }
    }
  });

  it("has a status command for each tool that offers one, and says so for the rest", () => {
    const withStatus = Object.entries(SIGN_INS).filter(([, s]) => statusOf(s) !== undefined).map(([k]) => k);
    expect(withStatus.sort()).toEqual(["aws", "claude", "cloudflared", "codex", "doppler", "fly", "gcloud", "gemini", "gh", "hermes", "hermes-keys", "kube", "netlify", "opencode", "pi", "railway", "supabase", "vercel", "wrangler"]);
    // cloudflared has no status command; its login writes the origin certificate, so the check proves that file.
    expect(command("cloudflared").status?.command).toBe(CLOUDFLARED_STATUS);
    expect(CLOUDFLARED_STATUS).toBe(`if test -s "$HOME/.cloudflared/cert.pem"; then echo cert.pem; else false; fi`);
    for (const name of ["op", "kube"]) expect(signInFor(name).kind, name).toBe("none");
    // kubectl has no sign-in, so its row stays a "none" row whose status still proves a copied kubeconfig. What runs drops
    // stderr (v1.36.1 prints a kuberc warning there with no newline, so on the merged pty it glues onto the context name);
    // what the row shows is the command alone.
    expect(statusOf(signInFor("kube"))?.command).toBe("kubectl config current-context");
    expect(statusOf(signInFor("kube"))?.typed).toBe("kubectl config current-context 2>/dev/null");
    // Claude Code's status is its own command and nothing around it: there is no key file beside it any more.
    expect(statusOf(signInFor("claude"))?.command).toBe("claude auth status");
    for (const [name, s] of Object.entries(SIGN_INS)) if (name !== "kube") expect(statusOf(s)?.typed, name).toBeUndefined();
    expect(statusOf(signInFor("op"))).toBeUndefined();
    expect(statusOf({ kind: "shell" })).toBeUndefined();
    expect(statusOf(signInFor("gh"))).toBe(command("gh").status);
    expect(command("opencode").status?.command).toBe("opencode auth list");
    expect(command("pi").status?.command).toBe("pi --list-models");
    expect(command("hermes").status?.command).toBe("hermes auth list");
    // Gemini CLI has no status command of its own, so the check is a shell line over the login file and the two key names its docs name.
    expect(command("gemini").status?.command).toBe(GEMINI_STATUS);
    expect(GEMINI_STATUS).toMatch(/^if test -s "\$HOME\/.gemini\/oauth_creds.json"; then echo oauth_creds.json; elif test -n "\$GEMINI_API_KEY"; then echo GEMINI_API_KEY; elif test -n "\$GOOGLE_API_KEY"; then echo GOOGLE_API_KEY; else false; fi$/);
    expect(GEMINI_STATUS).not.toMatch(/exit/);
  });

  it("reads gh auth status: every account listed must be logged in, so a stale one beside a good one fails, as does the no-hosts answer", () => {
    const twoAccounts = [
      "github.com",
      "  ✓ Logged in to github.com account someone (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: ssh",
      "  - Token: gho_************************************",
      "",
      "  X Failed to log in to github.com account other (default)",
      "  - The token in default is invalid.",
    ].join("\n");
    expect(check("gh", twoAccounts, 1)).toBe(false);
    expect(check("gh", twoAccounts.replace(/  X Failed to log in to github.com account other \(default\)\n  - The token in default is invalid\./, "  ✓ Logged in to github.com account other (default)\n  - Active account: false"), 0)).toBe(true);
    expect(check("gh", "You are not logged into any GitHub hosts. To log in, run: gh auth login", 1)).toBe(false);
    expect(check("gh", "  X Failed to log in to github.com account other (default)\n  - The token in default is invalid.", 1)).toBe(false);
  });

  it("reads the other status commands from their printed shapes", () => {
    expect(check("gcloud", "someone@example.com", 0)).toBe(true);
    expect(check("gcloud", "", 0)).toBe(false);
    expect(check("gcloud", "No credentialed accounts.", 0)).toBe(false);
    expect(check("aws", '{\n    "UserId": "AIDAFAKE",\n    "Account": "123456789012",\n    "Arn": "arn:aws:iam::123456789012:user/someone"\n}', 0)).toBe(true);
    expect(check("aws", "Error loading SSO Token: Token for https://example.awsapps.com/start does not exist", 255)).toBe(false);
    expect(check("wrangler", "Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email someone@example.com.", 0)).toBe(true);
    expect(check("wrangler", "You are not authenticated. Please run `wrangler login`.", 0)).toBe(false);
    // wrangler 4.106.0 (src/user/whoami.ts) exits 0 either way and words an API token login differently.
    expect(check("wrangler", "Getting User settings...\n👋 You are logged in with an API Token. Unset the CLOUDFLARE_API_TOKEN in the environment to log in via OAuth.", 0)).toBe(true);
    expect(check("wrangler", "Getting User settings...\nYou are not authenticated. Please run `wrangler login`.\nTo deploy without logging in, run a command like `wrangler deploy --temporary` to use a temporary preview account.", 0)).toBe(false);
    expect(check("vercel", "someone", 0)).toBe(true);
    expect(check("vercel", "Error: No existing credentials found. Please run `vercel login` or pass \"--token\"", 1)).toBe(false);
    expect(check("netlify", "──────────────────────┐\n Current Netlify User │\n──────────────────────┘\nEmail: someone@example.com", 0)).toBe(true);
    expect(check("netlify", "Not logged in. Please log in to see site status.", 1)).toBe(false);
    expect(check("fly", "someone@example.com", 0)).toBe(true);
    expect(check("fly", "Error: No access token available. Please login with 'flyctl auth login'", 1)).toBe(false);
    expect(check("supabase", "LINKED | ORG ID | REFERENCE ID | NAME", 0)).toBe(true);
    expect(check("supabase", "Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.", 1)).toBe(false);
    expect(check("railway", "Logged in as someone (someone@example.com) 👋", 0)).toBe(true);
    expect(check("railway", "Unauthorized. Please login with `railway login`", 1)).toBe(false);
    expect(check("doppler", "NAME      EMAIL\nsomeone   someone@example.com", 0)).toBe(true);
    expect(check("doppler", "Doppler Error: you must provide a token", 1)).toBe(false);
    expect(check("claude", '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty"\n}', 0)).toBe(true);
    expect(check("claude", '{\n  "loggedIn": false\n}', 1)).toBe(false);
    // The token is what signs it in on a workspace, and the status names that road.
    expect(check("claude", '{\n  "loggedIn": true,\n  "authMethod": "oauth_token"\n}', 0)).toBe(true);
    expect(check("codex", "Logged in using ChatGPT", 0)).toBe(true);
    expect(check("codex", "Not logged in", 1)).toBe(false);
  });

  it("reads kubectl, pi, hermes, opencode and the gemini shell check from their printed shapes", () => {
    // kubectl v1.36.1 on this Mac: the context name on exit 0, nothing (its error went to stderr) on exit 1.
    expect(check("kube", "connectgateway_someorg-default_us-central1_someorg-default-cluster-internal", 0)).toBe(true);
    expect(check("kube", "", 1)).toBe(false);
    expect(check("kube", "", 0)).toBe(false);
    expect(statusOf(signInFor("kube"))?.detail?.("minikube\n", new Map())).toBe("context minikube");
    // pi 0.84.1 on this Mac: a model table when some provider has credentials, a /login hint on exit 0 when none has.
    const models = ["provider   model                       context  max-out  thinking  images", "anthropic  claude-haiku-4-5            200K     64K      yes       yes   "].join("\n");
    expect(check("pi", models, 0)).toBe(true);
    expect(check("pi", "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md", 0)).toBe(false);
    expect(check("pi", models, 1)).toBe(false);
    // Hermes Agent v0.20.0 on this Mac: one block per provider with credentials, nothing at all when none has (exit 0 both).
    const pool = ["anthropic (1 credentials):", "  #1  ANTHROPIC_API_KEY    api_key env:ANTHROPIC_API_KEY ←", "", "nous (1 credentials):", "  #1  device_code          oauth   device_code ←", ""].join("\n");
    expect(check("hermes", pool, 0)).toBe(true);
    expect(check("hermes", "", 0)).toBe(false);
    expect(check("hermes", "Traceback (most recent call last):\n  ModuleNotFoundError: No module named 'yaml'", 1)).toBe(false);
    // opencode 1.18.18 on this Mac: a credentials count, then an environment count only when a provider key is exported (exit 0 both).
    const none = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
    expect(check("opencode", none, 0)).toBe(false);
    expect(check("opencode", "┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  Anthropic api\n│\n└  1 credentials\n", 0)).toBe(true);
    expect(check("opencode", `${none}\n┌  Environment\n│\n●  Anthropic ANTHROPIC_API_KEY\n│\n└  1 environment variable\n`, 0)).toBe(true);
    expect(check("opencode", `${none}\n┌  Environment\n│\n●  Anthropic ANTHROPIC_API_KEY\n│\n●  OpenAI OPENAI_API_KEY\n│\n└  2 environment variables\n`, 0)).toBe(true);
    expect(check("opencode", "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  10 credentials\n", 0)).toBe(true);
    // The gemini shell line prints what it found and fails when nothing is there.
    expect(check("gemini", "oauth_creds.json", 0)).toBe(true);
    expect(check("gemini", "GEMINI_API_KEY", 0)).toBe(true);
    expect(check("gemini", "", 1)).toBe(false);
    expect(check("cloudflared", "cert.pem", 0)).toBe(true);
    expect(check("cloudflared", "", 1)).toBe(false);
  });

  it("names the key the secrets step set when a status lists it, and what the gemini check found", () => {
    const secrets = new Map([["ANTHROPIC_API_KEY", "~/.zshrc"], ["OPENAI_API_KEY", "~/.env"]]);
    expect(secretNamed("  #1  ANTHROPIC_API_KEY    api_key env:ANTHROPIC_API_KEY ←", secrets)).toBe("API key from ~/.zshrc, set on the machine as a secret");
    expect(secretNamed("●  OpenAI OPENAI_API_KEY", secrets)).toBe("API key from ~/.env, set on the machine as a secret");
    expect(secretNamed("●  Anthropic api\n└  1 credentials", secrets)).toBeUndefined();
    expect(secretNamed("OPENAI_API_KEY_OLD", secrets)).toBeUndefined();
    expect(secretNamed("anything", new Map())).toBeUndefined();
    expect(command("opencode").status?.detail).toBe(secretNamed);
    expect(command("hermes").status?.detail).toBe(secretNamed);
    expect(geminiSource("oauth_creds.json", secrets)).toBe("OAuth credentials");
    expect(geminiSource("GEMINI_API_KEY", new Map([["GEMINI_API_KEY", "~/.zshrc"]]))).toBe("API key from ~/.zshrc, set on the machine as a secret");
    expect(geminiSource("GOOGLE_API_KEY\n", new Map())).toBe("API key from GOOGLE_API_KEY on the machine");
    expect(geminiSource("", new Map())).toBeUndefined();
    expect(command("gemini").status?.detail).toBe(geminiSource);
  });

  it("reads which source claude auth status names: the exported key by the file it was cut from, the token from this computer, or the OAuth credentials", () => {
    const envKey = '{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiProvider": "firstParty",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}';
    const secrets = new Map([["ANTHROPIC_API_KEY", "~/.zshrc"]]);
    expect(claudeSource(envKey, secrets)).toBe("API key from ~/.zshrc, set on the machine as a secret");
    expect(claudeSource(envKey, new Map())).toBe("API key from ANTHROPIC_API_KEY on the machine");
    // The token is its own source, which is what a workspace runs on.
    expect(claudeSource('{\n  "loggedIn": true,\n  "authMethod": "oauth_token"\n}', secrets)).toBe(TOKEN_SOURCE);
    expect(TOKEN_SOURCE).toBe("the token from this computer");
    expect(statusOf(signInFor("claude"))?.why).toBeUndefined();
    expect(command("gh").status?.why).toBeUndefined();
    expect(claudeSource('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}', secrets)).toBe("OAuth credentials");
    expect(claudeSource('{\n  "loggedIn": false,\n  "authMethod": "none"\n}', secrets)).toBeUndefined();
    expect(claudeSource("not json at all", secrets)).toBeUndefined();
    expect(statusOf(signInFor("claude"))?.detail).toBe(claudeSource);
    expect(command("gh").status?.detail).toBeUndefined();
  });

  it("names the flow each login takes: a browser callback, a code typed on a page, or a key", () => {
    expect(command("gh").kind).toBe("device");
    expect(command("hermes").kind).toBe("device");
    expect(command("opencode").kind).toBe("key");
    for (const name of ["codex", "gemini", "gcloud", "aws", "wrangler", "vercel", "pi", "cloudflared"]) expect(command(name).kind, name).toBe("oauth");
    expect(signInFor("claude").kind).toBe("token");
    // Codex signs in once on the computer that runs the workspaces, and it is the only row that does.
    expect(collectorLogins().filter(id => livesOnComputer(signInFor(id)))).toEqual(["codex"]);
  });

  it("declares in one place how each login finishes where nobody is at the machine's terminal, so the hand-off reads a road instead of guessing one", () => {
    // The tools whose own notes here say a browser on the machine finishes them: their page returns to a port there.
    for (const name of ["gcloud", "gemini", "railway", "wrangler", "aws", "codex"]) expect(command(name).finish, name).toBe("callback");
    // gh prints the code its page asks for, and the rest are unmeasured from the app, so none of them takes a code back.
    for (const name of ["gh", "vercel", "netlify", "fly", "supabase", "doppler", "opencode", "cloudflared", "pi", "hermes"]) expect(command(name).finish, name).toBe("none");
    for (const [name, s] of Object.entries(SIGN_INS)) if (hasLogin(s)) expect(SignInFinish.options, name).toContain(s.finish);
  });

  it("signsInByDefault holds for the oauth and device kinds and not for key, none or a bare shell", () => {
    const machine = collectorLogins().filter(id => signsInByDefault(signInFor(id)));
    expect(machine.sort()).toEqual(["aws", "cloudflared", "codex", "gcloud", "gemini", "gh", "hermes", "pi", "vercel", "wrangler"]);
    for (const id of ["opencode", "kube", "op"]) expect(signsInByDefault(signInFor(id)), id).toBe(false);
    expect(signsInByDefault({ kind: "shell" })).toBe(false);
  });

  it("words a row for a checklist: the command, what to do instead, or a plain ask", () => {
    expect(signInWords(signInFor("gh"))).toBe(command("gh").login);
    // A row has no room for the flags that answer a tool's questions, and nobody has to type them.
    expect(loginWords(command("gh"))).toBe("gh auth login");
    expect(loginWords(command("gemini"))).toBe("gemini");
    expect(loginWords(command("aws"))).toBe("aws configure sso");
    expect(signInWords(signInFor("kube"))).toBe("kubectl has no sign-in; copy the kubeconfig instead");
    expect(signInWords(signInFor("unknown"))).toBe("sign in as the tool asks");
  });

  it("never carries a token-looking value", () => {
    expect(JSON.stringify(SIGN_INS, (_k, v: unknown) => (typeof v === "function" ? String(v) : v))).not.toMatch(/gho_|sk-ant|ya29\.|AKIA/);
  });
});
