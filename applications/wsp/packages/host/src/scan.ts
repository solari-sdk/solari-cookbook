// SPDX-License-Identifier: AGPL-3.0-only
// What this computer has installed by a package manager that can install the
// same thing on the Linux image: one row per tool, with the line that installs it
// there, the line that says it is there, and the size measured here. One entry
// per manager in MANAGER_SCANS and nothing else decides by a manager's name.
// Casks and Mac App Store apps never reach a row (the Brewfile reader drops
// them), nor does a formula with no Linux bottle, nor anything the catalog
// already carries: a brew node or python is the base row, not a second row.
import { ROADS, asLinuxbrew, catalogToolFor, roadModule, type InstallRoad, type RoadName } from "@wsp/catalog";
import { aptPackages, aptSizes, firstLine, linuxSupport, nodeHost, parseBrewfile, parseCargoInstalls, parseNpmGlobals, parsePipxList, parseUvToolList, type Host, type Pkg } from "@wsp/collect";
import { agentOwning, parseDu } from "@wsp/engine";
import { shellQuote, toolRowId, type RecipeCustomRow } from "@wsp/protocol";
import type { VerbDeps } from "./verbs.js";

/** One tool this computer has, as the Also screen and `wsp recipe scan` draw it. */
export interface ScanRow {
  /** `<manager>/<name>`: unique across managers, the id the screen ticks by. */
  id: string;
  /** The package as its manager names it; the id a tick writes into the recipe. */
  name: string;
  /** The manager that has it, which is also the road the build brings that manager by. */
  manager: RoadName;
  group: string;
  /** The line that installs it on the Linux image, as a person would type it. */
  install: string;
  /** Exits 0 once it is on the machine. */
  check: string;
  /** Bytes it takes here, when du could read them. */
  size?: number;
  version?: string;
}

/** The id a scanned package has on the Also screen and in a `wsp recipe --set` word, the one spelling of it: the
 * manager and the package, unique across managers since two of them can carry one name (uv and pipx both list ruff). */
export const scanRowId = (manager: string, pkg: string): string => `${manager}/${pkg}`;

/** The last segment of a package name: the command a manager's package usually leaves on PATH. */
const lastSegment = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

/** The line a road installs a package with, as its module writes it; a manager whose road cannot write one has no
 * business in MANAGER_SCANS, so that is an error here rather than a row nobody can install. */
function roadLine(road: InstallRoad, bin: string): string {
  const line = roadModule(road).install(road, bin);
  if (typeof line !== "string") throw new Error(`${road.road}: ${line.note}`);
  return line;
}

/** How a manager's sizes are read here: one du over the directory its packages sit under, or the manager's own
 * answer where they sit under no one directory (apt spreads a package over the filesystem and records its size
 * itself). Exactly one of the two, so a manager added to the table cannot forget both. */
type SizeReader =
  /** Where its packages sit here, so one du reads them all; a manager whose directory cannot be found gives no sizes. */
  | { dir(host: Host): Promise<string | undefined> }
  /** Bytes each of these packages takes here, by package; a manager that cannot say leaves them out. */
  | { sizes(host: Host, names: readonly string[]): Promise<Map<string, number>> };

type ManagerScan = {
  /** The manager's own name, which is its road's: the build brings it onto the machine by that name. */
  id: RoadName;
  /** The heading the screen and the table draw its rows under. */
  group: string;
  /** The command that says the manager is on this computer. */
  bin: string;
  /** What it has installed here. */
  list(host: Host): Promise<Pkg[]>;
  install(pkg: Pkg): string;
  /** What exits 0 on the machine once the package is there. Asked of the manager, never guessed from the package's
   * name: brew install llvm leaves clang and llvm-config, and a guessed `command -v llvm` would read as a failure. */
  check(pkg: Pkg): string;
} & SizeReader;

/** The output of a listing command, or nothing when the command failed. */
const listed = async (host: Host, bin: string, args: readonly string[]): Promise<string> => (await host.exec.run(bin, args)) ?? "";

/** A manager that answers only with a list: the package is there when its own line is in it. */
const inListing = (cmd: string, name: string): string => `${cmd} | grep -q ${shellQuote(`^${name} `)}`;

export const MANAGER_SCANS: readonly ManagerScan[] = [
  {
    id: "brew",
    group: "Homebrew formulae",
    bin: "brew",
    // A formula with no Linux bottle has nothing to install there; the Brewfile reader already drops casks and Mac App Store apps.
    list: async host => parseBrewfile(await listed(host, "brew", ["bundle", "dump", "--file=-"])).filter(l => l.kind === "brew" && linuxSupport(l.name) !== "no").map(l => ({ name: l.name })),
    // Not the road module's line: the builder runs a custom row as root, where Homebrew's own refusal is answered by the brew of CUSTOM_PRELUDE.
    install: p => `brew install ${p.name}`,
    // Homebrew's own answer, through the catalog's linuxbrew line: the check runs as root, where brew itself refuses.
    check: p => asLinuxbrew(`list --versions ${shellQuote(p.name)}`),
    dir: async host => firstLine(await host.exec.run("brew", ["--cellar"])),
  },
  {
    id: "npm",
    group: "npm globals",
    bin: "npm",
    list: async host => parseNpmGlobals(await listed(host, "npm", ["ls", "-g", "--depth=0", "--json"])),
    install: p => roadLine({ road: "npm", package: p.name }, lastSegment(p.name)),
    check: p => `npm ls -g ${shellQuote(p.name)}`,
    dir: async host => {
      const prefix = firstLine(await host.exec.run("npm", ["prefix", "-g"]));
      return prefix === undefined ? undefined : `${prefix}/lib/node_modules`;
    },
  },
  {
    id: "uv",
    group: "uv and pipx tools",
    bin: "uv",
    list: async host => parseUvToolList(await listed(host, "uv", ["tool", "list"])),
    install: p => roadLine({ road: "uv", package: p.name }, lastSegment(p.name)),
    check: p => inListing("uv tool list", p.name),
    dir: async host => `${host.home}/.local/share/uv/tools`,
  },
  {
    id: "pipx",
    group: "uv and pipx tools",
    bin: "pipx",
    list: async host => parsePipxList(await listed(host, "pipx", ["list", "--json"])),
    install: p => roadLine({ road: "pipx", package: p.name }, lastSegment(p.name)),
    check: p => inListing("pipx list --short", p.name),
    dir: async host => `${host.home}/.local/share/pipx/venvs`,
  },
  {
    id: "cargo",
    group: "cargo installs",
    bin: "cargo",
    list: async host => parseCargoInstalls(await listed(host, "cargo", ["install", "--list"])),
    install: p => roadLine({ road: "cargo", package: p.name }, lastSegment(p.name)),
    check: p => inListing("cargo install --list", p.name),
    dir: async host => `${host.home}/.cargo/bin`,
  },
  {
    id: "apt",
    group: "apt packages",
    // apt-mark is what says which packages a person asked for; dpkg alone cannot tell those from the base image's own.
    bin: "apt-mark",
    list: aptPackages,
    // The catalog's own apt road as one line, since a row's install is read on a screen and in one table cell; the
    // export it opens with is what keeps apt from waiting at a prompt nobody is there to answer.
    install: p => roadLine({ road: "apt", packages: [p.name] }, p.name).split("\n").join("; "),
    check: p => `dpkg -s ${shellQuote(p.name)}`,
    sizes: aptSizes,
  },
];

/** The names directly under a directory, a scoped npm name read one level deeper so a row is the package and not its scope. */
async function entriesUnder(host: Host, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await host.fs.list(dir)) {
    if (!name.startsWith("@")) {
      out.push(name);
      continue;
    }
    for (const inner of await host.fs.list(`${dir}/${name}`)) out.push(`${name}/${inner}`);
  }
  return out;
}

/** One du over a manager's directory: bytes by the package name asked for, so two scoped npm names ending in the
 * same word keep their own reading. */
async function sizesUnder(host: Host, dir: string | undefined, names: readonly string[]): Promise<Map<string, number>> {
  if (dir === undefined) return new Map();
  const here = new Set(await entriesUnder(host, dir));
  const wanted = names.filter(n => here.has(n));
  if (wanted.length === 0) return new Map();
  const du = await host.exec.run("du", ["-sk", ...wanted.map(n => `${dir}/${n}`)]);
  return du === undefined ? new Map() : parseDu(du, path => wanted.find(n => path.endsWith(`/${n}`)) ?? path);
}

/** Whether the catalog already carries a package: a tool row of its own on the Tools screen (a formula the base
 * installs on every machine is one of those), or the package an agent on the Agents screen installs itself. */
function carried(manager: string, name: string): boolean {
  return catalogToolFor(name) !== undefined || catalogToolFor(lastSegment(name)) !== undefined || agentOwning(toolRowId(manager, name)) !== undefined;
}

/** Whether the recipe already installs the tool by another hand than this screen's: a row `wsp recipe --add` wrote
 * under the tool's own name, or the row this screen wrote for another manager carrying it. Such a row is left off
 * the screen, since a tick there would install the same tool twice. The row this screen wrote for this very package
 * is not one of these: it comes back drawn and ticked, and an untick takes it away again. */
function inRecipe(recipe: readonly RecipeCustomRow[], id: string, name: string): boolean {
  return recipe.some(c => c.id !== id && (c.id === name || c.name === name));
}

/** Every tool a package manager on this computer could install on the Linux image, by manager in MANAGER_SCANS
 * order. A package the catalog carries is left out: it has a row of its own on the Tools screen, and a formula the
 * base installs on every machine is that base row. So is one the recipe already installs. */
export async function scanTools(host: Host, recipe: readonly RecipeCustomRow[] = []): Promise<ScanRow[]> {
  const rows: ScanRow[] = [];
  for (const m of MANAGER_SCANS) {
    if (!(await host.exec.which(m.bin))) continue;
    const pkgs = (await m.list(host)).filter(p => !carried(m.id, p.name) && !inRecipe(recipe, scanRowId(m.id, p.name), p.name));
    const names = pkgs.map(p => p.name);
    const sizes = "sizes" in m ? await m.sizes(host, names) : await sizesUnder(host, await m.dir(host), names);
    for (const p of pkgs) {
      const size = sizes.get(p.name);
      rows.push({
        id: scanRowId(m.id, p.name),
        name: p.name,
        manager: m.id,
        group: m.group,
        install: m.install(p),
        check: m.check(p),
        ...(size !== undefined ? { size } : {}),
        ...(p.version !== undefined ? { version: p.version } : {}),
      });
    }
  }
  return rows;
}

/** What else a package manager on this computer has, for the recipe verbs on both doors: the scanner reaches the
 * engine, so the command line and the host hand it in rather than the verb table importing it. */
export const alsoHere: VerbDeps["alsoHere"] = recipe => scanTools(nodeHost(), recipe);
