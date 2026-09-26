// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectShell } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

describe("shell", () => {
  it.each([
    ["~/.zshrc", "shell/zshrc", "~/.zshrc"],
    ["~/.zshenv", "shell/zshenv", "~/.zshenv"],
    ["~/.bashrc", "shell/bashrc", "~/.bashrc"],
    ["~/.bash_profile", "shell/bash_profile", "~/.bash_profile"],
    ["~/.profile", "shell/profile", "~/.profile"],
    ["~/.inputrc", "shell/inputrc", "~/.inputrc"],
    ["~/.aliases", "shell/aliases", "~/.aliases"],
    ["~/.config/fish/config.fish", "shell/fish", "~/.config/fish"],
    ["~/.config/starship.toml", "shell/starship", "~/.config/starship.toml"],
    ["~/.p10k.zsh", "shell/p10k", "~/.p10k.zsh"],
    ["~/.config/oh-my-posh/theme.json", "shell/oh-my-posh", "~/.config/oh-my-posh"],
    ["~/.tmux.conf", "shell/tmux", "~/.tmux.conf"],
    ["~/.config/tmux/tmux.conf", "shell/tmux", "~/.config/tmux"],
    ["~/.config/zellij/config.kdl", "shell/zellij", "~/.config/zellij"],
    ["~/.config/direnv/direnvrc", "shell/direnv", "~/.config/direnv"],
    ["~/.direnvrc", "shell/direnv", "~/.direnvrc"],
    ["~/.config/sheldon/plugins.toml", "shell/sheldon", "~/.config/sheldon"],
  ])("%s is offered as %s", async (file, id, path) => {
    const rows = await detectShell(fakeHost({ files: { [file]: 10 } }));
    expect(rows).toEqual([{ rung: "shell", id, label: expect.any(String), paths: [path], bytes: 10, default: "bring" }]);
  });

  it("records the login shell on every shell row when SHELL names one /etc/shells lists, by name", async () => {
    const shells = "# List of acceptable login shells\n/bin/bash\n/bin/zsh\n/opt/homebrew/bin/fish\n";
    const zsh = await detectShell(fakeHost({ shell: "/bin/zsh", files: { "~/.zshrc": 10, "~/.config/fish/config.fish": 5, "/etc/shells": shells } }));
    expect(zsh.map(r => [r.id, r.login])).toEqual([["shell/zshrc", "zsh"], ["shell/fish", "zsh"]]);
    const fish = await detectShell(fakeHost({ shell: "/opt/homebrew/bin/fish", files: { "~/.zshrc": 10, "/etc/shells": shells } }));
    expect(fish[0]).toMatchObject({ id: "shell/zshrc", login: "fish" });
  });

  it("a SHELL that /etc/shells does not list, or no SHELL at all, leaves the rows without a login shell", async () => {
    const unlisted = await detectShell(fakeHost({ shell: "/usr/local/bin/nu", files: { "~/.zshrc": 10, "/etc/shells": "/bin/bash\n/bin/zsh\n" } }));
    expect(unlisted[0]).not.toHaveProperty("login");
    const missing = await detectShell(fakeHost({ shell: "/bin/zsh", files: { "~/.zshrc": 10 } }));
    expect(missing[0]).not.toHaveProperty("login");
    const none = await detectShell(fakeHost({ files: { "~/.zshrc": 10, "/etc/shells": "/bin/zsh\n" } }));
    expect(none[0]).not.toHaveProperty("login");
  });

  it("oh-my-zsh brings only the custom dir; the framework reinstalls", async () => {
    const rows = await detectShell(fakeHost({ files: { "~/.oh-my-zsh/oh-my-zsh.sh": 9000, "~/.oh-my-zsh/custom/aliases.zsh": 200 } }));
    expect(rows).toEqual([
      { rung: "shell", id: "shell/oh-my-zsh", label: "oh-my-zsh custom dir (the framework reinstalls)", paths: ["~/.oh-my-zsh/custom"], bytes: 200, default: "bring" },
    ]);
  });

  it("plugin managers that reinstall from the rc file are listed with no paths", async () => {
    const rows = await detectShell(fakeHost({ files: { "~/.local/share/zinit/zinit.git/zinit.zsh": 100, "~/.zplug/init.zsh": 5 } }));
    expect(rows).toEqual([
      { rung: "shell", id: "shell/zinit", label: "zinit (reinstalls from ~/.zshrc)", paths: [], bytes: 0, default: "bring" },
      { rung: "shell", id: "shell/zplug", label: "zplug (reinstalls from ~/.zshrc)", paths: [], bytes: 0, default: "bring" },
    ]);
  });

  it("antidote and fisher bring their plugin list", async () => {
    const rows = await detectShell(fakeHost({
      files: { "~/.antidote/antidote.zsh": 5, "~/.zsh_plugins.txt": 60, "~/.config/fish/functions/fisher.fish": 5, "~/.config/fish/fish_plugins": 30 },
    }));
    expect(rows.map(r => [r.id, r.paths])).toEqual([
      ["shell/fish", ["~/.config/fish"]],
      ["shell/antidote", ["~/.zsh_plugins.txt"]],
      ["shell/fisher", ["~/.config/fish/fish_plugins"]],
    ]);
  });

  it("history is offered unticked, in one row", async () => {
    const rows = await detectShell(fakeHost({ files: { "~/.zsh_history": 800_000, "~/.local/share/atuin/history.db": 2_000_000 } }));
    expect(rows).toEqual([
      { rung: "shell", id: "shell/history", label: "shell history", paths: ["~/.zsh_history", "~/.local/share/atuin"], bytes: 2_800_000, default: "skip" },
    ]);
  });

  it("an empty laptop gives no shell rows", async () => {
    expect(await detectShell(fakeHost())).toEqual([]);
  });
});
