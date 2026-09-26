// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The landing site's own source is marketing copy, not the product: it names sizes and words the grep rules guard.
 * Its tests are tests like any other and are read. */
const WWW = "apps/www";

/** Every .ts and .tsx file under the src folder of each package and app, repo-relative, tests left out. */
export function sourceFiles(): string[] {
  return under("src", f => !/\.test\.tsx?$/.test(f), [WWW]);
}

/** Every test file, repo-relative, and no source file: the fixtures under each test folder as well as the cases,
 * since a fixture reaching for something a case must say is the same fault in a place harder to see, and the cases
 * that sit beside the source they cover, which sourceFiles drops out of src and no test folder holds. */
export function testFiles(): string[] {
  return [...under("test", () => true, []), ...under("src", f => /\.test\.tsx?$/.test(f), [])];
}

function under(folder: string, keep: (rel: string) => boolean, skip: readonly string[]): string[] {
  const out: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      if (!pkg.isDirectory() || skip.includes(`${top}/${pkg.name}`)) continue;
      const dir = join(ROOT, top, pkg.name, folder);
      let files: string[];
      try {
        files = readdirSync(dir, { recursive: true, encoding: "utf8" });
      } catch {
        continue;
      }
      for (const f of files) {
        if (/\.tsx?$/.test(f) && keep(f)) out.push(join(top, pkg.name, folder, f));
      }
    }
  }
  return out;
}
