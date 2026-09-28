// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DETECTORS, bareSources, guardSources } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const HOME = "/Users/dev";

const RC = [
  "export PATH=\"$HOME/bin:$PATH\"",
  '. "$HOME/.cargo/env"',
  "source ~/.deno/env  # deno",
  '  source "${HOME}/.zsh/functions.zsh"',
  ". /Users/dev/.local/share/x/env",
  "source '/Users/dev/.aliases'",
  '\\. "$HOME/.bun/_bun"',
  "[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh",
  'if [ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]; then',
  '  source "$HOME/.sdkman/bin/sdkman-init.sh"',
  "fi",
  "source $ZSH/oh-my-zsh.sh",
  '. "$NVM_DIR/nvm.sh"',
  "source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh",
  "source ~/.secrets 2>/dev/null",
  "source ~/.extra || true",
  "# source ~/.disabled",
  "source ~/.deno/env",
  "source ~/.zsh/*.zsh",
  "source",
  ".",
  "sourced=1",
  "source ~/.x; source ~/.y",
  '. "/Users/dev/.zsh/functions.zsh"',
].join("\n");

describe("bareSources", () => {
  it("a line that is one source or dot of a literal path and nothing else, once per file, in order; a path under home is ~-relative, one outside it absolute", () => {
    expect(bareSources(RC, HOME)).toEqual(["~/.cargo/env", "~/.deno/env", "~/.zsh/functions.zsh", "~/.local/share/x/env", "~/.aliases", "~/.bun/_bun", "~/.sdkman/bin/sdkman-init.sh", "/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh"]);
  });

  it("a guarded, redirected, chained, variable, glob, relative or commented line is not one", () => {
    const paths = bareSources(RC, HOME);
    expect(paths).not.toContain("~/.fzf.zsh");
    expect(paths).not.toContain("~/.secrets");
    expect(paths).not.toContain("~/.extra");
    expect(paths).not.toContain("~/.disabled");
    expect(paths).not.toContain("~/.x");
    expect(paths.some(p => p.includes("*") || p.includes("$"))).toBe(false);
    expect(bareSources("", HOME)).toEqual([]);
    expect(bareSources("source ~someone/.x\nsource ~\n. ~/\nsource ~/../etc/profile\nsource ~//x\nsource /\nsource /opt/../etc/x\nsource opt/x\nsource ./x\n", HOME)).toEqual([]);
  });
});

describe("guardSources", () => {
  it("wraps each bare line whose file is not present, a path outside home always, keeping its indent, word, token and comment; leaves the rest byte for byte", () => {
    const present = new Set(["~/.zsh/functions.zsh", "~/.aliases"]);
    const out = guardSources(RC, HOME, rel => present.has(`~/${rel}`));
    const lines = out.split("\n");
    const before = RC.split("\n");
    expect(lines).toHaveLength(before.length);
    expect(lines[1]).toBe('[ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"');
    expect(lines[2]).toBe("[ -r ~/.deno/env ] && source ~/.deno/env # deno");
    expect(lines[3]).toBe(before[3]);
    expect(lines[4]).toBe('[ -r "$HOME"/.local/share/x/env ] && . "$HOME"/.local/share/x/env');
    expect(lines[5]).toBe('[ -r "$HOME"\'/.aliases\' ] && source "$HOME"\'/.aliases\'');
    expect(lines[6]).toBe('[ -r "$HOME/.bun/_bun" ] && \\. "$HOME/.bun/_bun"');
    expect(lines[9]).toBe('  [ -r "$HOME/.sdkman/bin/sdkman-init.sh" ] && source "$HOME/.sdkman/bin/sdkman-init.sh"');
    expect(lines[13]).toBe("[ -r /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh ] && source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh");
    expect(lines[17]).toBe("[ -r ~/.deno/env ] && source ~/.deno/env");
    for (const i of [0, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20, 21, 22]) expect(lines[i]).toBe(before[i]);
  });

  it("a line naming this computer's home literally is wrapped even when its file travels, the home prefix written as \"$HOME\" so the machine reads the carried file; the token's own quoting stays around the rest", () => {
    const rc = ['. "/Users/dev/.zsh/functions.zsh"', "source /Users/dev/.zsh/functions.zsh", "source '/Users/dev/.zsh/functions.zsh'  # fns", "source /Users/developer/.x", ""].join("\n");
    expect(guardSources(rc, HOME, () => true)).toBe(['[ -r "$HOME/.zsh/functions.zsh" ] && . "$HOME/.zsh/functions.zsh"', '[ -r "$HOME"/.zsh/functions.zsh ] && source "$HOME"/.zsh/functions.zsh', '[ -r "$HOME"\'/.zsh/functions.zsh\' ] && source "$HOME"\'/.zsh/functions.zsh\' # fns', "[ -r /Users/developer/.x ] && source /Users/developer/.x", ""].join("\n"));
    expect(bareSources(rc, HOME)).toEqual(["~/.zsh/functions.zsh", "/Users/developer/.x"]);
  });

  it("everything present leaves the text as it was, line endings and trailing newline included", () => {
    const crlf = '. "$HOME/.cargo/env"\r\nalias g=git\r\n';
    expect(guardSources(crlf, HOME, () => true)).toBe(crlf);
    expect(guardSources("source /opt/homebrew/etc/profile.d/z.sh\n", HOME, () => true)).toBe("[ -r /opt/homebrew/etc/profile.d/z.sh ] && source /opt/homebrew/etc/profile.d/z.sh\n");
    expect(guardSources(crlf, HOME, () => false)).toBe('[ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"\r\nalias g=git\r\n');
    expect(guardSources("alias g=git", HOME, () => false)).toBe("alias g=git");
  });
});

describe("the shell rung records the bare sources of each zsh and bash rc file", () => {
  it("the paths land on the rc file's own row; a file with none, a fish config and inputrc carry no field", async () => {
    const rows = await DETECTORS.shell(fakeHost({
      files: {
        "~/.zshrc": '. "$HOME/.cargo/env"\nsource ~/.zsh/aliases.zsh\n[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh\n',
        "~/.zprofile": "eval \"$(/opt/homebrew/bin/brew shellenv)\"\n",
        "~/.bashrc": "source ~/.bash_aliases\nsource /opt/homebrew/etc/profile.d/bash_completion.sh\n",
        "~/.inputrc": "$include ~/.inputrc_local\n",
        "~/.config/fish/config.fish": "source ~/.config/fish/local.fish\n",
      },
    }), []);
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get("shell/zshrc")?.sources).toEqual(["~/.cargo/env", "~/.zsh/aliases.zsh"]);
    expect(byId.get("shell/bashrc")?.sources).toEqual(["~/.bash_aliases", "/opt/homebrew/etc/profile.d/bash_completion.sh"]);
    expect(byId.get("shell/zprofile")).not.toHaveProperty("sources");
    expect(byId.get("shell/inputrc")).not.toHaveProperty("sources");
    expect(byId.get("shell/fish")).not.toHaveProperty("sources");
  });
});
