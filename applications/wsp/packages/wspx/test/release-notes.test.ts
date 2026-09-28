// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareVersions } from "../../protocol/src/semver.mjs";
import { bundleNames } from "../scripts/bundles.mjs";
import { bundleNote, changeLines, cliArgs, previousTag, releaseNotes, renameNote } from "../scripts/release-notes.mjs";

const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
const published = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).name as string;

const FAKE_LOG = [
  "fix(host): --port moves the pair, a busy default steps aside",
  "chore: v0.1.4",
  "",
  "feat(app): the palette runs the same verbs as the command line",
  "fix(host): --port moves the pair, a busy default steps aside",
];

function notes(signed = false): string {
  return releaseNotes({ version: "0.1.4", previous: "v0.1.3", changes: changeLines(FAKE_LOG), bundles: bundleNote(readme, signed) });
}

describe("what the draft job can load", () => {
  // The release workflow writes the notes on a bare checkout: node and the repo, no pnpm install and no build. So
  // every file that job reaches has to resolve on its own, which is why the version order lives in a plain module
  // rather than behind the protocol's package name. A bare specifier here fails the release, not the suite.
  const GRAPH = ["../scripts/release-notes.mjs", "../scripts/bundles.mjs", "../scripts/tag-version.mjs", "../scripts/release.mjs", "../../protocol/src/semver.mjs"];
  const IMPORTS = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+"([^"]+)"/g;

  it("is node and the repo: nothing the draft job reaches imports a package that an install would have to put there", () => {
    for (const file of GRAPH) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      // A match with no group is a regex that stopped matching what it was written for, and reads here as a
      // specifier that is neither node's nor the repo's, which fails rather than passing quietly.
      for (const match of source.matchAll(IMPORTS)) {
        const specifier = match[1] ?? "";
        expect(specifier.startsWith("node:") || specifier.startsWith("."), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});

describe("the tag a change list starts from", () => {
  it("is the highest release tag below this one", () => {
    expect(previousTag(["v0.1.1", "v0.1.3", "v0.1.2"], "v0.1.4")).toBe("v0.1.3");
    expect(previousTag(["v0.1.9", "v0.1.10"], "v0.2.0")).toBe("v0.1.10");
    expect(previousTag(["v0.1.3", "v0.2.0", "v0.3.0"], "v0.2.0")).toBe("v0.1.3");
  });

  it("skips tags that are not releases, and the empty lines git leaves", () => {
    expect(previousTag(["v0.1.3", "nightly", "prototype/design", "", "  "], "v0.1.4")).toBe("v0.1.3");
  });

  it("is nothing at all for the first release", () => {
    expect(previousTag([], "v0.1.3")).toBeUndefined();
    expect(previousTag(["v0.2.0"], "v0.1.3")).toBeUndefined();
  });

  it("puts a release above its own prereleases, on the one order the app reads too", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("0.1.3", "0.1.3")).toBe(0);
    expect(previousTag(["v1.0.0-rc.1", "v0.9.0"], "v1.0.0")).toBe("v1.0.0-rc.1");
    // Two prereleases of one core sort apart, whichever way they are spelled, so the tag below a tag is never a coin toss.
    expect(previousTag(["v1.0.0-alpha", "v1.0.0-beta"], "v1.0.0")).toBe("v1.0.0-beta");
    expect(previousTag(["v1.0.0-rc1", "v1.0.0-rc2"], "v1.0.0")).toBe("v1.0.0-rc2");
    expect(previousTag(["v1.0.0-rc.2", "v1.0.0-rc.10"], "v1.0.0")).toBe("v1.0.0-rc.10");
  });
});

describe("the change list", () => {
  it("is each commit subject once, without the renumbering commit", () => {
    expect(changeLines(FAKE_LOG)).toEqual([
      "fix(host): --port moves the pair, a busy default steps aside",
      "feat(app): the palette runs the same verbs as the command line",
    ]);
  });

  it("is empty when nothing landed between the tags", () => {
    expect(changeLines(["", "chore: v0.1.4"])).toEqual([]);
  });
});

describe("the lines about opening a downloaded bundle", () => {
  it("come out of the README, so the page and the notes cannot drift", () => {
    expect(bundleNote(readme, false)).toContain("not signed yet");
    expect(bundleNote(readme, false)).toContain("Open Anyway");
    expect(bundleNote(readme, false)).toContain("drag wsp onto the Applications folder");
    expect(bundleNote(readme, false)).toContain("chmod +x");
    expect(bundleNote(readme, false)).not.toContain("<!--");
  });

  it("drop the paragraph on unsigned bundles once an identity signs them, and keep the rest", () => {
    const signed = bundleNote(readme, true);
    expect(signed).not.toContain("not signed yet");
    expect(signed).not.toContain("Open Anyway");
    expect(signed).toContain("### Opening a downloaded bundle\n\nOpen the macOS disk image");
    expect(signed).toContain("chmod +x");
    expect(signed).not.toContain("<!--");
  });

  it("are the same lines once the README no longer carries the paragraph", () => {
    const later = "<!-- bundles:start -->\n### Opening a downloaded bundle\n\nThe Linux AppImage needs the run bit.\n<!-- bundles:end -->\n";
    expect(bundleNote(later, false)).toBe(bundleNote(later, true));
  });

  it("say so when the README no longer marks them", () => {
    expect(() => bundleNote("# wsp\n\nno markers here\n", false)).toThrow(/no bundles:start and bundles:end markers/);
  });
});

describe("what a release that renamed things says", () => {
  it("is the README's own block, lifted whole and printed above the change lines", () => {
    const note = renameNote(readme);
    expect(note).toBeDefined();
    expect(note).toContain("Renamed in");
    expect(note).toContain("wsp run <workspace>");
    expect(note).not.toContain("<!--");
    // Nothing answers to the old words, so the note is the one place a person who typed one reads the new one.
    for (const old of ["wsp thread new", "thread_new", "--to <workspace>", "wsp threads --in", "wsp new --local", "wsp new --ssh", "wsp init --provider", "wsp pair", "wsp connect", "wsp hosts", "wsp disconnect", "wsp relay link", "wsp relay hosts"]) {
      expect(note, old).toContain(old);
    }
    const printed = releaseNotes({ version: "0.1.4", previous: "v0.1.3", changes: changeLines(FAKE_LOG), bundles: bundleNote(readme, false), renames: note! });
    expect(printed.indexOf(note!)).toBeGreaterThan(printed.indexOf("## What changed since v0.1.3"));
    expect(printed.indexOf(note!)).toBeLessThan(printed.indexOf("- feat(app):"));
  });

  it("is nothing at a release that renamed nothing, and the notes are the change lines alone", () => {
    expect(renameNote("# wsp\n\nno markers here\n")).toBeUndefined();
    expect(notes()).not.toContain("Renamed in");
  });
});

describe("the command line", () => {
  it("is the tag, and --signed when an identity signs the bundles", () => {
    expect(cliArgs(["v0.1.4"])).toEqual({ tag: "v0.1.4", signed: false });
    expect(cliArgs(["v0.1.4", "--signed"])).toEqual({ tag: "v0.1.4", signed: true });
    expect(cliArgs([])).toEqual({ tag: "", signed: false });
  });
});

describe("the notes on the draft release", () => {
  it("name the tag they start from and list what landed", () => {
    expect(notes()).toContain("## What changed since v0.1.3");
    expect(notes()).toContain("- feat(app): the palette runs the same verbs as the command line");
    expect(notes()).not.toContain("chore: v0.1.4");
  });

  it("name every bundle and the command line install for this version", () => {
    const names = bundleNames("0.1.4");
    expect(names).toEqual({ mac: "wsp-0.1.4-mac.dmg", appImage: "wsp-0.1.4.AppImage" });
    for (const name of Object.values(names)) expect(notes()).toContain(name);
    expect(published).toBe("@zingzy/wsp");
    expect(notes()).toContain(`npm i -g ${published}@0.1.4`);
  });

  it("carry the README's lines on opening a downloaded bundle, for the signing the release got", () => {
    expect(notes()).toContain(bundleNote(readme, false));
    expect(notes(true)).toContain(bundleNote(readme, true));
    expect(notes(true)).not.toContain("Open Anyway");
  });

  it("say it is the first release when there is no tag before it", () => {
    const first = releaseNotes({ version: "0.1.3", previous: undefined, changes: [], bundles: bundleNote(readme, false) });
    expect(first).toContain("## What changed\n");
    expect(first).toContain("- The first release.");
  });

  it("are plain: no em-dash, no tool or model names", () => {
    for (const word of ["—", "–", "Claude", "Anthropic", "AI", "agent-written"]) expect(notes()).not.toContain(word);
  });
});
