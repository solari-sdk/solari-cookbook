// SPDX-License-Identifier: AGPL-3.0-only
// Golden import, the planning half: a saved recipe (the collector's rows with
// the person's ticks) becomes the list of laptop files that travel and where
// they land, the Brewfile and per-manager installs, and the pinned installer
// of every ticked agent. Nothing here touches a disk or a machine; golden.ts
// runs the plan on the builder.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BREW_ID_PREFIX, MCP_ID_PREFIX, packageOf, shellLine, shellQuote, TOOLS_PATH, toolRowId, toolRowPrefix, type LoginChoice, type RecipeCustomRow, type RecipeDigest } from "@wsp/protocol";
import { APT, PRELUDE } from "./dotfiles-presets.js";
import { APT_ENV, APT_INDEX, APT_UPDATE, asLinuxbrew, asLinuxbrewScript, BASE_FLOOR, BASE_IMAGE_COMMANDS, baseEntryFor, BREW, BREW_ENV, BREW_PREFIX, BREW_REAL, BREW_REPO, brewHasCheck, LINUXBREW_HOME, MAC_BIN_DIRS, MAC_BREW, MAC_ONLY, CATALOG_AGENTS, CATALOG_TOOLS, catalogEntry, catalogToolFor, editJson, GUEST_HOME, installEnv, installHomes, loginSignIn, mintsToken, HOMEBREW, HOMEBREW_STEP, fixesVersion, installAfter, installLine, LINUXBREW_SHIM, NODE_PATH_LINE, NODE_RELEASES, nodeInstallScript, parseJsonc, ROAD_MODULES, roadModule, ROADS, rowRoadReader, smokeOf, standingPin, unpinned, UV_INSTALL, versionOf, type AgentEntry, type InstallRoad, type NodeMajor, type RoadName, type ToolEntry, type ToolPin } from "@wsp/catalog";

export { CLAUDE_KEY_FILE, HOMEBREW, NODE_PATH_LINE, NODE_RELEASES, UV, UV_INSTALL, nodeInstallScript, type NodeMajor, type NodeRelease, type ToolPin } from "@wsp/catalog";
export { packageOf } from "@wsp/protocol";

export type { RecipeDigest };

/** The recipe row as this module reads it: a structural subset of the
 * collector's manifest entry, so a recipe file parses straight into it. */
export interface RecipeEntry {
  rung: string;
  id: string;
  label: string;
  paths: readonly string[];
  /** `~`-relative subtrees under paths that stay on the laptop. */
  excludes?: readonly string[];
  /** Entries of paths the tool rewrites while it runs; they travel but never decide the recipe hash. */
  volatile?: readonly string[];
  bytes: number;
  default: "bring" | "skip";
  reason?: string;
  required?: boolean;
  bring?: boolean;
  /** A logins or consent row's answer; the same union the collector and the recipe carry, so a digest built from
   * these rows is a digest the diff can read exhaustively. */
  choice?: LoginChoice;
  linux?: string;
  /** The version the laptop runs (tools rows); the install pins it. */
  version?: string;
  /** The version the row is to install at, as the record a copy is planned from pinned it: the road installs at its tag and checks its sum where one was recorded. */
  pin?: ToolPin;
  /** Credential-shaped: copied only when `choice` is copy, never on the tick alone. */
  consent?: boolean;
  /** Exported names cut from the carried copy of this file, for the checklist; the pack strips every rc file it stages on its own. */
  secrets?: readonly string[];
  /** Shell rows: the name of the login shell the computer runs, when the collector could read it. */
  login?: string;
  /** Shell rows: the family the person's terminal draws with; the app's pane reads it and nothing on the machine does. */
  font?: string;
}

/** What the planner's injected stat says about one laptop path. A link reports
 * its target's kind, mode and size, and where it resolves to. */
export type PathInfo =
  | { kind: "file" | "dir"; mode: number; size: number; mtimeMs: number; realpath: string }
  | { kind: "dangling"; target: string };

export interface PlannedFile {
  id: string;
  /** The row's rung and its copy answer, so the pack and the digest judge every file under this path, every link
   * target and every hook by the rule the row's own path was judged by. */
  rung: string;
  consent?: boolean;
  /** Absolute path on this computer. */
  source: string;
  /** Path under the guest's home. */
  dest: string;
  mode: number;
  dir: boolean;
  /** Absolute laptop paths under `source` the copy leaves out. */
  excludes: string[];
  /** The tool rewrites this path while it runs: it ships, and an attach ships it again, but it never enters the recipe hash. */
  volatile: boolean;
}

/** A credential read on this computer at pack time, from the macOS Keychain or
 * by running a helper command; `place` renders the guest file from the secret
 * and whatever the plan already copied to `dest`. */
export interface PlannedSecret {
  id: string;
  /** The Keychain service, or with `command` the `~`-relative settings file the command was read from. */
  service: string;
  /** The account the item is filed under, for a tool that keeps one Keychain item per signed-in user. */
  account?: string;
  /** A shell line that prints the value on this computer, run in place of the Keychain lookup. */
  command?: string;
  dest: string;
  place: (secret: string, existing: string | undefined) => string;
  /** The file with this account taken out, for an account whose item was not read while another of the login's was. */
  drop?: (existing: string) => string;
  /** Set on an account the copy does not carry, with why: its item is never read and it is dropped from the copied
   * file. A tool that signs in as one account at a time (gh) has one login in use here, and a copy that carried
   * every account would land a file naming users the machine holds no token for. */
  left?: string;
}

/** The name a secret's value is kept and reported under: the service, with the account when the item is per user. */
export function secretKey(s: { service: string; account?: string }): string {
  return s.account === undefined ? s.service : `${s.service} (${s.account})`;
}

/** The path a secret is listed by, the way the collector's row names it. */
export function secretPath(s: { service: string; account?: string; command?: string }): string {
  return s.command === undefined ? `Keychain: ${secretKey(s)}` : `Helper: ${s.service}`;
}

export interface SkippedPath {
  id: string;
  path: string;
  note: string;
}

export interface FilesPlan {
  files: PlannedFile[];
  secrets: PlannedSecret[];
  skipped: SkippedPath[];
  /** The `~`-relative prefix moves this plan landed its files by, the caller's before the built-in macOS ones; the
   * pack repoints a path written inside a copied file by the same list. */
  rewrites: readonly [string, string][];
  /** The recipe's own byte estimate for what travels; the packed size is known only after packing. */
  bytes: number;
  /** Files that travel, counted per rung. */
  rungs: Record<string, number>;
}

export interface PlanFilesOptions {
  /** This computer's home with every link in it resolved, so link targets compare against it. */
  home: string;
  stat: (abs: string) => PathInfo | undefined;
  platform: "darwin" | "linux";
  /** Guest-side prefix rewrites tried before the built-in macOS ones (a config dir the guest keeps elsewhere). */
  rewrites?: readonly [string, string][];
  /** A small laptop file's text, for a login whose Keychain items are filed per account: the tool's own file names them. */
  read?: (abs: string) => string | undefined;
  /** Which planned files travel at all, where the caller carries fewer than the recipe ticked: a computer somebody
   * owns takes the agents' own files and nothing else. Absent, every ticked path travels, which is the image. A
   * file this turns away counts nowhere: not in the rungs, not in the bytes and not among the skips, since the
   * recipe did not set it aside, this destination did not ask for it. */
  keep?: (f: PlannedFile) => boolean;
}

const ticked = (e: RecipeEntry): boolean => e.bring === true;
/** A credential-shaped row travels only on a copy answer; the tick alone withholds it, and so does a skip. */
export const withheld = (e: Pick<RecipeEntry, "consent" | "choice">): boolean => e.consent === true && e.choice !== "copy";
export const WITHHELD_NOTE = "credential-shaped; not copied without your answer on its row";
/** Why a copy leaves one of a login's accounts behind: the tool is signed in as another one here, and the machine
 * takes the login the tool uses rather than every account the file lists. */
export const notTheLogin = (active: string): string => `${active} is the login in use here`;
/** Why a copy leaves every account behind: the file lists more than one and names none in use, so there is nothing
 * to pick between; the sign-in runs on the machine instead. */
export const NO_ACTIVE_LOGIN = "the file names no login in use here; sign in on the machine";
const name = (e: Pick<RecipeEntry, "id">): string => e.id.slice(e.id.indexOf("/") + 1);

/** An MCP server's row: under the agents rung, filed by the MCP id prefix; the one rule every reader of the agents rung asks. */
export const isMcpRow = (e: Pick<RecipeEntry, "rung" | "id">): boolean => e.rung === "agents" && e.id.startsWith(MCP_ID_PREFIX);

// Linux has no ~/Library; these are where the same programs read on XDG systems.
const MAC_REWRITES: readonly [string, string][] = [
  ["Library/Application Support/", ".config/"],
  ["Library/Preferences/", ".config/"],
];

/** A path character: every byte a path carries, to the first one that ends a word in a config file. */
const PATH_CHAR = "[^\\s\"'`:;,)\\]}]";
/** The Mac trees a spelled-out path begins under, off the catalog's table so a prefix added there is found here
 * too: Homebrew's prefix, the tree every Mac home sits in, and the Mac-only trees, minus the ones already under
 * Homebrew's prefix. The person's own home is added to these per file, since it is the plan's, not the platform's. */
const MAC_TREES = [MAC_BREW, "/Users", ...MAC_ONLY.filter(p => !p.startsWith(`${MAC_BREW}/`)).map(p => p.slice(0, -1))];
const escaped = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A path a copied file spells out, as the file writes one: the person's own home or one of the Mac trees, to the
 * end of its run. The home is a tree of its own wherever it sits, since it is the plan's and not the platform's: a
 * home under /Users is already one, a temporary one sits under /private/var and a Linux laptop's under /home, and a
 * spelled-out home moves to the guest's home in every one of those cases. A word with no leading slash keeps the
 * run going, so `Library/Application Support/x` is one path, while a second absolute path on the same line begins
 * its own run. A run that something is already spelling a path or a host against is not one of these:
 * `https://developer.apple.com/Library/x` is a URL, and `$HOME/Library/x` and `~/Library/x` are read against the
 * machine's own home, not this computer's. A tree's own name ends at the run: `/Library.d` and a sibling of the
 * home one character longer are neither. */
const pathsIn = (home: string): RegExp =>
  new RegExp(`(?<![\\w.~-])(?:${[escaped(home), ...MAC_TREES].join("|")})(?:/${PATH_CHAR}*(?: (?!/)${PATH_CHAR}+)*)?(?![\\w.-])`, "g");

export interface ImagePathOptions {
  /** This computer's home with every link in it resolved, as the plan read it. */
  home: string;
  /** The `~`-relative prefix moves the plan landed the copied files by (FilesPlan.rewrites); a path written inside
   * one of those files follows the file. */
  rewrites: readonly [string, string][];
}

/** Where a Mac path lands on the image, or nothing where the image has no such place. A Homebrew binary becomes its
 * command alone: a tool arrives on the image by whichever road the catalog gives it (a release binary, apt, npm, uv,
 * brew), so the name on PATH is the only spelling that holds for every road. The person's own home is asked first,
 * since it is the most specific prefix and always has a place: a Mac's temporary home sits under /private/var,
 * which is otherwise a tree with nothing behind it on the image. */
export function imagePath(mac: string, opts: ImagePathOptions): string | undefined {
  const { home, rewrites } = opts;
  if (mac === home) return GUEST_HOME;
  if (mac.startsWith(`${home}/`)) {
    const rel = mac.slice(home.length + 1);
    for (const [from, to] of rewrites) if (rel.startsWith(from)) return `${GUEST_HOME}/${to}${rel.slice(from.length)}`;
    return `${GUEST_HOME}/${rel}`;
  }
  if (MAC_ONLY.some(prefix => mac.startsWith(prefix))) return undefined;
  for (const dir of MAC_BIN_DIRS) if (mac.startsWith(dir) && !mac.slice(dir.length).includes("/")) return mac.slice(dir.length);
  if (mac === MAC_BREW || mac.startsWith(`${MAC_BREW}/`)) return `${BREW_PREFIX}${mac.slice(MAC_BREW.length)}`;
  return undefined;
}

export interface ImagePaths {
  text: string;
  /** What became of each Mac path met, once each in the order met, as the stage prints it. */
  notes: string[];
}

/** A run ends at the first space in its last segment: a space is part of a directory name only where the path goes
 * on into another directory, so `/opt/homebrew/bin/gh auth git-credential` is the binary and the words after it. */
function pathRun(run: string): string {
  const space = run.indexOf(" ", run.lastIndexOf("/"));
  return space === -1 ? run : run.slice(0, space);
}

/** Files a line cannot leave without taking the syntax around it: a JSON object's key carries the comma that holds
 * the object together, a TOML array and a plist element run over several lines, and a YAML key holds its block by
 * indent. By name, and by parsing for a file that is JSON under another name. A git config, an rc file and an ssh
 * config all read fine a line short. */
const STRUCTURED_NAME = /\.(jsonc?|toml|ya?ml|plist)$/;
function structuredFile(text: string, shown: string): boolean {
  if (STRUCTURED_NAME.test(shown)) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** What begins a comment where a copied config carries one. One list for every file rather than a table per kind:
 * a line this leaves as written is a line nothing was going to run, and the ruling is that a comment stays. */
const COMMENT_MARKS = ["#", "//", ";"];
const isComment = (line: string): boolean => COMMENT_MARKS.some(mark => line.trimStart().startsWith(mark));

/** A copied file with its Mac paths repointed at the image. A path the image has no place for takes its line with
 * it, so a shell does not run it and git does not call it; in a file a line cannot leave the path stays there and
 * the note says so. A comment is left as written, whatever it names. */
export function withImagePaths(text: string, shown: string, opts: ImagePathOptions): ImagePaths {
  const structured = structuredFile(text, shown);
  const macPath = pathsIn(opts.home);
  const notes: string[] = [];
  const note = (n: string): void => {
    if (!notes.includes(n)) notes.push(n);
  };
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (isComment(line)) {
      kept.push(line);
      continue;
    }
    const runs = [...line.matchAll(macPath)].map(m => ({ at: m.index, mac: pathRun(m[0]) }));
    const strays = runs.filter(r => imagePath(r.mac, opts) === undefined);
    if (strays.length > 0 && !structured) {
      for (const r of strays) note(`${r.mac} out of ${shown}`);
      continue;
    }
    for (const r of strays) note(`${r.mac} left in ${shown}`);
    let out = "";
    let from = 0;
    for (const r of runs) {
      const to = imagePath(r.mac, opts);
      if (to === undefined) continue;
      note(`${r.mac} now ${to}`);
      out += line.slice(from, r.at) + to;
      from = r.at + r.mac.length;
    }
    kept.push(out + line.slice(from));
  }
  return { text: kept.join(text.includes("\r\n") ? "\r\n" : "\n"), notes };
}

const SSH_PUBLIC = /^(config|authorized_keys|allowed_signers|environment|rc|.*\.pub)$/;

/** Paths that never travel whatever the tick says, by name; `dir` is known once the path is stat'ed. */
export function refusedPath(rel: string, dir: boolean | undefined): string | undefined {
  if (rel === ".gnupg" || rel.startsWith(".gnupg/")) return "GPG keys are never copied";
  if (rel === ".ssh") return "the .ssh directory is never copied whole; tick its config and public keys";
  if (rel.startsWith(".ssh/")) {
    if (dir === true) return "a directory under .ssh is never copied whole";
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (/known_hosts/.test(base)) return "known_hosts is never copied";
    if (!SSH_PUBLIC.test(base)) return "private key, never copied";
  }
  return undefined;
}

/** Why a row's path never travels, or nothing. Environment files and .netrc hold values, not config: they
 * copy only as a login row's own file or on a credential row the person answered copy. The name rule is
 * about files; a directory called .env is a Python environment more often than a secret. */
export function neverCopied(e: Pick<RecipeEntry, "id" | "rung" | "consent">, rel: string, dir: boolean | undefined): string | undefined {
  if (e.id.startsWith("identity/ssh-key")) return "private key, never copied";
  if (e.id === "identity/gpg") return "GPG keys are never copied";
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (e.rung !== "logins" && e.consent !== true && dir === false) {
    if (/^\.env(\..+)?$/.test(base)) return ".env files are never copied; set the values on the machine";
    if (base === ".netrc") return ".netrc is never copied; sign in on the machine";
  }
  return refusedPath(rel, dir);
}

const under = (home: string, abs: string): boolean => abs === home || abs.startsWith(`${home}/`);

/** A hosts.yml line without its comment, which starts at a # after white space or at the line's start. */
const yamlCode = (line: string): string => line.replace(/(^|\s)#.*$/, "");

/** The accounts gh's hosts.yml lists under a host, in file order, and the one it marks active. */
export function ghAccounts(hostsYml: string, host: string): { users: string[]; active?: string } {
  const users: string[] = [];
  let active: string | undefined;
  let inHost = false;
  let inUsers = false;
  for (const line of hostsYml.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const t = yamlCode(line).trim();
    if (t === "") continue;
    if (indent === 0) {
      inHost = t === `${host}:`;
      inUsers = false;
    } else if (!inHost) {
      continue;
    } else if (indent === 4) {
      inUsers = t === "users:";
      const user = /^user:\s*(\S+)$/.exec(t);
      if (user !== null) active = user[1]!;
    } else if (indent === 8 && inUsers && t.endsWith(":")) {
      users.push(t.slice(0, -1));
    }
  }
  return { users, ...(active !== undefined ? { active } : {}) };
}

/** The account's lines leave the host's users block; when it was the active one,
 * `user:` moves to the first account left, and goes with the block when none is.
 * Other hosts and other users keep their lines. */
export function dropGhAccount(host: string, existing: string, account: string): string {
  const left = ghAccounts(existing, host).users.filter(u => u !== account);
  const out: string[] = [];
  let inHost = false;
  let inUsers = false;
  let inAccount = false;
  for (const line of existing.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const t = yamlCode(line).trim();
    if (t === "") {
      // A comment nested in the account goes with it; every other comment and blank line stands.
      if (!(inAccount && indent > 8)) out.push(line);
      continue;
    }
    if (indent === 0) {
      inHost = t === `${host}:`;
      inUsers = false;
      inAccount = false;
    }
    if (!inHost) {
      out.push(line);
      continue;
    }
    if (indent === 4) {
      inUsers = t === "users:";
      inAccount = false;
    }
    if (indent === 8 && inUsers) inAccount = t === `${account}:`;
    if (inAccount) continue;
    if (indent === 4 && t === "users:" && left.length === 0) continue;
    if (indent === 4 && /^user:\s*(\S+)$/.exec(t)?.[1] === account) {
      if (left.length > 0) out.push(`    user: ${left[0]}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** An account's token goes under its own users block, and under the host too when
 * the file marks that account active; with no account the host line alone is
 * written. Other hosts and other users keep their lines. A file without the host
 * gets the block appended, with no account marked active. */
export function placeGhToken(host: string, token: string, existing: string | undefined, account?: string): string {
  const block = account === undefined ? `${host}:\n    oauth_token: ${token}\n    git_protocol: https\n` : `${host}:\n    git_protocol: https\n    users:\n        ${account}:\n            oauth_token: ${token}\n`;
  if (existing === undefined) return block;
  const atHost = account === undefined || ghAccounts(existing, host).active === account;
  const out: string[] = [];
  let inHost = false;
  let inUsers = false;
  let inAccount = false;
  let seen = false;
  for (const line of existing.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const t = yamlCode(line).trim();
    if (t === "") {
      out.push(line);
      continue;
    }
    if (indent === 0) {
      inHost = t === `${host}:`;
      inUsers = false;
      inAccount = false;
      if (inHost) seen = true;
    }
    if (!inHost) {
      out.push(line);
      continue;
    }
    if (indent === 4) {
      inUsers = t === "users:";
      inAccount = false;
    }
    if (indent === 8 && inUsers) inAccount = t === `${account}:`;
    if (t.startsWith("oauth_token:") && ((indent === 4 && atHost) || (indent === 12 && inAccount))) continue;
    if (indent === 0 && t.endsWith(":")) out.push(line, ...(atHost ? [`    oauth_token: ${token}`] : []));
    else if (indent === 8 && inAccount && t.endsWith(":")) out.push(line, `            oauth_token: ${token}`);
    else out.push(line);
  }
  if (seen) return out.join("\n");
  const body = out.join("\n");
  return `${body.endsWith("\n") ? body : `${body}\n`}${block}`;
}

interface KeychainItem {
  dest: string;
  place: (secret: string, existing: string | undefined, account?: string) => string;
  /** The laptop file, home-relative, that names the accounts the tool keeps one item each for, which of them the
   * tool is signed in as here, and how one leaves the file. */
  accounts?: { file: string; list(text: string): string[]; active(text: string): string | undefined; drop(text: string, account: string): string };
}

/** Where a Keychain item the recipe lists as `Keychain: <service>` lands on the
 * guest and how; on Linux the same tools keep the token in the file itself. */
const KEYCHAIN: Record<string, KeychainItem> = {
  "gh:github.com": {
    dest: ".config/gh/hosts.yml",
    place: (secret, existing, account) => placeGhToken("github.com", secret, existing, account),
    accounts: {
      file: ".config/gh/hosts.yml",
      list: text => ghAccounts(text, "github.com").users,
      active: text => ghAccounts(text, "github.com").active,
      drop: (text, account) => dropGhAccount("github.com", text, account),
    },
  },
};

/** The settings file with its apiKeyHelper set to the line given, or taken out with none, in place so every comment
 * of the person's stands; a file that is not JSON or names no helper is returned as it is. Absent, a file is made for
 * the helper alone. */
export function withApiKeyHelper(text: string | undefined, helper: string | undefined): string | undefined {
  if (text === undefined) return helper === undefined ? undefined : `${JSON.stringify({ apiKeyHelper: helper }, null, 2)}\n`;
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text;
  if (!("apiKeyHelper" in parsed) && helper === undefined) return text;
  return editJson(text, [[["apiKeyHelper"], helper]]);
}

/** Where every login the pack copies lands on the guest, home-relative and before the pack's own rewrites: what the
 * catalog's rows have to hold between them, so a new Keychain reader cannot land a login the image vault never
 * archives. */
export function copiedLoginDests(): string[] {
  return Object.values(KEYCHAIN).map(k => k.dest);
}

/** Why a credential-shaped path does not travel for a tool whose login is a token minted here, said in the words of
 * the row's own command; nothing for a tool that has no such row. */
function tokenInstead(id: string): string | undefined {
  const s = loginSignIn(id);
  return s !== undefined && mintsToken(s) ? `${s.mint} on this computer holds this login as a token; nothing of it travels` : undefined;
}

export function planFiles(entries: readonly RecipeEntry[], opts: PlanFilesOptions): FilesPlan {
  const rewrites = [...(opts.rewrites ?? []), ...(opts.platform === "darwin" ? MAC_REWRITES : [])];
  // A prefix rewrite also moves the directory itself when a row names it bare.
  const rewrite = (rel: string): string => {
    for (const [from, to] of rewrites) {
      if (rel.startsWith(from)) return to + rel.slice(from.length);
      if (from.endsWith("/") && rel === from.slice(0, -1)) return to.endsWith("/") ? to.slice(0, -1) : to;
    }
    return rel;
  };
  const plan: FilesPlan = { files: [], secrets: [], skipped: [], rewrites, bytes: 0, rungs: {} };
  for (const e of entries) {
    if (!ticked(e) || e.rung === "tools") continue;
    if (e.rung === "logins" && e.choice !== "copy") continue;
    let brought = 0;
    for (const p of e.paths) {
      const skip = (note: string): void => void plan.skipped.push({ id: e.id, path: p, note });
      if (withheld(e)) {
        skip(WITHHELD_NOTE);
        continue;
      }
      const keychainPath = /^keychain:\s*(.+)$/i.exec(p);
      if (keychainPath !== null) {
        const service = keychainPath[1]!.trim();
        const keychain = KEYCHAIN[service];
        const token = tokenInstead(e.id);
        if (token !== undefined) skip(token);
        else if (opts.platform !== "darwin") skip("a macOS Keychain item; sign in on the machine");
        else if (keychain === undefined) skip("no Keychain reader for this login yet; sign in on the machine");
        else {
          const dest = rewrite(keychain.dest);
          const perAccount = keychain.accounts;
          const text = perAccount === undefined || opts.read === undefined ? "" : (opts.read(join(opts.home, perAccount.file)) ?? "");
          const accounts = perAccount === undefined ? [] : perAccount.list(text);
          if (perAccount === undefined || accounts.length === 0) plan.secrets.push({ id: e.id, service, dest, place: keychain.place });
          else {
            // One login travels: the one the tool is signed in as here, or the only one there is. Every other
            // account's item is never read and its lines leave the copied file, so the machine is signed in as
            // that one user rather than holding a file naming users it has no token for.
            const carried = perAccount.active(text) ?? (accounts.length === 1 ? accounts[0] : undefined);
            const left = carried === undefined ? NO_ACTIVE_LOGIN : notTheLogin(carried);
            for (const account of accounts) {
              plan.secrets.push({
                id: e.id,
                service,
                account,
                dest,
                place: (secret, existing) => keychain.place(secret, existing, account),
                drop: existing => perAccount.drop(existing, account),
                ...(account === carried ? {} : { left }),
              });
            }
          }
          brought++;
        }
        continue;
      }
      // No helper key travels any more: a configured apiKeyHelper outranks the token the vault hands every turn
      // inside Claude Code, so a fork that kept one would bill the key instead (credential order, measured 2.1.257).
      if (/^helper:\s*(.+)$/i.test(p)) {
        skip(tokenInstead(e.id) ?? "no helper reader for this login yet; sign in on the machine");
        continue;
      }
      if (!p.startsWith("~/")) {
        skip("not under your home directory");
        continue;
      }
      const rel = p.slice(2);
      const source = join(opts.home, rel);
      const st = opts.stat(source);
      const dir = st === undefined || st.kind === "dangling" ? undefined : st.kind === "dir";
      const blocked = neverCopied(e, rel, dir);
      if (blocked !== undefined) {
        skip(blocked);
        continue;
      }
      if (!st) {
        skip("no longer on this computer");
        continue;
      }
      if (st.kind === "dangling") {
        skip(`a link to ${under(opts.home, st.target) ? `~/${st.target.slice(opts.home.length + 1)}` : st.target}, which is gone`);
        continue;
      }
      if (st.realpath !== source) {
        if (!under(opts.home, st.realpath)) {
          skip(`a link to ${st.realpath}, outside your home directory`);
          continue;
        }
        const targetRel = st.realpath.slice(opts.home.length + 1);
        const blockedTarget = neverCopied(e, targetRel, dir === true);
        if (blockedTarget !== undefined) {
          skip(`a link to ~/${targetRel}: ${blockedTarget}`);
          continue;
        }
      }
      const excludes = (e.excludes ?? []).filter(x => x.startsWith(`${p}/`)).map(x => join(opts.home, x.slice(2)));
      const planned: PlannedFile = { id: e.id, rung: e.rung, ...(e.consent === true ? { consent: true } : {}), source, dest: rewrite(rel), mode: st.mode & 0o7777, dir: st.kind === "dir", excludes, volatile: (e.volatile ?? []).includes(p) };
      if (opts.keep !== undefined && !opts.keep(planned)) continue;
      plan.files.push(planned);
      brought++;
    }
    if (brought > 0) {
      plan.bytes += e.bytes;
      plan.rungs[e.rung] = (plan.rungs[e.rung] ?? 0) + brought;
    }
  }
  return plan;
}

/** A planned path with a digest of the bytes that would travel; the host
 * computes it, since the planner never reads a disk. */
export interface DigestedFile {
  id: string;
  /** `~`-relative laptop path, the one the person knows it by. */
  path: string;
  dest: string;
  digest: string;
  /** Recorded but never hashed: the tool rewrites it while it runs, or it is a login value rendered on the machine. */
  volatile?: boolean;
}

const sorted = <T extends object>(rows: T[]): T[] => rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
type Tick = RecipeDigest["ticks"][number];

/** What identifies a tools row's install: the version its road installs at (the laptop's, or the one the road reads
 * for the row, a tap formula's release tag), the road by name, the sha256 of the lines it runs before any recorded
 * pin (what a first run of it installs), and the pin those lines are fixed to while it stands. The one rule the
 * seal, the diff and the hash read a road's identity by. */
function roadIdentity(e: RecipeEntry, brew: BrewTable): Pick<Tick, "version" | "road" | "installer" | "pin"> {
  const planned = e.rung === "tools" ? rowRoad(e, brew) : undefined;
  if (planned === undefined) return e.version !== undefined ? { version: e.version } : {};
  const bare = unpinned(planned.road);
  const line = roadModule(bare).install(bare, planned.bin ?? packageOf(e));
  const pin = standingPin(planned.road);
  const version = ("version" in planned.road ? planned.road.version : undefined) ?? e.version;
  return { ...(version !== undefined ? { version } : {}), road: planned.road.road, ...(typeof line === "string" ? { installer: createHash("sha256").update(line).digest("hex") } : {}), ...(pin !== undefined ? { pin } : {}) };
}

/** What a golden is built from: the ticked ids with their login answers, tool
 * pins and install roads, the computer's login shell once when a shell row is
 * ticked, and every planned path with its digest, volatile ones marked, and
 * every row outside the catalog under its install line. Labels, row order, disk
 * stats and the terminal font row do not enter, so a file rewritten with the
 * same bytes reads the same and a font tick changes no golden. */
export function recipeDigest(entries: readonly RecipeEntry[], files: readonly DigestedFile[], custom: readonly RecipeCustomRow[], brew: BrewTable): RecipeDigest {
  const login = entries.find(e => ticked(e) && e.rung === "shell" && e.login !== undefined)?.login;
  // A row outside the catalog is pinned by the lines that install it: change one and the golden is another golden.
  // A check that changed alone is not a change to the machine, so it does not rebuild.
  const customTicks = custom.map(c => ({ id: `${CUSTOM_PREFIX}${c.id}`, version: c.install.join("; ") }));
  return {
    ticks: sorted([...entries.filter(e => ticked(e) && e.font === undefined).map(e => ({ id: e.id, ...(e.choice !== undefined ? { choice: e.choice } : {}), ...roadIdentity(e, brew) })), ...customTicks]),
    ...(login !== undefined ? { login } : {}),
    files: sorted(files.map(f => ({ id: f.id, path: f.path, dest: f.dest, digest: f.digest, ...(f.volatile === true ? { volatile: true } : {}) }))),
  };
}

/** The digest's hash, the same for any key or row order, with the volatile entries left out; a builder
 * carrying it needs nothing re-applied but those. A recorded pin stays out too: the build that records one stamps
 * it on the builder's own digest, so the recipe that then carries it still attaches to that builder. */
export function recipeHash(digest: RecipeDigest): string {
  const ticks = sorted(digest.ticks.map(t => [t.id, t.choice ?? null, t.version ?? null, t.road ?? null, t.installer ?? null]));
  const files = sorted(digest.files.filter(f => f.volatile !== true).map(f => [f.id, f.path, f.dest, f.digest]));
  return createHash("sha256").update(JSON.stringify({ ticks, login: digest.login ?? null, files })).digest("hex");
}

// --- tools -------------------------------------------------------------------

export interface ToolInstall {
  id: string;
  label: string;
  /** The road the step takes; an extension list written as a file is a script. */
  manager: RoadName;
  /** One bash -c script; exits non-zero on failure. */
  cmd: string;
  /** The install this one needs on the machine first; when that one did not install, this is skipped. */
  after?: string;
  /** The command the install puts on PATH, when the row names it; checked with command -v after the stage. */
  bin?: string;
  /** A command that exits 0 once the row is on the machine, run after the install for a row that carries its own. */
  check?: string;
  /** The road's own reading of whether the row is already there, where the road has one that the command it puts on
   * PATH cannot answer: a formula is the prefix's link, since a command of that name is another road's work. The
   * presence read takes this over `check`; the check after an install stays the road's own. */
  present?: string;
  /** The directories this step's road links its commands into, off the road's module: what the presence read's
   * answering path is held against, so a command answering from outside them is said rather than read as this
   * row. Absent where the road names none. */
  bins?: readonly string[];
  /** The version the row asks for, off its road, so a presence read can compare; absent where the road installs
   * what its source serves. */
  asks?: string;
  /** The one line a person reads while the step runs: the manager's command, or where a download comes from. Absent, cmd is read. */
  shown?: string;
  /** What the result says beside the install once it lands: a road no golden build has proven yet, a version the road could not pin. */
  note?: string;
  /** How the row's pin is read once it is on the machine, and whether a copy gets the version read: absent for a step no recipe row stands behind. */
  pin?: PinRead;
}

/** What a step says about its pin: the line that prints the installed version (absent for a road whose install line
 * prints it itself), whether the road installs at that version on a copy or takes the current one wherever it runs,
 * and the road's own words for the line that names a latest row. */
export interface PinRead {
  read?: string;
  fixed: boolean;
  words: string;
}

/** The version a road's install line asks for, for a presence read to compare against: the road's own where the
 * road fixes one, nothing where it installs whatever its source serves that day. */
export function asksVersion(road: InstallRoad): string | undefined {
  return fixesVersion(road) ? versionOf(road) : undefined;
}

/** A step's `asks` as a field, so a caller spreads it rather than reading the rule twice. */
const asksOf = (road: InstallRoad): { asks?: string } => {
  const asks = asksVersion(road);
  return asks === undefined ? {} : { asks };
};

/** What a step carries off its road for reading it back later: the road's own presence test where it has one, and
 * the directories that road links its commands into. One reader, so every step planned on a road answers the same
 * two questions however it was planned. */
export function roadReads(road: InstallRoad, bin: string, prefix?: string): { present?: string; bins?: readonly string[] } {
  const mod = roadModule(road);
  const present = mod.present?.(road, bin);
  const bins = mod.bins(road, installHomes(prefix));
  return { ...(present !== undefined ? { present } : {}), ...(bins.length > 0 ? { bins } : {}) };
}

/** What a step reads off its road: `roadReads`, and the road's own check where the road has one of its own. Read
 * by the steps whose reads are the road's word and nothing else, a formula the plan installs and a row outside the
 * catalog whose manager names a road, so both answer the same questions however the row reached the plan. */
export function roadStepReads(road: InstallRoad, bin: string, prefix?: string): { present?: string; bins?: readonly string[]; check?: string } {
  const check = roadModule(road).check?.(road, bin);
  return { ...roadReads(road, bin, prefix), ...(check !== undefined ? { check } : {}) };
}

/** The pin read a road gives a step: its module's version line on the command it puts on PATH, whether it fixes one, and its words. */
export function pinReadOf(road: InstallRoad, bin: string, prefix?: string): PinRead {
  const mod = roadModule(road);
  const read = mod.installed?.(road, bin, installHomes(prefix));
  return { ...(read !== undefined ? { read } : {}), fixed: fixesVersion(road), words: mod.words };
}

export interface SkippedItem {
  id: string;
  note: string;
}

export interface Brewfile {
  text: string;
  taps: string[];
  formulae: string[];
  skipped: SkippedItem[];
  /** Tap formulae with no Linux bottle whose source repository is known; each installs from its release. */
  roads: PlannedRoad[];
  /** Rows the base stage already put on every golden, by the base row's name; nothing installs them twice. */
  base: BaseRow[];
}

export interface BaseRow {
  id: string;
  /** The base row it stands for, as the catalog names it. */
  name: string;
  /** The floor entry it stands for and the version the computer that was read runs, so whoever reports the row
   * writes its note with the platform that computer is: the plan itself knows no computer. */
  entry: ToolEntry;
  version?: string;
}

export interface PlannedRoad {
  id: string;
  /** The command the road puts in /usr/local/bin. */
  name: string;
  source: ToolSource;
  pin?: ToolPin;
}

/** A tools row the recipe added for a catalog tool this computer has no row for: the tool's catalog id after the prefix. */
export const CATALOG_PREFIX = "tools/catalog/";
/** The note beside a catalog road's install when no golden build has proven the road yet. */
export const UNMEASURED_ROAD = "by an unmeasured road";

/** The base row a tools row stands for, when the base stage installs the same tool on every golden. The version
 * read here is the row's, or the brew table's for a formula. */
export function baseRowFor(e: RecipeEntry, brew: BrewTable = new Map()): BaseRow | undefined {
  if (e.rung !== "tools") return undefined;
  const pkg = packageOf(e);
  const entry = baseEntryFor(pkg);
  if (entry === undefined) return undefined;
  const version = e.version ?? brew.get(pkg)?.version;
  return { id: e.id, name: entry.name, entry, ...(version !== undefined ? { version } : {}) };
}

/** The GitHub repository a formula builds from and the tag of the version the Mac has. */
export interface ToolSource {
  repo: string;
  tag: string;
}

/** What this Mac's Homebrew says about one installed formula. */
export interface BrewFormula {
  name: string;
  /** With the tap prefix for a tap formula; the same as name for homebrew/core. */
  fullName: string;
  /** Runtime dependencies by full name, direct and transitive. */
  deps: string[];
  /** The Cellar entry's size on the Mac, when read. */
  bytes?: number;
  /** The version installed on the Mac, as brew reported it. */
  version?: string;
  macosOnly: boolean;
  source?: ToolSource;
}

/** By full name. */
export type BrewTable = ReadonlyMap<string, BrewFormula>;

/** Tap formulae that only build for macOS and say nothing of it in their metadata. */
export const MACOS_ONLY_FORMULAE: ReadonlySet<string> = new Set(["felixkratz/formulae/sketchybar", "felixkratz/formulae/borders", "koekeishiya/formulae/yabai", "koekeishiya/formulae/skhd"]);

/** Where the guest finds what the tools stage installs; each install line exports it so it does not depend on the
 * machine's own environment, login shells get it from profile.d, and a workspace on a computer somebody owns boots
 * with it. One PATH for a machine's tools, so it is the protocol's and neither side spells its own order. */
export { TOOLS_PATH } from "@wsp/protocol";
/** The line every script of a job exports its PATH and its managers' knobs with. Both are handed in rather than
 * fixed: a machine wsp forked is root's alone and takes the tools PATH with each manager's own folders under its
 * home, and a computer somebody owns shares its home with the workspaces on it, so the job there runs on the probe
 * list and names the folder of wsp's own every manager installs under. One line for an install, a presence read
 * and a version read alike, so no two of them reach different folders. */
export const pathLine = (path: string, prefix?: string): string =>
  ["export", `PATH=${path}`, ...Object.entries(installEnv(installHomes(prefix))).map(([name, value]) => `${name}=${value}`)].join(" ");
export const PATH_LINE = pathLine(TOOLS_PATH);
/** The guest runs as root, and its exec environment names no user (measured 2026-09-05): what every road that
 * hands the guest an environment says about who is logged in. */
export const GUEST_USER_ENV: Readonly<Record<string, string>> = { HOME: GUEST_HOME, USER: "root" };
/** That environment as a shell line, since no road to the guest hands it over any other way: the exec API gives a
 * command PATH and nothing else, and the deploy's own install runs under the same gap. Written here, beside the
 * map it exports, so a road cannot spell it its own way. */
export const EXEC_ENV = `export ${shellLine(Object.entries(GUEST_USER_ENV).map(([name, value]) => `${name}=${value}`))}`;
const withPath = (cmd: string, path: string, prefix?: string): string => `${pathLine(path, prefix)}\n${cmd}`;

/** Where a login shell reads the tools PATH: a thread's terminal is one, and it inherits nothing from the stages. */
export const PROFILE_PATH_FILE = "/etc/profile.d/wsp-golden.sh";
/** The base stage writes it on every golden, so a machine that never bootstraps Homebrew still answers `cargo`. */
export const PROFILE_PATH_LINE = `printf '%s\\n' ${shellQuote(PATH_LINE)} > ${PROFILE_PATH_FILE}`;

/** After the tools loop: dependencies no formula needs any more (a failed formula
 * left a 2.4 GB llvm@21 behind), then the bottle cache and old kegs (5.5 GB measured). */
export const brewHousekeeping = (path: string): readonly string[] => [withPath(asLinuxbrew("autoremove"), path), withPath(asLinuxbrew("cleanup -s --prune=all"), path)];

/** Dependencies two or more of the formulae share install in one brew process before any
 * of them, marked as dependencies so autoremove still owns them; each formula then finds
 * its shared dependencies present and installs only its own. */
/** The line that puts the dependencies two or more of the formulae share in `shared`, Homebrew's own toolchain
 * left out: the step installs them and its check reads them back, so the list is derived once and the two cannot
 * ask about different formulae. */
const sharedDepsLine = (formulae: readonly string[]): string =>
  `shared=$(${BREW} deps --for-each ${formulae.map(shellQuote).join(" ")} | sed 's/^[^:]*: *//' | tr ' ' '\\n' | grep -vx -e '' ${BREW_TOOLCHAIN.map(f => `-e ${f}`).join(" ")} | sort | uniq -d || true)`;

function brewSharedDeps(formulae: readonly string[]): string {
  return asLinuxbrewScript(
    [
      "set -uo pipefail",
      sharedDepsLine(formulae),
      'if [ -z "$shared" ]; then echo "no shared dependencies"; exit 0; fi',
      'echo "shared: $(echo $shared)"',
      `${BREW} install $shared; rc=$?`,
      `${BREW} tab --no-installed-on-request $shared || true`,
      "exit $rc",
    ].join("\n"),
  );
}

/** Whether the dependencies the shared step installs are already on the machine: the same list that step derives,
 * read back by Homebrew's own list. A list with nothing in it is a step with nothing to do rather than a row that
 * failed, and a formula of its own that did not install is that row's failure and not this one's. */
const brewSharedCheck = (formulae: readonly string[]): string =>
  asLinuxbrewScript(
    [
      "set -uo pipefail",
      sharedDepsLine(formulae),
      'if [ -z "$shared" ]; then exit 0; fi',
      `${BREW} list --versions $shared >/dev/null`,
    ].join("\n"),
  );

function homebrewBootstrap(): string {
  return [
    "set -euo pipefail",
    APT_ENV,
    `if [ ! -x ${BREW} ]; then`,
    "  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null 2>&1 || true; apt-get install -y -qq procps curl file git >/dev/null 2>&1 || true; fi",
    "  id -u linuxbrew >/dev/null 2>&1 || useradd -m -s /bin/bash linuxbrew",
    `  git clone -q --depth 1 --branch ${HOMEBREW.tag} https://github.com/Homebrew/brew ${BREW_REPO}`,
    `  test "$(git -C ${BREW_REPO} rev-parse HEAD)" = "${HOMEBREW.commit}"`,
    // A clone at a tag fetches that tag and nothing else, so brew's update has no branch to compare against and git
    // prints "Not a valid ref: refs/remotes/origin/main" at every run: the remote gets what a plain clone leaves.
    `  git -C ${BREW_REPO} remote set-branches origin '*'`,
    // All the fetch buys update is a 304 in place of a full read, and every formula row waits on this step, so a
    // network that is gone costs the line and nothing else.
    `  git -C ${BREW_REPO} fetch -q --depth 1 origin main || echo "origin/main did not fetch: brew update reads the branch in full"`,
    `  mkdir -p ${BREW_PREFIX}/bin "$(dirname ${BREW_REAL})"`,
    `  ln -sfn ../Homebrew/bin/brew ${BREW_REAL}`,
    `  chown -R linuxbrew:linuxbrew ${LINUXBREW_HOME}`,
    // After the chown, so the one file root executes stays root's; the rm is for the dangling link a half-built
    // machine leaves, which the redirect would otherwise follow into the checkout.
    `  rm -f ${BREW}`,
    `  printf '%s\\n' ${shellQuote(LINUXBREW_SHIM)} > ${BREW}`,
    `  chmod 0755 ${BREW}`,
    "fi",
    `${asLinuxbrew("--version")} >/dev/null`,
  ].join("\n");
}

const TAP_PREFIX = "tools/brew-tap/";
/** A tap row: the tap it names, not a formula or a command. */
export const isTap = (e: Pick<RecipeEntry, "id">): boolean => e.id.startsWith(TAP_PREFIX);
const tapOf = (e: Pick<RecipeEntry, "id">): string => e.id.slice(TAP_PREFIX.length);

/** The formula a Homebrew row names; nothing for a tap or any other row. */
export const formulaOf = (e: Pick<RecipeEntry, "id">): string | undefined => (e.id.startsWith(BREW_ID_PREFIX) ? e.id.slice(BREW_ID_PREFIX.length) : undefined);
const macOsOnly = (formula: string, info: BrewFormula | undefined): boolean => MACOS_ONLY_FORMULAE.has(formula) || info?.macosOnly === true;

/** A tap formula with no Linux bottle whose GitHub release the Mac's Homebrew names installs from that release, with
 * the pin its first install recorded. Only a tap formula takes the road: a core formula unknown to the snapshot may
 * well have a Linux bottle by now. The one place that decides it, read by the Brewfile, the plan and the digest. */
function releaseFor(e: RecipeEntry, brew: BrewTable): PlannedRoad | undefined {
  const formula = formulaOf(e);
  const info = formula === undefined ? undefined : brew.get(formula);
  if (formula === undefined || e.linux !== "unknown" || !formula.includes("/") || info?.source === undefined || macOsOnly(formula, info)) return undefined;
  return { id: e.id, name: info.name, source: info.source, ...pinOf(e) };
}

export function brewfileFor(entries: readonly RecipeEntry[], brew: BrewTable = new Map()): Brewfile {
  const out: Brewfile = { text: "", taps: [], formulae: [], skipped: [], roads: [], base: [] };
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "tools") continue;
    const base = baseRowFor(e, brew);
    const formula = formulaOf(e);
    if (base !== undefined) {
      out.base.push(base);
    } else if (isTap(e)) {
      out.taps.push(tapOf(e));
    } else if (formula !== undefined) {
      // A formula the catalog brings as a manager's toolchain takes the catalog's road, so it is no formula here.
      if (catalogToolOf(e) !== undefined) continue;
      const road = releaseFor(e, brew);
      if (e.linux === "no") out.skipped.push({ id: e.id, note: "no Linux bottle" });
      else if (e.linux === "unknown" && macOsOnly(formula, brew.get(formula))) out.skipped.push({ id: e.id, note: "macOS only" });
      else if (road !== undefined) out.roads.push(road);
      else if (e.linux === "unknown") out.skipped.push({ id: e.id, note: "no Linux bottle known" });
      else out.formulae.push(formula);
    }
  }
  const lines = [...out.taps.map(t => `tap "${t}"`), ...out.formulae.map(f => `brew "${f}"`)];
  out.text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return out;
}

/** Where the step that brings a manager onto the machine is filed; what follows is the manager's own name. */
export const MANAGER_STEP = "tools/manager/";

/** The manager whose own toolchain an install runs on top of, when what it waits on names one: npm's node.
 * Nothing for an install that waits on the apt index, on Homebrew, or on a row the floor carries. */
function managerBehind(dep: string | undefined): RoadName | undefined {
  return dep === undefined ? undefined : MANAGER_ORDER.find(m => catalogToolFor(m)?.id === dep);
}

/** What a planned row waits on: the road the row takes where it names one of its own, else what that road's module
 * runs on top of. The one reading, so the loop that resolves a manager and the one that plans the row cannot part. */
const depOf = (planned: PlannedRow): string | undefined => planned.after ?? ROAD_MODULES[planned.road.road].after;

/** The manager rows the collector writes (`tools/<manager>/<package>`), in the order their steps run. */
const MANAGER_ORDER: readonly ("npm" | "pnpm" | "bun" | "uv" | "pipx" | "cargo" | "go")[] = ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go"];

// Homebrew's Linux bottles are built against a newer glibc than the base image
// ships, so its first formula pulls Homebrew's own glibc and gcc in and, on
// 6.0.21, a nested brew racing the parent for those locks fails one run in
// two (measured: 4 of 7 plain runs failed, 3 of 3 passed with these first).
// Each is its own single brew process, in this order, before any formula.
export const BREW_TOOLCHAIN: readonly string[] = ["glibc", "gcc"];

/** The catalog tool this Mac's formula stands for, when a manager comes by that tool and the catalog brings it some
 * other way: cargo's toolchain is rustup's whatever the Brewfile names, so the row takes the catalog's road and
 * Homebrew's formula never installs beside it. */
function managerTool(formula: string): ToolEntry | undefined {
  const entry = catalogToolFor(formula);
  if (entry === undefined || entry.installRoad.road === "brew") return undefined;
  return MANAGER_ORDER.some(m => catalogToolFor(m)?.id === entry.id) ? entry : undefined;
}

/** The catalog tool a tools row is: a catalog row by the id after its prefix, this Mac's formula for a manager's
 * toolchain by the formula; nothing for any other row. */
export function catalogToolOf(e: RecipeEntry): ToolEntry | undefined {
  const pkg = packageOf(e);
  if (e.id.startsWith(CATALOG_PREFIX)) {
    const entry = catalogEntry(pkg);
    return entry?.kind === "tool" ? entry : undefined;
  }
  return e.id.startsWith(BREW_ID_PREFIX) ? managerTool(pkg) : undefined;
}

/** The formula a manager with no catalog row comes by. */
const MANAGER_FORMULA: Readonly<Partial<Record<RoadName, string>>> = { pipx: "pipx" };

/** The Homebrew formula a manager comes by: its catalog row's, when that row takes the brew road, else the one named
 * here; nothing for a manager the catalog installs another way or the base carries. */
export function managerFormula(manager: RoadName): string | undefined {
  const road = catalogToolFor(manager)?.installRoad;
  return road === undefined ? MANAGER_FORMULA[manager] : road.road === "brew" ? road.formula : undefined;
}

const pinOf = (e: { pin?: ToolPin }): { pin?: ToolPin } => (e.pin !== undefined ? { pin: e.pin } : {});

/** The release road of a tap row whose GitHub release is known, with the pin its first install recorded and the
 * repository's main package for `go install` to fall back to. */
const releaseRoad = (r: Pick<PlannedRoad, "source" | "pin">): InstallRoad => ({ road: "release", repo: r.source.repo, version: r.source.tag, ...pinOf(r), go: `github.com/${r.source.repo}@${r.source.tag}` });

/** What a tools row installs by, with the command it puts on PATH where known: a catalog row its entry's road at the
 * row's version where the road pins one (noted when no golden build has proven the road, or when the version could not
 * be pinned), a tap formula with no Linux bottle its GitHub release when this Mac's Homebrew (`brew`) names one, any
 * other formula row the brew road, a manager row its manager's road at the row's version; nothing for a row no road
 * installs. A road carries the pin the row's first install recorded. The one resolver the plan and the digest read. */
export function rowRoad(e: RecipeEntry, brew: BrewTable): PlannedRow | undefined {
  const pkg = packageOf(e);
  const known = catalogToolOf(e);
  if (known !== undefined) {
    const mod = roadModule(known.installRoad);
    const road = e.version !== undefined && mod.at !== undefined ? mod.at(known.installRoad, e.version) : known.installRoad;
    // A road the catalog pinned installs that pin on every machine, so a row asking another version is told which
    // one it gets; a road that takes no version at all is told it installs the source's current one.
    const pinned = "version" in known.installRoad ? known.installRoad.version : undefined;
    const asked = e.version !== undefined && mod.at === undefined && e.version !== pinned;
    const notes = [
      ...(known.source.road === "unmeasured" ? [UNMEASURED_ROAD] : []),
      ...(asked ? [pinned !== undefined ? `asked ${e.version}, installed at the catalog's pinned ${pinned}` : `${e.version} asked, installed ${mod.words} at its current version`] : []),
    ];
    const after = installAfter(known);
    return { road: { ...road, ...pinOf(e) }, bin: known.bin, ...(after !== undefined ? { after } : {}), ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
  }
  const release = releaseFor(e, brew);
  if (release !== undefined) return { road: releaseRoad(release), bin: release.name };
  if (e.id.startsWith(CATALOG_PREFIX)) return undefined;
  // The manager the row's id names, and the road its own module reads off such a row; a manager whose module reads
  // none (apt, which every machine has already and no row of its own brings) leaves the row to the hand that added it.
  const manager = ROADS.find(m => e.id.startsWith(toolRowPrefix(m)));
  const fromRow = manager === undefined ? undefined : rowRoadReader(manager);
  if (fromRow === undefined) return undefined;
  const road = fromRow({ name: pkg, ...(e.version !== undefined ? { version: e.version } : {}), paths: e.paths, label: e.label });
  const bin = roadModule(road).bin?.(road);
  return { road, ...(bin !== undefined ? { bin } : {}) };
}

export interface PlannedRow {
  road: InstallRoad;
  bin?: string;
  /** What the catalog says the row runs on top of; a row outside the catalog takes its road's word. */
  after?: string;
  note?: string;
}

/** How a removed tool comes off the machine: through its road's module, on the tools PATH; a row no road installed is noted. */
export function toolUninstall(e: RecipeEntry, brew: BrewTable, path: string = TOOLS_PATH, prefix?: string): { cmd: string } | { note: string } {
  const base = baseRowFor(e, brew);
  if (base !== undefined) return { note: `${base.name} is part of the base and stays` };
  if (isTap(e)) return { cmd: withPath(asLinuxbrew(`untap ${tapOf(e)}`), path, prefix) };
  const planned = rowRoad(e, brew);
  if (planned === undefined) return { note: "no manager known for this row" };
  const r = roadModule(planned.road).uninstall(planned.road, planned.bin ?? packageOf(e), installHomes(prefix));
  return "cmd" in r ? { cmd: withPath(r.cmd, path, prefix) } : r;
}

export interface ToolsPlan {
  installs: ToolInstall[];
  skipped: SkippedItem[];
  /** Ticked rows the base stage covers; they count as installed without a step. */
  base: BaseRow[];
  brewfile: string;
}

/** A row an agent added by hand: its id under this prefix, so the lineage names it apart from any catalog road. */
export const CUSTOM_PREFIX = "tools/custom/";

/** What a custom row runs with: the catalog roads' own PATH and apt environment, and Homebrew's build environment,
 * which the shim on that PATH carries through to brew. */
export const customPrelude = (path: string, prefix?: string): string => [pathLine(path, prefix), APT_ENV, `export ${BREW_ENV}`].join("\n");

/** The road a row outside the catalog installs by, read off the manager it names by that manager's own module;
 * nothing for a row that names no manager, or one whose module reads no row of its own (apt, on every machine
 * already). The row carries a name and nothing else a road reads. */
const customRoad = (c: RecipeCustomRow): InstallRoad | undefined => (c.manager === undefined ? undefined : rowRoadReader(c.manager)?.({ name: c.name, paths: [], label: c.name }));

/** The rows outside the catalog as installs, in the order the recipe carries them; each runs its own lines as given.
 * A row whose manager names a road takes its reads off that road's module, the road's presence read and the road's
 * own check, the same two a catalog row of that road gets: the check the scan wrote beside the row is a command
 * frozen on the day it ran, and a recipe carries it unchanged for as long as the row lives. The row's own check
 * stands where no module reads the row. `after` is what the plan brings the row's manager by, when the row names
 * one and the plan brings it. */
export function customInstallsFor(custom: readonly RecipeCustomRow[], after: (c: RecipeCustomRow) => string | undefined = () => undefined, path: string = TOOLS_PATH, prefix?: string): ToolInstall[] {
  return custom.map(c => {
    const waits = after(c);
    const road = customRoad(c);
    const reads = road === undefined ? undefined : roadStepReads(road, c.name, prefix);
    return {
      id: `${CUSTOM_PREFIX}${c.id}`,
      label: c.name,
      manager: "script" as const,
      cmd: [customPrelude(path, prefix), ...c.install].join("\n"),
      ...reads,
      check: reads?.check ?? c.check,
      shown: shownOf(c.install),
      ...(waits !== undefined ? { after: waits } : {}),
    };
  });
}

/** A script of several lines as one a person reads: the lines as typed, one after the other. */
export const shownOf = (lines: readonly string[]): string => lines.join("; ");

/** A step's script and the line shown for it, through the road's module: the module's own line when the script is
 * not one a person reads, else the script itself. */
export function viaRoad(road: InstallRoad, bin: string, path: string = TOOLS_PATH, prefix?: string): { cmd: string; shown: string } | { note: string } {
  const mod = roadModule(road);
  const line = mod.install(road, bin, installHomes(prefix));
  if (typeof line !== "string") return line;
  return { cmd: withPath(line, path, prefix), shown: mod.shown?.(road, bin) ?? shownOf(line.split("\n")) };
}

/** The apt index read once, as a step every apt row waits on; the base and the recipe plan each have one. */
export function aptIndexStep(id: string, cmd: string): ToolInstall {
  return { id, label: "apt index", manager: "apt", cmd, shown: "apt-get update" };
}

/** Whether a tap is already tapped, off the list Homebrew prints of them. */
export const brewTapCheck = (tap: string): string => `${asLinuxbrew("tap")} 2>/dev/null | grep -qx ${shellQuote(tap)}`;

/** A formula's step, for the plan's own brew lines: the toolchain, a manager's formula. */
function viaBrew(formula: string, path: string, prefix?: string): { cmd: string; shown: string } {
  const step = viaRoad({ road: "brew", formula }, formula, path, prefix);
  if (!("cmd" in step)) throw new Error(`${formula}: ${step.note}`);
  return step;
}

/** The road a row outside the catalog names as its manager, when it names one the catalog knows. */
const managerRoad = (c: RecipeCustomRow): RoadName | undefined => ROADS.find(r => r === c.manager);

export function toolInstallsFor(entries: readonly RecipeEntry[], table: BrewTable = new Map(), custom: readonly RecipeCustomRow[] = [], path: string = TOOLS_PATH, prefix?: string): ToolsPlan {
  const brew = brewfileFor(entries, table);
  const installs: ToolInstall[] = [];
  const skipped: SkippedItem[] = [...brew.skipped];
  const toolRows = entries.filter(e => ticked(e) && e.rung === "tools" && baseRowFor(e) === undefined);
  const rowsOf = (manager: RoadName): RecipeEntry[] => toolRows.filter(e => e.id.startsWith(toolRowPrefix(manager)));
  // A catalog row installs by its entry's road; a package road's rows go with the manager's, the rest after everything else.
  // This Mac's formula for a manager's toolchain is one of them: the catalog's road, once, under the row's own id.
  const catalog = toolRows.flatMap(e => {
    if (!e.id.startsWith(CATALOG_PREFIX) && catalogToolOf(e) === undefined) return [];
    const planned = rowRoad(e, table);
    if (planned === undefined) skipped.push({ id: e.id, note: "not in the catalog" });
    return planned === undefined ? [] : [{ e, planned }];
  });
  const catalogRowsOf = (manager: RoadName): RecipeEntry[] => catalog.filter(c => c.planned.road.road === manager).map(c => c.e);
  const npmTicked = new Set(rowsOf("npm").map(e => packageOf(e)));

  // Homebrew's own toolchain, each step waiting on the one before; everything brew installs waits on the last.
  const toolchain = BREW_TOOLCHAIN.reduce<{ steps: ToolInstall[]; last: string }>(
    (acc, f) => {
      const id = `tools/brew-toolchain/${f}`;
      acc.steps.push({ id, label: `Homebrew's ${f}`, manager: "brew", ...viaBrew(f, path, prefix), after: acc.last, check: brewHasCheck(f) });
      return { steps: acc.steps, last: id };
    },
    { steps: [], last: "tools/homebrew" },
  );

  // A row outside the catalog calls its manager's own command, so it counts as a row of that manager here: the
  // manager is brought onto the machine the one way this function knows, and the row waits on it.
  const customOf = (manager: RoadName): RecipeCustomRow[] => custom.filter(c => managerRoad(c) === manager);
  // One step per manager that has rows, unless the base carries it or it already comes along as a formula, a ticked
  // catalog row or an npm global; the step takes the manager's catalog road, or its formula when the catalog has none.
  // npm's manager is node, which no image carries by default, so it is resolved on demand as well: whatever first
  // runs on node asks for it, and it lands once.
  const managers = new Map<RoadName, { after: string; step?: ToolInstall; row?: { e: RecipeEntry; planned: PlannedRow } }>();
  const managerFormulae: string[] = [];
  const resolved = new Set<RoadName>();
  const resolveManager = (manager: RoadName): void => {
    if (resolved.has(manager)) return;
    resolved.add(manager);
    if (baseEntryFor(manager) !== undefined) return;
    const own = `${MANAGER_STEP}${manager}`;
    const entry = catalogToolFor(manager);
    const formula = managerFormula(manager);
    const fromCatalog = entry === undefined ? undefined : catalog.find(c => catalogToolOf(c.e)?.id === entry.id);
    // This Mac's Brewfile may already carry the manager, under its formula's name or its own.
    const macFormula = [formula, manager].find(f => f !== undefined && brew.formulae.includes(f));
    if (macFormula !== undefined) managers.set(manager, { after: `${BREW_ID_PREFIX}${macFormula}` });
    else if (fromCatalog !== undefined) managers.set(manager, { after: fromCatalog.e.id, row: fromCatalog });
    else if (npmTicked.has(manager)) managers.set(manager, { after: toolRowId("npm", manager) });
    else if (formula !== undefined) {
      managers.set(manager, { after: own, step: { id: own, label: manager, manager: "brew", ...viaBrew(formula, path, prefix), ...roadReads({ road: "brew", formula }, manager, prefix), after: toolchain.last, bin: manager } });
      managerFormulae.push(formula);
    } else if (entry !== undefined) {
      const step = viaRoad(entry.installRoad, entry.bin, path, prefix);
      if (!("cmd" in step)) throw new Error(`${entry.id}: ${step.note}`);
      managers.set(manager, { after: own, step: { id: own, label: entry.name, manager: entry.installRoad.road, ...step, bin: entry.bin } });
    }
    else throw new Error(`${manager} is neither in the base, nor in the catalog, nor a formula`);
  };
  for (const manager of MANAGER_ORDER) {
    if (rowsOf(manager).length + catalogRowsOf(manager).length + customOf(manager).length === 0) continue;
    resolveManager(manager);
  }
  // A catalog row that runs on another manager's toolchain resolves that manager here and not when the row is
  // planned: the step it brings may be a ticked row of the recipe's own, and what stands for a manager has to be
  // settled before the first row is planned or that row is planned twice.
  for (const { planned } of catalog) {
    const owner = managerBehind(depOf(planned));
    if (owner !== undefined) resolveManager(owner);
  }
  const catalogFormulae = catalog.flatMap(c => (c.planned.road.road === "brew" ? roadModule(c.planned.road).names(c.planned.road) : []));

  if (brew.taps.length + brew.formulae.length > 0 || managerFormulae.length + catalogFormulae.length + customOf("brew").length > 0) {
    installs.push({ id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: withPath(homebrewBootstrap(), path, prefix), shown: `git clone github.com/Homebrew/brew at ${HOMEBREW.tag}`, bin: "brew" });
    installs.push(...toolchain.steps);
    for (const t of brew.taps) installs.push({ id: `tools/brew-tap/${t}`, label: t, manager: "brew", cmd: withPath(asLinuxbrew(`tap ${t}`), path, prefix), shown: `brew tap ${t}`, after: toolchain.last, check: brewTapCheck(t) });
    const formulae = [...brew.formulae, ...managerFormulae, ...catalogFormulae];
    // The check reads the dependencies this step installs, not the formulae they belong to: a formula whose own
    // step failed is that row's failure, and this one did its work.
    if (formulae.length > 1) installs.push({ id: "tools/brew-shared", label: "shared Homebrew dependencies", manager: "brew", cmd: withPath(brewSharedDeps(formulae), path, prefix), shown: `brew install the dependencies ${formulae.join(", ")} share`, after: toolchain.last, check: brewSharedCheck(formulae) });
    for (const f of brew.formulae) installs.push({ id: `${BREW_ID_PREFIX}${f}`, label: f, manager: "brew", ...viaBrew(f, path, prefix), ...roadStepReads({ road: "brew", formula: f }, f, prefix), after: toolchain.last, pin: pinReadOf({ road: "brew", formula: f }, f, prefix) });
  }
  // What a row waits on: the apt index read once by its own step, Homebrew's toolchain, node for a road that runs on
  // it, the manager's step otherwise; a floor row is there already.
  const APT_STEP = `tools/${APT_INDEX}`;
  const afterDep = (dep: string | undefined, road: RoadName): string | undefined => {
    if (dep === APT_INDEX) {
      if (!installs.some(t => t.id === APT_STEP)) installs.push(aptIndexStep(APT_STEP, withPath(APT_UPDATE, path, prefix)));
      return APT_STEP;
    }
    if (dep === HOMEBREW_STEP) return toolchain.last;
    // A road that names a catalog row it runs on (npm's node) waits on the manager that row is the toolchain of,
    // whether or not the recipe has rows of that manager's own.
    const owner = managerBehind(dep);
    if (owner !== undefined) resolveManager(owner);
    return bringManager(owner ?? road);
  };
  const afterRoad = (road: RoadName): string | undefined => afterDep(ROAD_MODULES[road].after, road);
  // The manager's own steps, pushed the first time anything waits on them, so the step that brings a manager stands
  // ahead of every row that needs it whichever road asked.
  const brought = new Set<RoadName>();
  function bringManager(manager: RoadName): string | undefined {
    const brings = managers.get(manager);
    if (brings === undefined || brought.has(manager)) return brings?.after;
    brought.add(manager);
    if (brings.step !== undefined) {
      const after = afterRoad(brings.step.manager);
      installs.push(after === undefined ? brings.step : { ...brings.step, after });
    }
    if (brings.row !== undefined) plan(brings.row.e, brings.row.planned);
    return brings.after;
  }
  const plan = (e: RecipeEntry, planned: PlannedRow): void => {
    const step = viaRoad(planned.road, planned.bin ?? packageOf(e), path, prefix);
    if (!("cmd" in step)) {
      skipped.push({ id: e.id, note: step.note });
      return;
    }
    const after = afterDep(depOf(planned), planned.road.road);
    const bin = planned.bin ?? packageOf(e);
    installs.push({ id: e.id, label: e.label, manager: planned.road.road, ...step, ...roadReads(planned.road, bin, prefix), ...(after !== undefined ? { after } : {}), ...(planned.bin !== undefined ? { bin: planned.bin } : {}), ...(planned.note !== undefined ? { note: planned.note } : {}), ...asksOf(planned.road), pin: pinReadOf(planned.road, bin, prefix) });
  };
  // A catalog row that is a manager's own toolchain is planned with that manager, not again with the road it takes.
  const asManager = (id: string): boolean => [...managers.values()].some(m => m.row?.e.id === id);
  for (const manager of MANAGER_ORDER) {
    const rows = rowsOf(manager);
    const fromCatalog = catalogRowsOf(manager).filter(e => !asManager(e.id));
    if (rows.length + fromCatalog.length + customOf(manager).length === 0) continue;
    bringManager(manager);
    for (const e of rows) {
      const planned = rowRoad(e, table);
      if (planned !== undefined) plan(e, planned);
    }
    for (const e of fromCatalog) plan(e, rowRoad(e, table)!);
  }
  // Last, after any go the plan brings: a road install needs no brew and waits on nothing.
  for (const r of brew.roads) {
    const e = entries.find(x => x.id === r.id)!;
    plan(e, rowRoad(e, table)!);
  }
  // The catalog rows on every other road: Homebrew's (unless one went out as a manager's step above), apt's, a release, a vendor's, a script.
  for (const { e, planned } of catalog) if (!(MANAGER_ORDER as readonly string[]).includes(planned.road.road) && !asManager(e.id)) plan(e, planned);
  // Last of all: the rows the catalog does not carry, each after the manager its line calls, so every road they
  // lean on has already run.
  installs.push(...customInstallsFor(custom, c => {
    const road = managerRoad(c);
    return road === undefined ? undefined : afterRoad(road);
  }, path, prefix));
  return { installs, skipped, base: brew.base, brewfile: brew.text };
}

/** What a tools row is known by: the names its road gives the package (a formula is named after its command
 * unless the catalog says otherwise), the command the road puts on PATH, and the catalog's command and the ones it
 * brings along for a row the catalog knows. Nothing for a tap or a row no road installs. */
function rowNames(e: RecipeEntry, brew: BrewTable): string[] {
  if (e.rung !== "tools" || isTap(e)) return [];
  const planned = rowRoad(e, brew);
  const known = catalogToolFor(packageOf(e));
  return [...(planned === undefined ? [] : [...roadModule(planned.road).names(planned.road), ...(planned.bin === undefined ? [] : [planned.bin])]), ...(known === undefined ? [] : [known.bin, ...(known.brings ?? []).map(b => b.bin)])];
}

/** Every command the golden answers, for the pack's guard over the carried rc files: the base image's, the floor's,
 * the shell the shell rows bring, each ticked tools row by its names, the command each step of the tools plan puts
 * on PATH, and each ticked agent's command. An unticked row adds nothing: a call to it in an rc file is what the
 * guard covers. */
export function imageCommands(entries: readonly RecipeEntry[], tools: ToolsPlan, brew: BrewTable): Set<string> {
  const out = new Set(BASE_IMAGE_COMMANDS);
  for (const e of BASE_FLOOR) for (const bin of [e.bin, ...(e.brings ?? []).map(b => b.bin)]) out.add(bin);
  const shell = shellInstallFor(entries);
  if (shell !== undefined) out.add(shell.shell);
  for (const e of entries) {
    if (!ticked(e)) continue;
    if (e.rung === "agents" && !isMcpRow(e)) out.add(catalogEntry(name(e))?.bin ?? name(e));
    for (const n of rowNames(e, brew)) out.add(n);
  }
  for (const t of tools.installs) if (t.bin !== undefined) out.add(t.bin);
  return out;
}

/** Every command the recipe or the catalog knows a tool for, ticked or not: the catalog's tools by id and command,
 * and each tools row by its names. An oh-my-zsh plugin by one of these names, with the tool off the image, is a
 * plugin for a missing tool and leaves the list; a plugin by any other name is a plugin and stays. */
export function toolNames(entries: readonly RecipeEntry[], brew: BrewTable): Set<string> {
  const out = new Set<string>();
  for (const e of CATALOG_TOOLS) for (const bin of [e.id, e.bin, ...(e.brings ?? []).map(b => b.bin)]) out.add(bin);
  for (const e of entries) for (const n of rowNames(e, brew)) out.add(n);
  return out;
}

// --- shell -------------------------------------------------------------------

export type LoginShell = "zsh" | "fish";

export interface ShellInstall {
  /** The login shell the ticked rows belong to; chsh sets it for the guest's uid. */
  shell: LoginShell;
  /** The ticked framework rows reinstalled into their homes, in recipe order. */
  frameworks: string[];
  /** One bash -c script under set -e. */
  cmd: string;
}

/** A shell framework as a git checkout at a pinned commit under the home its rc
 * file expects; fetched by the commit itself, since none of them tags releases. */
export interface PinnedRepo {
  url: string;
  branch: string;
  commit: string;
  /** Relative to the guest's home. */
  home: string;
}

export const SHELL_FRAMEWORKS: Record<string, PinnedRepo> = {
  // https://github.com/ohmyzsh/ohmyzsh#manual-installation
  "shell/oh-my-zsh": { url: "https://github.com/ohmyzsh/ohmyzsh.git", branch: "master", commit: "421d95782d369f266b8087a0eae11eac2f6a6041", home: ".oh-my-zsh" },
  // https://github.com/zdharma-continuum/zinit#manual (the XDG home; the rc file's own installer keeps any other)
  "shell/zinit": { url: "https://github.com/zdharma-continuum/zinit.git", branch: "main", commit: "db9e267184c85a26056c2646222f48df609cecd5", home: ".local/share/zinit/zinit.git" },
  // https://github.com/zplug/zplug#manually
  "shell/zplug": { url: "https://github.com/zplug/zplug.git", branch: "main", commit: "cc6906ea7ea18a5058e8b4862d4086148434ddde", home: ".zplug" },
  // https://github.com/mattmc3/antidote#install
  "shell/antidote": { url: "https://github.com/mattmc3/antidote.git", branch: "main", commit: "db19ea3aa9ad83dbe6ac465ecce0a0afc5a752a5", home: ".antidote" },
};

/** Rows only zsh can read: its rc files, its prompt, and the frameworks above. */
const ZSH_ROWS = new Set(["shell/zshrc", "shell/zshenv", "shell/zprofile", "shell/zlogin", "shell/p10k", ...Object.keys(SHELL_FRAMEWORKS)]);

function pinnedClone(repo: PinnedRepo): string {
  const dir = `"$HOME/${repo.home}"`;
  return [
    `if [ ! -d ${dir}/.git ]; then`,
    `  git init -q ${dir}`,
    `  git -C ${dir} remote add origin ${repo.url}`,
    `  git -C ${dir} fetch -q --depth 1 origin ${repo.commit}`,
    // A kept builder may already hold the person's custom directory; the upload that follows puts it back.
    `  git -C ${dir} checkout -q -f -B ${repo.branch} FETCH_HEAD`,
    "fi",
    `test "$(git -C ${dir} rev-parse HEAD)" = "${repo.commit}"`,
  ].join("\n");
}

/** The shell the ticked rows are for and how the builder gets it: each ticked shell by apt,
 * each ticked framework at its pin, then chsh for the uid. With zsh and fish rows both ticked,
 * the computer's own login shell decides which one chsh sets, zsh when the collector could
 * not read it. Runs before the files land, so a framework's home is empty when its clone
 * arrives and the copied custom directory lands on top of it. */
export function shellInstallFor(entries: readonly RecipeEntry[]): ShellInstall | undefined {
  const shellRows = entries.filter(e => ticked(e) && e.rung === "shell");
  const zsh = shellRows.some(e => ZSH_ROWS.has(e.id));
  const fish = shellRows.some(e => e.id === "shell/fish");
  if (!zsh && !fish) return undefined;
  const login = entries.find(e => e.rung === "shell" && e.login !== undefined)?.login;
  const shell: LoginShell = fish && (!zsh || login === "fish") ? "fish" : "zsh";
  const frameworks = shellRows.map(e => e.id).filter(id => id in SHELL_FRAMEWORKS);
  const lines = [PRELUDE, APT_ENV];
  if (zsh) lines.push(APT("zsh"));
  if (fish) lines.push(APT("fish"));
  if (frameworks.length > 0) lines.push(APT("git"), ...frameworks.map(id => pinnedClone(SHELL_FRAMEWORKS[id]!)));
  // Debian's zprofile is empty, so a zsh login shell would skip the PATH and BROWSER lines the golden puts in profile.d.
  if (zsh) lines.push(`grep -qs 'source /etc/profile' /etc/zsh/zprofile || printf '%s\\n' "emulate sh -c 'source /etc/profile'" >> /etc/zsh/zprofile`);
  lines.push(`chsh -s "$(command -v ${shell})" "$(id -un)"`);
  return { shell, frameworks, cmd: lines.join("\n") };
}

// --- agents ------------------------------------------------------------------

export interface AgentInstaller {
  name: string;
  /** One bash -c script under set -e; may span lines. */
  install: string;
  /** Exits 0 once the agent is on the machine. */
  smoke: string;
  /** The road the install line walks, which is what bounds a step running it. */
  road: RoadName;
  /** The lowest Node major its package's engines field accepts; absent when it declares none. */
  node?: number;
  /** How the agent's installed version is read back and whether a copy gets it; absent for an installer outside the catalog. */
  pin?: PinRead;
}

export interface AgentInstall extends AgentInstaller {
  id: string;
}

/** An agent's installer as the catalog gives it: its road's line, its version check, its Node floor and its pin read. */
function agentInstaller(a: AgentEntry): AgentInstaller {
  return { name: a.name, install: installLine(a), smoke: smokeOf(a), road: a.installRoad.road, ...(a.node !== undefined ? { node: a.node } : {}), pin: pinReadOf(a.installRoad, a.bin) };
}

/** The line a guest gets when no supported pinned major meets an agent's floor. */
export const CURRENT_LTS: NodeMajor = 22;

/** The major a set of engines floors gets: the lowest pinned major at or above the
 * floor that is still in active or maintenance support on `now`, else the current
 * LTS; nothing when the floor is above every pinned major. */
export function nodeMajorFor(floor: number, now: Date): NodeMajor | undefined {
  const majors = (Object.keys(NODE_RELEASES).map(Number) as NodeMajor[]).sort((a, b) => a - b);
  if (floor > majors.at(-1)!) return undefined;
  const supported = (m: NodeMajor): boolean => now.getTime() < Date.parse(`${NODE_RELEASES[m].eol}T23:59:59Z`);
  return majors.find(m => m >= floor && supported(m)) ?? CURRENT_LTS;
}

/** Every installer pins a version; npm checks the registry's integrity hash for each tarball, uv is checksummed
 * by its release, git checkouts compare the commit. The catalog's agents install by their roads. Aider is not a
 * catalog agent; its line stays for recipes that tick it: https://aider.chat/docs/install.html, the uv tool line. */
export function agentInstallers(agents: readonly AgentEntry[]): Record<string, AgentInstaller> {
  return {
    ...Object.fromEntries(agents.map(a => [a.id, agentInstaller(a)])),
    aider: { name: "Aider", install: `${UV_INSTALL}\nuv tool install --force --python 3.12 --with pip aider-chat==0.86.2`, smoke: "aider --version", road: "uv" },
  };
}

export const AGENT_INSTALLERS: Record<string, AgentInstaller> = agentInstallers(CATALOG_AGENTS);

/** The package an installer's npm or uv line puts on the machine, read off the line's pinned spec. */
const NPM_INSTALL_LINE = /^npm install -g (?:--ignore-scripts )?(\S+?)@\S+$/m;
const UV_INSTALL_LINE = /^uv tool install .*?([\w.-]+)==[\w.-]+$/m;

/** The Node major the catalog's own row pins, for an install that runs on node and names no floor of its own. */
const CATALOG_NODE_MAJOR = Number(catalogToolFor("node")?.major?.version ?? 0);

/** The one file a pinned binary's install line puts on the machine, which is its inverse. */
const INSTALLED_BINARY_LINE = /^install -D -m 0755 \S+ (\S+)$/m;

/** The inverse of an installer, read off its install line: an npm global is
 * uninstalled, a uv tool uninstalled, Hermes's checkout and venv removed, a
 * pinned binary's one file taken off; anything else is noted. */
export function agentUninstall(installer: AgentInstaller): { cmd: string } | { note: string } {
  const npm = NPM_INSTALL_LINE.exec(installer.install);
  if (npm !== null) return { cmd: `${NODE_PATH_LINE}\nnpm uninstall -g ${npm[1]}` };
  const uv = UV_INSTALL_LINE.exec(installer.install);
  if (uv !== null) return { cmd: `uv tool uninstall ${uv[1]}` };
  if (installer.install.includes("/root/.hermes/")) return { cmd: "rm -rf /root/.hermes/venvs/hermes /root/.hermes/hermes-agent /usr/local/bin/hermes" };
  const binary = INSTALLED_BINARY_LINE.exec(installer.install);
  if (binary !== null) return { cmd: `rm -f ${binary[1]}` };
  return { note: `${installer.name} has no uninstaller; left on the machine` };
}

/** The one Node step a golden gets when a ticked agent's engines floor may be
 * above the base image's: the lowest pinned major that satisfies every ticked agent. */
export interface NodeInstall {
  floor: number;
  version: string;
  /** The agents whose engines asked for it, in recipe order. */
  agents: string[];
  cmd: string;
}

/** The package each agent installer puts on the machine through a manager the tools rung also lists, as that rung's row id. */
const AGENT_TOOL_ROWS: ReadonlyMap<string, string> = new Map(
  Object.entries(AGENT_INSTALLERS).flatMap(([agent, a]) => {
    const npm = NPM_INSTALL_LINE.exec(a.install)?.[1];
    const uv = UV_INSTALL_LINE.exec(a.install)?.[1];
    return [...(npm !== undefined ? [[toolRowId("npm", npm), agent] as const] : []), ...(uv !== undefined ? [[toolRowId("uv", uv), agent] as const] : [])];
  }),
);

/** The agent whose installer would put this tools row's package on the machine a second time, by id. */
export function agentOwning(toolId: string): string | undefined {
  return AGENT_TOOL_ROWS.get(toolId);
}

export interface AgentsPlan {
  installs: AgentInstall[];
  skipped: SkippedItem[];
  node?: NodeInstall;
}

/** The installer a row with a recorded pin gets: the catalog's road fixed to the pin's version where the road takes
 * one, so a copy installs what the seal read; the catalog's own line where it does not, or where the pin is a
 * latest mark. */
function pinnedInstaller(a: AgentEntry, pin: ToolPin | undefined): AgentInstaller {
  const at = pin === undefined || pin.latest === true ? undefined : roadModule(a.installRoad).at?.(a.installRoad, pin.tag);
  return agentInstaller(at === undefined ? a : { ...a, installRoad: at });
}

/** The ticked agents with an installer, in recipe order, from the installers of `agents`, the catalog's by default;
 * a row carrying a pin installs at it. */
export function agentInstallsFor(entries: readonly RecipeEntry[], agents: readonly AgentEntry[] = CATALOG_AGENTS, now: Date = new Date()): AgentsPlan {
  const table = agentInstallers(agents);
  const out: AgentsPlan = { installs: [], skipped: [] };
  // Node is not on the floor, so an agent whose own installer is an npm global asks for it here even where its
  // package declares no floor of its own: the road it takes says it runs on node.
  const onNode = new Set<string>();
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "agents" || isMcpRow(e)) continue;
    const entry = agents.find(a => a.id === name(e));
    const installer = entry !== undefined ? pinnedInstaller(entry, e.pin) : table[name(e)];
    if (installer) {
      out.installs.push({ id: e.id, ...installer });
      const road = entry === undefined ? undefined : ROAD_MODULES[entry.installRoad.road].after;
      if (entry === undefined ? NPM_INSTALL_LINE.test(installer.install) : managerBehind(road) !== undefined) onNode.add(e.id);
    } else out.skipped.push({ id: e.id, note: "no installer known" });
  }
  // An agent whose floor no pinned major meets is set aside rather than installed on a Node its engines refuse.
  const pinnable = out.installs.filter(a => {
    if (a.node === undefined || nodeMajorFor(a.node, now) !== undefined) return true;
    out.skipped.push({ id: a.id, note: `needs Node ${a.node}, none pinned` });
    return false;
  });
  out.installs = pinnable;
  const floors = out.installs.filter(a => a.node !== undefined);
  const needs = out.installs.filter(a => a.node !== undefined || onNode.has(a.id));
  const floor = floors.length > 0 ? Math.max(...floors.map(a => a.node!)) : CATALOG_NODE_MAJOR;
  const major = nodeMajorFor(floor, now);
  if (needs.length > 0 && major !== undefined) {
    const release = NODE_RELEASES[major];
    out.node = { floor, version: release.version, agents: needs.map(a => a.name), cmd: nodeInstallScript(floor, release) };
  }
  return out;
}

/** Where the Node install is filed when the agents ride the one tools loop, so an agent step waits on it by name. */
export const AGENT_NODE_STEP = "agents/node";

/** Whether the node on the machine already meets an agents plan's floor, read the way the install script reads it
 * so the two cannot disagree: the step keeps such a node and installs nothing, so this is also what says the step
 * has nothing to do on a computer that has been provisioned before. */
export const nodeFloorCheck = (floor: number): string =>
  `major="$(node --version 2>/dev/null | sed 's/^v//; s/\\..*//')"; [ "\${major:-0}" -ge ${floor} ]`;

/** An agents plan as steps of the one tools loop: the node step first, then each agent, waiting on that step
 * where its road runs on node. The install line runs on the tools PATH with the Node the step installed ahead of
 * it, the agent's own version check is the step's check, the catalog's command is its bin and the version the
 * catalog's road pins is what the step asks for, so a computer that already answers at that version installs
 * nothing. The road is the step's manager, which is what bounds the run.
 *
 * The plan's own skipped rows are not here: they never became steps, and whoever runs the plan reports them. */
export function agentSteps(plan: AgentsPlan, agents: readonly AgentEntry[] = CATALOG_AGENTS, path: string = TOOLS_PATH, prefix?: string): ToolInstall[] {
  const out: ToolInstall[] = [];
  const node = plan.node;
  if (node !== undefined) {
    out.push({ id: AGENT_NODE_STEP, label: `Node ${node.version}`, manager: "script", cmd: node.cmd, shown: `Node ${node.version} for ${node.agents.join(", ")}`, check: nodeFloorCheck(node.floor) });
  }
  for (const a of plan.installs) {
    const entry = agents.find(e => e.id === name(a));
    const waits = node !== undefined && managerBehind(ROAD_MODULES[a.road].after) !== undefined ? { after: AGENT_NODE_STEP } : {};
    out.push({
      id: a.id,
      label: a.name,
      manager: a.road,
      cmd: `${pathLine(path, prefix)}\n${NODE_PATH_LINE}\n${a.install}`,
      shown: shownOf(a.install.split("\n")),
      check: a.smoke,
      ...waits,
      ...(entry === undefined ? {} : { bin: entry.bin, ...roadReads(entry.installRoad, entry.bin, prefix), ...asksOf(entry.installRoad) }),
      ...(a.pin === undefined ? {} : { pin: a.pin }),
    });
  }
  return out;
}
