// SPDX-License-Identifier: AGPL-3.0-only
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { type RowSpec, exists, item, present, row } from "./common.js";

export const RC_FILES = ["zshrc", "zshenv", "zprofile", "zlogin", "bashrc", "bash_profile", "profile", "inputrc", "aliases", "zsh_aliases"];

const ROWS: readonly RowSpec[] = [
  { rung: "shell", id: "shell/fish", label: "fish config", paths: ["~/.config/fish"] },
  { rung: "shell", id: "shell/sheldon", label: "sheldon plugins", paths: ["~/.config/sheldon"] },
  { rung: "shell", id: "shell/starship", label: "starship prompt", paths: ["~/.config/starship.toml"] },
  { rung: "shell", id: "shell/p10k", label: "powerlevel10k prompt", paths: ["~/.p10k.zsh"] },
  { rung: "shell", id: "shell/oh-my-posh", label: "oh-my-posh prompt", paths: ["~/.config/oh-my-posh"] },
  { rung: "shell", id: "shell/tmux", label: "tmux config", paths: ["~/.tmux.conf", "~/.config/tmux"] },
  { rung: "shell", id: "shell/zellij", label: "zellij config", paths: ["~/.config/zellij"] },
  { rung: "shell", id: "shell/direnv", label: "direnv config", paths: ["~/.config/direnv", "~/.direnvrc"] },
];

/** Plugin managers whose install is a line in the rc file; only a separate plugin list travels. */
const MANAGERS: readonly { id: string; label: string; markers: string[]; list?: string }[] = [
  { id: "zinit", label: "zinit (reinstalls from ~/.zshrc)", markers: ["~/.local/share/zinit", "~/.zinit"] },
  { id: "zplug", label: "zplug (reinstalls from ~/.zshrc)", markers: ["~/.zplug"] },
  { id: "antidote", label: "antidote plugin list", markers: ["~/.antidote"], list: "~/.zsh_plugins.txt" },
  { id: "fisher", label: "fisher plugin list", markers: ["~/.config/fish/functions/fisher.fish"], list: "~/.config/fish/fish_plugins" },
];

const HISTORY = ["~/.zsh_history", "~/.bash_history", "~/.local/share/fish/fish_history", "~/.local/share/atuin"];

/** The name of the login shell, when SHELL names one /etc/shells lists; a SHELL set by hand to
 * something else, or none at all, leaves the choice to the machine's default. */
export async function loginShell(host: Host): Promise<string | undefined> {
  if (host.shell === undefined) return undefined;
  const listed = ((await host.fs.readText("/etc/shells")) ?? "").split("\n").map(l => l.trim());
  return listed.includes(host.shell) ? host.shell.slice(host.shell.lastIndexOf("/") + 1) : undefined;
}

export async function detectShell(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [];
  for (const name of RC_FILES) {
    rows.push(await row(host, { rung: "shell", id: `shell/${name}`, label: `~/.${name}`, paths: [`~/.${name}`] }));
  }
  for (const spec of ROWS) rows.push(await row(host, spec));

  if (await exists(host, "~/.oh-my-zsh")) {
    rows.push(await row(host, { rung: "shell", id: "shell/oh-my-zsh", label: "oh-my-zsh custom dir (the framework reinstalls)", paths: ["~/.oh-my-zsh/custom"], always: true }));
  }
  for (const m of MANAGERS) {
    let hit = false;
    for (const marker of m.markers) hit = hit || (await exists(host, marker));
    if (!hit) continue;
    rows.push(m.list === undefined
      ? item({ rung: "shell", id: `shell/${m.id}`, label: m.label })
      : await row(host, { rung: "shell", id: `shell/${m.id}`, label: m.label, paths: [m.list], always: true }));
  }

  rows.push(await row(host, { rung: "shell", id: "shell/history", label: "shell history", paths: HISTORY, default: "skip" }));
  const login = await loginShell(host);
  return present(rows).map(r => (login === undefined ? r : { ...r, login }));
}
