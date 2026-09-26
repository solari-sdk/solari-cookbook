// SPDX-License-Identifier: AGPL-3.0-only
// The roads a catalog entry or a recipe's tools row can take onto a Linux
// machine (the modules that walk them are in road-modules.ts), and the pinned
// installers the script road carries: uv, Node, Docker's compose plugin and
// Swift and rustup by their checksummed releases, Playwright's Chromium at the
// Playwright the render tests run, 1Password's CLI from its own apt repository
// under its pinned signing key, Hermes by a git checkout at a commit, Claude Code
// by the vendor's own binary at a pinned version. Every pin here is checked on
// the machine before anything runs.
import { SUM_SHOWN, pinMismatchLine, shellQuote, shortSum, type ToolPin } from "@wsp/protocol";
import type { LinuxCask } from "./linux-casks.js";

export type { ToolPin };

export const MIB = 1024 * 1024;

/** How an install stands against the recipe's pin: nothing recorded, the same version (checked), or a version the
 * source has since moved to (a first install again, re-recorded). Without a version the pin's own stands. */
export function pinStateOf(version: string | undefined, pin: ToolPin | undefined): "none" | "same" | "moved" {
  if (pin === undefined) return "none";
  return version === undefined || version === pin.tag ? "same" : "moved";
}

/** The pin an install is fixed to: the recorded one while the road's version is its tag or names none; nothing once
 * the version moved past it, since that install is a first one again. */
export function standingPin<R extends { road: string; version?: string; pin?: ToolPin }>(road: R): ToolPin | undefined {
  return pinStateOf(road.version, road.pin) === "same" ? road.pin : undefined;
}

/** The road without the pin a build recorded on it: what a first run of it installs. */
export function unpinned<R extends InstallRoad>(road: R): R {
  if (!("pin" in road)) return road;
  const { pin: _pin, ...rest } = road;
  return rest as R;
}

/** The line that fails a pinned download whose sum is not the recorded one. `what` and `tag` are bash words the
 * script has set by then; the served sum is read from the script's own `sum`. */
export function pinCheckLine(what: string, tag: string, sha256: string): string {
  return `[ "$sum" = ${shellQuote(sha256)} ] || { echo "Error: ${pinMismatchLine(what, tag, shortSum(sha256), `\${sum:0:${SUM_SHOWN}}`)}" >&2; exit 1; }`;
}

/** One release asset wsp recorded: the file's name under its tag's download address and its sha256, which the
 * machine checks before anything the file carries runs. */
export interface ReleaseAsset {
  name: string;
  sha256: string;
}

/** A release's recorded assets by the arch a machine reports; an arch with none has no Linux build in that release. */
export interface ReleaseAssets {
  x86_64?: ReleaseAsset;
  aarch64?: ReleaseAsset;
}

/** A package manager's global: at `version` when the row names one (the laptop's), else at the recorded `pin` while
 * it stands, else the current one. */
export interface PackageRoad<K extends string> {
  road: K;
  package: string;
  version?: string;
  pin?: ToolPin;
}

export type InstallRoad =
  | { road: "brew"; formula: string; pin?: ToolPin }
  | (PackageRoad<"npm"> & { ignoreScripts?: true })
  | PackageRoad<"pnpm">
  | PackageRoad<"bun">
  | PackageRoad<"uv">
  | PackageRoad<"pipx">
  | PackageRoad<"cargo">
  /** `go install` of a module at a version; a row whose module nobody could read carries none and installs nothing. */
  | { road: "go"; module?: string; version?: string; pin?: ToolPin }
  /** A GitHub repository's Linux asset for the arch at `version`, the tag the catalog pinned or the one a person's own
   * row names; `assets` is the file and the sha256 wsp recorded per arch, which every catalog row carries, and a row
   * without them takes the release's own listing with the sum its first install recorded (`pin`). `go` is the main
   * package `go install` falls back to for an arch the release has no asset for; with none there is no fall-through.
   * A row that came back from a golden's digest names no repository: it only ever comes off. */
  | { road: "release"; repo?: string; version?: string; assets?: ReleaseAssets; pin?: ToolPin; go?: string }
  /** A vendor's own Linux download, as its cask row scripts and hashes it. */
  | { road: "vendor"; cask: LinuxCask; version?: string; pin?: ToolPin }
  | { road: "apt"; packages: readonly string[]; pin?: ToolPin }
  /** A vendor installer as the stage runs it. The script is fixed text and takes no version from outside; `version`
   * is the one its own text fixes (a checksummed release, a tagged checkout), absent when it takes the current one.
   * `bins` names the directories this script links its commands into, which no two of them share: the row carries
   * them because the road cannot know, and a script that says none is read as saying nothing. */
  | { road: "script"; script: string; version?: string; pin?: ToolPin; bins?: readonly string[] };

export type RoadName = InstallRoad["road"];
export const ROADS: readonly RoadName[] = ["brew", "npm", "pnpm", "bun", "uv", "pipx", "cargo", "go", "release", "vendor", "apt", "script"];
/** Whether a word a digest or a record carries names a road. */
export const isRoad = (s: string | undefined): s is RoadName => (ROADS as readonly string[]).includes(s ?? "");

/** The version a road installs at: the row's own, else the recorded pin's while it stands, else nothing, which is
 * the source's current one. The one rule every road that takes a version reads. */
export function versionOf<R extends { road: string; version?: string; pin?: ToolPin }>(road: R): string | undefined {
  return road.version ?? standingPin(road)?.tag;
}

/** The guest's home directory: every machine runs as root. */
export const GUEST_HOME = "/root";
/** Where uv and pipx link their commands on a machine wsp forked, which is their own default there. */
export const HOME_BIN = `${GUEST_HOME}/.local/bin`;
/** Where every pinned command lands, and every manager links its commands on a computer somebody owns: on every job's
 * PATH, a box's included, and read-only inside every workspace on a box. */
export const LOCAL_BIN = "/usr/local/bin";
/** The one line every apt run exports, so no prompt can wait on a machine nobody types at. */
export const APT_ENV = "export DEBIAN_FRONTEND=noninteractive";
/** Claude Code's config dir on the guest under the guest home, which the pack rewrites `.claude/` to. */
export const CLAUDE_CONFIG_REL = ".claude-cfg";
/** Claude Code's config dir on the guest, always CLAUDE_CONFIG_DIR and never HOME. */
export const CLAUDE_CONFIG_DIR = `${GUEST_HOME}/${CLAUDE_CONFIG_REL}`;
/** The file under Claude Code's config dir that the apiKeyHelper's key is placed in and the copied settings read. */
export const CLAUDE_KEY_FILE = "anthropic-api-key";

/** Claude Code by the vendor's own Linux binary at the version the owner's Mac runs, checksummed against the sums
 * that version's manifest publishes (https://downloads.claude.ai/claude-code-releases/2.1.280/manifest.json, the
 * glibc platform keys linux-x64 and linux-arm64, which are the sums the vendor's own installer checks). */
export const CLAUDE_CODE = {
  version: "2.1.280",
  sha256: {
    x86_64: "1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b",
    aarch64: "92f2b4fd05d0bdcf7b9a0d4e0ecef4a1e4b368b290cd8fd07cff9a50013f45a2",
  },
} as const;

const CLAUDE_DOWNLOADS = "https://downloads.claude.ai/claude-code-releases";

/** The address whose whole answer is the newest version the vendor publishes, which its own installer reads. */
export const CLAUDE_LATEST = `${CLAUDE_DOWNLOADS}/latest`;

/** The binary alone, since the vendor's installer reads the current version off the network, in the folder every
 * pinned command lands in: the home a box shares with its workspaces is off its job's PATH and each can write it. */
export const CLAUDE_INSTALL = [
  'arch="$(uname -m)"',
  'case "$arch" in',
  `  x86_64) plat=linux-x64 sha=${CLAUDE_CODE.sha256.x86_64} ;;`,
  `  aarch64) plat=linux-arm64 sha=${CLAUDE_CODE.sha256.aarch64} ;;`,
  '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "esac",
  // The trap stands ahead of the download so the file goes whichever way the script leaves, a refused sum included.
  "trap 'rm -f /tmp/claude' EXIT",
  `curl -o /tmp/claude "${CLAUDE_DOWNLOADS}/${CLAUDE_CODE.version}/$plat/claude"`,
  'echo "$sha  /tmp/claude" | sha256sum -c - >/dev/null',
  `install -D -m 0755 /tmp/claude ${LOCAL_BIN}/claude`,
].join("\n");

/** What the image build runs to put the harness on a first-life builder, recorded in the manifest as setupSha; the
 * smoke is what proves the result. An update runs it too, on an image that may hold the harness under the home,
 * first on TOOLS_PATH, so that file goes first: a builder's home is root's alone. */
export const GOLDEN_SETUP = [`rm -f ${HOME_BIN}/claude`, CLAUDE_INSTALL].join("\n");
export const GOLDEN_SMOKE = "claude --version";

/** uv by its release tarball, checksummed against the sums astral publishes
 * next to it (https://github.com/astral-sh/uv/releases). */
export const UV = {
  version: "0.12.9",
  sha256: {
    x86_64: "ec7a99cd05e0cd7f80243f135ce1361c76835cb0ee60055d14d20eba8eba1460",
    aarch64: "c36fe17937ff6bd16dc42fc13854b5465999fcab2efe0af559381e945e3c6001",
  },
} as const;

export const UV_INSTALL = [
  "if ! command -v uv >/dev/null 2>&1; then",
  '  arch="$(uname -m)"',
  '  case "$arch" in',
  `    x86_64) sha=${UV.sha256.x86_64} ;;`,
  `    aarch64) sha=${UV.sha256.aarch64} ;;`,
  '    *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "  esac",
  '  pkg="uv-$arch-unknown-linux-gnu.tar.gz"',
  `  curl -o "/tmp/$pkg" "https://github.com/astral-sh/uv/releases/download/${UV.version}/$pkg"`,
  '  echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
  '  tar -xzf "/tmp/$pkg" -C /tmp',
  '  install -m 0755 "/tmp/uv-$arch-unknown-linux-gnu/uv" /usr/local/bin/uv',
  '  install -m 0755 "/tmp/uv-$arch-unknown-linux-gnu/uvx" /usr/local/bin/uvx',
  '  rm -rf "/tmp/$pkg" "/tmp/uv-$arch-unknown-linux-gnu"',
  "fi",
].join("\n");

/** Node releases the guest may get, one per major, pinned to nodejs.org's
 * SHASUMS256.txt entries (https://nodejs.org/dist/); `eol` is the day the
 * release schedule ends maintenance (https://github.com/nodejs/Release). */
export const NODE_RELEASES = {
  20: {
    version: "20.20.2",
    sha256: { x86_64: "19e56f0825510207dd904f087fe52faa0a4eb6b2aab5f0ea7a33830d04888b8b", aarch64: "47ef73d543ecf6eb19435f6c03a0ac4809b3bf0dd6b26c7c571efc2a6572a74d" },
    eol: "2026-04-30",
  },
  22: {
    version: "22.23.2",
    sha256: { x86_64: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a", aarch64: "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30" },
    eol: "2027-04-30",
  },
} as const;

export type NodeMajor = keyof typeof NODE_RELEASES;

export interface NodeRelease {
  version: string;
  sha256: { x86_64: string; aarch64: string };
  eol: string;
}

/** Puts the Node the golden installed ahead of any the image shipped, so the
 * agents and their version checks run on it. */
export const NODE_PATH_LINE = 'export PATH="/usr/local/bin:$PATH"';

/** Installs the release into /usr/local when the guest's Node major is under
 * `floor`, and reports what it had and what it did on stdout. */
export function nodeInstallScript(floor: number, release: NodeRelease): string {
  const v = release.version;
  return [
    "node_have=\"$(node --version 2>/dev/null || echo v0)\"",
    "node_major=\"$(printf '%s' \"$node_have\" | sed 's/^v//; s/\\..*//')\"",
    'echo "NODE_HAVE $node_have"',
    `if [ "\${node_major:-0}" -ge ${floor} ]; then echo "NODE_KEPT $node_have"; exit 0; fi`,
    'arch="$(uname -m)"',
    'case "$arch" in',
    `  x86_64) pkg=node-v${v}-linux-x64.tar.gz sha=${release.sha256.x86_64} ;;`,
    `  aarch64) pkg=node-v${v}-linux-arm64.tar.gz sha=${release.sha256.aarch64} ;;`,
    '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
    "esac",
    `curl -o "/tmp/$pkg" "https://nodejs.org/dist/v${v}/$pkg"`,
    'echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
    'tar -xzf "/tmp/$pkg" -C /usr/local --strip-components=1',
    'rm -f "/tmp/$pkg"',
    // The install is only real once the node the agents will run is this one.
    NODE_PATH_LINE,
    `test "$(node --version)" = "v${v}"`,
    `echo "NODE_INSTALLED v${v}"`,
  ].join("\n");
}

/** Docker Compose by its release binary, checksummed against the sums Docker
 * publishes next to it (https://github.com/docker/compose/releases). */
export const COMPOSE = {
  version: "v5.5.1",
  sha256: {
    x86_64: "db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576",
    aarch64: "732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7",
  },
} as const;

/** Where the docker cli looks for its plugins system-wide, so `docker compose` finds the binary. */
export const COMPOSE_PLUGIN = "/usr/libexec/docker/cli-plugins/docker-compose";

/** The engine from the distro, compose from its release: Debian bookworm, the machines' base, packages
 * docker.io but no compose v2, so the plugin is fetched pinned and put where the cli reads it. */
export const DOCKER_INSTALL = [
  APT_ENV,
  "apt-get install -y -qq docker.io",
  'arch="$(uname -m)"',
  'case "$arch" in',
  `  x86_64) sha=${COMPOSE.sha256.x86_64} ;;`,
  `  aarch64) sha=${COMPOSE.sha256.aarch64} ;;`,
  '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "esac",
  `curl -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/${COMPOSE.version}/docker-compose-linux-$arch"`,
  'echo "$sha  /tmp/docker-compose" | sha256sum -c - >/dev/null',
  `install -D -m 0755 /tmp/docker-compose ${COMPOSE_PLUGIN}`,
  "rm -f /tmp/docker-compose",
].join("\n");

/** Python 3.12 as uv's managed interpreter: uv pins the python-build-standalone release and checks its sha256,
 * so the pin is uv's own; python3 on PATH is a link to that interpreter, ahead of whatever the image ships. */
export const PYTHON_INSTALL = [
  UV_INSTALL,
  "uv python install 3.12",
  'ln -sfn "$(uv python find --managed-python 3.12)" /usr/local/bin/python3',
].join("\n");

/** rustup by the installer rust-lang archives per release, checksummed against
 * the sha256 published beside it (https://static.rust-lang.org/rustup/archive). */
export const RUSTUP = {
  version: "1.29.1",
  sha256: {
    x86_64: "dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71",
    aarch64: "15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433",
  },
} as const;

/** The stable toolchain in rustup's default profile, which is cargo, rustc, the standard library, clippy, rustfmt and
 * the docs. Homebrew's rust bottle would link against llvm@22 instead, 2.5 GB of its 3.1 GB closure on Linux. The
 * installer leaves the shell files alone: the guest's PATH already carries the cargo bin directory. */
export const RUSTUP_INSTALL = [
  'arch="$(uname -m)"',
  'case "$arch" in',
  `  x86_64) sha=${RUSTUP.sha256.x86_64} ;;`,
  `  aarch64) sha=${RUSTUP.sha256.aarch64} ;;`,
  '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "esac",
  `curl -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP.version}/$arch-unknown-linux-gnu/rustup-init"`,
  'echo "$sha  /tmp/rustup-init" | sha256sum -c - >/dev/null',
  "chmod +x /tmp/rustup-init",
  "/tmp/rustup-init -y --no-modify-path --profile default --default-toolchain stable",
  "rm -f /tmp/rustup-init",
].join("\n");

/** Debian ships fd as fdfind to dodge a name clash; agents type fd, so the row links it onto PATH under that name. */
export const FD_INSTALL = [APT_ENV, "apt-get install -y -qq fd-find", "ln -sfn /usr/bin/fdfind /usr/local/bin/fd"].join("\n");

/** Yarn through the corepack Node 22 ships, at the exact version corepack's own `stable` alias named on 2026-09-22
 * (https://repo.yarnpkg.com/tags, aliases.stable), with the download prompt off: the alias moves under an image
 * build, a version does not. */
export const YARN_VERSION = "4.18.0";
export const YARN_INSTALL = ["corepack enable yarn", `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g yarn@${YARN_VERSION}`].join("\n");

export const HERMES = { tag: "v2026.8.31", commit: "29112bef099274229cadff79cdff7bf7b99c4b77" } as const;

/** https://hermes-agent.nousresearch.com/docs/developer-guide/contributing#manual-clone-fallback */
export const HERMES_INSTALL = [
  UV_INSTALL,
  "if [ ! -d /root/.hermes/hermes-agent/.git ]; then",
  `  git clone -q --depth 1 --branch ${HERMES.tag} https://github.com/NousResearch/hermes-agent.git /root/.hermes/hermes-agent`,
  "fi",
  `test "$(git -C /root/.hermes/hermes-agent rev-parse HEAD)" = "${HERMES.commit}"`,
  "uv venv --python 3.11 /root/.hermes/venvs/hermes",
  "uv pip install --python /root/.hermes/venvs/hermes/bin/python -e /root/.hermes/hermes-agent",
  "ln -sfn /root/.hermes/venvs/hermes/bin/hermes /usr/local/bin/hermes",
].join("\n");

/** Playwright's own Chromium build for the Playwright the web render tests import: the browser lives under
 * ~/.cache/ms-playwright keyed by that version's revision, so a project on another Playwright looks for another one. */
export const PLAYWRIGHT = { version: "1.62.1" } as const;

/** The global first, then Playwright's installer for its Chromium and the Debian packages the browser needs; that
 * installer reads the apt index itself. */
export const PLAYWRIGHT_INSTALL = [APT_ENV, `npm install -g playwright@${PLAYWRIGHT.version}`, "playwright install --with-deps chromium"].join("\n");

/** Swift by swift.org's Debian 12 toolchain tarball; swift.org signs it and publishes no sum, so the sums are the
 * tarballs' own as read on 2026-09-07 (https://www.swift.org/install/linux/debian/12/). */
export const SWIFT = {
  version: "6.3.3",
  sha256: {
    x86_64: "19e0c78cad5418ad48bfa87aa20c53ac9ac9996d1695d04dd94f7c7ea4eb133f",
    aarch64: "ecba8ef87b54a5048d466af500f3169c939a6b8a2cb7c600f76b5184457f293a",
  },
} as const;

const SWIFT_HOME = "/opt/swift";

/** The packages swift.org's own Debian 12 image installs ahead of the toolchain
 * (https://github.com/swiftlang/swift-docker/blob/main/6.3/debian/12/Dockerfile). The toolchain unpacks under its
 * own prefix, since it ships a clang and an lld of its own that would shadow the LLVM row's under /usr/bin. */
export const SWIFT_INSTALL = [
  APT_ENV,
  "apt-get install -y -qq binutils libicu-dev libcurl4-openssl-dev libedit-dev libsqlite3-dev libncurses-dev libpython3-dev libxml2-dev pkg-config uuid-dev tzdata git gcc libstdc++-12-dev",
  'arch="$(uname -m)"',
  'case "$arch" in',
  `  x86_64) dir=debian12 sha=${SWIFT.sha256.x86_64} ;;`,
  `  aarch64) dir=debian12-aarch64 sha=${SWIFT.sha256.aarch64} ;;`,
  '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "esac",
  `pkg="swift-${SWIFT.version}-RELEASE-$dir.tar.gz"`,
  `curl -o "/tmp/$pkg" "https://download.swift.org/swift-${SWIFT.version}-release/$dir/swift-${SWIFT.version}-RELEASE/$pkg"`,
  'echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
  `rm -rf ${SWIFT_HOME} && mkdir -p ${SWIFT_HOME}`,
  `tar -xzf "/tmp/$pkg" -C ${SWIFT_HOME} --strip-components=1`,
  'rm -f "/tmp/$pkg"',
  `chmod -R o+r ${SWIFT_HOME}/usr/lib/swift`,
  `ln -sfn ${SWIFT_HOME}/usr/bin/swift /usr/local/bin/swift`,
  `ln -sfn ${SWIFT_HOME}/usr/bin/swiftc /usr/local/bin/swiftc`,
].join("\n");

/** 1Password's apt signing key as published on 2026-09-07 (https://downloads.1password.com/linux/keys/1password.asc);
 * a rotated key fails the install instead of being trusted unread. */
const ONE_PASSWORD_KEY_SHA256 = "f39e7dd9dedc581ced85732832f217e0de5860a3b80279b5af4bc7c6d8157bae";

const ONE_PASSWORD_KEYRING = "/usr/share/keyrings/1password-archive-keyring.asc";
const ONE_PASSWORD_LIST = "/etc/apt/sources.list.d/1password.list";

/** 1Password publishes the CLI only through its own apt repository (https://developer.1password.com/docs/cli/get-started/),
 * so the road adds the repository under its key and reads that one index before the install. */
export const OP_INSTALL = [
  APT_ENV,
  `curl -o ${ONE_PASSWORD_KEYRING} https://downloads.1password.com/linux/keys/1password.asc`,
  `echo "${ONE_PASSWORD_KEY_SHA256}  ${ONE_PASSWORD_KEYRING}" | sha256sum -c - >/dev/null`,
  'arch="$(dpkg --print-architecture)"',
  `echo "deb [arch=$arch signed-by=${ONE_PASSWORD_KEYRING}] https://downloads.1password.com/linux/debian/$arch stable main" > ${ONE_PASSWORD_LIST}`,
  `apt-get update -qq -o Dir::Etc::sourcelist=${ONE_PASSWORD_LIST} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0`,
  "apt-get install -y -qq 1password-cli",
].join("\n");
