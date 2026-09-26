// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { nextVersion, setVersion, versionedManifests } from "../scripts/release.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const made: string[] = [];

function fakeRepo(packages: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-release-"));
  made.push(root);
  for (const dir of ["packages", "apps"]) mkdirSync(join(root, dir), { recursive: true });
  for (const [path, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the release version", () => {
  it("bumps by part", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("takes an exact version, prerelease included", () => {
    expect(nextVersion("0.1.0", "0.2.0")).toBe("0.2.0");
    expect(nextVersion("0.1.0", "1.0.0-rc.1")).toBe("1.0.0-rc.1");
  });

  it("refuses anything that is not a version or a bump", () => {
    expect(() => nextVersion("0.1.0", "next")).toThrow(/not a version or a bump/);
    expect(() => nextVersion("0.1.0", "v0.2.0")).toThrow(/not a version or a bump/);
    expect(() => nextVersion("nightly", "patch")).toThrow(/not semver/);
  });
});

describe("the packages a release renumbers", () => {
  it("is every package under packages and apps that carries a version", () => {
    const root = fakeRepo({
      "packages/one": { name: "one", version: "0.1.0" },
      "packages/two": { name: "two" },
      "apps/three": { name: "three", version: "0.1.0" },
      "apps/four": { name: "four", private: true },
    });
    expect(versionedManifests(root).map(f => basename(dirname(f))).sort()).toEqual(["one", "three"]);
  });

  it("is the same set this repo has, and it holds wspx", () => {
    expect(versionedManifests(repo)).toContain(join(repo, "packages", "wspx", "package.json"));
    for (const file of versionedManifests(repo)) expect(JSON.parse(readFileSync(file, "utf8")).version).toBeTypeOf("string");
  });

  it("renumbers in place, leaving the rest of the file alone", () => {
    const root = fakeRepo({ "packages/one": { name: "one", version: "0.1.0", bin: { wsp: "./dist/bin.js" } } });
    const file = join(root, "packages", "one", "package.json");
    setVersion(file, "0.2.0");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "one", version: "0.2.0", bin: { wsp: "./dist/bin.js" } });
    expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
  });

  it("takes the version a package already has, so a re-run of a release is not an error", () => {
    const root = fakeRepo({ "packages/one": { name: "one", version: "0.1.0" } });
    const file = join(root, "packages", "one", "package.json");
    const before = readFileSync(file, "utf8");
    setVersion(file, "0.1.0");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("says so when there is no version line to rewrite", () => {
    const root = fakeRepo({ "packages/one": { name: "one" } });
    expect(() => setVersion(join(root, "packages", "one", "package.json"), "0.2.0")).toThrow(/no version line/);
  });
});
