// SPDX-License-Identifier: AGPL-3.0-only
// package.json: the manager it pins, the runtimes its engines field accepts,
// the programs its scripts run and the packages it depends on. A script's first
// word names a devDependency as often as a machine tool, an engines key names
// an editor as often as a runtime, and a dependency is the project's own to
// install, so all three count only where the catalog already carries them.
import { commandNames } from "../../history/commands.js";
import type { ProjectFinding, ProjectReader } from "../reader.js";

interface PackageJson {
  packageManager?: unknown;
  engines?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function parse(text: string): PackageJson | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value: unknown): [string, string][] =>
  typeof value === "object" && value !== null ? Object.entries(value).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])) : [];

export const packageJsonReader: ProjectReader = {
  id: "package-json",
  // A workspace keeps its browser or its linters in a package's own manifest, not the root's.
  files: ["package.json", "apps/*/package.json", "packages/*/package.json"],
  reads: "text",
  read(file): readonly ProjectFinding[] {
    const pkg = parse(file.text);
    if (pkg === undefined) return [];
    const out: ProjectFinding[] = [];
    if (typeof pkg.packageManager === "string" && pkg.packageManager !== "") {
      // corepack writes a `+sha512.<88 chars>` integrity suffix after the version; the line the row shows drops it.
      const spec = pkg.packageManager.split("+")[0] ?? pkg.packageManager;
      const name = spec.split("@")[0] ?? spec;
      if (name !== "") out.push({ name, label: name, why: `packageManager ${spec}` });
    }
    for (const [key, range] of strings(pkg.engines)) out.push({ name: key, label: key, why: `engines.${key} ${range}`, catalogOnly: true });
    for (const [, command] of strings(pkg.scripts)) {
      for (const name of commandNames(command)) out.push({ name, label: name, why: `${file.path} scripts run ${name}`, catalogOnly: true });
    }
    for (const [name, range] of [...strings(pkg.dependencies), ...strings(pkg.devDependencies)]) out.push({ name, label: name, why: `${file.path} depends on ${name} ${range}`, catalogOnly: true, installs: "npm" });
    return out;
  },
};
