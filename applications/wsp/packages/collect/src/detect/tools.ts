// SPDX-License-Identifier: AGPL-3.0-only
import { MAC_BREW, catalogToolFor, readsRowRoad } from "@wsp/catalog";
import { toolRowId } from "@wsp/protocol";
import { linuxSupport } from "../brew-bottles.js";
import { aptPackages } from "./apt.js";
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { exists, firstLine, found, entry, item, present } from "./common.js";

export interface BrewLine {
  kind: "tap" | "brew";
  name: string;
}

/** The Brewfile lines that name a tap or a formula; a cask or a Mac App Store app has no Linux build to bring. */
export function parseBrewfile(text: string): BrewLine[] {
  const out: BrewLine[] = [];
  for (const line of text.split("\n")) {
    const m = /^(tap|brew)\s+"([^"]+)"/.exec(line.trim());
    if (m === null) continue;
    const kind = m[1];
    const name = m[2];
    if ((kind === "tap" || kind === "brew") && name !== undefined) out.push({ kind, name });
  }
  return out;
}

export interface Pkg {
  name: string;
  version?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const NPM_OWN = new Set(["npm", "corepack"]);

export function parseNpmGlobals(text: string): Pkg[] {
  const data = tryJson(text);
  if (!isRecord(data) || !isRecord(data["dependencies"])) return [];
  const out: Pkg[] = [];
  for (const [name, info] of Object.entries(data["dependencies"])) {
    if (NPM_OWN.has(name)) continue;
    const version = isRecord(info) && typeof info["version"] === "string" ? info["version"] : undefined;
    out.push(version === undefined ? { name } : { name, version });
  }
  return out;
}

export function parsePipxList(text: string): Pkg[] {
  const data = tryJson(text);
  if (!isRecord(data) || !isRecord(data["venvs"])) return [];
  const out: Pkg[] = [];
  for (const [name, venv] of Object.entries(data["venvs"])) {
    const meta = isRecord(venv) && isRecord(venv["metadata"]) ? venv["metadata"] : undefined;
    const main = meta !== undefined && isRecord(meta["main_package"]) ? meta["main_package"] : undefined;
    const version = main !== undefined && typeof main["package_version"] === "string" ? main["package_version"] : undefined;
    out.push(version === undefined ? { name } : { name, version });
  }
  return out;
}

/** Top-level lines of `uv tool list` and `cargo install --list`: `name v1.2.3` with optional trailing decoration. */
function parseNameVersionLines(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || /^[\s-]/.test(line)) continue;
    const m = /^(\S+)\s+v(\S+?)(?::|\s|$)/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    out.push({ name: m[1], version: m[2] });
  }
  return out;
}

export const parseUvToolList = parseNameVersionLines;
export const parseCargoInstalls = parseNameVersionLines;

/** `pnpm ls -g --json`: one object per global dir, each with a dependencies map. */
export function parsePnpmGlobals(text: string): Pkg[] {
  const data = tryJson(text);
  if (!Array.isArray(data)) return [];
  const out: Pkg[] = [];
  for (const dir of data) {
    if (!isRecord(dir) || !isRecord(dir["dependencies"])) continue;
    for (const [name, info] of Object.entries(dir["dependencies"])) {
      const version = isRecord(info) && typeof info["version"] === "string" ? info["version"] : undefined;
      out.push(version === undefined ? { name } : { name, version });
    }
  }
  return out;
}

/** `bun pm ls -g`: a header naming the global dir, then tree lines of `name@version`. */
export function parseBunGlobals(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const line of text.split("\n")) {
    const m = /^[│├└─\s]+(@?[^@\s]+)@(\S+)$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    out.push({ name: m[1], version: m[2] });
  }
  return out;
}

export interface GoModule {
  path: string;
  version: string;
}

/** `go version -m <binary>`: the `path` line is the install target, the `mod` line carries the version. */
export function parseGoVersionM(text: string): GoModule | undefined {
  let path: string | undefined;
  let version: string | undefined;
  for (const line of text.split("\n")) {
    const cols = line.split("\t");
    if (cols[1] === "path" && cols[2] !== undefined) path = cols[2];
    if (cols[1] === "mod" && cols[3] !== undefined) version = cols[3];
  }
  return path !== undefined && version !== undefined ? { path, version } : undefined;
}

const versioned = (p: Pkg, sep: string | undefined) => (p.version === undefined || sep === undefined ? p.name : `${p.name}${sep}${p.version}`);

/** How a manager says what it has: one listing this reader parses, or a reader of its own where one listing is not
 * the whole story (npm's other prefixes, apt's rule over what a person chose). */
type Listing = { args: readonly string[]; parse: (out: string) => Pkg[] } | { list: (host: Host) => Promise<Pkg[]> };

type GlobalManager = {
  id: string;
  bin: string;
  group: string;
  /** Between a package and its version in the row's label; a manager whose packages carry no version needs none. */
  sep?: string;
} & Listing;

const NPM_LS = ["ls", "-g", "--depth=0", "--json"];
/** Where another node once kept its globals; a laptop that moved to a new node still runs them from PATH. */
const NPM_PREFIXES = [MAC_BREW, "/usr/local"];

/** npm's own prefix, then every other prefix on this laptop that holds globals; a name in both is the own prefix's. */
async function npmGlobals(host: Host): Promise<Pkg[]> {
  const own = firstLine(await host.exec.run("npm", ["prefix", "-g"]));
  const out = new Map<string, Pkg>();
  const add = (pkgs: Pkg[]): void => {
    for (const p of pkgs) if (!out.has(p.name)) out.set(p.name, p);
  };
  add(parseNpmGlobals((await host.exec.run("npm", NPM_LS)) ?? ""));
  for (const prefix of NPM_PREFIXES) {
    if (prefix === own || !(await exists(host, `${prefix}/lib/node_modules`))) continue;
    add(parseNpmGlobals((await host.exec.run("npm", [...NPM_LS, "--prefix", prefix])) ?? ""));
  }
  return [...out.values()];
}

const GLOBALS: readonly GlobalManager[] = [
  { id: "npm", bin: "npm", group: "npm globals", list: npmGlobals, sep: "@" },
  { id: "pnpm", bin: "pnpm", group: "pnpm globals", args: ["ls", "-g", "--depth=0", "--json"], parse: parsePnpmGlobals, sep: "@" },
  { id: "bun", bin: "bun", group: "bun globals", args: ["pm", "ls", "-g"], parse: parseBunGlobals, sep: "@" },
  { id: "pipx", bin: "pipx", group: "pipx", args: ["list", "--json"], parse: parsePipxList, sep: " " },
  { id: "uv", bin: "uv", group: "uv tools", args: ["tool", "list"], parse: parseUvToolList, sep: " " },
  { id: "cargo", bin: "cargo", group: "cargo installs", args: ["install", "--list"], parse: parseCargoInstalls, sep: " " },
  // apt-mark is what says which packages a person asked for; dpkg alone cannot tell those from the base image's own.
  { id: "apt", bin: "apt-mark", group: "apt packages", list: aptPackages },
];

// A formula the laptop already runs on Linux needs no snapshot to vouch for it. A formula nothing vouches
// for starts unticked without a reason, so the row stays open to a tick that tries it.
function formulaRow(host: Host, name: string): ManifestEntry {
  const linux = host.platform === "linux" ? "yes" : linuxSupport(name);
  const base = { rung: "tools" as const, id: toolRowId("brew", name), label: name, group: "Homebrew", linux };
  if (linux === "no") return item({ ...base, default: "skip", reason: "no Linux bottle" });
  return linux === "unknown" ? item({ ...base, default: "skip" }) : item(base);
}

async function brewRows(host: Host): Promise<ManifestEntry[]> {
  if (!(await host.exec.which("brew"))) return [];
  const lines = parseBrewfile((await host.exec.run("brew", ["bundle", "dump", "--file=-"])) ?? "");
  return lines.map(l => (l.kind === "tap" ? item({ rung: "tools", id: `tools/brew-tap/${l.name}`, label: l.name, group: "Homebrew taps", linux: "yes" }) : formulaRow(host, l.name)));
}

async function goRows(host: Host): Promise<ManifestEntry[]> {
  if (!(await host.exec.which("go"))) return [];
  const bin = `${host.home}/go/bin`;
  const rows: ManifestEntry[] = [];
  for (const name of await host.fs.list(bin)) {
    const mod = parseGoVersionM((await host.exec.run("go", ["version", "-m", `${bin}/${name}`])) ?? "");
    rows.push(mod === undefined
      ? item({ rung: "tools", id: toolRowId("go", name), label: `${name} (no module info)`, group: "Go binaries", default: "skip", linux: "yes" })
      // The module path rides in paths so the detail pane shows it first; bytes 0 says there is nothing to upload.
      : entry({ rung: "tools", id: toolRowId("go", name), label: name, group: "Go binaries", paths: [`${mod.path}@${mod.version}`], bytes: 0, linux: "yes", version: mod.version }));
  }
  return rows;
}

export async function detectTools(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [...(await brewRows(host))];

  if ((await exists(host, "~/.config/home-manager")) || (await exists(host, "~/.config/nixpkgs/home.nix"))) {
    rows.push(entry({ rung: "tools", id: "tools/nix-home-manager", label: "Nix home-manager config", linux: "yes", ...(await found(host, ["~/.config/home-manager", "~/.config/nixpkgs/home.nix"])) }));
  }

  // Each row installs on the image: a language manager fetches that package's own Linux build, and apt is the
  // image's own package manager. A manager whose rows the build reads no road off (apt) files none for a tool the
  // catalog carries: that row would stand in for the catalog's, whose own road is what installs it there.
  for (const g of GLOBALS) {
    if (!(await host.exec.which(g.bin))) continue;
    const all = "list" in g ? await g.list(host) : g.parse((await host.exec.run(g.bin, g.args)) ?? "");
    const pkgs = readsRowRoad(g.id) ? all : all.filter(p => catalogToolFor(p.name) === undefined);
    for (const p of pkgs) {
      rows.push(item({ rung: "tools", id: toolRowId(g.id, p.name), label: versioned(p, g.sep), group: g.group, linux: "yes", ...(p.version !== undefined ? { version: p.version } : {}) }));
    }
  }
  rows.push(...(await goRows(host)));
  return present(rows);
}
