// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { stubBackend } from "../../runtime/test/stub-backend.js";
import {
  LIST_SCRIPT,
  applyDotfiles,
  applyScript,
  cloneScript,
  detectManager,
  parseListing,
  resolveDotfilesSource,
  type RepoEntry,
} from "../src/dotfiles.js";
import { CURL_NET } from "@wsp/catalog";
import { DOTFILES_PRESETS } from "../src/dotfiles-presets.js";

const URL = "https://github.com/someone/dotfiles";

function entries(...specs: string[]): RepoEntry[] {
  // "d path" / "f path", same shape parseListing produces.
  return specs.map(s => {
    const [kind, path] = [s.slice(0, 1), s.slice(2)];
    return { path, kind: kind === "d" ? "dir" : "file" } as RepoEntry;
  });
}

describe("resolveDotfilesSource", () => {
  it("expands a bare GitHub username to the dotfiles convention", () => {
    expect(resolveDotfilesSource("geerlingguy")).toBe("https://github.com/geerlingguy/dotfiles");
  });

  it("passes an https URL through", () => {
    expect(resolveDotfilesSource(URL)).toBe(URL);
  });

  it("rejects ssh remotes and says why", () => {
    for (const src of ["git@github.com:x/dotfiles.git", "ssh://git@github.com/x/dotfiles"]) {
      expect(() => resolveDotfilesSource(src)).toThrow(/https/);
      expect(() => resolveDotfilesSource(src)).toThrow(/credential/);
    }
  });

  it("rejects http and credentialed URLs", () => {
    expect(() => resolveDotfilesSource("http://github.com/x/dotfiles")).toThrow(/https/);
    expect(() => resolveDotfilesSource("https://user:tok@github.com/x/dotfiles")).toThrow(/credential/);
  });

  it("rejects anything that is neither a username nor a URL", () => {
    expect(() => resolveDotfilesSource("x/dotfiles")).toThrow(/username/);
  });
});

describe("detectManager (table)", () => {
  const cases: { name: string; listing: RepoEntry[]; want: string }[] = [
    { name: "chezmoiroot at top", listing: entries("f .chezmoiroot", "f dot_zshrc"), want: "chezmoi" },
    { name: "chezmoiignore at top", listing: entries("f .chezmoiignore"), want: "chezmoi" },
    { name: "any .chezmoi* entry", listing: entries("d .chezmoitemplates", "f dot_vimrc"), want: "chezmoi" },
    { name: "yadm via top-level bootstrap", listing: entries("f bootstrap", "f .zshrc"), want: "yadm" },
    { name: "yadm via .config/yadm", listing: entries("d .config", "d .config/yadm", "f .zshrc"), want: "yadm" },
    { name: "chezmoi outranks yadm", listing: entries("f .chezmoiroot", "f bootstrap"), want: "chezmoi" },
    {
      name: "stow: package dirs of dotfiles, none at top",
      listing: entries("d zsh", "f zsh/.zshrc", "d tmux", "f tmux/.tmux.conf", "f README.md"),
      want: "stow",
    },
    {
      name: "stow tolerates repo plumbing at top",
      listing: entries("f .gitignore", "d .github", "d zsh", "f zsh/.zshrc"),
      want: "stow",
    },
    {
      name: "a real dotfile at top defeats stow",
      listing: entries("f .zshrc", "d zsh", "f zsh/.zshrc"),
      want: "plain",
    },
    {
      name: "dirs without dotfile contents are not stow packages",
      listing: entries("d scripts", "f scripts/backup.sh", "f .vimrc"),
      want: "plain",
    },
    {
      name: "plain: top-level dotfiles (geerlingguy shape)",
      listing: entries("f .gitconfig", "d .github", "f .gitignore", "f .inputrc", "f .osx", "f .vimrc", "f .zshrc", "f LICENSE", "f README.md"),
      want: "plain",
    },
    { name: "empty repo falls back to plain", listing: [], want: "plain" },
    { name: "yadm outranks stow", listing: entries("f bootstrap", "d zsh", "f zsh/.zshrc"), want: "yadm" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(detectManager(c.listing)).toBe(c.want);
    });
  }
});

describe("parseListing", () => {
  it("parses find output and ignores blank lines", () => {
    expect(parseListing("f .zshrc\nd zsh\nf zsh/.zshrc\n\n")).toEqual([
      { path: ".zshrc", kind: "file" },
      { path: "zsh", kind: "dir" },
      { path: "zsh/.zshrc", kind: "file" },
    ]);
  });
});

describe("generated scripts", () => {
  const managers = ["chezmoi", "yadm", "stow", "plain"] as const;

  const STOW_LISTING = entries("d zsh", "f zsh/.zshrc", "d tmux", "f tmux/.tmux.conf", "d docs", "f docs/readme.md");

  it.each(managers)("%s apply script snapshot", m => {
    expect(applyScript(m, URL, STOW_LISTING)).toMatchSnapshot();
  });

  it("stow applies only the detected packages, not every top-level dir", () => {
    const s = applyScript("stow", URL, STOW_LISTING);
    expect(s).toContain(`stow --verbose --target "$HOME" 'zsh' 'tmux'`);
    expect(s).not.toContain("docs");
    expect(s).not.toContain("*/");
  });

  it("clone script snapshot", () => {
    expect(cloneScript(URL)).toMatchSnapshot();
  });

  it("list script snapshot", () => {
    expect(LIST_SCRIPT).toMatchSnapshot();
  });

  it("every script fails fast and never uses a login shell or curl|sh", () => {
    const scripts = [
      cloneScript(URL),
      LIST_SCRIPT,
      ...managers.map(m => applyScript(m, URL)),
      ...Object.values(DOTFILES_PRESETS),
    ];
    for (const s of scripts) {
      expect(s.startsWith("set -euo pipefail")).toBe(true);
      expect(s).toContain('export HOME="${HOME:-');
      expect(s).not.toMatch(/bash -lc/);
      expect(s).not.toMatch(/\|\s*(bash|sh)\b/);
    }
  });

  it("single quotes in a URL cannot escape the script quoting", () => {
    const s = cloneScript("https://github.com/x/dotfiles'; rm -rf /'");
    expect(s).toContain(`'https://github.com/x/dotfiles'\\''; rm -rf /'\\'''`);
  });
});

describe("presets", () => {
  it("is exactly the three named scripts", () => {
    expect(Object.keys(DOTFILES_PRESETS).sort()).toEqual(["neovim", "tmux", "zsh"]);
  });

  it.each(Object.keys(DOTFILES_PRESETS))("%s preset script snapshot", name => {
    expect(DOTFILES_PRESETS[name as keyof typeof DOTFILES_PRESETS]).toMatchSnapshot();
  });

  it("zsh installs starship from a pinned, checksummed release binary", () => {
    const s = DOTFILES_PRESETS.zsh;
    expect(s).toMatch(/starship\/releases\/download\/v\d+\.\d+\.\d+\//);
    expect(s).toContain("sha256sum -c");
    expect(s).not.toContain("oh-my-zsh");
  });

  it("a pinned binary's download goes through the catalog's one curl function, defined ahead of it, and types no flags of its own", () => {
    for (const s of [DOTFILES_PRESETS.zsh, applyScript("chezmoi", URL)]) {
      expect(s.indexOf(CURL_NET)).toBeGreaterThan(0);
      expect(s.indexOf(CURL_NET)).toBeLessThan(s.indexOf("curl -o"));
      expect(s).not.toMatch(/\bcurl +-[A-Za-z]*[fsSL]\b/);
    }
  });
});

const PLAIN_LISTING = "f .zshrc\nf .vimrc\nf README.md\n";

function machineWith(routes: (cmd: string) => { exitCode: number; stdout: string; stderr: string }) {
  const backend = stubBackend();
  backend.execImpl = (_m, cmd) => routes(cmd);
  return backend;
}

async function newMachine(backend: ReturnType<typeof stubBackend>) {
  return (await backend.create({ kind: "sandbox", template: "base" })) as import("../../runtime/test/stub-backend.js").StubMachine;
}

describe("applyDotfiles exec sequence", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };

  it("runs clone, list, apply, then presets in order", async () => {
    const backend = machineWith(cmd =>
      cmd === LIST_SCRIPT ? { ...ok, stdout: PLAIN_LISTING } : ok,
    );
    const m = await newMachine(backend);
    const result = await applyDotfiles(m, "someone", { presets: ["tmux", "neovim"] });
    expect(result.manager).toBe("plain");
    expect(result.steps).toEqual([
      { name: "clone", exitCode: 0 },
      { name: "list", exitCode: 0 },
      { name: "apply", exitCode: 0 },
      { name: "preset:tmux", exitCode: 0 },
      { name: "preset:neovim", exitCode: 0 },
    ]);
    // A clone or an apply can run for minutes, so every step is a run.
    expect(m.runLog).toEqual(m.execLog);
    expect(m.execLog).toEqual([
      cloneScript("https://github.com/someone/dotfiles"),
      LIST_SCRIPT,
      applyScript("plain", "https://github.com/someone/dotfiles"),
      DOTFILES_PRESETS.tmux,
      DOTFILES_PRESETS.neovim,
    ]);
  });

  it("a failing apply throws the stderr tail in the golden failure shape and skips presets", async () => {
    const backend = machineWith(cmd => {
      if (cmd === LIST_SCRIPT) return { ...ok, stdout: PLAIN_LISTING };
      if (cmd === applyScript("plain", "https://github.com/someone/dotfiles")) {
        return { exitCode: 2, stdout: "", stderr: "x".repeat(600) + "TAIL" };
      }
      return ok;
    });
    const m = await newMachine(backend);
    const p = applyDotfiles(m, "someone", { presets: ["tmux"] });
    await expect(p).rejects.toThrow(/^dotfiles apply failed \(exit 2\): /);
    await expect(p).rejects.toThrow(/TAIL$/);
    await p.catch((e: Error) => {
      const tail = e.message.split("): ")[1]!;
      expect(tail).toHaveLength(500);
    });
    expect(m.execLog).toHaveLength(3);
  });

  it("an auth-shaped clone failure names the v1 private-repo limit", async () => {
    const backend = machineWith(cmd =>
      cmd.includes("git clone")
        ? { exitCode: 128, stdout: "", stderr: "fatal: repository 'https://github.com/x/dotfiles/' not found" }
        : ok,
    );
    const m = await newMachine(backend);
    await expect(applyDotfiles(m, "https://github.com/x/dotfiles")).rejects.toThrow(
      /private repos are not supported in v1/,
    );
    expect(m.execLog).toHaveLength(1);
  });

  it("an auth-shaped failure on the chezmoi re-clone at apply also names the v1 limit", async () => {
    const backend = machineWith(cmd => {
      if (cmd === LIST_SCRIPT) return { ...ok, stdout: "f .chezmoiroot\nf dot_zshrc\n" };
      if (cmd.includes("chezmoi init")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/x/dotfiles/'" };
      }
      return ok;
    });
    const m = await newMachine(backend);
    await expect(applyDotfiles(m, "https://github.com/x/dotfiles")).rejects.toThrow(
      /^dotfiles apply failed \(exit 128\) \(private repos are not supported in v1/,
    );
  });

  it("rejects an unknown preset before touching the machine", async () => {
    const backend = machineWith(() => ok);
    const m = await newMachine(backend);
    await expect(applyDotfiles(m, "someone", { presets: ["emacs"] })).rejects.toThrow(/unknown preset "emacs"/);
    expect(m.execLog).toEqual([]);
  });
});
