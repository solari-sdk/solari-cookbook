// SPDX-License-Identifier: AGPL-3.0-only
// The desktop's tsup bundles everything @wsp/host's entry reaches into the Electron main script, so an eager edge
// from this entry is a module loaded in every process that imports the host, before app.whenReady in the packaged
// app. This reads that graph, so a rule about what may sit on it has something to hold.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** The specifier a statement makes the runtime load, or undefined: a type-only import or export is erased, and a
 * dynamic import is not a statement, so neither is an edge the loader walks. */
function eagerSpecifier(statement: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true && ts.isStringLiteral(statement.moduleSpecifier)) return statement.moduleSpecifier.text;
  if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
    return statement.moduleSpecifier.text;
  }
  return undefined;
}

/** Every package the entry's own sources import at load, following relative edges. A relative specifier that is
 * not a `.js` one is an asset the build inlines (the skill's markdown), not a module to walk. An edge that lands
 * on no file is thrown on rather than skipped: a walk that quietly stops short would pass this file for nothing. */
function eagerPackages(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    if (!existsSync(file)) throw new Error(`the import graph names ${file}, which is not a file here`);
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    for (const statement of source.statements) {
      const spec = eagerSpecifier(statement);
      if (spec === undefined) continue;
      if (!spec.startsWith(".")) packages.add(spec);
      else if (spec.endsWith(".js")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  walk(entry);
  return packages;
}

describe("what importing @wsp/host loads", () => {
  it("reaches the packages it is built on", () => {
    const packages = eagerPackages(ENTRY);
    expect(packages).toContain("@wsp/protocol");
    expect(packages).toContain("@wsp/runtime");
  });
});
