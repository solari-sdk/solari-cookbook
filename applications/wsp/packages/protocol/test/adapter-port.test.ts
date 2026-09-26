// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, sourceFiles } from "./source-files.js";

const PACKAGES = join(ROOT, "packages");
const PORT_FILE = "packages/protocol/src/adapter-port.ts";
/** What an adapter is written against; each of these may be declared in PORT_FILE and nowhere else. */
const PORT_NAMES = [
  "AdapterAttachOptions",
  "AdapterEvent",
  "ExecStream",
  "ExecStreamFactory",
  "HarnessCatalogAnswer",
  "HarnessCatalogModelProbe",
  "HarnessCatalogProbe",
  "HarnessCatalogRefusal",
  "SessionRenameWrite",
  "SessionRenamer",
  "SessionTitleReader",
  "catalogRefused",
  "endAfterResult",
  "endRun",
];
/** Matches whatever keywords a declaration uses, so a duplicate written as an interface, class or const cannot hide
 * from a type-only pattern. The name has to sit where a declaration puts it, right after the keyword: a pattern that
 * took any run of words before it read `export interface X extends ExecStream` as declaring ExecStream, which is a
 * type that uses the port rather than a second copy of it. */
export const declarationOf = (name: string): RegExp =>
  new RegExp(String.raw`^export (?:default |declare |abstract |async )*(?:interface|type|class|const|let|var|function|enum) ${name}\b`, "m");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const adapterPackages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith("adapter-"))
  .map(entry => entry.name)
  .sort();

/** Every source and test file of a package, repo-relative. */
function filesOf(pkg: string): string[] {
  const out: string[] = [];
  for (const dir of ["src", "test"]) {
    let names: string[];
    try {
      names = readdirSync(join(PACKAGES, pkg, dir), { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const name of names) if (/\.tsx?$/.test(name)) out.push(join("packages", pkg, dir, name));
  }
  return out;
}

const wspImports = (rel: string): string[] => [...read(rel).matchAll(/from "(@wsp\/[^"]+)"/g)].map(m => m[1]!);

describe("the harness adapter port", () => {
  it("reads the declared name off the keyword, so a type that extends a port name is not a second declaration of it", () => {
    // What tripped this: a runtime type that carries a port stream plus a field of its own.
    expect(declarationOf("ExecStream").test("export interface RunningExec extends ExecStream {")).toBe(false);
    expect(declarationOf("ExecStream").test("export type RunningExec = ExecStream & { readonly ranIn?: string };")).toBe(false);
    expect(declarationOf("ExecStream").test("export class Runs implements ExecStream {")).toBe(false);
    // And a second declaration of the name is still caught, in whatever keywords it is written.
    for (const line of ["export interface ExecStream {", "export type ExecStream = never;", "export class ExecStream {", "export const ExecStream = 1;", "export declare function ExecStream(): void;"]) {
      expect(declarationOf("ExecStream").test(line), line).toBe(true);
    }
    // The forms the port file itself uses, each read by its own name.
    expect(declarationOf("endRun").test("export async function endRun(stream: ExecStream, graceMs: number): Promise<void> {")).toBe(true);
    expect(declarationOf("catalogRefused").test("export function catalogRefused(answer: HarnessCatalogAnswer): answer is HarnessCatalogRefusal {")).toBe(true);
    expect(declarationOf("AdapterEvent").test("export type AdapterEvent =")).toBe(true);
    // A name that only opens another one is not that other one.
    expect(declarationOf("ExecStream").test("export interface ExecStreamFactory {")).toBe(false);
  });

  it("is declared in one file, and that file is in the protocol", () => {
    const sources = sourceFiles();
    for (const name of PORT_NAMES) {
      const declared = sources.filter(rel => declarationOf(name).test(read(rel)));
      expect(`${name}: ${declared.join(", ")}`).toBe(`${name}: ${PORT_FILE}`);
    }
  });

  it("is what every adapter package is written against", () => {
    expect(adapterPackages.length).toBeGreaterThan(1);
    for (const pkg of adapterPackages) {
      const siblings = adapterPackages.filter(other => other !== pkg).map(other => `@wsp/${other}`);
      for (const rel of filesOf(pkg)) {
        expect(`${rel}: ${wspImports(rel).filter(i => siblings.includes(i)).join(", ")}`).toBe(`${rel}: `);
      }
      const manifest = JSON.parse(read(join("packages", pkg, "package.json"))) as Record<string, Record<string, string> | undefined>;
      const declared = [...Object.keys(manifest["dependencies"] ?? {}), ...Object.keys(manifest["devDependencies"] ?? {})];
      expect(declared.filter(dep => dep !== `@wsp/${pkg}` && dep.startsWith("@wsp/adapter-"))).toEqual([]);
    }
  });
});
