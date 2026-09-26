// SPDX-License-Identifier: AGPL-3.0-only
// How a catalog entry is signed into on the machine: the command to run, the
// variant that needs no browser there (the retry when the shim and the
// callback forward did not land), and the tool's own status command that
// proves the login. Nothing here reads the tool's output beyond the status
// lines named below.
import type { SignInFinish, SignInRoad } from "@wsp/protocol";
import { CLAUDE_CONFIG_REL, CLAUDE_KEY_FILE, GUEST_HOME } from "./roads.js";

export interface StatusCheck {
  /** The command as the row and the golden's notes show it. */
  command: string;
  /** The line typed on the guest when it carries shell plumbing the shown command leaves out; absent, the command is typed as shown. */
  typed?: string;
  /** Reads the status command's exit code and output; never anything the login printed. */
  signedIn(output: string, exitCode: number): boolean;
  /** Which of a tool's login sources the status says is in use, for the row; `secrets` maps a name the
   * secrets step set on the machine to the file it was cut from. Absent or undefined: the row names none. */
  detail?(output: string, secrets: ReadonlyMap<string, string>): string | undefined;
  /** Why a status was refused when its own words would not say; absent, the row says the command said not signed in. */
  why?(output: string): string | undefined;
}

/** How a login is present on this computer and how it travels: a Keychain item (found by service name, read at copy
 * time with consent, placed as the tool's file on the machine), an API key exported in a shell rc file (found by name,
 * cut from the file and set on the machine before any check), a credential file (found by path and copied), or an
 * apiKeyHelper command in a settings file (run here at copy time, its key placed in a 0600 file the copied settings
 * read). Verification is the row's status, whichever source signed the tool in. */
export type LoginSource = "keychain" | "rc-key" | "file" | "helper";

/** The flow a tool's sign-in takes: a browser with a callback (oauth), a code typed on a page the machine names
 * (device), a key pasted or exported (key), a long-lived token minted on this computer (token), or nothing to run
 * on a headless machine (none). */
export type SignInKind = "oauth" | "device" | "key" | "token" | "none";

interface Asks {
  /** What the tool prints when it asks, matched against its output with the terminal's escapes taken out. */
  asks: RegExp;
}

/** A question the tool puts to its terminal that a run with nobody there would stop on, measured by running the
 * login command in a pty with nothing typed into it, and the one thing that settles it: `flag`, the flag in the
 * login command that means it is never asked; `answer`, the line the relay types when the question appears;
 * `person`, a choice nothing but they can make (which provider, whose organisation), which keeps the machine no
 * road for that row. A page that hands a code back is no question of this kind; `finish` declares that road. */
export type Question = (Asks & { flag: string }) | (Asks & { answer: string }) | (Asks & { person: true });

/** Key files beside a login that no sign-in on the machine produces: they travel only by copy, as a row of their
 * own under the login's id plus "-keys", and the login's own status proves them once landed. */
export interface KeyFiles {
  /** `~/`-relative. */
  paths: readonly string[];
  /** The keys row's second detail line: what the files hold and why only a copy brings them. */
  note: string;
}

/** A login the computer running the workspaces signs in once, outside every one of them, and mounts into each:
 * `dir` is its own directory under that computer's logins directory, `file` the one file every workspace shares,
 * `target` where the tool reads it inside, and `homeEnv` the variable the tool reads its store's directory from,
 * which is what the sign-in on that computer runs with. One declaration per tool and nothing else names these. */
export interface SharedLogin {
  dir: string;
  file: string;
  target: string;
  homeEnv: string;
}

/** A long-lived token minted on this computer by the tool's own command, held in the wsp home's .env under
 * `tokenEnv` and set in the environment of every turn. Nothing of it is on any machine. */
export type TokenSignIn = {
  kind: "token";
  /** Runs on this computer, in the person's terminal. */
  mint: string;
  tokenEnv: string;
  /** What the printed token looks like, so the stage can read it off the output or refuse a paste. */
  token: RegExp;
  keyEnv?: string;
  status?: StatusCheck;
  note?: string;
  sources: [];
  stateOnMachine: [];
};

export type SignIn =
  | TokenSignIn
  | {
      kind: Exclude<SignInKind, "none" | "token">;
      login: string;
      /** The sources the collector finds and the pack carries for this tool; empty when nothing of it travels. */
      sources: readonly LoginSource[];
      /** The device-code, paste-code or no-browser variant, offered on a retry. */
      fallback?: string;
      /** How the flow finishes with no browser on the machine: a device page taking a code the tool printed, or a
       * page whose code comes back to be pasted. Absent: the paste. */
      headless?: "device" | "code";
      /** Every question this tool is known to put to a terminal, each with what settles it. Absent: running the
       * login command in a pty with nothing typed into it printed a page and waited on the browser. */
      questions?: readonly Question[];
      /** How this login finishes where nobody is at the machine's terminal: `callback` is the road the app takes for
       * every tool that has one, `code` a page that hands a code back for the person to submit, `none` a flow the
       * page or the tool's own prompts finish. Declared per tool here and nowhere else; the hand-off reads it. */
      finish: SignInFinish;
      /** The shape the one-time code prints in, for a flow whose page asks for one; matched against what the tool
       * printed, past the URLs it printed. Absent, the flow shows no code and none is read out of its output. */
      code?: RegExp;
      /** The variable the tool reads an API key from; a key loaded on this computer is set under it on the machine. */
      keyEnv?: string;
      /** Absent when the tool has no status command: the login is then "not verified". */
      status?: StatusCheck;
      note?: string;
      keys?: KeyFiles;
      /** Set where this login lives on the computer that runs the workspaces rather than in the image: signed in
       * there once and shared into each of them. A login that lives on the computer is never copied onto a
       * builder and never signed in on one; what it shares is the file this names. */
      shared?: SharedLogin;
      /** Where this tool's login lives on the machine once signed in there or copied onto it, `~`-relative guest
       * paths: what the image vault archives for the row. Claude Code's is under CLAUDE_CONFIG_DIR, never HOME. */
      stateOnMachine: readonly string[];
    }
  /** Nothing to run on a headless machine; the note, when there is one, says what to do instead. A status still
   * proves copied files, and a row with sources keeps state on the machine because a copy puts it there. */
  | { kind: "none"; note?: string; sources: readonly LoginSource[]; status?: StatusCheck; stateOnMachine?: readonly string[] };

export type LoginSignIn = Extract<SignIn, { login: string }>;

/** A sign-in the wizard runs as a command on the machine. */
export function hasLogin(s: SignIn | { kind: "shell" }): s is LoginSignIn {
  return "login" in s;
}

/** A sign-in that is a token minted on this computer: nothing runs on a machine for it. */
export function mintsToken(s: SignIn | { kind: "shell" }): s is TokenSignIn {
  return s.kind === "token";
}

/** What this login shares from the computer that runs the workspaces into each of them, or nothing: the one
 * reader of that field, so where the file lives, what the sign-in runs with and what may not be sealed all read
 * the same declaration. */
export function sharedLoginOf(s: SignIn | { kind: "shell" }): SharedLogin | undefined {
  return hasLogin(s) ? s.shared : undefined;
}

/** A login signed in once on the computer that runs the workspaces and shared into each of them. */
export function livesOnComputer(s: SignIn | { kind: "shell" }): boolean {
  return sharedLoginOf(s) !== undefined;
}

/** Where a computer keeps one shared login's own store, under the logins directory its daemon names: the
 * directory the sign-in there points the tool's home at, and where the file it shares lands. */
export function loginHomeIn(logins: string, shared: SharedLogin): string {
  return `${logins}/${shared.dir}`;
}

/** The variable this tool reads an API key from, or nothing: the one reader of that field, so every place that
 * asks for a key, sets one on a turn or lists what the vault may hold reads the same rule. */
export function keyEnvOf(s: SignIn | { kind: "shell" }): string | undefined {
  return "keyEnv" in s ? s.keyEnv : undefined;
}

/** The token in what a person pasted, or nothing: the whole of the trimmed value has to be the shape that tool
 * prints, so a line copied with the tool's own prompt around it is refused rather than saved with the junk. */
export function tokenIn(s: TokenSignIn, pasted: string): string | undefined {
  const value = pasted.trim();
  return new RegExp(`^(?:${s.token.source})$`).test(value) ? value : undefined;
}

/** The questions this login is known to ask, for the relay to watch the tool's output for: it types the ones the
 * row answers and reports the rest, so a question nobody here can answer ends its row where it stands. */
export function questionsOf(s: SignIn | { kind: "shell" }): readonly Question[] {
  return hasLogin(s) ? (s.questions ?? []) : [];
}

/** Whether this login stops on a question only the person can answer: the sign-ins step then never offers to run it
 * on the machine, and the hand-off ends its row at the question instead of waiting out the cap. */
export function asksThePerson(s: SignIn | { kind: "shell" }): boolean {
  return questionsOf(s).some(q => "person" in q);
}

/** How a person signs this in where it stands, in the agents report's one word: the agent's own terminal where it
 * asks them to pick, the token or key it takes, a device page where its login or the no-browser variant prints
 * one, and otherwise the code its page hands back, which is the road a login with a callback takes where no
 * browser is. The row says which of the two it is. */
export function signInRoadOf(s: SignIn): SignInRoad {
  if (asksThePerson(s)) return "terminal";
  if (s.kind === "token" || s.kind === "key" || s.kind === "none" || s.kind === "device") return s.kind;
  return s.headless ?? "code";
}

/** The login as a row names it: the command up to the flags that answer its questions, which a row has no room for
 * and nobody has to type. */
export function loginWords(s: LoginSignIn): string {
  const at = s.login.indexOf(" --");
  return at === -1 ? s.login : s.login.slice(0, at);
}

/** Whether a login starts as a sign-in on the machine: a browser or device flow the relay finishes there. A key has no
 * browser flow to produce it and a tool with no sign-in has nothing to run, so those start as a copy. */
export function signsInByDefault(s: SignIn | { kind: "shell" }): boolean {
  return s.kind === "oauth" || s.kind === "device";
}

/** The login id the collector files an entry's row under, where it differs from the entry's id: kubectl's row is its kubeconfig. */
const LOGIN_IDS: Readonly<Record<string, string>> = { kubectl: "kube" };

export function loginIdOf(entryId: string): string {
  return LOGIN_IDS[entryId] ?? entryId;
}

const KEYS_SUFFIX = "-keys";

/** The login id the collector files an entry's key files under. */
export function keysIdOf(entryId: string): string {
  return `${loginIdOf(entryId)}${KEYS_SUFFIX}`;
}

/** The row a login's key files make: nothing to run on the machine, and the login's own status proves the copy. */
export function keysRowOf(keys: KeyFiles, status: StatusCheck | undefined): SignIn {
  return { kind: "none", sources: ["file"], note: keys.note, ...(status !== undefined ? { status } : {}) };
}

/** The absolute guest paths a catalog entry's login lives at; empty for an entry with no sign-in. The one place
 * a row's `stateOnMachine` is turned into a path on the machine. */
export function loginStatePaths(entry: { signIn: SignIn }): string[] {
  return (entry.signIn.stateOnMachine ?? []).map(p => `${GUEST_HOME}/${p}`);
}

/** No sign-in and nothing to say about it. */
export const NO_SIGN_IN: SignIn = { kind: "none", sources: [] };

/** In a subshell so its exits never cut the quiet run's own exit marker. */
export const AWS_STATUS = `sh -c 'for p in $(aws configure list-profiles 2>/dev/null); do aws sts get-caller-identity --profile "$p" 2>/dev/null && exit 0; done; exit 1'`;

/** Gemini CLI has no status command: its Google sign-in caches oauth_creds.json under ~/.gemini and its other two
 * sign-ins are these keys, so the line echoes what it finds. No exit, so a miss never cuts the quiet run's marker. */
export const GEMINI_STATUS = `if test -s "$HOME/.gemini/oauth_creds.json"; then echo oauth_creds.json; elif test -n "$GEMINI_API_KEY"; then echo GEMINI_API_KEY; elif test -n "$GOOGLE_API_KEY"; then echo GOOGLE_API_KEY; else false; fi`;

/** cloudflared has no status command: its login writes the origin certificate and nothing else, so the line proves the file. */
export const CLOUDFLARED_STATUS = `if test -s "$HOME/.cloudflared/cert.pem"; then echo cert.pem; else false; fi`;

const has = (re: RegExp) => (output: string): boolean => re.test(output);
const ok = (re?: RegExp) => (output: string, exitCode: number): boolean => exitCode === 0 && (re === undefined || re.test(output));

/** A key named by the status, by the file the secrets step cut it from, or as the machine's own when that step did not set it. */
function keyFrom(name: string, secrets: ReadonlyMap<string, string>): string {
  const from = secrets.get(name);
  return from === undefined ? `API key from ${name} on the machine` : `API key from ${from}, set on the machine as a secret`;
}

/** The first key the secrets step set that the status output names as a word: that key is the login's source. */
export function secretNamed(output: string, secrets: ReadonlyMap<string, string>): string | undefined {
  const words = new Set(output.split(/[^A-Za-z0-9_]+/));
  for (const [name, from] of secrets) if (words.has(name)) return `API key from ${from}, set on the machine as a secret`;
  return undefined;
}

/** What the gemini line echoed: the cached Google sign-in, or the key it found. */
export function geminiSource(output: string, secrets: ReadonlyMap<string, string>): string | undefined {
  const found = output.trim().split(/\s+/).at(-1);
  if (found === "oauth_creds.json") return "OAuth credentials";
  if (found === "GEMINI_API_KEY" || found === "GOOGLE_API_KEY") return keyFrom(found, secrets);
  return undefined;
}

/** The JSON claude auth status printed, when it did. */
function claudeStatus(output: string): Record<string, unknown> | undefined {
  const json = /\{[\s\S]*\}/.exec(output)?.[0];
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function claudeSignedIn(output: string): boolean {
  return claudeStatus(output)?.["loggedIn"] === true;
}

/** What claude auth status says the login comes from (measured on 2.1.257 and 2.1.259): apiKeySource names
 * ANTHROPIC_API_KEY when a key is in use, authMethod is oauth_token under the long-lived token and claude.ai on
 * the stored credentials of a browser sign-in. */
export function claudeSource(output: string, secrets: ReadonlyMap<string, string>): string | undefined {
  const status = claudeStatus(output);
  if (status === undefined) return undefined;
  if (status["apiKeySource"] === "ANTHROPIC_API_KEY") return keyFrom("ANTHROPIC_API_KEY", secrets);
  if (status["loggedIn"] !== true) return undefined;
  if (status["authMethod"] === "oauth_token") return TOKEN_SOURCE;
  if (status["authMethod"] === "claude.ai") return "OAuth credentials";
  return undefined;
}

/** What the status says when the token is what signed the tool in; the sign-in stage's own word for a held token. */
export const TOKEN_SOURCE = "the token from this computer";

/** The sign-in rows of the entries that have one, by the tool's name; a row's words are the wizard's. */
export const SIGN_IN_ROWS = {
  // Device flow by default; the shim opens the device page and the person types the code there. The status lists
  // every account of the host, so one is signed in only when none of them failed. Bare, gh 2.100.0 stops on its
  // first question and prints no page at all, so the four flags answer its four pickers ahead of time.
  gh: {
    kind: "device",
    sources: ["file", "keychain"],
    finish: "none",
    login: "gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key",
    questions: [
      { asks: /Where do you use GitHub\?/, flag: "--hostname" },
      { asks: /What is your preferred protocol for Git operations on this host\?/, flag: "--git-protocol" },
      { asks: /How would you like to authenticate GitHub CLI\?/, flag: "--web" },
      { asks: /(?:Generate a new SSH key to add to|Upload your SSH public key to) your GitHub account\?/, flag: "--skip-ssh-key" },
      { asks: /Press \[?Enter\]? to (?:open|continue)/, answer: "\r" },
      // gh sets the git credential helper after the token lands, so this one comes only once the person is through.
      { asks: /Authenticate Git with your GitHub credentials\?/, answer: "\r" },
    ],
    // Two groups of four, as gh prints it: "! First copy your one-time code: XXXX-XXXX".
    code: /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/,
    status: { command: "gh auth status", signedIn: o => /Logged in to/.test(o) && !/Failed to log in/.test(o) },
    stateOnMachine: [".config/gh/hosts.yml"],
  },
  // Under the daemon pty DISPLAY is unset, so gcloud, gemini and railway take their paste or device flow by
  // themselves; their callback road is the one a DISPLAY the hand-off asks for opens.
  gcloud: {
    kind: "oauth",
    sources: ["file"],
    finish: "callback",
    login: "gcloud auth login",
    status: { command: "gcloud auth list --filter=status:ACTIVE --format=value(account)", signedIn: ok(/@/) },
    stateOnMachine: [".config/gcloud"],
  },
  // A fresh machine has no sso-session profile, so the login is the one that writes it first; it names
  // the profile {role}-{account} by default, so the check tries every configured profile. It is a configuration
  // wizard before it is a sign-in: the start URL and the region it asks for are the person's organisation's.
  aws: {
    kind: "oauth",
    sources: ["file"],
    finish: "callback",
    login: "aws configure sso",
    fallback: "aws configure sso --use-device-code",
    headless: "device",
    questions: [
      { asks: /SSO session name \(Recommended\)/, person: true },
      { asks: /SSO start URL/, person: true },
      { asks: /SSO region/, person: true },
    ],
    status: { command: AWS_STATUS, signedIn: ok(/"Arn"/) },
    note: "the check tries every configured profile; the start URL and region it asks for are yours to type",
    stateOnMachine: [".aws"],
  },
  // --browser=false still binds the callback port, so there is no flag around the callback.
  wrangler: {
    kind: "oauth",
    sources: ["file"],
    finish: "callback",
    login: "wrangler login",
    status: { command: "wrangler whoami", signedIn: has(/You are logged in/) },
    note: "needs the callback forward; CLOUDFLARE_API_TOKEN on the machine is the alternative",
    stateOnMachine: [".config/.wrangler"],
  },
  // A row's road is how the hand-off runs that login, so a road nobody measured would move a flow that works: these
  // five carry `none`, which is what they do today.
  vercel: { kind: "oauth", sources: ["file"], finish: "none", login: "vercel login", status: { command: "vercel whoami", signedIn: (o, c) => c === 0 && !/No existing credentials/.test(o) }, stateOnMachine: [".config/com.vercel.cli", ".vercel"] },
  netlify: { kind: "oauth", sources: [], finish: "none", login: "netlify login", status: { command: "netlify status", signedIn: (o, c) => c === 0 && !/Not logged in/i.test(o) }, stateOnMachine: [".netlify/config.json"] },
  fly: { kind: "oauth", sources: [], finish: "none", login: "fly auth login", status: { command: "fly auth whoami", signedIn: ok(/@/) }, stateOnMachine: [".fly"] },
  // supabase waits for an Enter before it opens anything and has no flag for it (--yes leaves it standing); the
  // relay presses it. --no-browser prints the link at once instead and asks for a code back, which is the retry.
  supabase: {
    kind: "oauth",
    sources: [],
    finish: "none",
    login: "supabase login",
    fallback: "supabase login --no-browser",
    questions: [{ asks: /Press Enter to open browser and login automatically/, answer: "\r" }],
    status: { command: "supabase projects list", signedIn: ok() },
    stateOnMachine: [".supabase"],
  },
  railway: { kind: "oauth", sources: [], finish: "callback", login: "railway login", status: { command: "railway whoami", signedIn: ok(/Logged in as/) }, stateOnMachine: [".railway"] },
  // Without --yes doppler asks before it prints anything; with it the page and the code its page asks for come at once.
  doppler: {
    kind: "oauth",
    sources: [],
    finish: "none",
    login: "doppler login --yes",
    questions: [{ asks: /Open the authorization page in your browser\?/, flag: "--yes" }],
    // The line under "Your auth code is:", lowercase words joined by underscores; anchored on that label so no
    // other word of its shape in the output is read as the code.
    code: /(?<=Your auth code is:\s*)[a-z]+(?:_[a-z]+){2,}/,
    status: { command: "doppler me", signedIn: ok() },
    stateOnMachine: [".doppler"],
  },
  // The shim gets the localhost-callback URL and the terminal the hosted paste-code one; either finishes the login.
  // The token is minted here by claude setup-token and held in the wsp home's .env; every turn on every kind of
  // machine gets it in its environment, so nothing of this login is ever on a machine or in an image.
  claude: {
    kind: "token",
    mint: "claude setup-token",
    tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    token: /sk-ant-oat01-[A-Za-z0-9_-]{20,}/,
    keyEnv: "ANTHROPIC_API_KEY",
    status: { command: "claude auth status", signedIn: claudeSignedIn, detail: claudeSource },
    sources: [],
    stateOnMachine: [],
  },
  codex: {
    kind: "oauth",
    sources: [],
    finish: "callback",
    keyEnv: "OPENAI_API_KEY",
    login: "codex login",
    fallback: "codex login --device-auth",
    headless: "device",
    // The one-time code 0.155.1 prints for its device page; read outside the URLs, so no query string is taken for it.
    code: /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/,
    shared: { dir: "codex", file: "auth.json", target: `${GUEST_HOME}/.codex/auth.json`, homeEnv: "CODEX_HOME" },
    status: { command: "codex login status", signedIn: ok(/Logged in using/) },
    stateOnMachine: [],
  },
  // Gemini CLI 0.59.0 asks about the folder before anything else, and then which sign-in to take, with Google's
  // preselected: --skip-trust answers the first and the relay's Enter takes the second.
  gemini: {
    kind: "oauth",
    sources: ["file"],
    finish: "callback",
    keyEnv: "GEMINI_API_KEY",
    login: "gemini --skip-trust",
    questions: [
      { asks: /Do you trust the files in this folder\?/, flag: "--skip-trust" },
      { asks: /How would you like to authenticate for this project\?/, answer: "\r" },
    ],
    status: { command: GEMINI_STATUS, signedIn: ok(), detail: geminiSource },
    stateOnMachine: [".gemini/oauth_creds.json"],
  },
  // Both counts print on exit 0; a provider key exported on the machine is listed under Environment and counts as a login.
  opencode: {
    kind: "key",
    sources: ["file"],
    finish: "none",
    login: "opencode auth login",
    questions: [{ asks: /Select provider/, person: true }],
    status: { command: "opencode auth list", signedIn: ok(/[1-9]\d* (credentials|environment variable)/), detail: secretNamed },
    note: "OpenCode dropped its Anthropic sign-in in 1.3.0; it takes an API key there",
    stateOnMachine: [".local/share/opencode/auth.json"],
  },
  cloudflared: { kind: "oauth", sources: ["file"], finish: "none", login: "cloudflared tunnel login", status: { command: CLOUDFLARED_STATUS, signedIn: ok() }, stateOnMachine: [".cloudflared"] },
  op: { kind: "none", sources: [], note: "needs the 1Password desktop app; set OP_SERVICE_ACCOUNT_TOKEN on the machine instead" },
  // kubectl v1.36.1 puts a kuberc warning on stderr with no newline, so on the merged pty it would glue onto the context.
  kubectl: {
    kind: "none",
    sources: ["file"],
    note: "kubectl has no sign-in; copy the kubeconfig instead",
    status: { command: "kubectl config current-context", typed: "kubectl config current-context 2>/dev/null", signedIn: ok(/\S/), detail: o => `context ${o.trim()}` },
    stateOnMachine: [".kube/config"],
  },
  // pi lists a model only for a provider it holds credentials for, and prints a /login hint on exit 0 when it holds none.
  pi: {
    kind: "oauth",
    sources: ["file"],
    finish: "none",
    login: "pi",
    questions: [{ asks: /Trust project folder\?/, person: true }],
    status: { command: "pi --list-models", signedIn: ok(/^provider\s+model\b/m) },
    note: "type /login inside pi and pick a provider, then /exit; a key on the machine counts",
    stateOnMachine: [".pi/agent/auth.json"],
  },
  // The pool lists keys from ~/.hermes/.env and the environment beside stored logins; with none it prints nothing on exit 0.
  hermes: {
    kind: "device",
    sources: ["file"],
    finish: "none",
    login: "hermes auth",
    questions: [{ asks: /What would you like to do\?/, person: true }],
    status: { command: "hermes auth list", signedIn: ok(/\(\d+ credentials\):/), detail: secretNamed },
    note: "pick Add a credential in the menu; keys in ~/.hermes/.env count",
    keys: { paths: ["~/.hermes/.env"], note: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" },
    stateOnMachine: [".hermes/auth.json", ".hermes/.env"],
  },
} satisfies Record<string, SignIn>;

/** Every login a computer signs in once and shares into each of its workspaces, off the rows themselves. */
export const SHARED_LOGINS: readonly SharedLogin[] = Object.values(SIGN_IN_ROWS as Record<string, SignIn>)
  .map(sharedLoginOf)
  .filter((s): s is SharedLogin => s !== undefined);

/** What a create on a computer that keeps its logins at `logins` shares into the workspace: one mount per login
 * signed in there, from that computer's own file to the path the tool reads it at inside. */
export function sharesIn(logins: string): { source: string; target: string }[] {
  return SHARED_LOGINS.map(s => ({ source: `${logins}/${sharedFileIn(s)}`, target: s.target }));
}

/** The file a shared login writes, named under the logins folder as a computer lists that folder. */
export function sharedFileIn(shared: SharedLogin): string {
  return `${shared.dir}/${shared.file}`;
}

/** The paths a builder may never hold when the seal reads it: the login files the pack used to copy, the key
 * file the apiKeyHelper road wrote, and every login a computer shares into its workspaces. A sign-in never sits
 * in an image, and a file that outranks the vault's token inside the tool would bill an API key on every fork. */
export const NEVER_IN_IMAGE: readonly string[] = [
  `${GUEST_HOME}/${CLAUDE_CONFIG_REL}/.credentials.json`,
  `${GUEST_HOME}/${CLAUDE_CONFIG_REL}/${CLAUDE_KEY_FILE}`,
  ...SHARED_LOGINS.map(s => s.target),
];

/** Every variable the vault hands a turn: each row's token variable and each row's key variable, derived from the
 * rows and nowhere else, so a tool that reads a new one declares it on its own row and the vault carries it. */
const rowVariables = (s: SignIn): string[] => {
  const key = keyEnvOf(s);
  return [...(mintsToken(s) ? [s.tokenEnv] : []), ...(key !== undefined ? [key] : [])];
};

export const VAULT_VARIABLES: ReadonlySet<string> = new Set(Object.values(SIGN_IN_ROWS as Record<string, SignIn>).flatMap(rowVariables));

/** The part of a record no catalog row declares: the values MCP servers' definitions read by name. */
export const serverValuesOf = (record: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(record).filter(([name]) => !VAULT_VARIABLES.has(name)));

/** The id of the row that keeps its token or key under `name`; nothing for a name no row declares. */
export const vaultVariableRow = (name: string): string | undefined => Object.entries(SIGN_IN_ROWS as Record<string, SignIn>).find(([, s]) => rowVariables(s).includes(name))?.[0];
