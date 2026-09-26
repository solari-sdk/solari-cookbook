// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCANNED = ["apps/web/src", "packages/protocol/src"];

/** A middle dot, a bullet and their look-alikes, as the glyph, its escape or its HTML entity. */
const DOT = /[·•∙⋅‧・]|\\u(?:00b7|2022|2219|22c5|2027|30fb)|&(?:middot|bull);/i;

/** Every dot the app may still carry, each with why it is no separator between two pieces of text. */
const ALLOWED: ReadonlyArray<{ file: string; text: string; why: string }> = [
  { file: "apps/web/src/settings/AddComputer.tsx", text: "•••• ••••", why: "the masked shape of a pairing code before it is shown" },
  { file: "apps/web/src/settings/recipe/RecipeScreen.tsx", text: '"••••••••"', why: "the masked placeholder of a key already saved" },
  { file: "packages/protocol/src/format.ts", text: 'NEEDS_YOU_MARK = "• "', why: "a mark leading the window title while a need stands, with no text before it" },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const hits = SCANNED.flatMap(dir =>
  sources(join(ROOT, dir)).flatMap(path =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, at) => (DOT.test(line) ? [{ file: relative(ROOT, path), line: at + 1, text: line.trim() }] : [])),
  ),
);

describe("no dot between two pieces of text", () => {
  it("finds no middle dot or bullet in the app's or the protocol's sources beyond the allowed list", () => {
    const loose = hits.filter(hit => !ALLOWED.some(ok => ok.file === hit.file && hit.text.includes(ok.text)));
    expect(loose.map(hit => `${hit.file}:${hit.line}: ${hit.text}`)).toEqual([]);
  });

  it("keeps no allowed entry that no longer matches a line", () => {
    const stale = ALLOWED.filter(ok => !hits.some(hit => hit.file === ok.file && hit.text.includes(ok.text)));
    expect(stale).toEqual([]);
  });
});
