// SPDX-License-Identifier: AGPL-3.0-only
// The install roads as modules, one per road kind: the bash line that puts a
// road's argument on a Linux machine (pinned where the road names a version),
// the line that takes it off again, the names a recipe row may carry for it,
// what it runs on top of, and how the install reads to a person. The stages
// and the wizard ask a module through roadModule(); nothing outside this file
// decides by a road's name. Every line is text: nothing here runs a command.
// Where each manager installs is one answer here too, installHomes(): the
// machine's own home for a job with no prefix, and a folder of wsp's own under
// /opt for a computer somebody owns, whose daemon resolves no command through
// a folder the workspaces there can write.
import { HOMEBREW_HOME as LINUXBREW_HOME, HOMEBREW_PREFIX as BREW_PREFIX, PNPM_HOME, shellQuote } from "@wsp/protocol";
import { APT_ENV, GUEST_HOME, HOME_BIN, LOCAL_BIN, ROADS, type InstallRoad, type PackageRoad, type ReleaseAsset, type ReleaseAssets, type RoadName, pinCheckLine, standingPin, versionOf } from "./roads.js";

type Road<K extends RoadName> = Extract<InstallRoad, { road: K }>;

/** A recipe's tools row as a manager road reads it: the package (or formula, or Go binary) after the manager in the
 * row's id, the version the laptop runs, and the paths and label the collector wrote, where a road keeps more there. */
export interface ToolRow {
  name: string;
  version?: string;
  paths: readonly string[];
  label: string;
}

export interface RoadModule<R extends { road: RoadName } = InstallRoad> {
  /** How an install by this road reads beside the tool's name: "by apt", "from its release". */
  words: string;
  /** Every directory on the machine this road writes an install into. A workspace on a computer somebody owns is
   * made of that computer's directories: it overlays the trees in the protocol's WORKSPACE_OVERLAID, binds /root,
   * and reads nothing else of the computer unless it is a shared tool root. A road that installs anywhere else
   * puts its tool on the computer and out of every workspace's sight, which is what the test below reads. */
  roots: readonly string[];
  /** The directories this road links the commands it installs into, which is a narrower question than `roots`:
   * roots are the trees a workspace has to be able to see, coarse on purpose, and these are where a command put
   * there by this road answers from. Read to tell a row this road installed from a row of the same name another
   * road put somewhere else, and for nothing about visibility. Empty where the road cannot say. */
  bins(road: R, homes?: InstallHomes): readonly string[];
  /** One shell test that reads whether the road's argument is already on the machine, for a road whose own
   * reading is not the command it puts on PATH: Homebrew's prefix keeps a link per formula it installed, and a
   * command of that name is another road's work. Absent leaves the step's own check and its command as the read. */
  present?(road: R, bin: string): string;
  /** One shell line that exits 0 once the road's argument is on the machine, asked of the road itself, for a road
   * whose own word on that is worth more than a line written beside the row: Homebrew's own list, which runs brew
   * and so is the read after an install, never the presence read a workspace answers (that is `present`). Absent
   * leaves the step the check whoever wrote the row gave it. */
  check?(road: R, bin: string): string;
  /** The one line a person reads while the install runs, for a road whose install line is not that: the brew line
   * without its su, where a release comes from. Absent, the install line is its own. */
  shown?(road: R, bin: string): string;
  /** False where `shown` says where the bytes come from rather than being a line a person could paste. */
  pastes?: false;
  /** What the install runs on top of: a floor row by id, the one apt index read, or Homebrew. */
  after?: string;
  /** The road a recipe's tools row under this manager takes; absent for a road no manager row names. */
  fromRow?(row: ToolRow): R;
  /** The bash line that puts the road's argument on the machine, or why nothing can; `bin` is the command it puts
   * on PATH and `homes` where this job's managers install. */
  install(road: R, bin: string, homes?: InstallHomes): string | { note: string };
  /** The line that takes it off again, or why it stays. */
  uninstall(road: R, bin: string, homes?: InstallHomes): { cmd: string } | { note: string };
  /** The knobs this road's manager reads for where it installs, for the one line every script of the job exports;
   * absent for a road whose install reads none. */
  env?(homes: InstallHomes): Readonly<Record<string, string>>;
  /** The package names a recipe's tools row may carry for the road's argument. */
  names(road: R): readonly string[];
  /** The command the install puts on PATH when the road alone knows it. */
  bin?(road: R): string | undefined;
  /** The road fixed to a version, for a road that pins one; absent for a road that installs what its source serves. */
  at?(road: R, version: string): R;
  /** One bash line that prints the installed version, in the form `at` takes, on the tools PATH once the row is on
   * the machine; nothing printed reads as unread. Absent for a road whose install line prints it itself. */
  installed?(road: R, bin: string, homes?: InstallHomes): string;
}

/** Whether a copy built from this road's pin gets the version the seal read: the road installs at one (`at`), or it
 * carries a version of its own (the catalog's pinned release, a script whose own text fixes one). Absent both, the
 * road installs what its source serves on the day. */
export function fixesVersion(road: InstallRoad): boolean {
  return roadModule(road).at !== undefined || ("version" in road && road.version !== undefined);
}

// --- the network clock every road runs under -------------------------------------

/** A network read that has gone dead fails after this long and is tried this many more times, on every road whose
 * tool takes the knobs from its environment; the road's step limit below bounds whatever the tool cannot clock. */
export const NET_READ_S = 60;
export const NET_RETRIES = 1;
/** Seconds curl gives a connection to open, and the most npm waits before its one more try. */
const NET_CONNECT_S = 15;
const NET_RETRY_WAIT_S = 10;
const NPM_NET = `export npm_config_fetch_timeout=${NET_READ_S * 1000} npm_config_fetch_retries=${NET_RETRIES} npm_config_fetch_retry_maxtimeout=${NET_RETRY_WAIT_S * 1000}`;
const PIP_NET = `export PIP_TIMEOUT=${NET_READ_S} PIP_RETRIES=${NET_RETRIES}`;
const UV_NET = `export UV_HTTP_TIMEOUT=${NET_READ_S} UV_HTTP_RETRIES=${NET_RETRIES}`;
const CARGO_NET = `export CARGO_HTTP_TIMEOUT=${NET_READ_S} CARGO_NET_RETRY=${NET_RETRIES}`;
/** curl reads no environment for these, so every curl a road's script types goes through this function; under a
 * byte a second for the read window is a dead read to it. --silent with --show-error leaves curl's one error line as
 * the last thing on stderr, which is what the reason rule reads; a script types `curl -o file url` and nothing more. */
export const CURL_NET = `curl() { command curl --connect-timeout ${NET_CONNECT_S} --speed-limit 1 --speed-time ${NET_READ_S} --retry ${NET_RETRIES} --fail --silent --show-error --location "$@"; }`;

const atVersion = <R extends { version?: string }>(r: R, version: string): R => ({ ...r, version });
const pinned = (pkg: string, version: string | undefined, sep: string): string => (version === undefined ? pkg : `${pkg}${sep}${version}`);
/** The version field of a Node global's package.json under the manager's global root. */
const nodeGlobalVersion = (rootCmd: string, pkg: string): string => `node -p 'require(process.argv[1] + "/package.json").version' "$(${rootCmd})/"${shellQuote(pkg)}`;
/** The second column of the line a listing prints for the package, with the leading v and a trailing colon off. */
const listedVersion = (list: string, pkg: string): string => `${list} 2>/dev/null | awk -v p=${shellQuote(pkg)} '$1==p{sub(/^v/,"",$2); sub(/:$/,"",$2); print $2}'`;

/** The directories a road links the commands it installs into, named once: what a module answers as its `bins`,
 * and what a script row on the catalog names for the installer it carries. */
const CARGO_HOME = `${GUEST_HOME}/.cargo`;
export const CARGO_BIN = `${CARGO_HOME}/bin`;
const GO_BIN = `${GUEST_HOME}/go/bin`;
export const APT_BIN = "/usr/bin";

/** The folder of wsp's own every manager installs under on a computer somebody owns: under /opt, which the
 * protocol's WORKSPACE_OVERLAID brings into every workspace there through an overlay of its own, so a tool
 * installed here answers inside a workspace while no process in one writes it on the computer itself. The
 * daemon on such a computer resolves every command through a fixed PATH that holds no folder under the home
 * the workspaces share, which is why nothing may install there. A machine wsp forked takes no prefix: its
 * home is root's alone and each manager keeps its own folder under it. */
export const TOOL_PREFIX = "/opt/wsp";

/** Where one manager keeps what it installs, and where a command it installed answers from. */
export interface InstallHome {
  /** The folder it keeps its environments, its caches and its packages under. */
  home: string;
  /** The folder a command it installed answers from: the one the manager links into where it takes a knob for
   * that, and the one `links` below is linked into where it takes none. */
  bin: string;
  /** The manager's own command folder, for a manager with no knob naming where its commands go: its install ends
   * by linking every command there into `bin`, and its own lines run with it ahead of the job's PATH, since pnpm
   * refuses to install a global while the folder it links into is off PATH. Absent where a knob does the work. */
  links?: string;
  /** The knobs a job exports so this manager reads this home, by name; empty where the manager's own defaults
   * already are it. */
  env: Readonly<Record<string, string>>;
}

/** The managers whose install folder a job can move, in the order the job's own line exports their knobs. */
export const INSTALL_HOMES = ["pnpm", "bun", "uv", "pipx", "cargo", "go"] as const;
export type InstallHomeName = (typeof INSTALL_HOMES)[number];
export type InstallHomes = { readonly [K in InstallHomeName]: InstallHome };

/** Where every manager installs for one job: under `prefix` with every command in /usr/local/bin for a computer
 * somebody owns, and under the machine's home for a machine wsp forked, which is each manager's own default and
 * what an image is built with. Every module's bins, its version read and its knobs come off this one answer, so
 * no two of them can name different folders, and the knobs are the line the job exports on every script it sends. */
export function installHomes(prefix?: string): InstallHomes {
  if (prefix === undefined) {
    return {
      // pnpm alone has no folder of its own by default, so its knob rides every job, image included.
      pnpm: { home: PNPM_HOME, bin: PNPM_HOME, env: { PNPM_HOME } },
      bun: { home: `${GUEST_HOME}/.bun`, bin: `${GUEST_HOME}/.bun/bin`, env: {} },
      uv: { home: `${GUEST_HOME}/.local`, bin: HOME_BIN, env: {} },
      pipx: { home: `${GUEST_HOME}/.local`, bin: HOME_BIN, env: {} },
      cargo: { home: CARGO_HOME, bin: CARGO_BIN, env: {} },
      go: { home: `${GUEST_HOME}/go`, bin: GO_BIN, env: {} },
    };
  }
  const at = (name: string): string => `${prefix}/${name}`;
  return {
    // pnpm links what it installs globally into its home's own bin folder and takes no knob for another, so that
    // folder is linked onto the fixed PATH; rustup's toolchain rides cargo's home and cargo install takes none either.
    pnpm: { home: at("pnpm"), bin: LOCAL_BIN, links: `${at("pnpm")}/bin`, env: { PNPM_HOME: at("pnpm") } },
    bun: { home: at("bun"), bin: LOCAL_BIN, env: { BUN_INSTALL: at("bun"), BUN_INSTALL_BIN: LOCAL_BIN } },
    uv: { home: at("uv"), bin: LOCAL_BIN, env: { UV_TOOL_DIR: `${at("uv")}/tools`, UV_TOOL_BIN_DIR: LOCAL_BIN, UV_PYTHON_INSTALL_DIR: `${at("uv")}/python` } },
    pipx: { home: at("pipx"), bin: LOCAL_BIN, env: { PIPX_HOME: at("pipx"), PIPX_BIN_DIR: LOCAL_BIN } },
    cargo: { home: at("cargo"), bin: LOCAL_BIN, links: `${at("cargo")}/bin`, env: { CARGO_HOME: at("cargo"), RUSTUP_HOME: at("rustup") } },
    go: { home: at("go"), bin: LOCAL_BIN, env: { GOPATH: at("go"), GOBIN: LOCAL_BIN } },
  };
}

/** The homes a job with no prefix runs on, which is every manager's own: the default every module reads where a
 * caller names none, and what a folder a row carries is read against. */
const OWN_HOMES = installHomes();

/** The homes a job on a computer somebody owns runs on, since one prefix is wsp's: read by the modules' roots, so
 * the folders a road writes are named once here and once there. */
const PREFIX_HOMES = installHomes(TOOL_PREFIX);

/** A manager's own command folder and the folder every command in it is linked into, for a manager whose commands
 * the job's homes put where no PATH of the job looks. */
interface LinkedCommands {
  links: string;
  bin: string;
}

/** That pair for one manager's home, or nothing where the manager puts its commands where it is told. */
const linkedOf = (home: InstallHome): LinkedCommands | undefined => (home.links === undefined ? undefined : { links: home.links, bin: home.bin });

/** The pair for the manager that keeps its commands in this folder and links them out of it under this job's
 * homes, which is cargo's own folder and pnpm's. Nothing for any other folder a row names, which is the row's own
 * and stands, and nothing at all for a job with no prefix, where no manager links. `/root/.local/bin` is the
 * folder uv and pipx are told to link into rather than one either of them keeps, so it answers here only if one of
 * those two is ever given a folder of its own. */
function movedHome(dir: string, homes: InstallHomes): LinkedCommands | undefined {
  for (const name of INSTALL_HOMES) {
    if (homes[name].links !== undefined && OWN_HOMES[name].bin === dir) return linkedOf(homes[name]);
  }
  return undefined;
}

/** The folders a row's own installer links into, under this job's homes: a folder a manager keeps its commands in
 * moves with that manager, and the commands there are linked onto the fixed PATH, so both folders answer for it. */
export const homeBins = (bins: readonly string[], homes: InstallHomes): readonly string[] =>
  bins.flatMap(dir => {
    const moved = movedHome(dir, homes);
    return moved === undefined ? [dir] : [moved.links, moved.bin];
  });

/** Every command in that folder, linked into the folder the daemon's fixed PATH holds: the last line of the
 * install of a manager's own row, and of a row whose installer writes into such a folder. Nothing where no folder
 * moved, which is every job on a machine wsp forked. */
const linkCommands = (at: LinkedCommands | undefined): string[] => (at === undefined ? [] : [`find ${at.links} -maxdepth 1 -type f -perm -u+x -exec ln -sfn {} ${at.bin}/ ';'`]);

/** The link one command answers by, taken off again where the install put one there. */
const unlinkCommand = (home: InstallHome, bin: string): string[] => (home.links === undefined ? [] : [`rm -f ${home.bin}/${shellQuote(bin)}`]);

/** What a step reads a row of this manager back by: the folder its commands answer from, with the manager's own
 * folder ahead of it where the install links them out of one the PATH does not name. */
const binsOf = (home: InstallHome): readonly string[] => (home.links === undefined ? [home.bin] : [home.links, home.bin]);

/** One line of a manager's own, run with its command folder ahead of the job's PATH where the manager reads its
 * own commands there and would otherwise refuse. */
const inHome = (home: InstallHome, cmd: string): string => (home.links === undefined ? cmd : `export PATH=${home.links}:$PATH; ${cmd}`);

/** The pseudo step every apt row waits on: the index read once, before the first of them. */
export const APT_INDEX = "apt-index";
/** The pseudo step every formula waits on: Homebrew with its toolchain. */
export const HOMEBREW_STEP = "homebrew";
/** The index read, as the stage runs it before the first apt row. */
export const APT_UPDATE = `${APT_ENV}\napt-get update -qq`;

// --- Homebrew ------------------------------------------------------------------

/** Homebrew itself is a git checkout at a release tag whose commit is checked
 * before anything runs (https://docs.brew.sh/Homebrew-on-Linux#alternative-installation). */
export const HOMEBREW = { tag: "6.0.21", commit: "560147012b9678b42ef5e83b690f0895552d1366" } as const;
/** The user Homebrew runs as and the home useradd makes for it, and the prefix under it. The protocol's, since a
 * workspace on a computer somebody owns is made of that computer's directories and the daemon binds this prefix in
 * for the tools installed here to answer inside: the road that installs them and the bundle that brings them in
 * cannot name two directories. */
export { HOMEBREW_HOME as LINUXBREW_HOME, HOMEBREW_PREFIX as BREW_PREFIX } from "@wsp/protocol";
/** Homebrew's own checkout, where its Linux install puts it. */
export const BREW_REPO = `${BREW_PREFIX}/Homebrew`;
// Install-time cleanup stays on: with it off, one recipe left 2.6 GB of bottles in the download cache on a 20 GB disk.
export const BREW_ENV = `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 NONINTERACTIVE=1 HOMEBREW_CURL_RETRIES=${NET_RETRIES}`;
/** The one brew anything on this machine types, a person's shell included: the shim below, in the directory Homebrew
 * puts its own on, so a dotfiles line that prepends that directory (`brew shellenv` does) still lands on the shim. */
export const BREW = `${BREW_PREFIX}/bin/brew`;
/** What the shim runs: brew reads its prefix off the path it was called by, two directories up, so calling the
 * checkout's own bin/brew would make the checkout the prefix and every keg with it. This link is at that depth and
 * in a directory no PATH carries and no keg links into, so it is the shim's alone. */
export const BREW_REAL = `${BREW_PREFIX}/libexec/brew`;

/** su hands linuxbrew the directory the caller stood in, and Homebrew stops before it starts on one linuxbrew
 * cannot read: root's home is 0700 on the images a box boots, and every formula row failed behind it. Stay where
 * the call was made when linuxbrew can read it, so a person's own brew still reads the folder they are in. */
export const FROM_A_READABLE_DIR = `cd . 2>/dev/null || cd ${LINUXBREW_HOME}`;

// Homebrew refuses to run as root, so it lives under its own user at the
// prefix its Linux bottles are built for; anything else compiles from source.
export function asLinuxbrewScript(script: string): string {
  return `su -s /bin/bash linuxbrew -c ${shellQuote(`${FROM_A_READABLE_DIR}\nexport ${BREW_ENV}\n${script}`)}`;
}

export function asLinuxbrew(cmd: string): string {
  return `su -s /bin/bash linuxbrew -c ${shellQuote(`${FROM_A_READABLE_DIR}\n${BREW_ENV} ${BREW} ${cmd}`)}`;
}

/** The file that sits at BREW, so every brew on the machine runs as the user that owns the tree however it was
 * reached. Root running Homebrew's own brew writes root-owned files into that tree and git then refuses to read it,
 * which reads as "No remote origin, skipping update". It sets no Homebrew environment: a person's brew is meant to
 * update, and a caller that wants otherwise exports it, which su carries through. */
export const LINUXBREW_SHIM = ["#!/bin/sh", `if [ "$(id -un)" = linuxbrew ]; then exec ${BREW_REAL} "$@"; fi`, `exec su -s /bin/bash linuxbrew -c ${shellQuote(`${FROM_A_READABLE_DIR}\nexec "$0" "$@"`)} -- ${BREW_REAL} "$@"`].join("\n");

/** A formula's own short name, the part after the tap: the name Homebrew links it under in the prefix, and the
 * name the road below installs the binary under where a tap formula has no Linux bottle. Not the command the
 * formula puts on PATH, which is the formula's business and often another word (git-delta puts delta on PATH,
 * gnupg puts gpg, c-ares puts adig and ahost); nothing a recipe carries names those. */
export const formulaShortName = (formula: string): string => formula.slice(formula.lastIndexOf("/") + 1);

/** Whether a formula is on a machine, as one shell test a workspace can answer, and neither half runs brew, which
 * cannot run inside a workspace at all: the prefix keeps an `opt/<short name>` link per formula it installed,
 * whatever binaries that formula puts on PATH, and that link alone is the answer for a core formula. A tap formula
 * falls back to a command of that name, since a tap formula with no Linux bottle took the road to /usr/local/bin
 * under it, which is the same split the uninstall above reads. A core formula is never read by its name: the base
 * stage's node and the release road's gh are on the PATH under theirs, and a formula Homebrew never installed
 * would read present off another road's work. */
const formulaPresent = (formula: string): string => {
  const short = formulaShortName(formula);
  const linked = `test -e ${BREW_PREFIX}/opt/${short}`;
  return formula.includes("/") ? `${linked} || command -v ${shellQuote(short)} >/dev/null 2>&1` : linked;
};

/** Whether Homebrew already holds every formula named, as its own list answers it: the check a brew step reads as
 * already done. `brew list --versions a b` exits non-zero as soon as one of them is not installed, and on a
 * computer with no Homebrew at all the su itself fails, which reads the same way. */
export const brewHasCheck = (...formulae: readonly string[]): string => asLinuxbrew(`list --versions ${formulae.join(" ")}`);

const brew: RoadModule<Road<"brew">> = {
  words: "with Homebrew",
  // A formula lands in the prefix; a tap formula with no Linux bottle takes the road to /usr/local/bin.
  roots: [BREW_PREFIX, "/usr/local/bin"],
  bins: () => [`${BREW_PREFIX}/bin`, `${BREW_PREFIX}/sbin`, LOCAL_BIN],
  present: r => formulaPresent(r.formula),
  check: r => brewHasCheck(r.formula),
  after: HOMEBREW_STEP,
  fromRow: r => ({ road: "brew", formula: r.name }),
  shown: r => `brew install ${r.formula}`,
  install: r => asLinuxbrew(`install ${r.formula}`),
  uninstall: r => {
    if (!r.formula.includes("/")) return { cmd: asLinuxbrew(`uninstall ${r.formula}`) };
    // A tap formula with no Linux bottle took the road to /usr/local/bin under the formula's name, not to the cellar.
    const bin = formulaShortName(r.formula);
    return { cmd: `if [ -x ${BREW} ] && ${asLinuxbrew(`list --formula ${r.formula}`)} >/dev/null 2>&1; then ${asLinuxbrew(`uninstall ${r.formula}`)}; else rm -f /usr/local/bin/${shellQuote(bin)}; fi` };
  },
  names: r => [r.formula],
  installed: r => `${asLinuxbrew(`list --versions ${r.formula}`)} 2>/dev/null | awk '{print $2}'`,
};

// --- package managers ----------------------------------------------------------

const npm: RoadModule<Road<"npm">> = {
  words: "as an npm global",
  // npm's global root under the Node the base stage unpacks into /usr/local.
  roots: ["/usr/local/lib/node_modules", "/usr/local/bin"],
  bins: () => [LOCAL_BIN],
  after: "node",
  fromRow: r => ({ road: "npm", package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `npm install -g ${r.ignoreScripts === true ? "--ignore-scripts " : ""}${pinned(r.package, versionOf(r), "@")}`,
  uninstall: r => ({ cmd: `npm uninstall -g ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
  installed: r => nodeGlobalVersion("npm root -g", r.package),
};

/** pnpm and bun keep npm's global shape under their own verbs; bun lists its globals as a tree and keeps no root command. */
const nodeGlobal = <K extends "pnpm" | "bun">(road: K): RoadModule<PackageRoad<K>> => ({
  words: `with ${road}`,
  roots: [OWN_HOMES[road].home, PREFIX_HOMES[road].home],
  bins: (_r, homes = OWN_HOMES) => binsOf(homes[road]),
  env: homes => homes[road].env,
  fromRow: r => ({ road, package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: (r, _bin, homes = OWN_HOMES) => [inHome(homes[road], `${road} add -g ${pinned(r.package, versionOf(r), "@")}`), ...linkCommands(linkedOf(homes[road]))].join("\n"),
  uninstall: (r, bin, homes = OWN_HOMES) => ({ cmd: [inHome(homes[road], `${road} remove -g ${r.package}`), ...unlinkCommand(homes[road], bin)].join("\n") }),
  names: r => [r.package],
  at: atVersion,
  installed: (r, _bin, homes = OWN_HOMES) =>
    inHome(homes[road], road === "bun" ? `bun pm ls -g 2>/dev/null | grep -oE "(^| )${r.package}@[^[:space:]]+" | head -n 1 | sed 's/.*@//'` : nodeGlobalVersion("pnpm root -g", r.package)),
});

/** uv and pipx install a Python tool into its own environment, pinned the pip way. */
const pythonTool = <K extends "uv" | "pipx">(road: K, cmd: string): RoadModule<PackageRoad<K>> => ({
  words: `with ${road}`,
  // Both install a tool into an environment of its own and link its command beside it: under the machine's home
  // by default, and under the prefix with the command in /usr/local/bin where the job names one.
  roots: [OWN_HOMES[road].home, PREFIX_HOMES[road].home],
  bins: (_r, homes = OWN_HOMES) => binsOf(homes[road]),
  env: homes => homes[road].env,
  fromRow: r => ({ road, package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `${cmd} install ${pinned(r.package, versionOf(r), "==")}`,
  uninstall: r => ({ cmd: `${cmd} uninstall ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
  installed: r => listedVersion(road === "uv" ? "uv tool list" : "pipx list --short", r.package),
});

const cargo: RoadModule<Road<"cargo">> = {
  words: "with cargo",
  roots: [OWN_HOMES.cargo.home, PREFIX_HOMES.cargo.home],
  bins: (_r, homes = OWN_HOMES) => binsOf(homes.cargo),
  env: homes => homes.cargo.env,
  fromRow: r => ({ road: "cargo", package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  // cargo install writes its command into the cargo home's own bin folder and takes no knob for another, so a job
  // that moved that home links what it left there onto the PATH the daemon resolves through. --locked builds the
  // crate against the lockfile it shipped; a crate that ships none warns and resolves as before.
  install: (r, _bin, homes = OWN_HOMES) => {
    const version = versionOf(r);
    return [inHome(homes.cargo, `cargo install ${r.package}${version === undefined ? "" : ` --version ${version}`} --locked`), ...linkCommands(linkedOf(homes.cargo))].join("\n");
  },
  uninstall: (r, bin, homes = OWN_HOMES) => ({ cmd: [inHome(homes.cargo, `cargo uninstall ${r.package}`), ...unlinkCommand(homes.cargo, bin)].join("\n") }),
  names: r => [r.package],
  at: atVersion,
  installed: (r, _bin, homes = OWN_HOMES) => inHome(homes.cargo, listedVersion("cargo install --list", r.package)),
};

/** The collector puts a Go binary's `path@version` in its first path; recipes saved
 * before that carried it in the label as `name (path@version)`. */
function goModule(row: ToolRow): { path: string; version: string } | undefined {
  const spec = row.paths[0] ?? /\(([^()\s]+)\)/.exec(row.label)?.[1];
  const at = spec?.lastIndexOf("@") ?? -1;
  if (spec === undefined || at <= 0 || at === spec.length - 1) return undefined;
  return { path: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** The file `go install` writes for a module: its last path element, skipping a major-version suffix. */
export function goBinary(module: string): string {
  const at = module.lastIndexOf("@");
  const parts = (at > 0 ? module.slice(0, at) : module).split("/");
  const last = parts.at(-1)!;
  return /^v[1-9]\d*$/.test(last) && parts.length > 1 ? parts.at(-2)! : last;
}

const go: RoadModule<Road<"go">> = {
  words: "with go install",
  roots: [OWN_HOMES.go.home, PREFIX_HOMES.go.home],
  bins: (_r, homes = OWN_HOMES) => binsOf(homes.go),
  env: homes => homes.go.env,
  fromRow: r => {
    const mod = goModule(r);
    return mod === undefined ? { road: "go" } : { road: "go", module: mod.path, version: r.version ?? mod.version };
  },
  install: r => (r.module === undefined ? { note: "no module to install from" } : `go install ${pinned(r.module, versionOf(r), "@")}`),
  uninstall: (_r, _bin, homes = OWN_HOMES) => ({ note: `go has no uninstall; the binary stays in ${homes.go.bin}` }),
  names: () => [],
  bin: r => (r.module === undefined ? undefined : goBinary(r.module)),
  at: atVersion,
  // The module's version as the binary records it, with its v: what `go install path@version` takes.
  installed: (_r, bin, homes = OWN_HOMES) => `go version -m ${homes.go.bin}/${shellQuote(bin)} 2>/dev/null | awk '$1=="mod"{print $3}'`,
};

// --- releases ------------------------------------------------------------------

/** What a downloaded asset becomes on the machine: unpacked where it is an archive, the command the row names found
 * in what came out, installed, and the artifact with its sum and tag printed on the WSP_ROAD line the stage reads.
 * `sum` is the shell word holding the sha256, which the two release roads fill from different places. */
function unpackLines(sum: string): string[] {
  return [
    'case "$asset" in',
    '  *.tar.gz|*.tgz) tar -xzf "$tmp/$asset" -C "$tmp" ;;',
    '  *.tar.xz) tar -xJf "$tmp/$asset" -C "$tmp" ;;',
    '  *.zip) if command -v unzip >/dev/null 2>&1; then unzip -qo "$tmp/$asset" -d "$tmp"; else python3 -m zipfile -e "$tmp/$asset" "$tmp"; fi ;;',
    '  *) mv "$tmp/$asset" "$tmp/$name"; chmod +x "$tmp/$name" ;;',
    "esac",
    'bin="$(find "$tmp" -type f -name "$name" | head -1)"',
    `[ -n "$bin" ] || bin="$(find "$tmp" -type f -perm -u+x ! -name "$asset" ! -name '*.md' ! -name '*.txt' -printf '%s %p\\n' | sort -rn | head -1 | cut -d' ' -f2-)"`,
    '[ -n "$bin" ] || { echo "Error: no binary in $asset" >&2; exit 1; }',
    'install -m 0755 "$bin" "/usr/local/bin/$name"',
    `echo "WSP_ROAD release $asset ${sum} $tag"`,
  ];
}

/** The fall-through for an arch the release has no Linux asset for: the main package the row names, built by the go
 * on the machine and moved to the row's command where the module's own name differs. */
function goLines(goAt: string, name: string): string[] {
  return [
    "elif command -v go >/dev/null 2>&1; then",
    `  GOBIN=/usr/local/bin go install ${shellQuote(goAt)}`,
    ...(goBinary(goAt) === name ? [] : [`  mv ${shellQuote(`/usr/local/bin/${goBinary(goAt)}`)} "/usr/local/bin/$name"`]),
    `  echo "WSP_ROAD go "${shellQuote(goAt)}`,
  ];
}

/** The module at a version, for the fall-through: its own where it names one, else the tag the road installs at. */
const goAtTag = (go: string | undefined, tag: string): string | undefined => (go === undefined || go.includes("@") ? go : `${go}@${tag}`);

/** The words an arch's Linux build carries in an asset's name, as one extended regular expression per arch: the
 * words the release road greps a listing for below, and the ones the pin script reads to record a sum, so the file
 * a machine picks and the file that was hashed are the same one. */
export const ASSET_ARCH: { readonly x86_64: string; readonly aarch64: string } = { x86_64: "amd64|x86_64|x64", aarch64: "arm64|aarch64" };
/** The endings that are never the build: sums, signatures, notes, other managers' packages, and archives no unpack
 * line below reads. Read by the release road's grep and by the pin script, as the arch words above are. */
export const ASSET_SKIPPED = "\\.(sha256|sha256sum|sha512|sig|asc|txt|md5|pem|deb|rpm|apk|zst|tar\\.zst|json)$";

/** A tool from its repository: the asset the catalog recorded for this arch, downloaded from the tag's own download
 * address, its sha256 checked before anything it carries is unpacked, and its binary put in /usr/local/bin. Nothing
 * is read off the API and no listing is grepped: the file's name and its sum stand in the catalog. An arch the
 * release has no asset for takes the go fall-through, and is refused where the row names no module. */
function assetInstall(name: string, repo: string, tag: string, assets: ReleaseAssets, go: string | undefined): string {
  const goAt = goAtTag(go, tag);
  const pick = (a: ReleaseAsset | undefined): string => (a === undefined ? "asset= sha=" : `asset=${shellQuote(a.name)} sha=${a.sha256}`);
  const body = [
    `url=${shellQuote(`https://github.com/${repo}/releases/download/${tag}/`)}"$asset"`,
    'curl -o "$tmp/$asset" "$url"',
    'echo "$sha  $tmp/$asset" | sha256sum -c - >/dev/null',
    ...unpackLines("$sha"),
  ];
  // A row the catalog recorded both arches for can only take the asset road, so nothing renders the other two.
  const complete = assets.x86_64 !== undefined && assets.aarch64 !== undefined;
  return [
    "set -euo pipefail",
    `name=${shellQuote(name)}`,
    `tag=${shellQuote(tag)}`,
    'arch="$(uname -m)"',
    `case "$arch" in x86_64) ${pick(assets.x86_64)} ;; aarch64) ${pick(assets.aarch64)} ;; *) echo "Error: unsupported arch: $arch" >&2; exit 1 ;; esac`,
    'tmp="$(mktemp -d /tmp/wsp-road-XXXXXX)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    ...(complete
      ? body
      : [
          'if [ -n "$asset" ]; then',
          ...body.map(l => `  ${l}`),
          ...(goAt === undefined ? [] : goLines(goAt, name)),
          "else",
          `  echo "Error: release "${shellQuote(tag)}" of "${shellQuote(repo)}" has no Linux build for $arch${goAt === undefined ? "" : ", and go is not on the machine"}" >&2`,
          "  exit 1",
          "fi",
        ]),
  ].join("\n");
}

/** A person's own row's release, which names no asset: the release's listing read off the API at the tag the row
 * carries, the Linux asset for this arch picked out of it, and the sum its first install recorded checked where one
 * stands. Only a row the catalog does not carry takes this road; every catalog row names its asset above. */
function releaseInstall(name: string, repo: string, tag: string, pin: string | undefined, go: string | undefined): string {
  const goAt = goAtTag(go, tag);
  return [
    "set -euo pipefail",
    `name=${shellQuote(name)}`,
    `tag=${shellQuote(tag)}`,
    'arch="$(uname -m)"',
    `case "$arch" in x86_64) pat="${ASSET_ARCH.x86_64}" ;; aarch64) pat="${ASSET_ARCH.aarch64}" ;; *) echo "Error: unsupported arch: $arch" >&2; exit 1 ;; esac`,
    'tmp="$(mktemp -d /tmp/wsp-road-XXXXXX)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `release="$(curl ${shellQuote(`https://api.github.com/repos/${repo}/releases/tags/${tag}`)} || true)"`,
    `urls="$(printf '%s\\n' "$release" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 || true)"`,
    `url="$(printf '%s\\n' "$urls" | grep -i linux | grep -iE "$pat" | grep -viE '${ASSET_SKIPPED}' | head -1 || true)"`,
    'if [ -n "$url" ]; then',
    '  asset="${url##*/}"',
    '  curl -o "$tmp/$asset" "$url"',
    `  sum="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"`,
    ...(pin !== undefined ? [`  ${pinCheckLine("$asset", "$tag", pin)}`] : []),
    ...unpackLines("$sum").map(l => `  ${l}`),
    ...(goAt === undefined ? [] : goLines(goAt, name)),
    "else",
    `  echo "Error: release "${shellQuote(tag)}" of "${shellQuote(repo)}" has no Linux build${goAt === undefined ? "" : ", and go is not on the machine"}" >&2`,
    "  exit 1",
    "fi",
  ].join("\n");
}

const NO_RELEASE = "no GitHub release to install from";
/** A release road with no tag installs nothing: the current release is a moving artifact and no road fetches one. */
const NO_TAG = "names no release tag; name the version";

const release: RoadModule<Road<"release">> = {
  words: "from its release",
  roots: ["/usr/local/bin"],
  bins: () => [LOCAL_BIN],
  shown: r => (r.repo === undefined ? NO_RELEASE : versionOf(r) === undefined ? NO_TAG : `the ${versionOf(r)} release of github.com/${r.repo}`),
  pastes: false,
  install: (r, bin) => {
    if (r.repo === undefined) return { note: NO_RELEASE };
    const tag = versionOf(r);
    if (tag === undefined) return { note: NO_TAG };
    return r.assets === undefined ? releaseInstall(bin, r.repo, tag, standingPin(r)?.sha256, r.go) : assetInstall(bin, r.repo, tag, r.assets, r.go);
  },
  uninstall: (_r, bin) => ({ cmd: `rm -f /usr/local/bin/${shellQuote(bin)}` }),
  names: () => [],
};

const vendor: RoadModule<Road<"vendor">> = {
  words: "from its vendor's release",
  // The cask's own prefix under /opt and the links it puts on PATH; the cask rows carry the paths themselves.
  roots: ["/opt", "/usr/local/bin"],
  bins: () => [LOCAL_BIN],
  shown: r => r.cask.from,
  pastes: false,
  install: r => r.cask.install,
  uninstall: r => ({ cmd: r.cask.uninstall }),
  names: () => [],
  bin: r => r.cask.bin,
};

// --- the distro and plain scripts ----------------------------------------------

const apt: RoadModule<Road<"apt">> = {
  words: "by apt",
  roots: ["/usr", "/etc", "/var"],
  bins: () => [APT_BIN, "/usr/sbin", "/bin", "/sbin"],
  after: APT_INDEX,
  shown: r => `apt-get install ${r.packages.join(" ")}`,
  install: r => `${APT_ENV}\napt-get install -y -qq ${r.packages.join(" ")}`,
  uninstall: r => ({ cmd: `${APT_ENV}\napt-get purge -y -qq ${r.packages.join(" ")} && apt-get autoremove -y -qq --purge` }),
  names: r => r.packages,
  // The row's first package names it; Debian's version string, epoch and revision included, is what dpkg holds.
  installed: r => `dpkg-query -W -f='\${Version}\\n' ${shellQuote(r.packages[0] ?? "")} 2>/dev/null`,
};

const script: RoadModule<Road<"script">> = {
  words: "by its own installer",
  // Every script this road carries unpacks under /usr/local or /opt, installs by apt, or writes under the machine's home, the /root every workspace on a computer somebody owns shares.
  roots: ["/usr", "/opt", "/root"],
  // The scripts put their commands in different directories, so the directories ride each script's row and the module reads them off it.
  bins: (r, homes = OWN_HOMES) => homeBins(r.bins ?? [], homes),
  // A row whose installer writes into a manager's own command folder writes into that manager's folder under the
  // prefix once the job tells it so, which no PATH names, so its commands are linked from there as the manager's
  // own rows are: rustup's toolchain is the row this is for.
  install: (r, _bin, homes = OWN_HOMES) => [r.script, ...(r.bins ?? []).flatMap(dir => linkCommands(movedHome(dir, homes)))].join("\n"),
  uninstall: (_r, bin) => ({ note: `${bin} has no uninstaller; left on the machine` }),
  names: () => [],
  // The command's own version line, cut to its version token: what a script leaves is whatever its vendor prints.
  installed: (_r, bin) => `${shellQuote(bin)} --version 2>/dev/null | head -n 1 | grep -oE '[0-9][^ ,()]*\\.[0-9][^ ,()]*' | head -n 1`,
};

export const ROAD_MODULES: { readonly [K in RoadName]: RoadModule<Road<K>> } = {
  brew,
  npm,
  pnpm: nodeGlobal("pnpm"),
  bun: nodeGlobal("bun"),
  uv: pythonTool("uv", "uv tool"),
  pipx: pythonTool("pipx", "pipx"),
  cargo,
  go,
  release,
  vendor,
  apt,
  script,
};

/** Every knob the managers read for one job's homes, in the order the modules stand: what the one line each
 * script of the job exports carries beside its PATH, so an install, a presence read and a version read all reach
 * the same folders. */
export function installEnv(homes: InstallHomes): Record<string, string> {
  const out: Record<string, string> = {};
  for (const road of ROADS) Object.assign(out, ROAD_MODULES[road].env?.(homes) ?? {});
  return out;
}

/** The reader a manager's own module has for a tools row filed under that manager's id, or nothing where it has
 * none. Every caller that turns such a row into a road goes through this one, so the plan of a row the collector
 * filed and the plan of a row an agent added read the same road. */
export const rowRoadReader = (manager: string): ((row: ToolRow) => InstallRoad) | undefined =>
  (ROADS as readonly string[]).includes(manager) ? ROAD_MODULES[manager as RoadName].fromRow : undefined;

/** Whether the build can read a package's install road off a tools row a manager filed under its own id, the same
 * question `rowRoad` answers with the reader itself. Every language manager can. apt cannot: it is on every
 * machine and brings no row of its own, so a row it filed can neither install the package nor stand in for the
 * catalog row of a tool the catalog carries, whose own road installs that one. The collector and the recipe verb
 * read this before filing or ticking such a row. */
export const readsRowRoad = (manager: string): boolean => rowRoadReader(manager) !== undefined;

/** What a road's step gets from the guard that runs it. */
export interface RoadStep {
  /** Seconds the step may run before the guard ends it. */
  limitS: number;
  /** Whether a step that ran the limit out is run once more: a download that did was a dead read, a compile that did will do it again. */
  retry: boolean;
  /** The lines ahead of the install that put the road's own network reads on the clock above. */
  env: readonly string[];
}

/** A script road's step is a whole script whose last line may be a cleanup, so the road runs it under set -e:
 * without it a failed download reads as an install on a machine that already carries the tool. */
const SHELL_STRICT = "set -euo pipefail";

/** A package manager or a download finishes in a couple of minutes or is stuck; Homebrew, go, apt and a script may
 * build or configure for longer; cargo compiles every crate from source. Homebrew's retry count rides BREW_ENV; apt
 * clocks its own reads (two minutes and three tries by default); bun and go expose no knob. */
const DOWNLOAD_S = 300;
const MIXED_S = 600;
const COMPILE_S = 1200;
export const ROAD_STEPS: { readonly [K in RoadName]: RoadStep } = {
  brew: { limitS: MIXED_S, retry: false, env: [] },
  npm: { limitS: DOWNLOAD_S, retry: true, env: [NPM_NET] },
  pnpm: { limitS: DOWNLOAD_S, retry: true, env: [NPM_NET] },
  bun: { limitS: DOWNLOAD_S, retry: true, env: [] },
  uv: { limitS: DOWNLOAD_S, retry: true, env: [UV_NET] },
  pipx: { limitS: DOWNLOAD_S, retry: true, env: [PIP_NET] },
  cargo: { limitS: COMPILE_S, retry: false, env: [CARGO_NET] },
  go: { limitS: MIXED_S, retry: false, env: [] },
  release: { limitS: DOWNLOAD_S, retry: true, env: [CURL_NET] },
  vendor: { limitS: DOWNLOAD_S, retry: true, env: [CURL_NET] },
  apt: { limitS: MIXED_S, retry: false, env: [] },
  script: { limitS: MIXED_S, retry: false, env: [SHELL_STRICT, NPM_NET, PIP_NET, UV_NET, CARGO_NET, CURL_NET] },
};

/** The module that walks a road, typed to it. */
export function roadModule<R extends InstallRoad>(road: R): RoadModule<R> {
  return ROAD_MODULES[road.road] as unknown as RoadModule<R>;
}
