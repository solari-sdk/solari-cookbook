// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectTools, parseBrewfile, parseBunGlobals, parseCargoInstalls, parseGoVersionM, parseNpmGlobals, parsePipxList, parsePnpmGlobals, parseUvToolList } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const BREWFILE = `tap "homebrew/bundle"
brew "gh"
brew "jq", link: true
brew "oven-sh/bun/bun"
brew "mas"
cask "rectangle"
mas "Xcode", id: 497799835
vscode "ms-python.python"
`;

describe("tools", () => {
  it("parses a Brewfile into taps and formulae; casks, mas apps and vscode lines have no Linux build and make no row", () => {
    expect(parseBrewfile(BREWFILE)).toEqual([
      { kind: "tap", name: "homebrew/bundle" },
      { kind: "brew", name: "gh" },
      { kind: "brew", name: "jq" },
      { kind: "brew", name: "oven-sh/bun/bun" },
      { kind: "brew", name: "mas" },
    ]);
  });

  it("Homebrew rows: taps, and formulae marked by the Linux bottle snapshot", async () => {
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": BREWFILE } });
    const rows = await detectTools(host);
    expect(rows).toEqual([
      { rung: "tools", id: "tools/brew-tap/homebrew/bundle", label: "homebrew/bundle", group: "Homebrew taps", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/jq", label: "jq", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/oven-sh/bun/bun", label: "oven-sh/bun/bun", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" },
      { rung: "tools", id: "tools/brew/mas", label: "mas", group: "Homebrew", paths: [], bytes: 0, default: "skip", reason: "no Linux bottle", linux: "no" },
    ]);
  });

  it("default ticks: no Linux bottle locks the row off with its reason, an unknown Linux build starts unticked but stays tickable, a bottled formula starts ticked", async () => {
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": 'brew "mas"\nbrew "zingzy/tap/diskbloom"\nbrew "gh"\n' } });
    const rows = await detectTools(host);
    expect(rows.map(r => [r.id, r.default, r.reason, r.linux])).toEqual([
      ["tools/brew/mas", "skip", "no Linux bottle", "no"],
      ["tools/brew/zingzy/tap/diskbloom", "skip", undefined, "unknown"],
      ["tools/brew/gh", "bring", undefined, "yes"],
    ]);
  });

  it("a formula already installed on a Linux laptop runs on Linux whatever the snapshot says", async () => {
    const host = fakeHost({ platform: "linux", which: ["brew"], exec: { "brew bundle dump --file=-": 'brew "mas"\nbrew "oven-sh/bun/bun"\n' } });
    const rows = await detectTools(host);
    expect(rows.map(r => [r.id, r.default, r.linux])).toEqual([["tools/brew/mas", "bring", "yes"], ["tools/brew/oven-sh/bun/bun", "bring", "yes"]]);
  });

  it("no brew means no dump is attempted", async () => {
    const host = fakeHost();
    expect(await detectTools(host)).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it("Nix home-manager config is brought wholesale", async () => {
    const rows = await detectTools(fakeHost({ files: { "~/.config/home-manager/home.nix": 700, "~/.config/home-manager/flake.nix": 300 } }));
    expect(rows).toEqual([{ rung: "tools", id: "tools/nix-home-manager", label: "Nix home-manager config", paths: ["~/.config/home-manager"], bytes: 1000, default: "bring", linux: "yes" }]);
  });

  it("parses npm globals, dropping npm and corepack", () => {
    const out = JSON.stringify({ dependencies: { npm: { version: "10.0.0" }, corepack: { version: "0.29.0" }, pnpm: { version: "9.12.0" }, "@anthropic-ai/claude-code": { version: "1.0.0" } } });
    expect(parseNpmGlobals(out)).toEqual([{ name: "pnpm", version: "9.12.0" }, { name: "@anthropic-ai/claude-code", version: "1.0.0" }]);
    expect(parseNpmGlobals("not json")).toEqual([]);
  });

  it("parses pnpm globals: one project object per global dir, its dependencies map", () => {
    const out = JSON.stringify([{ path: "/Users/dev/Library/pnpm/global/5", private: true, dependencies: { typescript: { from: "typescript", version: "5.6.2", resolved: "https://x", path: "/y" }, "@biomejs/biome": { from: "@biomejs/biome", version: "1.9.4" } } }]);
    expect(parsePnpmGlobals(out)).toEqual([{ name: "typescript", version: "5.6.2" }, { name: "@biomejs/biome", version: "1.9.4" }]);
    expect(parsePnpmGlobals(JSON.stringify([{ path: "/x", private: true, dependencies: {} }]))).toEqual([]);
    expect(parsePnpmGlobals("not json")).toEqual([]);
  });

  it("parses bun globals: a header line then a tree of name@version, scoped names included", () => {
    const out = "/Users/dev/.bun/install/global node_modules (4)\n├── @types/node@26.4.1\n└── is-odd@3.0.1\n";
    expect(parseBunGlobals(out)).toEqual([{ name: "@types/node", version: "26.4.1" }, { name: "is-odd", version: "3.0.1" }]);
    expect(parseBunGlobals("")).toEqual([]);
  });

  it("parses pipx, uv tool and cargo listings", () => {
    const pipx = JSON.stringify({ venvs: { httpie: { metadata: { main_package: { package_version: "3.2.4" } } }, black: { metadata: {} } } });
    expect(parsePipxList(pipx)).toEqual([{ name: "httpie", version: "3.2.4" }, { name: "black" }]);
    expect(parseUvToolList("ruff v0.6.3\n- ruff\nhttpx v0.27.0\n- httpx\n")).toEqual([{ name: "ruff", version: "0.6.3" }, { name: "httpx", version: "0.27.0" }]);
    expect(parseCargoInstalls("ripgrep v14.1.0:\n    rg\nbat v0.24.0 (/src/bat):\n    bat\n")).toEqual([{ name: "ripgrep", version: "14.1.0" }, { name: "bat", version: "0.24.0" }]);
  });

  it("reads module path and version out of go version -m", () => {
    const out = "/Users/dev/go/bin/gopls: go1.23.1\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n";
    expect(parseGoVersionM(out)).toEqual({ path: "golang.org/x/tools/gopls", version: "v0.16.2" });
    expect(parseGoVersionM("garbage")).toBeUndefined();
  });

  it("global installs become one row per package under their manager's group", async () => {
    const host = fakeHost({
      files: { "~/go/bin/gopls": 1 },
      which: ["npm", "pnpm", "bun", "pipx", "uv", "cargo", "go"],
      exec: {
        "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { pnpm: { version: "9.12.0" } } }),
        "pnpm ls -g --depth=0 --json": JSON.stringify([{ path: "/g", private: true, dependencies: { typescript: { version: "5.6.2" } } }]),
        "bun pm ls -g": "/Users/dev/.bun/install/global node_modules (1)\n└── is-odd@3.0.1\n",
        "pipx list --json": JSON.stringify({ venvs: { httpie: { metadata: { main_package: { package_version: "3.2.4" } } } } }),
        "uv tool list": "ruff v0.6.3\n- ruff\n",
        "cargo install --list": "ripgrep v14.1.0:\n    rg\n",
        "go version -m /Users/dev/go/bin/gopls": "/Users/dev/go/bin/gopls: go1.23.1\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n",
      },
    });
    const rows = await detectTools(host);
    expect(rows).toEqual([
      { rung: "tools", id: "tools/npm/pnpm", label: "pnpm@9.12.0", group: "npm globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "9.12.0" },
      { rung: "tools", id: "tools/pnpm/typescript", label: "typescript@5.6.2", group: "pnpm globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "5.6.2" },
      { rung: "tools", id: "tools/bun/is-odd", label: "is-odd@3.0.1", group: "bun globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "3.0.1" },
      { rung: "tools", id: "tools/pipx/httpie", label: "httpie 3.2.4", group: "pipx", paths: [], bytes: 0, default: "bring", linux: "yes", version: "3.2.4" },
      { rung: "tools", id: "tools/uv/ruff", label: "ruff 0.6.3", group: "uv tools", paths: [], bytes: 0, default: "bring", linux: "yes", version: "0.6.3" },
      { rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep 14.1.0", group: "cargo installs", paths: [], bytes: 0, default: "bring", linux: "yes", version: "14.1.0" },
      { rung: "tools", id: "tools/go/gopls", label: "gopls", group: "Go binaries", paths: ["golang.org/x/tools/gopls@v0.16.2"], bytes: 0, default: "bring", linux: "yes", version: "v0.16.2" },
    ]);
  });

  it("npm globals under a node prefix npm no longer uses are listed too; a name under both is the current prefix's", async () => {
    const host = fakeHost({
      files: { "/opt/homebrew/lib/node_modules/wrangler/package.json": 1 },
      which: ["npm"],
      exec: {
        "npm prefix -g": "/Users/dev/.local\n",
        "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { bun: { version: "1.4.0" } } }),
        "npm ls -g --depth=0 --json --prefix /opt/homebrew": JSON.stringify({ dependencies: { npm: { version: "11.17.0" }, wrangler: { version: "4.106.0" }, bun: { version: "1.3.0" } } }),
      },
    });
    const rows = await detectTools(host);
    expect(rows.map(r => [r.id, r.label])).toEqual([["tools/npm/bun", "bun@1.4.0"], ["tools/npm/wrangler", "wrangler@4.106.0"]]);
    expect(host.calls).toContain("run npm ls -g --depth=0 --json --prefix /opt/homebrew");
  });

  it("the prefix npm itself uses is listed once, and a prefix with no globals is not asked", async () => {
    const host = fakeHost({
      files: { "/opt/homebrew/lib/node_modules/wrangler/package.json": 1 },
      which: ["npm"],
      exec: { "npm prefix -g": "/opt/homebrew\n", "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { wrangler: { version: "4.106.0" } } }) },
    });
    const rows = await detectTools(host);
    expect(rows.map(r => r.id)).toEqual(["tools/npm/wrangler"]);
    expect(host.calls.filter(c => c.includes("--prefix"))).toEqual([]);
  });

  it("bun with an empty global dir lists nothing (bun pm ls -g exits non-zero there)", async () => {
    const host = fakeHost({ which: ["bun"] });
    expect(await detectTools(host)).toEqual([]);
    expect(host.calls).toEqual(["run bun pm ls -g"]);
  });

  const LONG_MODULE = "github.com/some-organisation/some-very-long-repository-name/cmd/tooling/wsp-go";

  it.each([
    ["gopls", "golang.org/x/tools/gopls", "v0.16.2"],
    ["wsp-go", LONG_MODULE, "v1.4.0"],
  ])("a go binary is labelled %s; the module path is its first detail line", async (name, path, version) => {
    expect(LONG_MODULE).toHaveLength(78);
    const host = fakeHost({ files: { [`~/go/bin/${name}`]: 1 }, which: ["go"], exec: { [`go version -m /Users/dev/go/bin/${name}`]: `x\n\tpath\t${path}\n\tmod\t${path}\t${version}\th1:abc=\n` } });
    const rows = await detectTools(host);
    expect(rows).toEqual([{ rung: "tools", id: `tools/go/${name}`, label: name, group: "Go binaries", paths: [`${path}@${version}`], bytes: 0, default: "bring", linux: "yes", version }]);
  });

  const APT = {
    platform: "linux" as const,
    which: ["apt-mark", "dpkg-query"],
    files: { "/var/lib/dpkg/info/direnv:amd64.list": "/usr/bin/direnv\n", "/var/lib/dpkg/info/libpq5.list": "/usr/lib/libpq.so.5\n" },
    exec: {
      "apt-mark showmanual": "direnv\nlibpq5\n",
      "dpkg-query -Wf ${Package} ${Priority}\n": "direnv optional\nlibpq5 optional\n",
    },
  };

  it("what apt has that a person chose is one row per package under its own group, installable on the image", async () => {
    expect(await detectTools(fakeHost(APT))).toEqual([
      { rung: "tools", id: "tools/apt/direnv", label: "direnv", group: "apt packages", paths: [], bytes: 0, default: "bring", linux: "yes" },
    ]);
  });

  it("files no apt row for a tool the catalog carries, since the build reads no road off an apt row and that row would stand in for the catalog's; a manager whose road it can read keeps such a row", async () => {
    const both = {
      ...APT,
      which: [...APT.which, "npm"],
      files: { ...APT.files, "/var/lib/dpkg/info/tmux.list": "/usr/bin/tmux\n" },
      exec: {
        ...APT.exec,
        "apt-mark showmanual": "direnv\ntmux\n",
        "dpkg-query -Wf ${Package} ${Priority}\n": "direnv optional\ntmux optional\n",
        "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { tmux: { version: "1.0.0" } } }),
      },
    };
    const ids = (await detectTools(fakeHost(both))).map(r => r.id);
    expect(ids).toContain("tools/apt/direnv");
    expect(ids).not.toContain("tools/apt/tmux");
    // npm's road is read off its row, so a catalog tool it has keeps one and the build installs it by npm.
    expect(ids).toContain("tools/npm/tmux");
  });

  it("a computer with no apt is asked nothing about it, so a Mac runs no dpkg", async () => {
    const host = fakeHost({ ...APT, which: ["brew"], exec: { ...APT.exec, "brew bundle dump --file=-": 'brew "gh"\n' } });
    expect((await detectTools(host)).map(r => r.id)).toEqual(["tools/brew/gh"]);
    expect(host.calls.filter(c => c.includes("apt-mark") || c.includes("dpkg"))).toEqual([]);
  });

  it("a go binary without module info is offered unticked", async () => {
    const host = fakeHost({ files: { "~/go/bin/mystery": 1 }, which: ["go"] });
    const rows = await detectTools(host);
    expect(rows).toEqual([{ rung: "tools", id: "tools/go/mystery", label: "mystery (no module info)", group: "Go binaries", paths: [], bytes: 0, default: "skip", linux: "yes" }]);
  });
});
