// SPDX-License-Identifier: AGPL-3.0-only
// A small laptop as the collector would describe it, fixed so the screens'
// tests can name rows; the real collector is what wsp init runs.
import { BASE_FLOOR } from "@wsp/catalog";
import { SSH_IGNORE_UNKNOWN_DETAIL, type Manifest, type ManifestEntry } from "@wsp/collect";
import type { Recipe } from "@wsp/protocol";

export const FIXTURE: Manifest = {
  entries: [
    { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 512, default: "bring", required: true },
    { rung: "identity", id: "identity/ssh-config", label: "~/.ssh/config", paths: ["~/.ssh/config"], bytes: 1200, default: "bring", detail: SSH_IGNORE_UNKNOWN_DETAIL },
    { rung: "identity", id: "identity/ssh-key", label: "~/.ssh/id_ed25519", paths: ["~/.ssh/id_ed25519"], bytes: 400, default: "skip", reason: "private key, never copied" },
    { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 3000, default: "bring" },
    { rung: "shell", id: "shell/starship", label: "starship prompt", paths: ["~/.config/starship.toml"], bytes: 900, default: "bring" },
    { rung: "toolchains", id: "toolchains/mise", label: "mise pins", paths: ["~/.config/mise/config.toml"], bytes: 300, default: "bring" },
    { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: ["Brewfile"], bytes: 0, default: "bring" },
    { rung: "tools", id: "tools/brew/yq", label: "yq", group: "Homebrew", paths: ["Brewfile"], bytes: 0, default: "bring" },
    { rung: "tools", id: "tools/npm/tsx", label: "tsx", group: "npm globals", paths: [], bytes: 0, default: "bring" },
    { rung: "tools", id: "tools/brew/rectangle", label: "rectangle", group: "Homebrew", paths: ["Brewfile"], bytes: 0, default: "skip", reason: "no Linux bottle", linux: "no" },
    { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude"], bytes: 40_000, default: "bring" },
    { rung: "agents", id: "agents/codex", label: "Codex", paths: ["~/.codex"], bytes: 8_000, default: "skip" },
    { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], bytes: 200, default: "skip" },
    { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: ["Keychain: Claude Code-credentials"], bytes: 0, default: "skip" },
    { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: ["~/.codex/auth.json"], bytes: 300, default: "skip" },
  ],
};

export const byId = (id: string): ManifestEntry => {
  const e = FIXTURE.entries.find(x => x.id === id);
  if (!e) throw new Error(`no fixture entry ${id}`);
  return e;
};

/** The small recipe wsp recipe would write on the same laptop: Claude Code and the two formulae installed here,
 * Codex known to the catalog but not here, the floor on by default; tsx stands for no catalog tool and is left out. */
export const RECIPE: Recipe = {
  version: 1,
  at: "2026-09-06T03:00:00.000Z",
  histories: [{ agent: "claude", state: "empty", sessions: 0, calls: 0 }],
  rows: [
    { id: "claude", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.claude/settings.json"], bin: true }, size: 208 * 1024 * 1024 },
    { id: "codex", kind: "agent", on: false, source: { kind: "popular", sessions: 5, images: 1 }, size: 455 * 1024 * 1024 },
    ...BASE_FLOOR.map(e => e.id).map((id): Recipe["rows"][number] => ({ id, kind: "tool", on: true, source: { kind: "popular", sessions: 10, images: 5 } })),
    { id: "gh", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } },
    { id: "yq", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } },
  ],
};
