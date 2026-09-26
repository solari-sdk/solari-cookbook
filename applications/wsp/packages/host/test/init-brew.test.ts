// SPDX-License-Identifier: AGPL-3.0-only
import type { Host } from "@wsp/collect";
import { describe, expect, it } from "vitest";
import { readBrewTable } from "../src/init-brew.js";

const INFO = JSON.stringify({
  formulae: [
    { name: "gh", full_name: "gh", tap: "homebrew/core", dependencies: [], requirements: [], urls: { stable: { url: "https://github.com/cli/cli/archive/refs/tags/v2.100.0.tar.gz", tag: null } }, installed: [{ version: "2.97.0", runtime_dependencies: [] }] },
    { name: "diskbloom", full_name: "zingzy/tap/diskbloom", tap: "zingzy/tap", dependencies: [], requirements: [], urls: { stable: { url: "https://github.com/Zingzy/diskbloom/releases/download/v0.1.0/diskbloom_0.1.0_darwin_arm64.tar.gz", tag: null } }, installed: [] },
  ],
  casks: [],
});

function fakeHost(over: { brew?: boolean; info?: string | null; cellar?: string[] | null; du?: null } = {}): Pick<Host, "exec" | "fs"> & { calls: string[] } {
  const calls: string[] = [];
  const cellar = over.cellar ?? ["gh", "diskbloom"];
  return {
    calls,
    exec: {
      which: async bin => bin === "brew" && (over.brew ?? true),
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "brew" && args[0] === "info") return over.info === null ? undefined : (over.info ?? INFO);
        if (cmd === "brew" && args[0] === "--cellar") return over.cellar === null ? undefined : "/opt/homebrew/Cellar\n";
        if (cmd === "du") return over.du === null ? undefined : args.slice(1).map((p, i) => `${(i + 1) * 1000}\t${p}`).join("\n");
        return undefined;
      },
    },
    fs: {
      stat: async () => undefined,
      list: async dir => (dir === "/opt/homebrew/Cellar" ? (cellar ?? []) : []),
      readText: async () => undefined,
      walk: async () => [],
      async *lines() {},
    },
  };
}

describe("readBrewTable", () => {
  it("asks brew once for every installed formula and du once for the Cellar, and keys the table by full name", async () => {
    const host = fakeHost();
    const table = await readBrewTable(host);
    expect(host.calls).toEqual(["brew info --json=v2 --installed", "brew --cellar", "du -sk /opt/homebrew/Cellar/gh /opt/homebrew/Cellar/diskbloom"]);
    expect(table.get("gh")).toMatchObject({ name: "gh", bytes: 1000 * 1024, source: { repo: "cli/cli", tag: "v2.100.0" } });
    expect(table.get("zingzy/tap/diskbloom")).toMatchObject({ name: "diskbloom", bytes: 2000 * 1024 });
  });

  it("without brew there is nothing to read and nothing runs", async () => {
    const host = fakeHost({ brew: false });
    expect(await readBrewTable(host)).toEqual(new Map());
    expect(host.calls).toEqual([]);
  });

  it("an empty Cellar skips du; brew output that is not JSON is the caller's error", async () => {
    const host = fakeHost({ cellar: [] });
    expect((await readBrewTable(host)).get("gh")?.bytes).toBeUndefined();
    expect(host.calls).not.toContainEqual(expect.stringMatching(/^du/));
    await expect(readBrewTable(fakeHost({ info: "Error: nope" }))).rejects.toThrow();
  });

  it("a brew that exits non-zero or times out, a missing Cellar path, or a du that fails, is an error the caller reports, never a silent empty table", async () => {
    await expect(readBrewTable(fakeHost({ info: null }))).rejects.toThrow("brew info failed or timed out");
    await expect(readBrewTable(fakeHost({ cellar: null }))).rejects.toThrow("brew --cellar failed");
    await expect(readBrewTable(fakeHost({ du: null }))).rejects.toThrow("du over the Cellar failed");
  });
});
