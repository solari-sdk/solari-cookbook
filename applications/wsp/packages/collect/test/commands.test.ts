// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { GUARD_BEGIN, GUARD_END, calledCommands, dropPlugins, guardCommands } from "../src/index.js";

const RC = [
  '# starship: eval "$(commented init zsh)"',
  'export ZSH="$HOME/.oh-my-zsh"',
  "plugins=(",
  "    git",
  "    eza",
  "    zsh-autosuggestions",
  ")",
  "plugins+=(zsh-syntax-highlighting)",
  "fpath=(/opt/homebrew/share/zsh/site-functions $fpath)",
  "source $ZSH/oh-my-zsh.sh",
  'eval "$(starship init zsh)"',
  "alias ls='eza -la' view=bat g=git",
  'alias please="sudo $(fc -ln -1)"',
  "diskbloom --quiet",
  "autoload -U select-word-style",
  "select-word-style bash",
  "greet() { echo hi; }",
  "function bye { echo bye; }",
  "greet; bye",
  "[ -s \"$NVM_DIR/nvm.sh\" ] && \\. \"$NVM_DIR/nvm.sh\"",
  "command -v zoxide >/dev/null 2>&1 && eval \"$(zoxide init zsh)\"",
  "if command -v fnm > /dev/null; then eval `fnm env`; fi",
  "cat <<EOF",
  "not-a-command inside heredoc",
  "EOF",
  "FOO=1 BAR=2 mytool run",
  "/usr/local/bin/absolute --flag",
  "$HOME/bin/variable",
  "export PATH=\"$HOME/.local/bin:$PATH\"",
  'export MOTD="hello',
  'world"',
  "print ${(j:,:)files}",
  "typeset -a more=(",
  "  first # (see docs)",
  "  second",
  ")",
  "",
].join("\n");

describe("calledCommands", () => {
  it("names each command the file calls once, in order: inside $(...) and backticks, as an alias body's first word, and as a bare line's first word past its environment and any wrapper such as sudo", () => {
    expect(calledCommands(RC)).toEqual(["starship", "eza", "bat", "git", "diskbloom", "zoxide", "fnm", "cat", "mytool"]);
  });

  it("a builtin, a keyword, a function or alias the file defines, an autoloaded name, an assignment, an array literal's words, a path, a variable, a comment, a heredoc body, a word inside a string spanning lines and a zsh ${(flags)name} are not calls", () => {
    const names = calledCommands(RC);
    for (const not of ["world", "print", "files", "first", "second", "see", "docs", "sudo", "fc", "export", "plugins", "zsh-autosuggestions", "zsh-syntax-highlighting", "fpath", "source", "eval", "alias", "ls", "view", "please", "autoload", "select-word-style", "greet", "bye", "echo", "command", "if", "then", "fi", "commented", "not-a-command", "inside", "EOF", "/usr/local/bin/absolute", "$HOME/bin/variable", "FOO=1"]) {
      expect(names, not).not.toContain(not);
    }
  });

  it("a fish config is not shell and yields nothing; an empty file yields nothing", () => {
    expect(calledCommands("")).toEqual([]);
    expect(calledCommands("set -gx EDITOR nvim\nstarship init fish | source\n", "fish")).toEqual([]);
  });
});

describe("guardCommands", () => {
  const guard = (name: string): string => `${name}() { if (unset -f ${name}; command -v ${name}) >/dev/null 2>&1; then unset -f ${name}; ${name} "$@"; else return 127; fi; }`;
  it("prepends one block that defines a guard for each name that runs the command when it is there at call time and is a silent no-op when it is not, with a one-line note naming them, and leaves the file's own bytes as they were", () => {
    const text = 'eval "$(starship init zsh)"\nalias ls=\'eza -la\'\ndiskbloom\n';
    expect(guardCommands(text, ["starship", "eza", "diskbloom"])).toBe(
      [
        GUARD_BEGIN,
        guard("starship"),
        guard("eza"),
        guard("diskbloom"),
        "# Guarded above: a call to one of these that is not on this machine is silent instead of an error: starship, eza, diskbloom. Tick them in wsp init to install them.",
        GUARD_END,
        "",
        'eval "$(starship init zsh)"',
        "alias ls='eza -la'",
        "diskbloom",
        "",
      ].join("\n"),
    );
  });

  it("a re-run replaces the block it wrote before instead of stacking a second one, and no missing name takes the block out", () => {
    const text = "alias ls='eza -la'\n";
    const once = guardCommands(text, ["eza", "starship"]);
    const again = guardCommands(once, ["eza"]);
    expect(again).toBe(guardCommands(text, ["eza"]));
    expect(again.split(GUARD_BEGIN)).toHaveLength(2);
    expect(guardCommands(once, [])).toBe(text);
    expect(guardCommands(text, [])).toBe(text);
  });

  it("names each plugin left out on its own note line, after the no-ops and before the silenced line; plugins alone still get a block", () => {
    expect(guardCommands("plugins=(git)\n", [], ["eza"])).toBe([GUARD_BEGIN, "# plugin eza left out: eza is not on the image", GUARD_END, "", "plugins=(git)", ""].join("\n"));
    expect(guardCommands("plugins=(git)\ndiskbloom\n", ["diskbloom"], ["eza", "gcloud"])).toBe(
      [GUARD_BEGIN, guard("diskbloom"), "# plugin eza left out: eza is not on the image", "# plugin gcloud left out: gcloud is not on the image", "# Guarded above: a call to one of these that is not on this machine is silent instead of an error: diskbloom. Tick them in wsp init to install them.", GUARD_END, "", "plugins=(git)", "diskbloom", ""].join("\n"),
    );
  });

  it("keeps the file's line endings", () => {
    expect(guardCommands("diskbloom\r\n", ["diskbloom"])).toBe(`${GUARD_BEGIN}\r\ndiskbloom() { if (unset -f diskbloom; command -v diskbloom) >/dev/null 2>&1; then unset -f diskbloom; diskbloom "$@"; else return 127; fi; }\r\n# Guarded above: a call to one of these that is not on this machine is silent instead of an error: diskbloom. Tick them in wsp init to install them.\r\n${GUARD_END}\r\n\r\ndiskbloom\r\n`);
  });
});

describe("dropPlugins", () => {
  const drop = (name: string): boolean => ["eza", "gcloud", "kubectl"].includes(name);

  it("takes the named plugins out of a multi-line plugins=( ) list and a plugins+=( ) line, their lines with them, and names them once in order; every other byte stays", () => {
    const text = ["plugins=(", "    git", "    eza  # listing", "    z", "    gcloud", "    kubectl", ")", "plugins+=(eza zsh-autosuggestions)", "alias e=eza", ""].join("\n");
    expect(dropPlugins(text, drop)).toEqual({
      text: ["plugins=(", "    git", "    # listing", "    z", ")", "plugins+=(zsh-autosuggestions)", "alias e=eza", ""].join("\n"),
      dropped: ["eza", "gcloud", "kubectl"],
    });
  });

  it("a one-line list keeps its shape; a list with nothing to drop, another array, or a file without a list is returned as it is", () => {
    expect(dropPlugins("plugins=(git eza z)\n", drop)).toEqual({ text: "plugins=(git z)\n", dropped: ["eza"] });
    for (const text of ["plugins=(git z)\n", "fpath=(eza $fpath)\n", "eval \"$(eza init)\"\n", ""]) expect(dropPlugins(text, drop)).toEqual({ text, dropped: [] });
  });
});
