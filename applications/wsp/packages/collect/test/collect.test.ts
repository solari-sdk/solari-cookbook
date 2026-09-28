// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { RUNGS, collect, parseManifest } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

/** A developer's MacBook as the collector sees it. */
const LAPTOP = fakeHost({
  files: {
    "~/.gitconfig": 512,
    "~/.ssh/config": 1200,
    "~/.ssh/id_ed25519": 400,
    "~/.ssh/id_ed25519.pub": 100,
    "~/.ssh/known_hosts": 3000,
    "~/.zshrc": 3000,
    "~/.zshenv": 200,
    "~/.config/starship.toml": 900,
    "~/.tmux.conf": 600,
    "~/.zsh_history": 800_000,
    "~/.config/nvim/init.lua": 120_000,
    "~/Library/Application Support/Code/User/settings.json": 2000,
    "~/.config/mise/config.toml": 300,
    "~/.claude/settings.json": 400,
    "~/.claude/CLAUDE.md": 900,
    "~/.claude/.credentials.json": 800,
    "~/.codex/config.toml": 50,
    "~/.codex/auth.json": 900,
    "~/.config/gh/hosts.yml": 200,
    "~/.aws/config": 300,
    "~/go/bin/gopls": 1,
  },
  which: ["git", "brew", "mise", "npm", "claude", "codex", "go"],
  exec: {
    "git config --global --get user.name": "Dev Person\n",
    "git config --global --get user.email": "dev@example.com\n",
    "git config --global --get gpg.format": "ssh\n",
    "brew bundle dump --file=-": 'tap "homebrew/bundle"\nbrew "gh"\nbrew "jq"\n',
    "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { npm: { version: "10" }, pnpm: { version: "9.12.0" } } }),
    "go version": "go version go1.23.1 darwin/arm64\n",
    "go version -m /Users/dev/go/bin/gopls": "x\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n",
    'security find-generic-password -s Claude Code-credentials': "found\n",
  },
});

describe("collect", () => {
  it("composes every rung in ladder order into a valid manifest", async () => {
    const manifest = await collect(LAPTOP);
    expect(parseManifest(manifest)).toEqual(manifest);
    const order = manifest.entries.map(e => RUNGS.indexOf(e.rung));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(manifest.entries.map(e => e.rung))).toEqual(new Set(RUNGS));
  });

  it("matches the fixture laptop snapshot", async () => {
    expect(await collect(LAPTOP)).toMatchSnapshot();
  });

  it("reports each rung's row count as it finishes, in ladder order, before the manifest resolves", async () => {
    const seen: [string, number][] = [];
    const manifest = await collect(LAPTOP, { onRung: (rung, count) => seen.push([rung, count]) });
    expect(seen.map(([r]) => r)).toEqual([...RUNGS]);
    for (const [rung, count] of seen) expect(count).toBe(manifest.entries.filter(e => e.rung === rung).length);
    expect(seen.every(([, n]) => n > 0)).toBe(true);
  });

  it("an empty laptop reports zero for every rung the detectors cover", async () => {
    const seen: number[] = [];
    await collect(fakeHost(), { onRung: (_rung, count) => seen.push(count) });
    expect(seen).toEqual(RUNGS.map(() => 0));
  });

  it("an empty laptop is an empty manifest", async () => {
    expect(await collect(fakeHost())).toEqual({ entries: [] });
  });
});
