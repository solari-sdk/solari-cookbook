// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(`${pkg}package.json`, "utf8")) as {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  files: string[];
  engines: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  license: string;
};

describe("the published package", () => {
  it("is @zingzy/wsp and puts wsp on the path", () => {
    expect(manifest.name).toBe("@zingzy/wsp");
    expect(manifest.bin).toEqual({ wsp: "./dist/bin.js" });
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe("AGPL-3.0-only");
  });

  it("states the Node the README asks for", () => {
    expect(manifest.engines["node"]).toBe(">=22");
  });

  it("declares no dependencies, because every one of them is bundled", () => {
    expect(manifest.dependencies).toBeUndefined();
    for (const range of Object.values(manifest.devDependencies)) {
      if (range.startsWith("workspace:")) continue;
      expect(range).toMatch(/^[\^~]?\d/);
    }
  });

  it("keeps the script that builds its dependencies first", () => {
    expect(manifest.scripts["build:deps"]).toBe('pnpm --filter "@zingzy/wsp^..." build');
  });

  it("ships the bundle and the staged assets", () => {
    expect(manifest.files).toEqual(["dist", "assets"]);
  });

  it("is versioned like the rest of the repo", () => {
    const host = JSON.parse(readFileSync(`${pkg}../host/package.json`, "utf8")) as { version: string };
    expect(manifest.version).toBe(host.version);
  });
});
