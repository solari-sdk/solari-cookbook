// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ROOT, sourceFiles } from "../../protocol/test/source-files.js";
import { describeDiff, diffRecipes, isEmptyDiff } from "../src/golden-diff.js";
import { withRecordedPins } from "../src/golden-tools.js";
import { CATALOG_AGENTS, CLAUDE_INSTALL, LOCAL_BIN, ROAD_MODULES, ROAD_STEPS, baseNote, catalogEntry as catalogEntryOf, parseJsonc } from "@wsp/catalog";
import {
  rowRoad,
  UNMEASURED_ROAD,
  PATH_LINE,
  CATALOG_PREFIX,
  AGENT_INSTALLERS,
  AGENT_NODE_STEP,
  agentSteps,
  nodeFloorCheck,
  NODE_PATH_LINE,
  CURRENT_LTS,
  NODE_RELEASES,
  agentInstallsFor,
  agentUninstall,
  agentOwning,
  brewfileFor,
  copiedLoginDests,
  dropGhAccount,
  ghAccounts,
  HOMEBREW,
  nodeInstallScript,
  neverCopied,
  nodeMajorFor,
  placeGhToken,
  planFiles,
  recipeDigest,
  recipeHash,
  refusedPath,
  secretKey,
  secretPath,
  withApiKeyHelper,
  withImagePaths,
  imagePath,
  SHELL_FRAMEWORKS,
  imageCommands,
  shellInstallFor,
  toolNames,
  toolInstallsFor,
  toolUninstall,
  brewHousekeeping,
  TOOLS_PATH,
  type BrewTable,
  type DigestedFile,
  type PathInfo,
  type RecipeDigest,
  type RecipeEntry,
} from "../src/golden-import.js";
import { BREW, BREW_PREFIX, BREW_REAL, BREW_REPO, KUBECTL, LINUXBREW_HOME, LINUXBREW_SHIM, MAC_ONLY, catalogEntry } from "@wsp/catalog";
import { HOMEBREW_PREFIX, shellQuote } from "@wsp/protocol";

const row = (over: Partial<RecipeEntry> & Pick<RecipeEntry, "rung" | "id">): RecipeEntry => ({
  label: over.id,
  paths: [],
  bytes: 0,
  default: "bring",
  bring: true,
  ...over,
});

/** A plan's base rows as a reader reports them: the row's id and name, and the note built for the computer read. */
const baseRows = (plan: { base: readonly { id: string; name: string; entry: Parameters<typeof baseNote>[0]; version?: string }[] }, platform: "darwin" | "linux" = "darwin"): [string, string, string][] =>
  plan.base.map(b => [b.id, b.name, baseNote(b.entry, b.version, platform)]);

const homebrewStep = (): string => toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" })]).installs.find(i => i.id === "tools/homebrew")!.cmd;

const HOME = "/Users/me";
const present = new Set([
  `${HOME}/.gitconfig`,
  `${HOME}/.ssh`,
  `${HOME}/.ssh/config`,
  `${HOME}/.ssh/id_ed25519`,
  `${HOME}/.ssh/id_ed25519.pub`,
  `${HOME}/.ssh/known_hosts`,
  `${HOME}/.ssh/keys`,
  `${HOME}/.zshrc`,
  `${HOME}/.local/bin/deploy`,
  `${HOME}/.local/bin/omp`,
  `${HOME}/.local/bin/agent`,
  `${HOME}/.config/starship.toml`,
  `${HOME}/.oh-my-zsh/custom`,
  `${HOME}/Library/Application Support/Cursor/User/settings.json`,
  `${HOME}/Library/Application Support/Code/User/settings.json`,
  `${HOME}/.config/Code/User/settings.json`,
  `${HOME}/.config/Cursor/User/settings.json`,
  `${HOME}/Library/Application Support/Code - Insiders/User/settings.json`,
  `${HOME}/.config/zed`,
  `${HOME}/Library/Preferences/.wrangler/config/default.toml`,
  `${HOME}/.claude`,
  `${HOME}/.claude/settings.json`,
  `${HOME}/.claude.json`,
  `${HOME}/.config/gh/hosts.yml`,
  `${HOME}/.codex/auth.json`,
  `${HOME}/dotfiles/zshrc`,
  `${HOME}/.config/demo`,
  `${HOME}/.config/demo/settings.toml`,
  `${HOME}/.config/demo/cache`,
  `${HOME}/.demo-token`,
  `${HOME}/.env`,
  `${HOME}/.netrc`,
  `${HOME}/.app/.env.local`,
  `${HOME}/.hermes/.env`,
  `${HOME}/proj/.env`,
]);
/** Links on the fixture laptop: where each resolves, or nowhere. */
const links: Record<string, string | undefined> = {
  [`${HOME}/.zshrc-linked`]: `${HOME}/dotfiles/zshrc`,
  [`${HOME}/.hosts-linked`]: "/etc/hosts",
  [`${HOME}/.key-linked`]: `${HOME}/.ssh/id_ed25519`,
  [`${HOME}/.gone-linked`]: undefined,
};
const isDir = (abs: string) => abs.endsWith("custom") || abs.endsWith("/.ssh") || abs.endsWith("/.ssh/keys") || abs.endsWith("/.claude") || abs.endsWith("/.config/demo") || abs.endsWith("/.config/zed") || abs.endsWith("/demo/cache") || abs.endsWith("/proj/.env");
const stat = (abs: string): PathInfo | undefined => {
  if (abs in links) {
    const target = links[abs];
    if (target === undefined) return { kind: "dangling", target: `${HOME}/nowhere` };
    return { kind: "file", mode: 0o644, size: 7, mtimeMs: 7_000, realpath: target };
  }
  if (!present.has(abs)) return undefined;
  const mode = isDir(abs) || abs.includes("/.local/bin/") ? 0o755 : abs.includes("/.ssh/") || abs.endsWith("auth.json") || abs.endsWith("-token") || abs.endsWith("/.netrc") ? 0o600 : 0o644;
  return { kind: isDir(abs) ? "dir" : "file", mode, size: abs.length, mtimeMs: 1_000, realpath: abs };
};
const plan = (entries: RecipeEntry[], over: { platform?: "darwin" | "linux"; rewrites?: readonly [string, string][] } = {}) =>
  planFiles(entries, { home: HOME, stat, platform: over.platform ?? "darwin", ...(over.rewrites !== undefined ? { rewrites: over.rewrites } : {}) });

describe("planFiles: which laptop files travel and where they land", () => {
  it("maps ~ paths to guest-home relative destinations, keeping the mode the laptop has", () => {
    const p = plan([
      row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"], bytes: 225 }),
      row({ rung: "shell", id: "shell/starship", paths: ["~/.config/starship.toml"], bytes: 2258 }),
      row({ rung: "shell", id: "shell/oh-my-zsh", paths: ["~/.oh-my-zsh/custom"], bytes: 1_031_384 }),
      row({ rung: "identity", id: "identity/ssh-config", paths: ["~/.ssh/config"], bytes: 2267 }),
    ]);
    expect(p.files).toEqual([
      { id: "identity/git-user", rung: "identity", source: `${HOME}/.gitconfig`, dest: ".gitconfig", mode: 0o644, dir: false, excludes: [], volatile: false },
      { id: "shell/starship", rung: "shell", source: `${HOME}/.config/starship.toml`, dest: ".config/starship.toml", mode: 0o644, dir: false, excludes: [], volatile: false },
      { id: "shell/oh-my-zsh", rung: "shell", source: `${HOME}/.oh-my-zsh/custom`, dest: ".oh-my-zsh/custom", mode: 0o755, dir: true, excludes: [], volatile: false },
      { id: "identity/ssh-config", rung: "identity", source: `${HOME}/.ssh/config`, dest: ".ssh/config", mode: 0o600, dir: false, excludes: [], volatile: false },
    ]);
    expect(p.bytes).toBe(225 + 2258 + 1_031_384 + 2267);
    expect(p.rungs).toEqual({ identity: 2, shell: 2 });
    expect(p.skipped).toEqual([]);
    expect(p.secrets).toEqual([]);
  });

  it("brings nothing that is unticked, a list row (tools), or a login not chosen as copy", () => {
    const p = plan([
      row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"], bring: false }),
      row({ rung: "tools", id: "tools/brew/gh", paths: ["Brewfile"] }),
      row({ rung: "logins", id: "logins/codex", paths: ["~/.codex/auth.json"], choice: "machine" }),
      row({ rung: "logins", id: "logins/gcloud", paths: ["~/.config/gcloud/credentials.db"], choice: "skip" }),
      row({ rung: "logins", id: "logins/codex2", paths: ["~/.codex/auth.json"] }),
    ]);
    expect(p.files).toEqual([]);
    expect(p.skipped).toEqual([]);
  });

  it("a tools row never travels as a file, whatever paths it carries", () => {
    const p = plan([
      row({ rung: "tools", id: "tools/go/gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"] }),
      row({ rung: "tools", id: "tools/nix-home-manager", paths: ["~/.config/home-manager"] }),
      row({ rung: "tools", id: "tools/hand/deploy", paths: ["~/.local/bin/deploy"], linux: "yes" }),
    ]);
    expect(p.files).toEqual([]);
    expect(p.skipped).toEqual([]);
    expect(p.rungs).toEqual({});
  });

  it("a login chosen as copy travels with its mode", () => {
    const p = plan([row({ rung: "logins", id: "logins/codex", paths: ["~/.codex/auth.json"], choice: "copy", bytes: 205 })]);
    expect(p.files.map(f => [f.dest, f.mode])).toEqual([[".codex/auth.json", 0o600]]);
  });

  it("never includes a private key, known_hosts, GPG, or the .ssh directory itself, even when a recipe says bring", () => {
    const p = plan([
      row({ rung: "identity", id: "identity/ssh-key/id_ed25519", paths: ["~/.ssh/id_ed25519"], default: "skip", reason: "private key", bring: true }),
      row({ rung: "identity", id: "identity/gpg", paths: ["~/.gnupg"], bring: true }),
      row({ rung: "shell", id: "shell/odd", paths: ["~/.ssh/id_rsa"], bring: true }),
      row({ rung: "identity", id: "identity/ssh-public-keys", paths: ["~/.ssh/id_ed25519.pub"], required: true }),
      row({ rung: "identity", id: "identity/ssh-dir", paths: ["~/.ssh"] }),
      row({ rung: "identity", id: "identity/ssh-known", paths: ["~/.ssh/known_hosts"] }),
      row({ rung: "identity", id: "identity/ssh-extra", paths: ["~/.ssh/keys"] }),
    ]);
    expect(p.files.map(f => f.dest)).toEqual([".ssh/id_ed25519.pub"]);
    expect(p.skipped.map(s => [s.path, s.note])).toEqual([
      ["~/.ssh/id_ed25519", "private key, never copied"],
      ["~/.gnupg", "GPG keys are never copied"],
      ["~/.ssh/id_rsa", "private key, never copied"],
      ["~/.ssh", "the .ssh directory is never copied whole; tick its config and public keys"],
      ["~/.ssh/known_hosts", "known_hosts is never copied"],
      ["~/.ssh/keys", "a directory under .ssh is never copied whole"],
    ]);
    expect(refusedPath(".ssh/config", false)).toBeUndefined();
    expect(refusedPath(".ssh/config", true)).toBe("a directory under .ssh is never copied whole");
  });

  it("follows a linked dotfile to a target inside home, and refuses one that leaves home, points at a refused path, or is gone", () => {
    const p = plan([
      row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc-linked"], bytes: 7 }),
      row({ rung: "shell", id: "shell/hosts", paths: ["~/.hosts-linked"] }),
      row({ rung: "shell", id: "shell/key", paths: ["~/.key-linked"] }),
      row({ rung: "shell", id: "shell/gone", paths: ["~/.gone-linked"] }),
    ]);
    // The target's bytes ship at the link's path: dest is the link, source is the link (packing follows it).
    expect(p.files).toEqual([{ id: "shell/zshrc", rung: "shell", source: `${HOME}/.zshrc-linked`, dest: ".zshrc-linked", mode: 0o644, dir: false, excludes: [], volatile: false }]);
    expect(p.skipped).toEqual([
      { id: "shell/hosts", path: "~/.hosts-linked", note: "a link to /etc/hosts, outside your home directory" },
      { id: "shell/key", path: "~/.key-linked", note: "a link to ~/.ssh/id_ed25519: private key, never copied" },
      { id: "shell/gone", path: "~/.gone-linked", note: "a link to ~/nowhere, which is gone" },
    ]);
  });

  it("a row whose file no longer exists is skipped with a note; a path outside ~ too", () => {
    const p = plan([
      row({ rung: "shell", id: "shell/bashrc", paths: ["~/.bashrc"] }),
      row({ rung: "shell", id: "shell/etc", paths: ["/etc/vimrc"] }),
    ]);
    expect(p.files).toEqual([]);
    expect(p.skipped).toEqual([
      { id: "shell/bashrc", path: "~/.bashrc", note: "no longer on this computer" },
      { id: "shell/etc", path: "/etc/vimrc", note: "not under your home directory" },
    ]);
  });

  it("rewrites macOS library paths to their Linux XDG homes, and applies the caller's rewrites first", () => {
    const p = plan(
      [
        row({ rung: "shell", id: "shell/cursor", paths: ["~/Library/Application Support/Cursor/User/settings.json"] }),
        row({ rung: "logins", id: "logins/wrangler", paths: ["~/Library/Preferences/.wrangler/config/default.toml"], choice: "copy" }),
        row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"] }),
      ],
      { rewrites: [[".claude/", ".claude-cfg/"], [".claude.json", ".claude-cfg/.claude.json"]] },
    );
    expect(p.files.map(f => f.dest)).toEqual([
      ".config/Cursor/User/settings.json",
      ".config/.wrangler/config/default.toml",
      ".claude-cfg/settings.json",
      ".claude-cfg/.claude.json",
    ]);
    // A row that names the directory itself moves with it; the guest's config dir is what CLAUDE_CONFIG_DIR reads.
    const bare = plan([row({ rung: "agents", id: "agents/claude", paths: ["~/.claude"] })], { rewrites: [[".claude/", ".claude-cfg/"]] });
    expect(bare.files.map(f => [f.dest, f.dir])).toEqual([[".claude-cfg", true]]);
  });

  it("a Keychain item becomes a secret to read at pack time on macOS, and a skip note elsewhere", () => {
    const rows = [row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" })];
    const mac = plan(rows);
    expect(mac.secrets.map(s => [s.id, s.service, s.dest])).toEqual([["logins/gh", "gh:github.com", ".config/gh/hosts.yml"]]);
    expect(mac.files.map(f => f.dest)).toEqual([".config/gh/hosts.yml"]);

    const linux = plan(rows, { platform: "linux" });
    expect(linux.secrets).toEqual([]);
    expect(linux.skipped).toEqual([{ id: "logins/gh", path: "Keychain: gh:github.com", note: "a macOS Keychain item; sign in on the machine" }]);
  });

  it("the Claude credential never travels on either platform: its row's token is minted on this computer and nothing of it is copied", () => {
    const note = "claude setup-token on this computer holds this login as a token; nothing of it travels";
    const claude = row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials", "Helper: ~/.claude/settings.json"], choice: "copy" });
    const settings = '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w", "model": "opus"}';
    for (const platform of ["darwin", "linux"] as const) {
      const p = planFiles([claude], { home: HOME, stat, platform, read: () => settings, rewrites: [[".claude/", ".claude-cfg/"]] });
      expect(p.secrets).toEqual([]);
      expect(p.files).toEqual([]);
      expect(p.skipped).toEqual([
        { id: "logins/claude", path: "Keychain: Claude Code-credentials", note },
        { id: "logins/claude", path: "Helper: ~/.claude/settings.json", note },
      ]);
    }
  });

  it("nothing the pack copies lands a Claude Code login: the dests it carries are the ones the image vault archives", () => {
    expect(copiedLoginDests().some(d => d.startsWith(".claude"))).toBe(false);
    expect(copiedLoginDests()).toEqual([".config/gh/hosts.yml"]);
  });

  it("a Keychain read is planned only for a Keychain: path the row carries; a gh row with hosts.yml alone reads nothing", () => {
    const p = plan([row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" })]);
    expect(p.secrets).toEqual([]);
    expect(p.files.map(f => f.dest)).toEqual([".config/gh/hosts.yml"]);
    expect(p.skipped).toEqual([]);
  });

  it("the Keychain: prefix is read whatever its case, as the collector's claims are", () => {
    const p = plan([row({ rung: "logins", id: "logins/gh", paths: ["keychain:gh:github.com"], choice: "copy" })]);
    expect(p.secrets.map(s => [s.id, s.service, s.dest])).toEqual([["logins/gh", "gh:github.com", ".config/gh/hosts.yml"]]);
    expect(p.skipped).toEqual([]);
  });

  it("a Keychain: path for a login the table has no reader for is a note, not a silent drop", () => {
    const p = plan([row({ rung: "logins", id: "logins/glab", paths: ["Keychain: glab:gitlab.com"], choice: "copy" })]);
    expect(p.secrets).toEqual([]);
    expect(p.skipped).toEqual([{ id: "logins/glab", path: "Keychain: glab:gitlab.com", note: "no Keychain reader for this login yet; sign in on the machine" }]);
  });

  it("a Helper: path plans nothing: the key an apiKeyHelper prints outranks the vault's token inside the tool, so no helper key travels", () => {
    expect(secretPath({ service: "gh:github.com", account: "Zingzy" })).toBe("Keychain: gh:github.com (Zingzy)");
    const unknown = planFiles([row({ rung: "logins", id: "logins/x", paths: ["Helper: ~/.x/settings.json"], choice: "copy" })], { home: HOME, stat, platform: "darwin", read: () => "{}" });
    expect(unknown.secrets).toEqual([]);
    expect(unknown.skipped).toEqual([{ id: "logins/x", path: "Helper: ~/.x/settings.json", note: "no helper reader for this login yet; sign in on the machine" }]);
  });

  it("withApiKeyHelper points a copied settings.json at the key file on the machine, drops the helper when no key travels, and leaves a file without one alone", () => {
    const settings = '{\n  "apiKeyHelper": "security find-generic-password -s anthropic-api-key -w",\n  "model": "opus"\n}\n';
    expect(withApiKeyHelper(settings, "cat /root/.claude-cfg/anthropic-api-key")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key",\n  "model": "opus"\n}\n');
    expect(withApiKeyHelper(settings, undefined)).toBe('{\n  "model": "opus"\n}\n');
    expect(withApiKeyHelper(undefined, "cat /root/.claude-cfg/anthropic-api-key")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key"\n}\n');
    for (const text of ['{"model": "opus"}', "{ not json", ""]) expect(withApiKeyHelper(text, undefined)).toBe(text);
    expect(withApiKeyHelper("{ not json", "cat x")).toBe("{ not json");
  });

  it("withApiKeyHelper edits a settings.json with comments in place, every comment of the person's standing", () => {
    const settings = '{\n  // my settings\n  "apiKeyHelper": "security find-generic-password -w", // on the Mac\n  /* the model */\n  "model": "opus"\n}\n// the end\n';
    expect(withApiKeyHelper(settings, "cat /root/key")).toBe(settings.replace("security find-generic-password -w", "cat /root/key"));
    // The comment lines right above the helper and the one at the end of its line are the helper's, and go with it.
    const dropped = withApiKeyHelper(settings, undefined)!;
    expect(dropped).toBe('{\n  /* the model */\n  "model": "opus"\n}\n// the end\n');
    expect(parseJsonc(dropped)).toEqual({ model: "opus" });
  });

  it("places and drops a gh account in a hosts.yml full of comments, and keeps every comment outside the account it took out", () => {
    const mac = ["# my hosts", "github.com:", "# written by gh", "    git_protocol: ssh # ssh for me", "    users:", "        # the work one", "        other:", "            # its token", "        Zingzy: # me", "    user: Zingzy", "# the end", ""].join("\n");
    const placed = placeGhToken("github.com", "gho_z", mac, "Zingzy");
    for (const c of ["# my hosts", "# written by gh", "# ssh for me", "# the work one", "# its token", "# me", "# the end"]) expect(placed, c).toContain(c);
    expect(ghAccounts(placed, "github.com")).toEqual({ users: ["other", "Zingzy"], active: "Zingzy" });
    expect(placed).toContain("    oauth_token: gho_z\n");
    expect(placed).toContain("        Zingzy: # me\n            oauth_token: gho_z\n");
    const dropped = dropGhAccount("github.com", mac, "other");
    for (const c of ["# my hosts", "# written by gh", "# ssh for me", "# the work one", "# me", "# the end"]) expect(dropped, c).toContain(c);
    expect(ghAccounts(dropped, "github.com")).toEqual({ users: ["Zingzy"], active: "Zingzy" });
  });

  it("a Keychain login not chosen as copy is neither read nor noted", () => {
    const p = plan([row({ rung: "logins", id: "logins/gh", paths: ["Keychain: gh:github.com"], choice: "machine" })]);
    expect(p.secrets).toEqual([]);
    expect(p.skipped).toEqual([]);
  });

  it("plans one gh item per account hosts.yml lists, each placing its own token under its user and the active one under the host; another host keeps its own lines", () => {
    const mac = ["github.com:", "    git_protocol: ssh", "    users:", "        other:", "        Zingzy:", "    user: Zingzy", ""].join("\n");
    expect(ghAccounts(mac, "github.com")).toEqual({ users: ["other", "Zingzy"], active: "Zingzy" });
    expect(ghAccounts(mac, "ghe.corp.example")).toEqual({ users: [] });
    const read = (abs: string) => (abs === `${HOME}/.config/gh/hosts.yml` ? mac : undefined);
    const gh = row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" });
    const p = planFiles([gh], { home: HOME, stat, platform: "darwin", read });
    expect(p.secrets.map(s => [s.id, s.service, s.account, s.dest])).toEqual([
      ["logins/gh", "gh:github.com", "other", ".config/gh/hosts.yml"],
      ["logins/gh", "gh:github.com", "Zingzy", ".config/gh/hosts.yml"],
    ]);
    expect(p.secrets.map(secretKey)).toEqual(["gh:github.com (other)", "gh:github.com (Zingzy)"]);
    const existing = ["ghe.corp.example:", "    oauth_token: ghe_theirs", "    git_protocol: ssh", "    users:", "        me:", "    user: me", ...mac.split("\n")].join("\n");
    // The pack places them in turn, each on the other's result.
    const placed = p.secrets[1]!.place("gho_zingzy", p.secrets[0]!.place("gho_other", existing));
    expect(placed).toBe(
      [
        "ghe.corp.example:",
        "    oauth_token: ghe_theirs",
        "    git_protocol: ssh",
        "    users:",
        "        me:",
        "    user: me",
        "github.com:",
        "    oauth_token: gho_zingzy",
        "    git_protocol: ssh",
        "    users:",
        "        other:",
        "            oauth_token: gho_other",
        "        Zingzy:",
        "            oauth_token: gho_zingzy",
        "    user: Zingzy",
        "",
      ].join("\n"),
    );
    // Placed again with fresher tokens, the old lines go and nothing doubles.
    expect(p.secrets[1]!.place("gho_z2", p.secrets[0]!.place("gho_o2", placed))).toBe(placed.replace(/gho_zingzy/g, "gho_z2").replace("gho_other", "gho_o2"));
    // A file without the host gets a block with the account's token under its user alone: nothing marked it active.
    expect(p.secrets[1]!.place("gho_zingzy", undefined)).toBe(["github.com:", "    git_protocol: https", "    users:", "        Zingzy:", "            oauth_token: gho_zingzy", ""].join("\n"));
    expect(placeGhToken("github.com", "gho_zingzy", "ghe.corp.example:\n    user: me\n", "Zingzy")).toBe(["ghe.corp.example:", "    user: me", "github.com:", "    git_protocol: https", "    users:", "        Zingzy:", "            oauth_token: gho_zingzy", ""].join("\n"));
  });

  it("drops an account from hosts.yml: its lines leave the users block, the active mark moves to the first account left, another host is untouched", () => {
    const mac = ["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", "    users:", "        other:", "            git_protocol: https", "        Zingzy:", "    user: Zingzy", ""].join("\n");
    const read = (abs: string) => (abs === `${HOME}/.config/gh/hosts.yml` ? mac : undefined);
    const gh = row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" });
    const p = planFiles([gh], { home: HOME, stat, platform: "darwin", read });
    expect(p.secrets.map(s => s.account)).toEqual(["other", "Zingzy"]);
    // The inactive account goes with its nested lines; the active one keeps the host.
    const withoutOther = p.secrets[0]!.drop!(mac);
    expect(withoutOther).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", "    users:", "        Zingzy:", "    user: Zingzy", ""].join("\n"));
    expect(ghAccounts(withoutOther, "github.com")).toEqual({ users: ["Zingzy"], active: "Zingzy" });
    // The active account goes and the one left becomes active, so its token lands under the host too.
    const withoutZingzy = p.secrets[1]!.drop!(mac);
    expect(withoutZingzy).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", "    users:", "        other:", "            git_protocol: https", "    user: other", ""].join("\n"));
    expect(p.secrets[0]!.place("gho_other", withoutZingzy)).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    oauth_token: gho_other", "    git_protocol: ssh", "    users:", "        other:", "            oauth_token: gho_other", "            git_protocol: https", "    user: other", ""].join("\n"));
    // The last account out takes the users block and the active mark with it.
    expect(dropGhAccount("github.com", withoutOther, "Zingzy")).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", ""].join("\n"));
    // An account the file does not list changes nothing.
    expect(dropGhAccount("github.com", mac, "nobody")).toBe(mac);
  });

  it("with no account list (no reader, or a hosts.yml naming none) the gh item is one and its token goes under the host alone", () => {
    const gh = row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" });
    const p = plan([gh]);
    expect(p.secrets.map(s => [s.id, s.service, s.account])).toEqual([["logins/gh", "gh:github.com", undefined]]);
    expect(planFiles([gh], { home: HOME, stat, platform: "darwin", read: () => "github.com:\n    user: Zingzy\n" }).secrets.map(s => s.account)).toEqual([undefined]);
    const existing = ["github.com:", "    oauth_token: gho_old", "    git_protocol: ssh", "    users:", "        Zingzy:", "    user: Zingzy", ""].join("\n");
    expect(p.secrets[0]!.place("gho_x", existing)).toBe(["github.com:", "    oauth_token: gho_x", "    git_protocol: ssh", "    users:", "        Zingzy:", "    user: Zingzy", ""].join("\n"));
    expect(p.secrets[0]!.place("gho_x", undefined)).toBe(["github.com:", "    oauth_token: gho_x", "    git_protocol: https", ""].join("\n"));
    // A file that knows only another host gets the github.com block appended, the other host untouched.
    expect(placeGhToken("github.com", "gho_x", "ghe.corp.example:\n    oauth_token: ghe_theirs\n    user: me\n")).toBe(
      "ghe.corp.example:\n    oauth_token: ghe_theirs\n    user: me\ngithub.com:\n    oauth_token: gho_x\n    git_protocol: https\n",
    );
  });
});

describe("imagePath: where a Mac path lands on the image", () => {
  const AT = { home: HOME, rewrites: [["Library/Application Support/", ".config/"], ["Library/Preferences/", ".config/"]] as [string, string][] };

  it("names a Homebrew binary by its command alone, since the image installs it by whichever road the catalog gives it", () => {
    expect(imagePath("/opt/homebrew/bin/gh", AT)).toBe("gh");
    expect(imagePath("/opt/homebrew/sbin/nginx", AT)).toBe("nginx");
  });

  it("moves the rest of the Homebrew prefix, the bare prefix included, to the image's", () => {
    expect(imagePath("/opt/homebrew", AT)).toBe(BREW_PREFIX);
    expect(imagePath("/opt/homebrew/bin", AT)).toBe(`${BREW_PREFIX}/bin`);
    expect(imagePath("/opt/homebrew/opt/fzf/shell/completion.zsh", AT)).toBe(`${BREW_PREFIX}/opt/fzf/shell/completion.zsh`);
    expect(imagePath("/opt/homebrew/share/zsh/site-functions", AT)).toBe(`${BREW_PREFIX}/share/zsh/site-functions`);
  });

  it("moves the person's own home under the guest's, and the two Library directories where the copy already lands them", () => {
    expect(imagePath(HOME, AT)).toBe("/root");
    expect(imagePath(`${HOME}/.cargo/env`, AT)).toBe("/root/.cargo/env");
    expect(imagePath(`${HOME}/Library/Application Support/io.foo/config`, AT)).toBe("/root/.config/io.foo/config");
    expect(imagePath(`${HOME}/Library/Preferences/io.foo.plist`, AT)).toBe("/root/.config/io.foo.plist");
  });

  it("has no place for another home, an app bundle, the system trees, mounted media, or a Homebrew cask, which is a Mac application", () => {
    expect(imagePath("/Users/someone-else/bin", AT)).toBeUndefined();
    expect(imagePath("/Applications/Docker.app/Contents/Resources/bin", AT)).toBeUndefined();
    expect(imagePath("/Library/TeX/texbin", AT)).toBeUndefined();
    expect(imagePath("/System/Library/Frameworks", AT)).toBeUndefined();
    expect(imagePath("/Volumes/backup/bin", AT)).toBeUndefined();
    expect(imagePath("/private/var/folders/x/T/sock", AT)).toBeUndefined();
    expect(imagePath("/opt/homebrew/Caskroom/ghostty/1.0/Ghostty.app", AT)).toBeUndefined();
  });

  it("leaves a path that only looks like one of them, and /usr/local, which the image writes into itself", () => {
    expect(imagePath("/Libraries/foo", AT)).toBeUndefined();
    expect(imagePath("/usr/local/bin/gh", AT)).toBeUndefined();
  });

  it("asks the person's own home before the Mac-only trees, since a Mac's temporary home sits inside one of them", () => {
    // What mkdtempSync hands a test on macOS: a home under /private/var, which is otherwise a tree with no place.
    const tmp = { home: "/private/var/folders/xx/T/wsp-import-home-IFSy2E", rewrites: [] as [string, string][] };
    expect(imagePath(tmp.home, tmp)).toBe("/root");
    expect(imagePath(`${tmp.home}/.codex/config.toml`, tmp)).toBe("/root/.codex/config.toml");
    // Another path under the same tree still has no place.
    expect(imagePath("/private/var/folders/xx/T/someone-else", tmp)).toBeUndefined();
    // The line the Codex row carries on such a home: the table header keeps its home and the file keeps the line.
    const toml = `[projects."${tmp.home}"]\ntrust_level = "trusted"\n`;
    expect(withImagePaths(toml, ".codex/config.toml", tmp).text).toBe('[projects."/root"]\ntrust_level = "trusted"\n');
  });

  it("finds the person's home wherever this computer keeps it, not only where a Mac keeps one", () => {
    // The four shapes a home takes on the computers this runs on: a Mac's own, a Mac's temporary one, a Linux
    // laptop's, and a Linux temporary one. The guest home is /root from every one of them, so a spelled-out home
    // moves the same way whichever computer the copy was made on.
    for (const home of ["/Users/me", "/private/var/folders/xx/T/wsp-import-home-rrF1mM", "/home/me", "/tmp/wsp-import-home-rrF1mM"]) {
      const at = { home, rewrites: [] as [string, string][] };
      expect(imagePath(home, at)).toBe("/root");
      expect(imagePath(`${home}/.codex/notify.py`, at)).toBe("/root/.codex/notify.py");
      expect(withImagePaths(`[projects."${home}"]\ntrust_level = "trusted"\n`, ".codex/config.toml", at).text).toBe('[projects."/root"]\ntrust_level = "trusted"\n');
    }
  });

  it("ends a tree's name at the run, so a sibling of the home one character longer is not the home", () => {
    const at = { home: "/tmp/wsp-import-home-rrF1mM", rewrites: [] as [string, string][] };
    expect(imagePath("/tmp/wsp-import-home-rrF1mM-other/f", at)).toBeUndefined();
    expect(withImagePaths("x=/tmp/wsp-import-home-rrF1mM-other/f", ".zshrc", at).text).toBe("x=/tmp/wsp-import-home-rrF1mM-other/f");
    expect(withImagePaths("x=/Library.d/thing", ".zshrc", AT).text).toBe("x=/Library.d/thing");
  });

  it("finds every tree the catalog's table names, so a prefix added there is met here too", () => {
    for (const prefix of MAC_ONLY) {
      expect(imagePath(`${prefix}thing/bin`, AT)).toBeUndefined();
      expect(withImagePaths(`x=${prefix}thing/bin`, ".zshrc", AT).notes).toEqual([`${prefix}thing/bin out of .zshrc`]);
    }
  });
});

describe("withImagePaths: a copied file repointed at the image", () => {
  const AT = { home: HOME, rewrites: [[".claude/", ".claude-cfg/"], ["Library/Application Support/", ".config/"]] as [string, string][] };

  it("names gh by name in the credential helper the Mac's gh auth setup-git wrote", () => {
    const mac = "[credential \"https://github.com\"]\n\thelper = \n\thelper = !/opt/homebrew/bin/gh auth git-credential\n";
    const out = withImagePaths(mac, ".gitconfig", AT);
    expect(out.text).toBe("[credential \"https://github.com\"]\n\thelper = \n\thelper = !gh auth git-credential\n");
    expect(out.notes).toEqual(["/opt/homebrew/bin/gh now gh"]);
  });

  it("repoints the prefix and the home in an rc file and keeps every other byte", () => {
    const rc = ['eval "$(/opt/homebrew/bin/brew shellenv)"', "fpath+=/opt/homebrew/share/zsh/site-functions", `. ${HOME}/.cargo/env`, "# done"].join("\n");
    const out = withImagePaths(rc, ".zshrc", AT);
    expect(out.text).toBe(['eval "$(brew shellenv)"', `fpath+=${BREW_PREFIX}/share/zsh/site-functions`, ". /root/.cargo/env", "# done"].join("\n"));
    expect(out.notes).toEqual(["/opt/homebrew/bin/brew now brew", `/opt/homebrew/share/zsh/site-functions now ${BREW_PREFIX}/share/zsh/site-functions`, `${HOME}/.cargo/env now /root/.cargo/env`]);
  });

  it("takes the line of a path the image has no place for, and says which", () => {
    const rc = ["export EDITOR=vim", 'export PATH="/Applications/Visual Studio Code.app/Contents/Resources/app/bin:$PATH"', "source /Users/someone-else/shared.sh", "alias l=ls"].join("\n");
    const out = withImagePaths(rc, ".zshrc", AT);
    expect(out.text).toBe(["export EDITOR=vim", "alias l=ls"].join("\n"));
    expect(out.notes).toEqual(["/Applications/Visual Studio Code.app/Contents/Resources/app/bin out of .zshrc", "/Users/someone-else/shared.sh out of .zshrc"]);
  });

  it("follows the move the plan landed the file by, so a home path names where the copy actually is", () => {
    expect(imagePath(`${HOME}/.claude/skills`, AT)).toBe("/root/.claude-cfg/skills");
  });

  it("leaves such a path in a file written as JSON, where a line out is a file that no longer parses, and repoints the rest", () => {
    const settings = `{\n  "hooks": { "Stop": "/Applications/Foo.app/bin/foo" },\n  "skills": "${HOME}/.claude/skills"\n}\n`;
    const out = withImagePaths(settings, ".claude-cfg/settings.json", AT);
    expect(out.text).toBe('{\n  "hooks": { "Stop": "/Applications/Foo.app/bin/foo" },\n  "skills": "/root/.claude-cfg/skills"\n}\n');
    expect(out.notes).toEqual(["/Applications/Foo.app/bin/foo left in .claude-cfg/settings.json", `${HOME}/.claude/skills now /root/.claude-cfg/skills`]);
  });

  it("says nothing and changes nothing about a file with no Mac path in it", () => {
    const text = "[user]\n\tname = Me\n\temail = me@example.com\n";
    expect(withImagePaths(text, ".gitconfig", AT)).toEqual({ text, notes: [] });
  });

  it("leaves a run something else already spells a path or a host against: a URL, a $HOME path, a tilde path", () => {
    const text = ['export DOCS="https://developer.apple.com/Library/archive/doc"', 'export X="$HOME/Library/Application Support/foo"', "source ~/Library/x.sh"].join("\n");
    expect(withImagePaths(text, ".zshrc", AT)).toEqual({ text, notes: [] });
  });

  it("gives each absolute path on one line its own run, so a binary and the file it is handed both move", () => {
    const out = withImagePaths(`command = /opt/homebrew/bin/node ${HOME}/.claude/hooks/x.js`, ".codex/config", AT);
    expect(out.text).toBe("command = node /root/.claude-cfg/hooks/x.js");
    expect(out.notes).toEqual(["/opt/homebrew/bin/node now node", `${HOME}/.claude/hooks/x.js now /root/.claude-cfg/hooks/x.js`]);
  });

  it("takes the line out of a git config, whose first byte is a section header and not an object", () => {
    const cfg = ["[user]", "\tname = Me", "[difftool \"ksdiff\"]", "\tcmd = /Applications/Kaleidoscope.app/Contents/MacOS/ksdiff", ""].join("\n");
    const out = withImagePaths(cfg, ".gitconfig", AT);
    expect(out.text).toBe(["[user]", "\tname = Me", "[difftool \"ksdiff\"]", ""].join("\n"));
    expect(out.notes).toEqual(["/Applications/Kaleidoscope.app/Contents/MacOS/ksdiff out of .gitconfig"]);
  });

  it("leaves the path where a line cannot leave the file: JSON, TOML, YAML, a plist", () => {
    for (const name of [".claude-cfg/settings.json", ".codex/config.toml", ".hermes/config.yaml", ".config/io.foo.plist"]) {
      const out = withImagePaths('notify = "/Applications/Foo.app/bin/foo"', name, AT);
      expect(out.text).toBe('notify = "/Applications/Foo.app/bin/foo"');
      expect(out.notes).toEqual([`/Applications/Foo.app/bin/foo left in ${name}`]);
    }
  });

  it("leaves a comment as written, whatever path it names", () => {
    const rc = [`# my dotfiles live in ${HOME}/dotfiles`, "  // borrowed from /Users/colleague/dotfiles", "; and see /Applications/Foo.app", "alias l=ls"].join("\n");
    expect(withImagePaths(rc, ".zshrc", AT)).toEqual({ text: rc, notes: [] });
  });

  it("keeps the file's line endings", () => {
    const out = withImagePaths("a=/opt/homebrew/bin/eza\r\nb=2\r\n", ".zshrc", AT);
    expect(out.text).toBe("a=eza\r\nb=2\r\n");
  });
});

describe("planFiles: files never copied by name", () => {
  it("refuses .env files and .netrc by name on rows without consent; a consent row answered copy and a login row's own .env copy", () => {
    const p = plan([
      row({ rung: "everything", id: "everything/.env", paths: ["~/.env"] }),
      row({ rung: "everything", id: "everything/.netrc", paths: ["~/.netrc"], consent: true, choice: "copy" }),
      row({ rung: "everything", id: "everything/.app/.env.local", paths: ["~/.app/.env.local"], consent: true, choice: "skip" }),
      row({ rung: "shell", id: "shell/app-env", paths: ["~/.app/.env.local"] }),
      row({ rung: "logins", id: "logins/hermes", paths: ["~/.hermes/.env"], choice: "copy" }),
    ]);
    expect(p.files.map(f => [f.dest, f.mode])).toEqual([[".netrc", 0o600], [".hermes/.env", 0o644]]);
    expect(p.skipped.map(s => [s.id, s.note])).toEqual([
      ["everything/.env", ".env files are never copied; set the values on the machine"],
      ["everything/.app/.env.local", "credential-shaped; not copied without your answer on its row"],
      ["shell/app-env", ".env files are never copied; set the values on the machine"],
    ]);
    expect(neverCopied(row({ rung: "everything", id: "everything/.netrc", paths: ["~/.netrc"] }), ".netrc", false)).toBe(".netrc is never copied; sign in on the machine");
    expect(neverCopied(row({ rung: "everything", id: "everything/.netrc", paths: ["~/.netrc"], consent: true, choice: "copy" }), ".netrc", false)).toBeUndefined();
  });

  it("a planned file carries its row's rung and copy answer, so the pack judges every file under it by the row's rule", () => {
    const p = plan([
      row({ rung: "everything", id: "everything/.config/demo", paths: ["~/.config/demo"] }),
      row({ rung: "everything", id: "everything/.netrc", paths: ["~/.netrc"], consent: true, choice: "copy" }),
    ]);
    expect(p.files.map(f => [f.dest, f.rung, f.consent])).toEqual([
      [".config/demo", "everything", undefined],
      [".netrc", "everything", true],
    ]);
    // The rule reads a row by those three fields alone, which is what a planned file carries.
    expect(neverCopied({ id: "everything/x", rung: "everything" }, ".config/demo/.env", false)).toBe(".env files are never copied; set the values on the machine");
    expect(neverCopied({ id: "everything/x", rung: "everything", consent: true }, ".config/demo/.env", false)).toBeUndefined();
  });

  it("the name rule is about files: a directory named .env (a Python environment) copies, and a missing .env is only missing", () => {
    const p = plan([row({ rung: "everything", id: "everything/proj/.env", paths: ["~/proj/.env"] }), row({ rung: "everything", id: "everything/.gone/.env", paths: ["~/.gone/.env"] })]);
    expect(p.files.map(f => [f.dest, f.dir])).toEqual([["proj/.env", true]]);
    expect(p.skipped).toEqual([{ id: "everything/.gone/.env", path: "~/.gone/.env", note: "no longer on this computer" }]);
    const bare = row({ rung: "everything", id: "everything/.env", paths: ["~/.env"] });
    expect(neverCopied(bare, ".env", false)).toBe(".env files are never copied; set the values on the machine");
    expect(neverCopied(bare, ".env", true)).toBeUndefined();
    expect(neverCopied(bare, ".env", undefined)).toBeUndefined();
  });
});

describe("planFiles: everything rows", () => {
  it("marks the planned paths a row calls volatile, and only those", () => {
    const p = plan([row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], volatile: ["~/.claude.json"] })], { rewrites: [[".claude/", ".claude-cfg/"], [".claude.json", ".claude-cfg/.claude.json"]] });
    expect(p.files.map(f => [f.dest, f.volatile])).toEqual([
      [".claude-cfg/settings.json", false],
      [".claude-cfg/.claude.json", true],
    ]);
  });

  it("carries a row's excludes as absolute paths under the copied source, and only those", () => {
    const p = plan([
      row({ rung: "everything", id: "everything/.config/demo", paths: ["~/.config/demo"], excludes: ["~/.config/demo/cache", "~/.other/thing"], bytes: 300 }),
      row({ rung: "everything", id: "everything/.zshrc", paths: ["~/.zshrc"] }),
    ]);
    expect(p.files.map(f => [f.dest, f.excludes])).toEqual([
      [".config/demo", [`${HOME}/.config/demo/cache`]],
      [".zshrc", []],
    ]);
    expect(p.rungs).toEqual({ everything: 2 });
    expect(p.skipped).toEqual([]);
  });

  it("a credential-shaped row ticked without copy as its answer is skipped with a note; with copy it is planned at its mode", () => {
    const withoutAnswer = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true })]);
    expect(withoutAnswer.files).toEqual([]);
    expect(withoutAnswer.skipped).toEqual([{ id: "everything/.demo-token", path: "~/.demo-token", note: "credential-shaped; not copied without your answer on its row" }]);
    const skip = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true, choice: "skip" })]);
    expect(skip.files).toEqual([]);
    expect(skip.skipped).toHaveLength(1);
    const machine = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true, choice: "machine" })]);
    expect(machine.files).toEqual([]);
    expect(machine.skipped.map(s => s.note)).toEqual(["credential-shaped; not copied without your answer on its row"]);
    const copy = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true, choice: "copy", bytes: 40 })]);
    expect(copy.files.map(f => [f.dest, f.mode])).toEqual([[".demo-token", 0o600]]);
    expect(copy.skipped).toEqual([]);
    expect(copy.bytes).toBe(40);
  });
});

describe("recipeDigest and recipeHash", () => {
  const zshrc = (digest = "d1") => ({ id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest });
  const hashOf = (entries: RecipeEntry[], files: DigestedFile[] = []) => recipeHash(recipeDigest(entries, files, [], new Map()));
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  it("the digest holds the ticked ids with their login answers and tool pins, and the planned files by path with their digest, each sorted", () => {
    const entries = [row({ rung: "tools", id: "tools/npm/bun", version: "1.4.0" }), row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/zshrc", bytes: 3 }), row({ rung: "shell", id: "shell/bashrc", bring: false })];
    const files = [{ id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d1" }, { id: "logins/gh", path: "~/.config/gh/hosts.yml", dest: ".config/gh/hosts.yml", digest: "d2" }];
    expect(recipeDigest(entries, files, [], new Map())).toEqual({
      ticks: [{ id: "logins/gh", choice: "copy" }, { id: "shell/zshrc" }, { id: "tools/npm/bun", version: "1.4.0", road: "npm", installer: sha256("npm install -g bun@1.4.0") }],
      files: [{ id: "logins/gh", path: "~/.config/gh/hosts.yml", dest: ".config/gh/hosts.yml", digest: "d2" }, { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d1" }],
    });
  });

  it("a tools tick carries its road's identity: the road by name, the sha256 of the lines a first run of it installs with, and the pin those lines are fixed to while it stands", () => {
    const gh = catalogEntryOf("gh")!;
    const road = gh.kind === "tool" ? gh.installRoad : undefined;
    if (road?.road !== "release") throw new Error("gh installs from its release");
    const tag = road.version!;
    const pin = { tag, sha256: "d".repeat(64) };
    const firstRun = ROAD_MODULES.release.install(road, "gh") as string;
    // The lines are hashed without the pin: the run that recorded it and the run that carries it install the same golden.
    const bare = recipeDigest([row({ rung: "tools", id: "tools/catalog/gh" })], [], [], new Map()).ticks[0]!;
    const pinned = recipeDigest([row({ rung: "tools", id: "tools/catalog/gh", pin })], [], [], new Map()).ticks[0]!;
    expect(bare).toEqual({ id: "tools/catalog/gh", version: tag, road: "release", installer: sha256(firstRun) });
    expect(pinned).toEqual({ id: "tools/catalog/gh", version: tag, road: "release", installer: sha256(firstRun), pin });
    expect(firstRun).toContain(`releases/download/${tag}/`);
    // The catalog's tag is what the row installs at, so a recipe asking another version moves no line, and a pin
    // recorded at another tag does not stand against it.
    const moved = recipeDigest([row({ rung: "tools", id: "tools/catalog/gh", version: "v2.87.0", pin: { tag: "v2.87.0", sha256: "d".repeat(64) } })], [], [], new Map()).ticks[0]!;
    expect(moved).toEqual({ id: "tools/catalog/gh", version: tag, road: "release", installer: sha256(firstRun) });
    // A tools row no road installs, and every other rung, carries none.
    expect(recipeDigest([row({ rung: "tools", id: "tools/brew-tap/zingzy/tap" })], [], [], new Map()).ticks[0]).toEqual({ id: "tools/brew-tap/zingzy/tap" });
    expect(recipeDigest([row({ rung: "agents", id: "agents/claude" })], [], [], new Map()).ticks[0]).toEqual({ id: "agents/claude" });
    // The hash reads the road and its lines, never the pin: the recipe that carries what a build recorded still attaches to that builder.
    expect(recipeHash(recipeDigest([row({ rung: "tools", id: "tools/catalog/gh", pin })], [], [], new Map()))).toBe(recipeHash(recipeDigest([row({ rung: "tools", id: "tools/catalog/gh" })], [], [], new Map())));
    const tick = (over: object) => recipeHash({ ticks: [{ id: "tools/catalog/x", ...over }], files: [] });
    expect(tick({ road: "brew", installer: "a" })).not.toBe(tick({ road: "script", installer: "a" }));
    expect(tick({ road: "brew", installer: "a" })).not.toBe(tick({ road: "brew", installer: "b" }));
    expect(tick({ road: "brew", installer: "a", pin })).toBe(tick({ road: "brew", installer: "a" }));
  });

  it("the hash depends on the ticked ids, login choices and tool pins, not on order, byte counts or labels", () => {
    const a = [row({ rung: "shell", id: "shell/zshrc", bytes: 1 }), row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/bashrc", bring: false })];
    const b = [row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/zshrc", bytes: 99, label: "renamed" })];
    expect(hashOf(a)).toBe(hashOf(b));
    expect(hashOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf([row({ rung: "logins", id: "logins/gh", choice: "machine" }), row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(hashOf(a));
    expect(hashOf([row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(hashOf(a));
    const bun = (version: string) => [row({ rung: "tools", id: "tools/npm/bun", label: `bun@${version}`, version })];
    expect(hashOf(bun("1.4.0"))).not.toBe(hashOf(bun("1.5.0")));
  });

  it("the login shell enters the digest once, off the ticked shell rows, and a change of it alone changes the hash", () => {
    const withLogin = (login?: string, bring = true) => [row({ rung: "identity", id: "identity/git-user" }), row({ rung: "shell", id: "shell/zshrc", bring, ...(login !== undefined ? { login } : {}) }), row({ rung: "shell", id: "shell/tmux", bring, ...(login !== undefined ? { login } : {}) })];
    expect(recipeDigest(withLogin("zsh"), [], [], new Map())).toMatchObject({ login: "zsh", ticks: [{ id: "identity/git-user" }, { id: "shell/tmux" }, { id: "shell/zshrc" }] });
    expect(recipeDigest(withLogin(), [], [], new Map())).not.toHaveProperty("login");
    expect(hashOf(withLogin("zsh"))).not.toBe(hashOf(withLogin("fish")));
    expect(hashOf(withLogin("zsh"))).not.toBe(hashOf(withLogin()));
    // With no shell row ticked the login shell decides nothing on the machine, so it stays out.
    expect(recipeDigest(withLogin("zsh", false), [], [], new Map())).not.toHaveProperty("login");
    expect(hashOf(withLogin("zsh", false))).toBe(hashOf(withLogin("fish", false)));
  });

  it("a terminal font row changes nothing on the machine, so its tick stays out of the digest and the hash", () => {
    const zsh = row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"], bytes: 10 });
    const font = (bring: boolean, family: string) => row({ rung: "shell", id: "shell/terminal-font", label: `terminal font: ${family} (Ghostty)`, bring, font: family });
    const zshAlone = "ee0a7014681344c90f680ef305d1d1585e7e82c2f272a03e3e683ffe3a787c05";
    expect(hashOf([zsh])).toBe(zshAlone);
    expect(hashOf([zsh, font(true, "Hack")])).toBe(zshAlone);
    expect(hashOf([zsh, font(true, "Menlo")])).toBe(zshAlone);
    expect(hashOf([zsh, font(false, "Hack")])).toBe(zshAlone);
    expect(recipeDigest([zsh, font(true, "Hack")], [], [], new Map()).ticks).toEqual([{ id: "shell/zshrc" }]);
  });

  it("a volatile file is in the digest, marked, and never in the hash, whatever its bytes; the same file not volatile is", () => {
    const rows = [row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], volatile: ["~/.claude.json"] })];
    const settings = { id: "agents/claude", path: "~/.claude/settings.json", dest: ".claude-cfg/settings.json", digest: "s1" };
    const state = (digest: string, volatile = true) => ({ id: "agents/claude", path: "~/.claude.json", dest: ".claude-cfg/.claude.json", digest, volatile });
    expect(recipeDigest(rows, [settings, state("c1")], [], new Map()).files).toEqual([{ ...state("c1"), volatile: true }, settings]);
    expect(recipeDigest(rows, [settings, state("c1", false)], [], new Map()).files).toEqual([{ id: "agents/claude", path: "~/.claude.json", dest: ".claude-cfg/.claude.json", digest: "c1" }, settings]);
    expect(hashOf(rows, [settings, state("c1")])).toBe(hashOf(rows, [settings, state("c2")]));
    expect(hashOf(rows, [settings, state("c1")])).toBe(hashOf(rows, [settings]));
    expect(hashOf(rows, [settings, state("c1", false)])).not.toBe(hashOf(rows, [settings, state("c2", false)]));
    expect(hashOf(rows, [{ ...settings, digest: "s2" }, state("c1")])).not.toBe(hashOf(rows, [settings, state("c1")]));
  });

  it("the hash follows a planned file's digest, path and where it lands, in any order, and nothing about the disk", () => {
    const rows = [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"] })];
    const git = { id: "identity/git-user", path: "~/.gitconfig", dest: ".gitconfig", digest: "g1" };
    expect(hashOf(rows, [zshrc(), git])).toBe(hashOf(rows, [git, zshrc()]));
    expect(hashOf(rows, [zshrc(), git])).not.toBe(hashOf(rows, [zshrc("d2"), git]));
    expect(hashOf(rows, [zshrc(), git])).not.toBe(hashOf(rows, [zshrc(), { ...git, dest: ".config/git/config" }]));
    expect(hashOf(rows, [zshrc(), git])).not.toBe(hashOf(rows, [zshrc()]));
    expect(hashOf(rows, [zshrc()])).not.toBe(hashOf(rows));
    // A digest read back from a store hashes the same as the one just computed, whatever its key order.
    const stored = JSON.parse(JSON.stringify(recipeDigest(rows, [git, zshrc()], [], new Map()))) as RecipeDigest;
    expect(recipeHash({ files: stored.files.map(f => ({ digest: f.digest, dest: f.dest, path: f.path, id: f.id })), ticks: stored.ticks })).toBe(hashOf(rows, [zshrc(), git]));
  });
});

describe("brewfileFor", () => {
  it("lists ticked taps and formulae with a Linux bottle; unknown and macOS-only ones are noted", () => {
    const b = brewfileFor([
      row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/jq", linux: "yes", bring: false }),
      row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", linux: "unknown" }),
      row({ rung: "tools", id: "tools/brew/mas", linux: "no", bring: true }),
      row({ rung: "tools", id: "tools/brew/bat" }),
    ]);
    expect(b.text).toBe(['tap "zingzy/tap"', 'brew "gh"', 'brew "bat"', ""].join("\n"));
    expect(b.taps).toEqual(["zingzy/tap"]);
    expect(b.formulae).toEqual(["gh", "bat"]);
    expect(b.skipped).toEqual([
      { id: "tools/brew/zingzy/tap/diskbloom", note: "no Linux bottle known" },
      { id: "tools/brew/mas", note: "no Linux bottle" },
    ]);
  });

  it("is empty when nothing Homebrew is ticked", () => {
    expect(brewfileFor([row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" })]).text).toBe("");
  });
});

describe("toolInstallsFor", () => {
  it("Homebrew comes first (pinned clone, as its own user), then taps, then formulae, then each manager after its own install, with the row's pinned version", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/go/sqlc", label: "sqlc", paths: ["github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1"], version: "v1.31.1" }),
      row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" }),
      row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }),
      row({ rung: "tools", id: "tools/npm/@monid-ai/cli", label: "@monid-ai/cli@0.3.1", version: "0.3.1" }),
      row({ rung: "tools", id: "tools/npm/pnpm", label: "pnpm" }),
      row({ rung: "tools", id: "tools/pnpm/turbo", label: "turbo@2.5.0", version: "2.5.0" }),
      row({ rung: "tools", id: "tools/bun/eslint", label: "eslint@9.0.0", version: "9.0.0" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty v0.0.56", version: "0.0.56" }),
      row({ rung: "tools", id: "tools/pipx/black", label: "black 24.1.0", version: "24.1.0" }),
      row({ rung: "tools", id: "tools/cargo/bat", label: "bat 0.24.0", version: "0.24.0" }),
      row({ rung: "tools", id: "tools/brew/mas", linux: "no" }),
      row({ rung: "tools", id: "tools/go/junk", label: "junk (no module info)" }),
    ]);
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/homebrew", "brew", undefined],
      // Homebrew's own glibc then gcc, each its own brew process, before any formula (the 6.0.21 lock race).
      ["tools/brew-toolchain/glibc", "brew", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "brew", "tools/brew-toolchain/glibc"],
      ["tools/brew-tap/zingzy/tap", "brew", "tools/brew-toolchain/gcc"],
      // What two or more of the formulae (gh and the managers' pipx and go) share installs once, after the taps it may need.
      ["tools/brew-shared", "brew", "tools/brew-toolchain/gcc"],
      ["tools/brew/gh", "brew", "tools/brew-toolchain/gcc"],
      // Node is not on the floor, so the first row on the npm road brings it, once, ahead of them all.
      ["tools/manager/npm", "script", undefined],
      ["tools/npm/bun", "npm", "tools/manager/npm"],
      ["tools/npm/@monid-ai/cli", "npm", "tools/manager/npm"],
      ["tools/npm/pnpm", "npm", "tools/manager/npm"],
      // bun and pnpm came as npm globals, so their rows wait on those lines rather than on a formula; uv is the base's, so its rows wait on nothing.
      ["tools/pnpm/turbo", "pnpm", "tools/npm/pnpm"],
      ["tools/bun/eslint", "bun", "tools/npm/bun"],
      ["tools/uv/ty", "uv", undefined],
      ["tools/manager/pipx", "brew", "tools/brew-toolchain/gcc"],
      ["tools/pipx/black", "pipx", "tools/manager/pipx"],
      // cargo comes by rustup, which needs no Homebrew, so its step waits on nothing.
      ["tools/manager/cargo", "script", undefined],
      ["tools/cargo/bat", "cargo", "tools/manager/cargo"],
      ["tools/manager/go", "brew", "tools/brew-toolchain/gcc"],
      ["tools/go/sqlc", "go", "tools/manager/go"],
    ]);
    const cmd = (id: string) => t.installs.find(i => i.id === id)!.cmd;
    expect(cmd("tools/homebrew")).toContain(`--branch ${HOMEBREW.tag} https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew`);
    expect(cmd("tools/homebrew")).toContain(`rev-parse HEAD)" = "${HOMEBREW.commit}"`);
    expect(cmd("tools/homebrew")).toContain("useradd");
    // The login-shell PATH file is written by the base stage on every golden, so the bootstrap no longer writes it.
    expect(cmd("tools/homebrew")).not.toContain("/etc/profile.d/wsp-golden.sh");
    expect(cmd("tools/homebrew")).not.toContain("Brewfile");
    expect(cmd("tools/brew-toolchain/glibc")).toMatch(/brew install glibc'$/);
    expect(cmd("tools/brew-toolchain/gcc")).toMatch(/brew install gcc'$/);
    expect(cmd("tools/brew-tap/zingzy/tap")).toMatch(/su -s \/bin\/bash linuxbrew -c 'cd \.[\s\S]*brew tap zingzy\/tap'$/);
    expect(cmd("tools/brew/gh")).toMatch(/su -s \/bin\/bash linuxbrew -c 'cd \.[\s\S]*HOMEBREW_NO_AUTO_UPDATE=1[\s\S]*brew install gh'$/);
    const shared = cmd("tools/brew-shared");
    expect(shared).toMatch(/su -s \/bin\/bash linuxbrew -c 'cd \. 2>\/dev\/null \|\| cd \/home\/linuxbrew\nexport HOMEBREW_NO_AUTO_UPDATE=1 .*NONINTERACTIVE=1 HOMEBREW_CURL_RETRIES=1\n/);
    expect(shared).toContain(`brew deps --for-each '\\''gh'\\'' '\\''pipx'\\'' '\\''go'\\'' | sed`);
    // Homebrew's own toolchain is never in the shared set: it installed before, on request, and stays that way.
    expect(shared).toContain(`grep -vx -e '\\'''\\'' -e glibc -e gcc | sort | uniq -d`);
    expect(shared).toContain("brew install $shared; rc=$?");
    // Installed as dependencies, so autoremove takes them with the formula that fails or leaves.
    expect(shared).toContain("brew tab --no-installed-on-request $shared || true\nexit $rc");
    // Homebrew cleans after each install; one recipe with it off left 2.6 GB of bottles on a 20 GB disk.
    for (const i of t.installs) expect(i.cmd).not.toContain("HOMEBREW_NO_INSTALL_CLEANUP");
    expect(cmd("tools/npm/bun")).toMatch(/npm install -g bun@1\.4\.0$/);
    expect(cmd("tools/npm/@monid-ai/cli")).toMatch(/npm install -g @monid-ai\/cli@0\.3\.1$/);
    expect(cmd("tools/pnpm/turbo")).toMatch(/pnpm add -g turbo@2\.5\.0$/);
    expect(cmd("tools/bun/eslint")).toMatch(/bun add -g eslint@9\.0\.0$/);
    expect(cmd("tools/uv/ty")).toMatch(/uv tool install ty==0\.0\.56$/);
    expect(cmd("tools/manager/pipx")).toMatch(/brew install pipx'$/);
    expect(cmd("tools/pipx/black")).toMatch(/pipx install black==24\.1\.0$/);
    expect(cmd("tools/manager/cargo")).toContain('curl -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/1.29.1/$arch-unknown-linux-gnu/rustup-init"');
    expect(cmd("tools/manager/cargo")).toMatch(/\n\/tmp\/rustup-init -y --no-modify-path --profile default --default-toolchain stable\nrm -f \/tmp\/rustup-init$/);
    expect(cmd("tools/cargo/bat")).toMatch(/cargo install bat --version 0\.24\.0 --locked$/);
    expect(cmd("tools/manager/go")).toMatch(/brew install go'$/);
    expect(cmd("tools/go/sqlc")).toMatch(/go install github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc@v1\.31\.1$/);
    for (const i of t.installs) expect(i.cmd).toMatch(/^export PATH=.*PNPM_HOME=/);
    expect(t.skipped).toEqual([
      { id: "tools/brew/mas", note: "no Linux bottle" },
      { id: "tools/go/junk", note: "no module to install from" },
    ]);
    expect(baseRows(t)).toEqual([]);
    expect(t.brewfile).toBe(['tap "zingzy/tap"', 'brew "gh"', ""].join("\n"));
  });

  it("a Go row's module rides in its first path (the collector's shape) and the version field pins it; an older recipe's label shape still works", () => {
    const fresh = toolInstallsFor([row({ rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], version: "v0.16.2" })]);
    expect(fresh.installs.at(-1)!.cmd).toMatch(/go install golang\.org\/x\/tools\/gopls@v0\.16\.2$/);
    const pinned = toolInstallsFor([row({ rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], version: "v0.17.0" })]);
    expect(pinned.installs.at(-1)!.cmd).toMatch(/gopls@v0\.17\.0$/);
    const old = toolInstallsFor([row({ rung: "tools", id: "tools/go/gopls", label: "gopls (golang.org/x/tools/gopls@v0.16.2)" })]);
    expect(old.installs.at(-1)!.cmd).toMatch(/go install golang\.org\/x\/tools\/gopls@v0\.16\.2$/);
    expect(toolInstallsFor([row({ rung: "tools", id: "tools/go/mystery", label: "mystery (no module info)" })]).skipped).toEqual([{ id: "tools/go/mystery", note: "no module to install from" }]);
  });

  it("a row with no version installs the manager's latest; a manager already ticked as a formula is not installed twice, and takes the catalog's road for it", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/brew/bun", linux: "yes" }),
      row({ rung: "tools", id: "tools/bun/elysia", label: "elysia" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty" }),
    ]);
    // The Mac's bun formula is the catalog's bun row, so it comes by the catalog's npm install and Homebrew stays off
    // the machine; that install runs on node, which the recipe ticked no row for, so the node step brings it.
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/manager/npm", "script", undefined],
      ["tools/brew/bun", "npm", "tools/manager/npm"],
      ["tools/bun/elysia", "bun", "tools/brew/bun"],
      ["tools/uv/ty", "uv", undefined],
    ]);
    expect(t.installs[1]!.cmd).toMatch(/\nnpm install -g bun$/);
    expect(t.brewfile).toBe("");
    expect(t.installs.find(i => i.id === "tools/bun/elysia")!.cmd).toMatch(/bun add -g elysia$/);
    expect(t.installs.find(i => i.id === "tools/uv/ty")!.cmd).toMatch(/uv tool install ty$/);
  });

  it("rows the base floor covers install nothing and are listed as the base's, whatever road the Mac had them by", () => {
    // Homebrew's node is the current major and its python the current 3.x: the Mac's versions come from the brew table.
    const table: BrewTable = new Map([
      ["node", { name: "node", fullName: "node", deps: [], macosOnly: false, version: "24.1.0" }],
      ["python", { name: "python", fullName: "python", deps: [], macosOnly: false, version: "3.14.0" }],
      ["python@3.12", { name: "python@3.12", fullName: "python@3.12", deps: [], macosOnly: false, version: "3.12.7" }],
    ]);
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/brew/jq", linux: "yes" }),
      row({ rung: "tools", id: "tools/npm/pnpm", label: "pnpm", version: "10.0.0" }),
      row({ rung: "tools", id: "tools/brew/python@3.12", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/node", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/python", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/uv", linux: "yes" }),
      row({ rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep", version: "14.1.0" }),
      row({ rung: "tools", id: "tools/brew/python@3.14", linux: "yes" }),
    ], table);
    expect(baseRows(t)).toEqual([
      ["tools/brew/jq", "jq", "jq is part of the base"],
      ["tools/brew/python@3.12", "Python 3.12", "Python 3.12 is part of the base"],
      ["tools/brew/python", "Python 3.12", "Python 3.12 is part of the base; this Mac runs Python 3.14"],
      ["tools/brew/uv", "uv", "uv is part of the base"],
      ["tools/cargo/ripgrep", "ripgrep", "ripgrep is part of the base"],
    ]);
    // The plan names no computer: it carries the floor row and the version read here, so the same rows read as a
    // Linux computer's when that is what was read.
    expect(baseRows(t, "linux").map(r => r[2])).toContain("Python 3.12 is part of the base; this computer runs Python 3.14");
    // Node and pnpm are off the floor: the Mac's node formula is the node the npm road runs on, by the catalog's
    // own script, and pnpm waits on it.
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/homebrew", "brew", undefined],
      ["tools/brew-toolchain/glibc", "brew", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "brew", "tools/brew-toolchain/glibc"],
      ["tools/brew/python@3.14", "brew", "tools/brew-toolchain/gcc"],
      ["tools/brew/node", "script", undefined],
      ["tools/npm/pnpm", "npm", "tools/brew/node"],
    ]);
    expect(t.skipped).toEqual([]);
    expect(t.brewfile).toBe('brew "python@3.14"\n');
    expect(toolUninstall(row({ rung: "tools", id: "tools/brew/jq" }), new Map())).toEqual({ note: "jq is part of the base and stays" });
  });

  it("one formula has nothing to share, so no shared step; two get one between the taps and the first formula", () => {
    const one = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" })]);
    expect(one.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/gh"]);
    const two = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }), row({ rung: "tools", id: "tools/brew/yq", linux: "yes" }), row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" })]);
    expect(two.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew-tap/zingzy/tap", "tools/brew-shared", "tools/brew/gh", "tools/brew/yq"]);
    expect(two.installs.find(i => i.id === "tools/brew-shared")).toMatchObject({ label: "shared Homebrew dependencies", after: "tools/brew-toolchain/gcc" });
    expect(two.installs.find(i => i.id === "tools/brew-shared")!.cmd).toContain(`brew deps --for-each '\\''gh'\\'' '\\''yq'\\'' |`);
  });

  it("the housekeeping after the loop is autoremove then a full cleanup, each as linuxbrew with the tools PATH", () => {
    const BREW_HOUSEKEEPING = brewHousekeeping(TOOLS_PATH);
    expect(BREW_HOUSEKEEPING).toHaveLength(2);
    expect(BREW_HOUSEKEEPING[0]).toMatch(/^export PATH=\/root\/\.local\/bin:.*\nsu -s \/bin\/bash linuxbrew -c 'cd \.[\s\S]*brew autoremove'$/);
    expect(BREW_HOUSEKEEPING[1]).toMatch(/\nsu -s \/bin\/bash linuxbrew -c 'cd \.[\s\S]*brew cleanup -s --prune=all'$/);
  });

  it("puts the one brew a PATH reaches in the directory Homebrew's own line prepends, and Homebrew's brew where no PATH goes", () => {
    // A Mac's `eval "$(brew shellenv)"` arrives rewritten to this prefix and prepends its bin directory, so a shim
    // anywhere else ends up behind it; the only brew on any directory of the tools PATH is the shim.
    expect(TOOLS_PATH.split(":").filter(d => BREW.startsWith(`${d}/`) || BREW_REAL.startsWith(`${d}/`))).toEqual([`${BREW_PREFIX}/bin`]);
  });

  it("installs the shim as the brew on PATH, root's own file, and links Homebrew's brew for it to run", () => {
    const cmd = homebrewStep();
    expect(cmd).toContain(`ln -sfn ../Homebrew/bin/brew ${BREW_REAL}`);
    expect(cmd).not.toContain(`ln -sfn ../Homebrew/bin/brew ${BREW}`);
    expect(cmd).toContain(`rm -f ${BREW}`);
    expect(cmd).toContain(`printf '%s\\n' ${shellQuote(LINUXBREW_SHIM)} > ${BREW}`);
    expect(cmd).toContain(`chmod 0755 ${BREW}`);
    // Written after the chown, so the file root runs with root's own rights is not the linuxbrew user's to rewrite.
    expect(cmd.indexOf(`> ${BREW}`)).toBeGreaterThan(cmd.indexOf("chown -R linuxbrew:linuxbrew"));
    // A person's own brew reads the folder they are in; one linuxbrew cannot read (root's home on some images)
    // would stop Homebrew before it starts, so the shim moves off it and only off it.
    expect(LINUXBREW_SHIM).toContain(`su -s /bin/bash linuxbrew -c 'cd . 2>/dev/null || cd ${LINUXBREW_HOME}
exec "$0" "$@"' -- ${BREW_REAL}`);
  });

  it("costs a line and not the step when the upstream branch will not fetch: the shim still lands", () => {
    // The generated step run for real, at a prefix of its own, with every command that would touch this machine
    // stubbed and the one fetch failing the way a dead network fails it. What it pins is that the rows waiting on
    // this step still get their Homebrew: the shim is written, the link is made, and the smoke at the end passes.
    const dir = mkdtempSync(join(tmpdir(), "wsp-brew-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const stub = join(dir, "stub");
    mkdirSync(stub);
    writeFileSync(
      join(stub, "git"),
      `#!/bin/sh\ncase " $* " in\n  *" clone "*) mkdir -p ${shellQuote(`${dir}/Homebrew/bin`)} && printf '%s\\n' '#!/bin/sh' 'echo Homebrew' > ${shellQuote(`${dir}/Homebrew/bin/brew`)} && chmod 0755 ${shellQuote(`${dir}/Homebrew/bin/brew`)} ;;\n  *"rev-parse HEAD"*) echo ${HOMEBREW.commit} ;;\n  *" fetch "*) echo "fatal: unable to access github.com" >&2; exit 128 ;;\nesac\nexit 0\n`,
      { mode: 0o755 },
    );
    for (const name of ["apt-get", "useradd", "chown"]) writeFileSync(join(stub, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(stub, "su"), '#!/bin/sh\nshell=/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -s) shell="$2"; shift 2 ;; -c) script="$2"; shift 2 ;; --) shift; break ;; *) shift ;; esac; done\nexec "$shell" -c "$script" "$@"\n', { mode: 0o755 });
    const script = homebrewStep().replaceAll(BREW_PREFIX, dir).replace("export PATH=", `export PATH=${stub}:`);
    // The chown line names /home/linuxbrew whatever the prefix is, so the stub PATH is what keeps this run off it.
    expect(script).toContain(`export PATH=${stub}:`);
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect({ status: run.status, out: run.stdout.trim() }).toEqual({ status: 0, out: "origin/main did not fetch: brew update reads the branch in full" });
    expect(readFileSync(join(dir, "bin/brew"), "utf8")).toBe(`${LINUXBREW_SHIM.replaceAll(BREW_PREFIX, dir)}\n`);
    expect(readFileSync(join(dir, "libexec/brew"), "utf8")).toContain("echo Homebrew");
  });

  it("leaves the checkout the origin remote a plain clone has, so brew update finds a branch to read", () => {
    expect(homebrewStep()).toContain(`git -C ${BREW_REPO} remote set-branches origin '*'`);
    expect(homebrewStep()).toContain(`git -C ${BREW_REPO} fetch -q --depth 1 origin main`);
  });

  it("a manager needed only for its rows brings Homebrew along when a formula is the only road to it", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/pipx/black", label: "black 24.1.0", version: "24.1.0" })]);
    expect(t.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/manager/pipx", "tools/pipx/black"]);
  });

  it("cargo's rows bring the catalog's rustup instead of Homebrew, and wait on it", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/cargo/bat", label: "bat 0.24.0", version: "0.24.0" })]);
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/manager/cargo", "script", undefined],
      ["tools/cargo/bat", "cargo", "tools/manager/cargo"],
    ]);
    expect(t.installs[0]).toMatchObject({ label: "Rust with cargo", bin: "cargo" });
    expect(t.installs[0]!.cmd).toContain("static.rust-lang.org/rustup/archive/1.29.1/");
    expect(t.brewfile).toBe("");
  });

  // Both of Homebrew's names for the Rust toolchain, the second the one Homebrew recommends: either one is the catalog's row.
  for (const formula of ["rust", "rustup"]) {
    it(`a Mac's ${formula} formula is the catalog's rust row, and Homebrew's ${formula} never installs beside it`, () => {
      const t = toolInstallsFor([
        row({ rung: "tools", id: `tools/brew/${formula}`, linux: "yes" }),
        row({ rung: "tools", id: "tools/cargo/bat", label: "bat 0.24.0", version: "0.24.0" }),
      ]);
      expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
        [`tools/brew/${formula}`, "script", undefined],
        ["tools/cargo/bat", "cargo", `tools/brew/${formula}`],
      ]);
      expect(t.installs[0]!.cmd).toContain("static.rust-lang.org/rustup/archive/1.29.1/");
      expect(t.installs[0]!.cmd).not.toContain("brew install");
      expect(t.brewfile).toBe("");
      // With no cargo row behind it the formula still comes by the catalog's road: one rust on the machine, never the bottle.
      expect(toolInstallsFor([row({ rung: "tools", id: `tools/brew/${formula}`, linux: "yes" })]).installs.map(i => [i.id, i.manager])).toEqual([[`tools/brew/${formula}`, "script"]]);
    });
  }

  it("a manager the catalog carries installs by the catalog's road: bun's rows wait on an npm install of bun, and no Homebrew comes along", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/bun/eslint", label: "eslint 9.0.0", version: "9.0.0" })]);
    // That install is itself an npm global, so the step that brings bun waits on the node step, which nothing else asked for.
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/manager/npm", "script", undefined],
      ["tools/manager/bun", "npm", "tools/manager/npm"],
      ["tools/bun/eslint", "bun", "tools/manager/bun"],
    ]);
    expect(t.installs[1]!.cmd).toMatch(/\nnpm install -g bun$/);
    expect(t.brewfile).toBe("");
  });

  it("no Homebrew step when no formula, tap or manager needs it; unticked rows install nothing", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }), row({ rung: "tools", id: "tools/brew/gh", linux: "yes", bring: false })]);
    expect(t.installs.map(i => i.id)).toEqual(["tools/manager/npm", "tools/npm/bun"]);
    expect(t.brewfile).toBe("");
  });

  it("never pipes a download into a shell", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty 0.0.56", version: "0.0.56" }),
      row({ rung: "tools", id: "tools/cargo/rg", label: "rg" }),
      row({ rung: "tools", id: "tools/pnpm/x", label: "x" }),
    ]);
    for (const i of t.installs) expect(i.cmd).not.toMatch(/\|\s*(ba)?sh\b/);
  });
});

describe("what a step shows while it runs", () => {
  it("is the manager's own line for a package, the brew line without its su, where a release comes from, and a custom row's lines as typed", () => {
    const t = toolInstallsFor(
      [
        row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
        row({ rung: "tools", id: "tools/brew/yq", linux: "yes" }),
        row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" }),
        row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }),
        row({ rung: "tools", id: "tools/pipx/black", label: "black 24.1.0", version: "24.1.0" }),
        row({ rung: "tools", id: `${CATALOG_PREFIX}tmux`, label: "tmux", linux: "yes" }),
        row({ rung: "tools", id: `${CATALOG_PREFIX}gh`, label: "GitHub CLI", linux: "yes" }),
      ],
      new Map(),
      [{ kind: "custom", id: "just", name: "just", install: ["brew install just", "just --version"], check: "command -v just", why: "added by hand" }],
    );
    // The node step shows its own script, one line, as the floor showed it before node left.
    const nodeShown = t.installs.find(i => i.id === "tools/manager/npm")!.shown!;
    expect(nodeShown).not.toContain("\n");
    expect(nodeShown).toContain(`https://nodejs.org/dist/v${NODE_RELEASES[22].version}/`);
    const shown = Object.fromEntries(t.installs.filter(i => i.id !== "tools/manager/npm").map(i => [i.id, i.shown]));
    expect(shown).toEqual({
      "tools/homebrew": "git clone github.com/Homebrew/brew at 6.0.21",
      "tools/brew-toolchain/glibc": "brew install glibc",
      "tools/brew-toolchain/gcc": "brew install gcc",
      "tools/brew-tap/zingzy/tap": "brew tap zingzy/tap",
      "tools/brew-shared": "brew install the dependencies gh, yq, pipx share",
      "tools/brew/gh": "brew install gh",
      "tools/brew/yq": "brew install yq",
      "tools/npm/bun": "npm install -g bun@1.4.0",
      "tools/manager/pipx": "brew install pipx",
      "tools/pipx/black": "pipx install black==24.1.0",
      "tools/apt-index": "apt-get update",
      "tools/catalog/tmux": "apt-get install tmux",
      "tools/catalog/gh": "the v2.101.0 release of github.com/cli/cli",
      "tools/custom/just": "brew install just; just --version",
    });
  });
});

describe("catalog rows", () => {
  const catalog = (id: string, over: Partial<RecipeEntry> = {}) => row({ rung: "tools", id: `${CATALOG_PREFIX}${id}`, label: catalogEntry(id)?.name ?? id, linux: "yes", ...over });

  it("a catalog script row waits on what the catalog says it runs on top of: the apt index by its one step, a floor row on nothing", () => {
    const t = toolInstallsFor([catalog("swift"), catalog("playwright"), catalog("yarn"), catalog("shellcheck")]);
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/apt-index", "apt", undefined],
      ["tools/catalog/swift", "script", "tools/apt-index"],
      // Playwright's npm road and yarn's script both name node, which is off the floor: one step brings it for both.
      ["tools/manager/npm", "script", undefined],
      ["tools/catalog/playwright", "script", "tools/manager/npm"],
      ["tools/catalog/yarn", "script", "tools/manager/npm"],
      ["tools/catalog/shellcheck", "apt", "tools/apt-index"],
    ]);
    expect(t.installs.filter(i => i.id === "tools/manager/npm")).toHaveLength(1);
    expect(t.installs.filter(i => i.id === "tools/apt-index")).toHaveLength(1);
  });

  it("a ticked catalog tool this computer has no row for installs by its catalog road, named for its command; a road no golden build has run is noted", () => {
    const t = toolInstallsFor([catalog("gh"), catalog("wrangler"), catalog("ffmpeg"), catalog("kubectl"), catalog("gcloud"), catalog("tmux")]);
    expect(t.installs.map(i => [i.id, i.manager, i.after, i.bin, i.note])).toEqual([
      ["tools/manager/npm", "script", undefined, "node", undefined],
      ["tools/catalog/wrangler", "npm", "tools/manager/npm", "wrangler", UNMEASURED_ROAD],
      ["tools/catalog/gh", "release", undefined, "gh", UNMEASURED_ROAD],
      ["tools/apt-index", "apt", undefined, undefined, undefined],
      ["tools/catalog/ffmpeg", "apt", "tools/apt-index", "ffmpeg", UNMEASURED_ROAD],
      ["tools/catalog/kubectl", "vendor", undefined, "kubectl", UNMEASURED_ROAD],
      ["tools/catalog/gcloud", "vendor", undefined, "gcloud", undefined],
      ["tools/catalog/tmux", "apt", "tools/apt-index", "tmux", UNMEASURED_ROAD],
    ]);
    const cmd = (id: string) => t.installs.find(i => i.id === id)!.cmd;
    for (const i of t.installs) expect(i.cmd).toMatch(/^export PATH=.*PNPM_HOME=/);
    expect(cmd("tools/catalog/wrangler")).toMatch(/\nnpm install -g wrangler$/);
    expect(cmd("tools/catalog/gh")).toContain("releases/download/v2.101.0/");
    expect(cmd("tools/catalog/gh")).toContain("name='gh'");
    expect(cmd("tools/apt-index")).toMatch(/\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq$/);
    expect(cmd("tools/catalog/ffmpeg")).toMatch(/\napt-get install -y -qq ffmpeg$/);
    expect(cmd("tools/catalog/kubectl")).toBe(`${PATH_LINE}\n${KUBECTL.install}`);
    expect(t.installs.some(i => i.id === "tools/homebrew")).toBe(false);
    expect(t.skipped).toEqual([]);
    expect(t.base).toEqual([]);
  });

  it("carries its road's own presence read and the directories that road links into, so the job and the doctor read one rule", () => {
    // A formula row: the presence read is the prefix's link, and the check after the install stays brew's own list,
    // so the read that decides whether to install runs no brew at all and the check that proves one still does.
    const formulae = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }), row({ rung: "tools", id: "tools/brew/yq", linux: "yes" })]).installs.filter(i => i.id.startsWith("tools/brew/"));
    expect(formulae.map(i => i.id)).toEqual(["tools/brew/gh", "tools/brew/yq"]);
    for (const step of formulae) {
      expect(step.present, step.id).toBe(`test -e ${HOMEBREW_PREFIX}/opt/${step.id.slice("tools/brew/".length)}`);
      expect(step.check, step.id).toContain("list --versions");
      expect(step.bins, step.id).toEqual([`${HOMEBREW_PREFIX}/bin`, `${HOMEBREW_PREFIX}/sbin`, "/usr/local/bin"]);
    }
    // A brew tick the catalog covers is planned on the catalog's own road, which is node's installer: no presence
    // read of its own, since the command it puts on PATH is the read, and the directories are that script's.
    const covered = toolInstallsFor([row({ rung: "tools", id: "tools/brew/node", linux: "yes" })]).installs.find(i => i.id === "tools/brew/node")!;
    expect([covered.manager, covered.bin, covered.present, covered.bins]).toEqual(["script", "node", undefined, ["/usr/local/bin"]]);
    // And a catalog row planned on the brew road carries brew's read and brew's directories, wherever it is planned.
    const go = toolInstallsFor([catalog("go")]).installs.at(-1)!;
    expect(go.id).toBe("tools/catalog/go");
    expect([go.present, go.bins]).toEqual([`test -e ${HOMEBREW_PREFIX}/opt/go`, [`${HOMEBREW_PREFIX}/bin`, `${HOMEBREW_PREFIX}/sbin`, "/usr/local/bin"]]);
  });

  it("a catalog tool on the Homebrew road brings Homebrew and its toolchain along, waits on them, and shares dependencies with the formulae ticked; a road a golden build has run carries no note", () => {
    const t = toolInstallsFor([catalog("go"), row({ rung: "tools", id: "tools/brew/yq", linux: "yes" })]);
    expect(t.installs.map(i => [i.id, i.after])).toEqual([
      ["tools/homebrew", undefined],
      ["tools/brew-toolchain/glibc", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "tools/brew-toolchain/glibc"],
      ["tools/brew-shared", "tools/brew-toolchain/gcc"],
      ["tools/brew/yq", "tools/brew-toolchain/gcc"],
      ["tools/catalog/go", "tools/brew-toolchain/gcc"],
    ]);
    expect(t.installs.find(i => i.id === "tools/brew-shared")!.cmd).toContain(`brew deps --for-each '\\''yq'\\'' '\\''go'\\'' |`);
    expect(t.installs.at(-1)).toMatchObject({ id: "tools/catalog/go", label: "Go", manager: "brew", bin: "go" });
    expect(t.installs.at(-1)!.cmd).toMatch(/brew install go'$/);
    expect(t.installs.at(-1)).not.toHaveProperty("note");
    // Homebrew's own bootstrap comes along for a catalog formula alone, as it does for a manager's.
    expect(toolInstallsFor([catalog("java")]).installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/catalog/java"]);
    // A catalog row on the script road brings none of it: Rust's rustup install is the whole step.
    expect(toolInstallsFor([catalog("rust")]).installs.map(i => [i.id, i.manager])).toEqual([["tools/catalog/rust", "script"]]);
  });

  it("a catalog tool the floor carries is the base's, an id the catalog does not know is skipped, and a row this computer has keeps its own road at the laptop's version", () => {
    const t = toolInstallsFor([catalog("git"), catalog("nothing", { label: "nothing" }), row({ rung: "tools", id: "tools/npm/wrangler", label: "wrangler", version: "4.1.0" })]);
    expect(baseRows(t)).toEqual([["tools/catalog/git", "git", "git is part of the base"]]);
    expect(t.skipped).toEqual([{ id: "tools/catalog/nothing", note: "not in the catalog" }]);
    expect(t.installs.map(i => [i.id, i.manager, i.note])).toEqual([["tools/manager/npm", "script", undefined], ["tools/npm/wrangler", "npm", undefined]]);
    expect(t.installs[1]!.cmd).toMatch(/\nnpm install -g wrangler@4\.1\.0$/);
  });

  it("a catalog tool comes off through the same module: the release binary, the formula, the apt package, the npm global, the vendor's tree", () => {
    expect(toolUninstall(catalog("gh"), new Map())).toEqual({ cmd: `${PATH_LINE}\nrm -f /usr/local/bin/'gh'` });
    expect(toolUninstall(catalog("go"), new Map())).toEqual({ cmd: expect.stringMatching(/brew uninstall go'$/) });
    expect(toolUninstall(catalog("ffmpeg"), new Map())).toEqual({ cmd: `${PATH_LINE}\nexport DEBIAN_FRONTEND=noninteractive\napt-get purge -y -qq ffmpeg && apt-get autoremove -y -qq --purge` });
    expect(toolUninstall(catalog("wrangler"), new Map())).toEqual({ cmd: `${PATH_LINE}\nnpm uninstall -g wrangler` });
    expect(toolUninstall(catalog("gcloud"), new Map())).toEqual({ cmd: expect.stringContaining("rm -rf /opt/google-cloud-sdk") });
    expect(toolUninstall(catalog("git"), new Map())).toEqual({ note: "git is part of the base and stays" });
    expect(toolUninstall(catalog("nothing"), new Map())).toEqual({ note: "no manager known for this row" });
  });

  it("a catalog go row beside go rows is the manager's step: go installs once, the go rows wait on the catalog row, and no manager step is planned", () => {
    const t = toolInstallsFor([catalog("go"), row({ rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"] })]);
    expect(t.installs.map(i => [i.id, i.after])).toEqual([
      ["tools/homebrew", undefined],
      ["tools/brew-toolchain/glibc", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "tools/brew-toolchain/glibc"],
      ["tools/catalog/go", "tools/brew-toolchain/gcc"],
      ["tools/go/gopls", "tools/catalog/go"],
    ]);
    expect(t.installs.filter(i => /brew install go'$/.test(i.cmd))).toHaveLength(1);
    expect(t.installs.at(-1)!.cmd).toMatch(/\ngo install golang\.org\/x\/tools\/gopls@v0\.16\.2$/);
  });

  it("a catalog row's version is the install's where the road pins one; where the road cannot, the note says what it installed instead", () => {
    const t = toolInstallsFor([catalog("wrangler", { version: "4.1.0" }), catalog("gh", { version: "v2.86.0" }), catalog("tmux", { version: "3.5a" })]);
    const get = (id: string) => t.installs.find(i => i.id === id)!;
    expect(get("tools/catalog/wrangler").cmd).toMatch(/\nnpm install -g wrangler@4\.1\.0$/);
    expect(get("tools/catalog/wrangler").note).toBe(UNMEASURED_ROAD);
    // A release row installs the catalog's pinned tag whatever the Mac runs, and the note says which one it got.
    expect(get("tools/catalog/gh").note).toBe(`${UNMEASURED_ROAD}; asked v2.86.0, installed at the catalog's pinned v2.101.0`);
    expect(get("tools/catalog/gh").cmd).toContain("releases/download/v2.101.0/");
    expect(get("tools/catalog/tmux").cmd).toMatch(/\napt-get install -y -qq tmux$/);
    expect(get("tools/catalog/tmux").note).toBe(`${UNMEASURED_ROAD}; 3.5a asked, installed by apt at its current version`);
  });

  it("a catalog row installs the artifact the catalog pinned and checks the sum beside it, whatever a recipe recorded", () => {
    const t = toolInstallsFor([catalog("gh", { pin: { tag: "v2.86.0", sha256: "d".repeat(64) } }), catalog("kubectl", { pin: { tag: "v1.37.0", sha256: "e".repeat(64) } })]);
    const gh = t.installs.find(i => i.id === "tools/catalog/gh")!.cmd;
    expect(gh).toContain("releases/download/v2.101.0/");
    expect(gh).not.toContain("api.github.com");
    // The recorded sum of an older tag decides nothing: the catalog's own sum is checked before the unpack.
    expect(gh).not.toContain(`[ "$sum" = '${"d".repeat(64)}' ]`);
    expect(gh).toContain('echo "$sha  $tmp/$asset" | sha256sum -c - >/dev/null');
    expect(t.installs.find(i => i.id === "tools/catalog/kubectl")!.cmd).toBe(`${PATH_LINE}\n${KUBECTL.install}`);
  });
});

describe("tap formulae on the release road", () => {
  it("a tap row on the road identifies by the road the plan installs by, with its pin: sealed with the recorded pin it diffs to nothing against the recipe that carries it", () => {
    const table: BrewTable = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const id = "tools/brew/zingzy/tap/diskbloom";
    const tap = (over: Partial<RecipeEntry> = {}) => row({ rung: "tools", id, label: "diskbloom", linux: "unknown", ...over });
    const pin = { tag: "v0.1.0", sha256: "a".repeat(64) };
    // The plan installs the row from its release with the check; the tick says the same road and carries the same pin.
    expect(toolInstallsFor([tap({ pin })], table).installs.at(-1)!.cmd).toContain('[ "$sum" = ');
    // The tick's version is the release the road installs at: the Mac's tag, which a Homebrew row does not carry itself.
    const pinned = recipeDigest([tap({ pin })], [], [], table).ticks[0]!;
    expect(pinned).toEqual({ id, version: "v0.1.0", road: "release", installer: expect.stringMatching(/^[0-9a-f]{64}$/), pin });
    // A first run of the same row: the same road and lines, no pin yet.
    const first = recipeDigest([tap()], [], [], table);
    expect(first.ticks[0]).toEqual({ id, version: "v0.1.0", road: "release", installer: pinned.installer });
    // The seal stamps what the install read back; the recipe that then carries it is no change, and the words say nothing.
    const sealed = withRecordedPins(first, [{ id, outcome: "installed", pin }]);
    expect(sealed.ticks[0]).toEqual(pinned);
    expect(isEmptyDiff(diffRecipes(sealed, recipeDigest([tap({ pin })], [], [], table)))).toBe(true);
    expect(describeDiff(diffRecipes(sealed, recipeDigest([tap({ pin })], [], [], table)))).toEqual([]);
    // A pin is what a build recorded, not what the recipe asks: the same row with none is no change either.
    expect(describeDiff(diffRecipes(sealed, first))).toEqual([]);
    // The Mac's tap moving on is a move, both releases named: the tick installs at the new tag, no pin standing yet.
    const moved: BrewTable = new Map([["zingzy/tap/diskbloom", { ...table.get("zingzy/tap/diskbloom")!, source: { repo: "Zingzy/diskbloom", tag: "v0.2.0" } }]]);
    expect(recipeDigest([tap({ pin })], [], [], moved).ticks[0]).toEqual({ id, version: "v0.2.0", road: "release", installer: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(describeDiff(diffRecipes(sealed, recipeDigest([tap({ pin })], [], [], moved)))).toEqual(["update 1 tool: diskbloom (v0.1.0 to v0.2.0)"]);
    // Without this Mac's Homebrew read, no release is known: the plan sets the row aside and the tick reads it as the formula it names.
    expect(toolInstallsFor([tap({ pin })]).skipped.map(s => s.note)).toEqual(["no Linux bottle known"]);
    expect(recipeDigest([tap({ pin })], [], [], new Map()).ticks[0]).toEqual({ id, road: "brew", installer: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // One resolver: the plan's step for the row is the road the digest read.
    expect(rowRoad(tap({ pin }), table)).toEqual({ road: { road: "release", repo: "Zingzy/diskbloom", version: "v0.1.0", pin, go: "github.com/Zingzy/diskbloom@v0.1.0" }, bin: "diskbloom" });
  });

  it("a tap formula on the road names its binary too", () => {
    const table: BrewTable = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", linux: "unknown" })], table);
    const step = t.installs.at(-1)!;
    expect(step).toMatchObject({ id: "tools/brew/zingzy/tap/diskbloom", manager: "release", bin: "diskbloom" });
    expect(step.after).toBeUndefined();
    expect(step.cmd).toContain("https://api.github.com/repos/Zingzy/diskbloom/releases/tags/v0.1.0");
    expect(step.cmd).toContain('install -m 0755 "$bin" "/usr/local/bin/$name"');
    expect(step.cmd).toContain("GOBIN=/usr/local/bin go install 'github.com/Zingzy/diskbloom@v0.1.0'");
    expect(step.cmd).not.toContain("mv '/usr/local/bin/");
    expect(step.cmd).not.toContain('[ "$sum" =');
  });

  it("a pin for the same tag is checked; one for another tag is not", () => {
    const table: BrewTable = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const road = (pin: { tag: string; sha256: string }) => toolInstallsFor([row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", linux: "unknown", pin })], table).installs.at(-1)!;
    expect(road({ tag: "v0.1.0", sha256: "c".repeat(64) }).cmd).toContain(`[ "$sum" = '${"c".repeat(64)}' ]`);
    expect(road({ tag: "v0.0.9", sha256: "c".repeat(64) }).cmd).not.toContain('[ "$sum" =');
  });

  it("the go fallback lands under the row's command: a module whose last element is another name is moved there; a /vN module suffix is not the name", () => {
    const table: BrewTable = new Map([["spoo-me/tap/spoo", { name: "spoo", fullName: "spoo-me/tap/spoo", deps: [], macosOnly: false, source: { repo: "spoo-me/spoo-cli", tag: "v0.4.1" } }]]);
    const tap = toolInstallsFor([row({ rung: "tools", id: "tools/brew/spoo-me/tap/spoo", label: "spoo", linux: "unknown" })], table).installs.at(-1)!;
    expect(tap).toMatchObject({ manager: "release", bin: "spoo" });
    expect(tap.cmd).toContain(`GOBIN=/usr/local/bin go install 'github.com/spoo-me/spoo-cli@v0.4.1'\n  mv '/usr/local/bin/spoo-cli' "/usr/local/bin/$name"\n  echo "WSP_ROAD go "`);
    const v2: BrewTable = new Map([["spoo-me/tap/spoo", { name: "spoo", fullName: "spoo-me/tap/spoo", deps: [], macosOnly: false, source: { repo: "spoo-me/spoo/v2", tag: "v2.0.0" } }]]);
    expect(toolInstallsFor([row({ rung: "tools", id: "tools/brew/spoo-me/tap/spoo", label: "spoo", linux: "unknown" })], v2).installs.at(-1)!.cmd).not.toContain("mv '/usr/local/bin/");
  });
});

describe("agentOwning", () => {
  it("names the agent whose installer brings an npm or uv package the tools rung would list again; other rows and the git or curl installers own nothing", () => {
    expect(agentOwning("tools/npm/@earendil-works/pi-coding-agent")).toBe("pi");
    expect(agentOwning("tools/npm/@openai/codex")).toBe("codex");
    expect(agentOwning("tools/npm/@google/gemini-cli")).toBe("gemini");
    expect(agentOwning("tools/npm/opencode-ai")).toBe("opencode");
    expect(agentOwning("tools/uv/aider-chat")).toBe("aider");
    expect(agentOwning("tools/npm/wrangler")).toBeUndefined();
    expect(agentOwning("tools/pnpm/@openai/codex")).toBeUndefined();
    expect(agentOwning("tools/npm/hermes")).toBeUndefined();
  });
});

describe("the node a recipe's own rows bring", () => {
  // Node is not on the floor: a recipe row whose road runs on it brings it, once, by the catalog's own script, and
  // a recipe that asks for nothing on node leaves the image without one.
  const NODE_STEP = "tools/manager/npm";
  const tool = (id: string): RecipeEntry => row({ rung: "tools", id, label: id.slice(id.lastIndexOf("/") + 1) });
  const plan = (...ids: string[]): { id: string; after?: string }[] => toolInstallsFor(ids.map(tool)).installs.map(t => ({ id: t.id, after: t.after }));

  it("runs once, ahead of every row whose road runs on it, whichever road asked", () => {
    expect(plan("tools/npm/pnpm")).toEqual([{ id: NODE_STEP, after: undefined }, { id: "tools/npm/pnpm", after: NODE_STEP }]);
    // Two rows on the road, and a row whose own road is another that runs on node: still one node step, first.
    expect(plan("tools/npm/pnpm", "tools/npm/prettier", "tools/catalog/yarn")).toEqual([
      { id: NODE_STEP, after: undefined },
      { id: "tools/npm/pnpm", after: NODE_STEP },
      { id: "tools/npm/prettier", after: NODE_STEP },
      { id: "tools/catalog/yarn", after: NODE_STEP },
    ]);
    // bun's own install is an npm global, so the step that brings bun waits on node as its rows wait on bun.
    expect(plan("tools/bun/eslint")).toEqual([
      { id: NODE_STEP, after: undefined },
      { id: "tools/manager/bun", after: NODE_STEP },
      { id: "tools/bun/eslint", after: "tools/manager/bun" },
    ]);
  });

  it("is the recipe's own node row when it ticked one, so the person's tick is the step and nothing installs node twice", () => {
    expect(plan("tools/catalog/node", "tools/npm/pnpm")).toEqual([
      { id: "tools/catalog/node", after: undefined },
      { id: "tools/npm/pnpm", after: "tools/catalog/node" },
    ]);
    // The row that waits on node comes after the node row in the recipe, so the wait is read while that row is
    // planned: what stands for npm is settled before the first row, or the node row is planned twice.
    const one = [{ id: "tools/catalog/node", after: undefined }, { id: "tools/catalog/yarn", after: "tools/catalog/node" }];
    expect(plan("tools/catalog/node", "tools/catalog/yarn")).toEqual(one);
    expect(plan("tools/catalog/yarn", "tools/catalog/node")).toEqual(one);
    expect(plan("tools/catalog/node", "tools/catalog/playwright")).toEqual([one[0], { id: "tools/catalog/playwright", after: "tools/catalog/node" }]);
    // This Mac's own node formula is the catalog's node row, and the same holds for it.
    expect(plan("tools/brew/node", "tools/catalog/yarn")).toEqual([{ id: "tools/brew/node", after: undefined }, { id: "tools/catalog/yarn", after: "tools/brew/node" }]);
  });

  it("is not there at all for a recipe whose rows need no node", () => {
    expect(plan("tools/catalog/gh", "tools/uv/ruff").map(t => t.id)).toEqual(["tools/uv/ruff", "tools/catalog/gh"]);
  });

  it("is the catalog's own script: the node step and a node row install the same pinned release", () => {
    const step = toolInstallsFor([tool("tools/npm/pnpm")]).installs.find(t => t.id === NODE_STEP)!;
    expect(step.label).toBe("Node 22 with npm");
    expect(step.bin).toBe("node");
    expect(step.manager).toBe("script");
    expect(step.cmd).toContain(nodeInstallScript(22, NODE_RELEASES[22]));
  });

  it("keeps a node the machine already has: the script prints NODE_KEPT and downloads nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-node-step-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "node"), "#!/bin/sh\necho v22.23.2\n", { mode: 0o755 });
    writeFileSync(join(dir, "curl"), '#!/bin/sh\necho "curl ran" >&2\nexit 1\n', { mode: 0o755 });
    const script = [...ROAD_STEPS.script.env, nodeInstallScript(22, NODE_RELEASES[22])].join("\n");
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("NODE_KEPT v22.23.2");
    expect(res.stderr).not.toContain("curl ran");
  });
});

describe("agentInstallsFor", () => {
  it("every known agent has a pinned installer, its version check, and the documentation it was read from", () => {
    for (const [name, a] of Object.entries(AGENT_INSTALLERS)) {
      expect(a.name, name).not.toBe("");
      expect(a.smoke, name).toMatch(/--version/);
      expect(a.install, name).not.toMatch(/\|\s*(ba)?sh\b/);
      expect(a.install, name).not.toMatch(/@latest\b/);
      // Every agent's line names the version it installs, the harness vendor's binary included.
      expect(a.install, name).toMatch(/@\d|==\d|--branch v?\d|releases\/download\/v?\d|\/\d+\.\d+\.\d+\//);
    }
    expect(Object.keys(AGENT_INSTALLERS).sort()).toEqual(["aider", "amp", "claude", "codex", "crush", "gemini", "goose", "hermes", "opencode", "pi", "qwen"]);
    // The harness installs at the version its own text fixes, so a copy built from the pin gets that version.
    expect(AGENT_INSTALLERS["claude"]).toEqual({ name: "Claude Code", install: CLAUDE_INSTALL, smoke: "claude --version", road: "script", pin: { read: expect.stringContaining("'claude' --version"), fixed: true, words: "by its own installer" } });
    // The road each line walks, which is what bounds a step that runs it on a computer somebody owns.
    expect(Object.fromEntries(Object.entries(AGENT_INSTALLERS).map(([k, a]) => [k, a.road]))).toEqual({ claude: "script", codex: "npm", gemini: "npm", opencode: "npm", aider: "uv", pi: "npm", hermes: "script", crush: "release", qwen: "npm", goose: "release", amp: "npm" });
    expect(AGENT_INSTALLERS["codex"]!.pin).toEqual({ read: expect.stringContaining("npm root -g"), fixed: true, words: "as an npm global" });
    expect(AGENT_INSTALLERS["hermes"]!.pin).toEqual({ read: expect.stringContaining("'hermes' --version"), fixed: true, words: "by its own installer" });
    // Engines floors as the registry states them at the pinned versions.
    expect(Object.fromEntries(Object.entries(AGENT_INSTALLERS).map(([k, a]) => [k, a.node]))).toEqual({ claude: undefined, codex: 16, gemini: 20, opencode: undefined, aider: undefined, pi: 22, hermes: undefined, crush: undefined, qwen: 22, goose: undefined, amp: undefined });
  });

  it("takes each agent off the way its line put it on: the global uninstalled, the checkout removed, the pinned binary's one file deleted", () => {
    // The harness is one file the install line names, so the inverse is that file and no vendor uninstaller.
    expect(agentUninstall(AGENT_INSTALLERS["claude"]!)).toEqual({ cmd: `rm -f ${LOCAL_BIN}/claude` });
    expect(agentUninstall(AGENT_INSTALLERS["codex"]!)).toEqual({ cmd: `${NODE_PATH_LINE}\nnpm uninstall -g @openai/codex` });
    expect(agentUninstall(AGENT_INSTALLERS["aider"]!)).toEqual({ cmd: "uv tool uninstall aider-chat" });
    expect(agentUninstall(AGENT_INSTALLERS["hermes"]!)).toEqual({ cmd: "rm -rf /root/.hermes/venvs/hermes /root/.hermes/hermes-agent /usr/local/bin/hermes" });
    expect(agentUninstall({ name: "Nothing", install: "echo hi", smoke: "nothing --version", road: "script" })).toEqual({ note: "Nothing has no uninstaller; left on the machine" });
  });

  it("installs only the ticked agents, in recipe order, each from the catalog's table", () => {
    const a = agentInstallsFor([
      row({ rung: "agents", id: "agents/claude" }),
      row({ rung: "agents", id: "agents/codex" }),
      row({ rung: "agents", id: "agents/gemini", bring: false }),
      row({ rung: "agents", id: "agents/unknown-thing" }),
      row({ rung: "shell", id: "shell/zshrc" }),
    ]);
    expect(a.installs.map(i => [i.id, i.name, i.smoke])).toEqual([
      ["agents/claude", "Claude Code", "claude --version"],
      ["agents/codex", "Codex", "codex --version"],
    ]);
    expect(a.installs[0]!.install).toBe(CLAUDE_INSTALL);
    expect(a.installs[1]!.install).toContain("npm install -g @openai/codex@");
    expect(a.skipped).toEqual([{ id: "agents/unknown-thing", note: "no installer known" }]);
  });

  it("asks for Node once, at the lowest supported pinned major that meets every ticked agent's floor, else the current LTS, and only for the agents that run on it", () => {
    const today = new Date("2026-09-03T00:00:00Z");
    // Node 20 left maintenance in April 2026: a Gemini-only recipe gets 22, not 20. OpenCode is an npm global with
    // no floor of its own, so it asks for node too, and the floor the two share is Gemini's.
    const gemini = agentInstallsFor([row({ rung: "agents", id: "agents/gemini" }), row({ rung: "agents", id: "agents/opencode" })], CATALOG_AGENTS, today);
    expect(gemini.node).toMatchObject({ floor: 20, version: NODE_RELEASES[22].version, agents: ["Gemini CLI", "OpenCode"] });
    const codexOnly = agentInstallsFor([row({ rung: "agents", id: "agents/codex" })], CATALOG_AGENTS, today);
    expect(codexOnly.node).toMatchObject({ floor: 16, version: NODE_RELEASES[22].version, agents: ["Codex"] });
    const both = agentInstallsFor([row({ rung: "agents", id: "agents/gemini" }), row({ rung: "agents", id: "agents/pi" })], CATALOG_AGENTS, today);
    expect(both.node).toMatchObject({ floor: 22, version: NODE_RELEASES[22].version, agents: ["Gemini CLI", "Pi"] });
    // An agent whose installer is an npm global brings node at the major the catalog's own row pins; nothing that
    // the floor no longer carries is assumed to be there.
    const opencode = agentInstallsFor([row({ rung: "agents", id: "agents/opencode" })], CATALOG_AGENTS, today);
    expect(opencode.node).toMatchObject({ floor: 22, version: NODE_RELEASES[22].version, agents: ["OpenCode"] });
    // Claude Code's installer is its vendor's own native one and Hermes takes a release: neither asks for node.
    expect(agentInstallsFor([row({ rung: "agents", id: "agents/claude" }), row({ rung: "agents", id: "agents/hermes" })], CATALOG_AGENTS, today).node).toBeUndefined();
    expect(agentInstallsFor([row({ rung: "agents", id: "agents/aider" })], CATALOG_AGENTS, today).node).toBeUndefined();
    expect(agentInstallsFor([row({ rung: "agents", id: "agents/pi", bring: false })], CATALOG_AGENTS, today).node).toBeUndefined();
    // While 20 was still in maintenance it was the lowest satisfying major.
    expect(nodeMajorFor(20, new Date("2026-01-15T00:00:00Z"))).toBe(20);
    expect(nodeMajorFor(20, today)).toBe(22);
    expect(nodeMajorFor(16, today)).toBe(22);
    expect(nodeMajorFor(22, new Date("2028-01-01T00:00:00Z"))).toBe(CURRENT_LTS);
    expect(nodeMajorFor(24, today)).toBeUndefined();
  });

  it("an agent whose floor no pinned major meets is set aside with a note rather than installed on a Node its engines refuse", () => {
    const future = { ...CATALOG_AGENTS.find(a => a.id === "codex")!, id: "future", name: "Future", installRoad: { road: "npm" as const, package: "future", version: "1.0.0" }, node: 24 };
    const a = agentInstallsFor([row({ rung: "agents", id: "agents/future" }), row({ rung: "agents", id: "agents/codex" })], [...CATALOG_AGENTS, future]);
    expect(a.installs.map(i => i.id)).toEqual(["agents/codex"]);
    expect(a.skipped).toEqual([{ id: "agents/future", note: "needs Node 24, none pinned" }]);
    expect(a.node).toMatchObject({ floor: 16, agents: ["Codex"] });
  });

  it("the Node script keeps a guest whose major meets the floor, else installs the pinned, sha256-checked release into /usr/local", () => {
    const script = nodeInstallScript(20, NODE_RELEASES[20]);
    expect(script).toContain('echo "NODE_HAVE $node_have"');
    expect(script).toContain('-ge 20 ]; then echo "NODE_KEPT $node_have"; exit 0; fi');
    expect(script).toContain(`https://nodejs.org/dist/v${NODE_RELEASES[20].version}/`);
    expect(script).toContain(`node-v${NODE_RELEASES[20].version}-linux-x64.tar.gz sha=${NODE_RELEASES[20].sha256.x86_64}`);
    expect(script).toContain(`node-v${NODE_RELEASES[20].version}-linux-arm64.tar.gz sha=${NODE_RELEASES[20].sha256.aarch64}`);
    expect(script).toContain("sha256sum -c");
    expect(script).toContain("-C /usr/local --strip-components=1");
    // The install is proven by the node on the agents' PATH being the pinned one before it is reported.
    const installed = script.indexOf(`echo "NODE_INSTALLED v${NODE_RELEASES[20].version}"`);
    const check = script.indexOf(`test "$(node --version)" = "v${NODE_RELEASES[20].version}"`);
    const path = script.indexOf('export PATH="/usr/local/bin:$PATH"');
    expect(path).toBeGreaterThan(script.indexOf("--strip-components=1"));
    expect(check).toBeGreaterThan(path);
    expect(installed).toBeGreaterThan(check);
    expect(script).not.toMatch(/apt|nvm|\| *sh\b|\| *bash\b/);
    for (const r of Object.values(NODE_RELEASES)) {
      expect(r.sha256.x86_64).toMatch(/^[0-9a-f]{64}$/);
      expect(r.sha256.aarch64).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the hermes and aider installers bring uv by a checksummed release binary and pin the source", () => {
    const hermes = AGENT_INSTALLERS["hermes"]!.install;
    expect(hermes).toContain("sha256sum -c");
    expect(hermes).toMatch(/git clone .*--branch v\d{4}\.\d+\.\d+ https:\/\/github\.com\/NousResearch\/hermes-agent\.git \/root\/\.hermes\/hermes-agent/);
    expect(hermes).toMatch(/rev-parse HEAD\)" = "[0-9a-f]{40}"/);
    expect(hermes).toContain("uv venv --python 3.11 /root/.hermes/venvs/hermes");
    expect(AGENT_INSTALLERS["aider"]!.install).toMatch(/uv tool install --force --python 3\.12 --with pip aider-chat==\d/);
  });
});

describe("the agents as steps of the one tools loop", () => {
  const ticked = (...ids: string[]): RecipeEntry[] => ids.map(id => row({ rung: "agents", id, bring: true }));

  it("puts the node step first and every agent whose road runs on node after it, each by its own road", () => {
    const steps = agentSteps(agentInstallsFor(ticked("agents/claude", "agents/codex")));
    expect(steps.map(t => [t.id, t.manager, t.after])).toEqual([
      [AGENT_NODE_STEP, "script", undefined],
      // The vendor's own installer brings whatever it needs, so it waits on nothing.
      ["agents/claude", "script", undefined],
      ["agents/codex", "npm", AGENT_NODE_STEP],
    ]);
    const codex = steps.find(t => t.id === "agents/codex")!;
    // The agent's own version check is the step's check, its command is the step's bin, and the version the
    // catalog's road pins is what the step asks for, so a computer that answers at it installs nothing.
    expect(codex.check).toBe(AGENT_INSTALLERS["codex"]!.smoke);
    expect(codex.bin).toBe("codex");
    const road = catalogEntry("codex")!.installRoad;
    expect(codex.asks).toBe(road.road === "npm" ? road.version : undefined);
    expect(codex.pin).toEqual(AGENT_INSTALLERS["codex"]!.pin);
    // The install line runs on the tools PATH with the Node the step put on ahead of it.
    expect(codex.cmd.startsWith(PATH_LINE)).toBe(true);
    expect(codex.cmd).toContain(NODE_PATH_LINE);
    expect(codex.cmd).toContain(AGENT_INSTALLERS["codex"]!.install);
  });

  it("names the node step after the release it installs, and reads the floor its script reads", () => {
    const plan = agentInstallsFor(ticked("agents/codex"));
    const node = agentSteps(plan).find(t => t.id === AGENT_NODE_STEP)!;
    expect(node.label).toBe(`Node ${plan.node!.version}`);
    expect(node.cmd).toBe(plan.node!.cmd);
    // The check is the floor the script itself keeps a node for, so a computer that already meets it runs nothing
    // and the row reads present on every run after the first.
    expect(node.check).toBe(nodeFloorCheck(plan.node!.floor));
    expect(node.check).toContain(`-ge ${plan.node!.floor}`);
    expect(node.bin).toBeUndefined();
  });

  it("reads that floor the way the install script reads it, under a real shell", () => {
    const here = Number(process.versions.node.split(".")[0]);
    const run = (line: string): number => spawnSync("bash", ["-c", `( ${line} )`], { encoding: "utf8" }).status ?? -1;
    expect(run(nodeFloorCheck(here))).toBe(0);
    expect(run(nodeFloorCheck(here + 1))).not.toBe(0);
    // A computer with no node at all reads as under every floor rather than as an error.
    expect(spawnSync("bash", ["-c", `( PATH=/nonexistent; ${nodeFloorCheck(18)} )`], { encoding: "utf8" }).status).not.toBe(0);
  });

  it("carries no node step when nothing ticked runs on node, and nothing at all for no agent", () => {
    expect(agentSteps(agentInstallsFor(ticked("agents/claude"))).map(t => t.id)).toEqual(["agents/claude"]);
    expect(agentSteps(agentInstallsFor([]))).toEqual([]);
  });
});

describe("the version a step asks for", () => {
  it("is the row's own where its road installs at one, and nothing where the road installs what its source serves", () => {
    const { installs } = toolInstallsFor([
      row({ rung: "tools", id: "tools/npm/bun", label: "bun", version: "1.4.0" }),
      row({ rung: "tools", id: `${CATALOG_PREFIX}tmux`, label: "tmux" }),
    ]);
    const asks = (id: string): string | undefined => installs.find(t => t.id === id)!.asks;
    expect(asks("tools/npm/bun")).toBe("1.4.0");
    // apt installs the distribution's own package: the line names no version, so the step asks for none, whatever
    // the row says this computer runs.
    expect(catalogEntry("tmux")!.installRoad.road).toBe("apt");
    expect(asks(`${CATALOG_PREFIX}tmux`)).toBeUndefined();
  });
});

describe("imageCommands", () => {
  it("reads each step's command from the step itself: Homebrew's step and a manager's formula step name theirs", () => {
    const plan = toolInstallsFor([row({ rung: "tools", id: "tools/brew/eza" }), row({ rung: "tools", id: "tools/pipx/black" })]);
    expect(plan.installs.find(t => t.id === "tools/homebrew")?.bin).toBe("brew");
    expect(plan.installs.find(t => t.id === "tools/manager/pipx")?.bin).toBe("pipx");
    const on = imageCommands([], { ...plan, installs: plan.installs.map(t => ({ ...t, bin: t.bin === undefined ? undefined : `x-${t.bin}` })) }, new Map());
    for (const cmd of ["x-brew", "x-pipx"]) expect(on.has(cmd), cmd).toBe(true);
    for (const cmd of ["brew", "pipx"]) expect(on.has(cmd), cmd).toBe(false);
  });

  it("names what the image answers: the base image's commands, the floor's, the shell the rows bring, each ticked tool by package and command, Homebrew when the plan brings it, each ticked agent; an unticked row adds nothing", () => {
    const entries = [
      row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }),
      row({ rung: "shell", id: "shell/starship", paths: ["~/.config/starship.toml"] }),
      row({ rung: "tools", id: "tools/brew/eza" }),
      row({ rung: "tools", id: "tools/brew/starship", bring: false }),
      row({ rung: "tools", id: "tools/catalog/typescript" }),
      row({ rung: "agents", id: "agents/claude" }),
    ];
    const on = imageCommands(entries, toolInstallsFor(entries), new Map());
    for (const cmd of ["ls", "dircolors", "stty", "git", "rg", "unzip", "zsh", "eza", "brew", "tsc", "claude"]) expect(on.has(cmd), cmd).toBe(true);
    for (const cmd of ["starship", "diskbloom", "fish"]) expect(on.has(cmd), cmd).toBe(false);
    const bare = imageCommands([row({ rung: "shell", id: "shell/fish", paths: ["~/.config/fish"] })], toolInstallsFor([]), new Map());
    expect(bare.has("fish")).toBe(true);
    for (const cmd of ["zsh", "brew", "eza"]) expect(bare.has(cmd), cmd).toBe(false);
  });
});

describe("toolNames", () => {
  it("names every tool the recipe or the catalog knows, ticked or not, by package and command, and never the base image's plain commands", () => {
    const names = toolNames([row({ rung: "tools", id: "tools/brew/eza", bring: false }), row({ rung: "tools", id: "tools/npm/@railway/cli" }), row({ rung: "tools", id: "tools/brew-tap/owner/tap" }), row({ rung: "shell", id: "shell/zshrc" })], new Map());
    for (const n of ["eza", "railway", "gh", "gcloud", "typescript", "tsc", "rg"]) expect(names.has(n), n).toBe(true);
    // A package's basename is not a command: the road names the package and the catalog names the command.
    for (const n of ["cli", "tap", "ls", "z", "zshrc", "docker-compose"]) expect(names.has(n), n).toBe(false);
  });
});

describe("shellInstallFor", () => {
  const shell = (id: string, over: Partial<RecipeEntry> = {}) => row({ rung: "shell", id: `shell/${id}`, paths: [`~/.${id}`], ...over });

  it("zsh's rc files ticked: one apt line for zsh, the ticked frameworks fetched at their pinned commits, then chsh for the uid, all under set -e", () => {
    const plan = shellInstallFor([shell("zshrc"), shell("oh-my-zsh", { paths: ["~/.oh-my-zsh/custom"] }), shell("antidote", { paths: ["~/.zsh_plugins.txt"] }), shell("zinit", { bring: false }), row({ rung: "tools", id: "tools/brew/zsh" })]);
    expect(plan).toMatchObject({ shell: "zsh", frameworks: ["shell/oh-my-zsh", "shell/antidote"] });
    const s = plan!.cmd;
    expect(s.startsWith("set -euo pipefail")).toBe(true);
    expect(s).toContain('export HOME="${HOME:-');
    expect(s).toContain("command -v zsh >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq zsh; }");
    const omz = SHELL_FRAMEWORKS["shell/oh-my-zsh"]!;
    expect(s).toContain(`git -C "$HOME/.oh-my-zsh" fetch -q --depth 1 origin ${omz.commit}`);
    expect(s).toContain(`test "$(git -C "$HOME/.oh-my-zsh" rev-parse HEAD)" = "${omz.commit}"`);
    expect(s).toContain('git -C "$HOME/.antidote" fetch -q --depth 1 origin ');
    expect(s).not.toContain("zinit");
    expect(s).not.toContain("zplug");
    expect(s).toContain('chsh -s "$(command -v zsh)" "$(id -un)"');
    expect(s.indexOf("chsh")).toBeGreaterThan(s.indexOf("rev-parse HEAD"));
    expect(s).not.toMatch(/bash -lc/);
    expect(s).not.toMatch(/\|\s*(bash|sh|zsh)\b/);
    expect(s).not.toMatch(/\bcurl\b/);
  });

  it("only bash's rc files ticked: nothing to install, the guest's bash is the shell", () => {
    expect(shellInstallFor([shell("bashrc"), shell("bash_profile"), shell("zshrc", { bring: false }), shell("starship", { paths: ["~/.config/starship.toml"] })])).toBeUndefined();
  });

  it("a zsh framework ticked on its own still brings zsh, since nothing else can run it", () => {
    expect(shellInstallFor([shell("zplug", { paths: [] })])).toMatchObject({ shell: "zsh", frameworks: ["shell/zplug"] });
  });

  it("fish's config ticked alone: fish, with no framework", () => {
    const plan = shellInstallFor([shell("fish", { paths: ["~/.config/fish"] }), shell("zshrc", { bring: false })]);
    expect(plan).toMatchObject({ shell: "fish", frameworks: [] });
    expect(plan!.cmd).toContain("apt-get install -y -qq fish");
    expect(plan!.cmd).not.toContain("apt-get install -y -qq zsh");
    expect(plan!.cmd).toContain('chsh -s "$(command -v fish)" "$(id -un)"');
  });

  it("zsh and fish rows both ticked: both install, and the computer's login shell picks the one chsh sets, zsh when unknown", () => {
    const both = (login?: string) => shellInstallFor([shell("fish", { paths: ["~/.config/fish"], ...(login !== undefined ? { login } : {}) }), shell("zshrc", login !== undefined ? { login } : {})]);
    for (const plan of [both("zsh"), both("fish"), both()]) {
      expect(plan!.cmd).toContain("apt-get install -y -qq fish");
      expect(plan!.cmd).toContain("apt-get install -y -qq zsh");
    }
    expect(both("zsh")!.shell).toBe("zsh");
    expect(both("zsh")!.cmd).toContain('chsh -s "$(command -v zsh)" "$(id -un)"');
    expect(both("fish")!.shell).toBe("fish");
    expect(both("fish")!.cmd).toContain('chsh -s "$(command -v fish)" "$(id -un)"');
    expect(both()!.shell).toBe("zsh");
    expect(both("bash")!.shell).toBe("zsh");
    // The login shell is read off the recipe whatever is ticked, but a shell with no ticked row is never set.
    expect(shellInstallFor([shell("zshrc"), shell("fish", { paths: ["~/.config/fish"], bring: false, login: "fish" })])!.shell).toBe("zsh");
  });

  it("every framework pin is a full commit on a named branch, cloned over https", () => {
    for (const repo of Object.values(SHELL_FRAMEWORKS)) {
      expect(repo.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(repo.url).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+\.git$/);
      expect(repo.branch).toMatch(/^(main|master)$/);
      expect(repo.home).not.toMatch(/^[~/]/);
    }
  });
});

describe("one place for the brew row's id prefix", () => {
  const HOME = join("packages", "protocol", "src", "index.ts");
  // The prefix of a recipe row naming a Homebrew formula, which the collector writes and the engine, sizes and host all read back.
  const RULE = /tools\/brew\//;

  it("no source file outside the protocol's own const writes the prefix", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });
});
