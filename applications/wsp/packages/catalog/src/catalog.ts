// SPDX-License-Identifier: AGPL-3.0-only
// The catalog: every agent wsp ships and every tool agents reach for, one
// entry each, with the road it takes onto a Linux machine, its sign-in and
// status check, the global config that carries over, how it keys project
// state to a path, and whether it is on by default with the evidence behind
// that. The wizard's tables read from here; nothing here runs a command.
import { agentOfRow, packageOf, thisComputer, toolRowPrefix, type PageReach } from "@wsp/protocol";
import { AGENT_MODULES } from "./agents/index.js";
import type { AgentContext } from "./context.js";
import type { HookCarry } from "./hooks.js";
import { GCLOUD, KUBECTL } from "./linux-casks.js";
import type { McpConfig } from "./mcp.js";
import { loginRoad, type ServerSignInRoad } from "./mcp-login.js";
import { pinnedRelease } from "./release-pins.js";
import type { PluginSkills, SkillRoots } from "./skills.js";
import { APT_BIN, APT_INDEX, CARGO_BIN, roadModule } from "./road-modules.js";
import type { RoadName } from "./roads.js";
import { DOCKER_INSTALL, FD_INSTALL, LOCAL_BIN, NODE_RELEASES, OP_INSTALL, PLAYWRIGHT, PLAYWRIGHT_INSTALL, PYTHON_INSTALL, RUSTUP_INSTALL, SWIFT, SWIFT_INSTALL, UV_INSTALL, YARN_INSTALL, nodeInstallScript, type InstallRoad } from "./roads.js";
import { NO_SIGN_IN, SIGN_IN_ROWS, hasLogin, keysIdOf, keysRowOf, loginIdOf, mintsToken, sharedLoginOf, type KeyFiles, type SharedLogin, type SignIn } from "./signin.js";

export type EntryKind = "agent" | "tool";

/** Where a default comes from: sessions with a tool call on the machine the histories were mined from (155 of them,
 * one Mac, 2026-09-05; the rows added on 2026-09-07 count the same Mac's 153; an agent's row counts the sessions it
 * ran), the count of the five published lab sandbox images that ship the tool, and whether a guest has run the
 * entry's road. */
export interface Evidence {
  sessions: number;
  images: number;
  /** Unmeasured until a golden build on a guest has installed the entry by this road and its smoke passed. */
  road: "measured" | "unmeasured";
  note?: string;
}

/** One store of an agent's project state and how it is keyed to the project's absolute path; `move` is what a
 * project move has to do to it. Measured by moving a scratch project on 2026-09-05, or inferred from a file. */
export interface ProjectState {
  state: string;
  location: string;
  key: string;
  pathFields: readonly string[];
  move: string;
  status: "measured" | "inferred";
}

interface EntryBase {
  id: string;
  name: string;
  kind: EntryKind;
  /** The command the install puts on PATH. */
  bin: string;
  installRoad: InstallRoad;
  /** Agents: the lowest Node major the package's engines field accepts; absent when it declares none. */
  node?: number;
  signIn: SignIn;
  /** Global config that travels with the entry; an allowlist, since login files sit beside it. */
  configPaths: readonly string[];
  /** Config the entry rewrites while it runs: it travels, and never decides whether a golden is the same golden. */
  volatile?: readonly string[];
  source: Evidence;
  size: Size;
}

/** The session store formats a reader exists for; the collector registers one reader per format. */
export const HISTORY_FORMATS = ["claude-jsonl", "codex-rollout", "hermes-sqlite"] as const;
export type HistoryFormat = (typeof HISTORY_FORMATS)[number];

/** Where an agent keeps its session histories on the computer and in which format: transcripts under a directory
 * or one database file. Only tool names and command words are ever read from them, never a line's content. */
export interface SessionHistory {
  format: HistoryFormat;
  /** `~/`-relative. */
  root: string;
}

/** Who an agent is, as its detail says it: read off each project's own repository, README and npm entry. */
export interface AgentAbout {
  creator: string;
  /** One or two sentences. */
  description: string;
  homepage?: string;
  /** Absent where the source is not public. */
  repo?: string;
  /** An SPDX id, or "proprietary". */
  license: string;
}

/** The agent's published mark, drawn inline wherever the agent is named and never fetched. A shape with no fill of its
 * own takes the first ink, or the ink of whatever it sits in where there is none; a shape filled `var(--ink-N)` takes
 * ink N; a shape with its own colour keeps it. */
export interface AgentMark {
  svg: string;
  /** The brand's colours on each theme's ground, each at least 3:1 against the tile it sits in. */
  inks?: readonly { light: string; dark: string }[];
  /** Where the paths were taken from, at a commit, a release or an etag. */
  source: string;
  /** The source's license as an SPDX id; the mark itself stays its owner's trademark. */
  license: string;
}

/** Where an agent's vendor publishes its newest version, which this host asks and no machine does: its npm package's
 * latest tag, its GitHub repository's latest release, or an address whose whole answer is the version. */
export type LatestSource = { from: "npm"; package: string } | { from: "github"; repo: string } | { from: "text"; url: string };

/** An agent is never on by the catalog's own default: a recipe ticks one only from this computer's use of it. */
export interface AgentEntry extends EntryBase {
  kind: "agent";
  about: AgentAbout;
  /** Absent for an agent no one has found a published mark for; it is drawn as its initials. */
  mark?: AgentMark;
  /** Absent where the vendor's versions are not in the form the agent's own version flag prints, so the two are
   * never compared, and the catalog's pin is not set beside what stands either. */
  latest?: LatestSource;
  /** The directory the projectState rows sit under, relative to the home directory of the computer the agent ran on. */
  stateHome: string;
  /** Where that directory is on the guest when it is not stateHome under the guest's home, absolute. */
  guestStateHome?: string;
  /** The variable that points the agent at guestStateHome; a golden with the agent carries it in its envs. */
  stateHomeEnv?: string;
  /** The variable that pins which folder under the state home this agent keeps a project's memory and sessions in,
   * whatever the working directory; the runtime exports it as the project's key on every launch, so one project's
   * memory follows it across the computers it sits on. Absent, the agent keys on the path alone. */
  projectKeyEnv?: string;
  /** Every store that holds the project's path. */
  projectState: readonly ProjectState[];
  /** Absent while the agent's session format has no reader: its history reads as none. */
  history?: SessionHistory;
  /** Where the agent on this computer keeps its user-wide MCP servers and how one is named there, per its own docs;
   * absent when the catalog knows no such file for it, and wsp's server is then added by hand. */
  mcp?: McpConfig;
  /** How the agent loads the machine context on the guest; absent, it gets no hook and no skill there. */
  context?: AgentContext;
  /** How the agent's settings name the hook scripts it runs, so a copy carries each script or takes the hook out;
   * absent when the catalog knows no hooks for it, and its settings copy as they are. */
  hooks?: HookCarry;
  /** The folders the agent loads skills from, its own first. Measured on 2026-09-24 against the version each entry
   * names beside them, off the folders the harness reads and what it wrote there. */
  skillRoots: SkillRoots;
  /** Skills its plugins bring, read-only; absent where the agent has no plugins. */
  pluginSkills?: PluginSkills;
  /** The files in a project this agent reads standing instructions from, project-relative; the MCP install keeps its
   * own marked section in each of them. */
  projectDocs: readonly string[];
  /** The first thing to type inside the agent once it has the wsp tools, in its own words: a slash form where the
   * agent has one for a skill, else the sentence that reaches the skill by its description. */
  firstMove: string;
}

export interface ToolEntry extends EntryBase {
  kind: "tool";
  defaultOn: boolean;
  /** On every golden from the base stage, whatever the Mac has; the floor runs these in catalog order. */
  floor: boolean;
  /** What a script road runs on top of: a floor row by id, or the apt index; the npm and apt roads say it themselves. */
  after?: string;
  /** Commands that come along with this row and have a version of their own. */
  brings?: readonly { bin: string; version: string }[];
  /** Package names a recipe's tools row may carry for this same tool, besides its id, its command and its road's argument. */
  covers?: readonly string[];
  /** Registry packages a project's manifest may depend on that mean this row, per the road the project installs
   * them by: the row puts on the machine what the package needs and its own install does not bring (a browser). A
   * client library named like a server's tools is not listed, so a dependency ticks nothing else. */
  depends?: Partial<Record<RoadName, readonly string[]>>;
  /** The major the floor pins, with the tool's plain name: a Mac on another major hears both in the covered row's note. */
  major?: { name: string; version: string };
}

export type CatalogEntry = AgentEntry | ToolEntry;

/** The ways a row's bytes were read, one entry each; a row names the one that measured it. Every method reads the
 * amd64 install, the arch the machines run. */
export const SIZE_METHODS = {
  df: "df before and after the install on a Linux machine, caches included",
  apt: "apt Installed-Size summed over the packages the install adds to debian:bookworm",
  brew: "installed_size on the x86_64_linux bottle manifests of the formula and its runtime dependencies",
  du: "du over what the install wrote, before and after, on a Debian bookworm host",
  unpacked: "the Linux x86_64 download, unpacked where it is an archive",
} as const;
export type SizeMethod = keyof typeof SIZE_METHODS;

/** What a row puts on the machine: the bytes with the day and the method that read them, or why nobody could. */
export type Size = { bytes: number; on: string; method: SizeMethod } | { unmeasured: string };

/** The bytes a size carries, or nothing for a row nobody measured. */
export function sizeBytes(s: Size): number | undefined {
  return "bytes" in s ? s.bytes : undefined;
}

const MEASURED_ON = "2026-09-07";
const measured = (method: SizeMethod, bytes: number, on: string = MEASURED_ON): Size => ({ bytes, on, method });
const brew = (formula: string, bytes: number): { installRoad: InstallRoad; size: Size } => ({ installRoad: { road: "brew", formula }, size: measured("brew", bytes) });
const apt = (bytes: number, ...packages: string[]): { installRoad: InstallRoad; size: Size } => ({ installRoad: { road: "apt", packages }, size: measured("apt", bytes) });
const npm = (bytes: number, pkg: string, version?: string): { installRoad: InstallRoad; size: Size } => ({ installRoad: { road: "npm", package: pkg, ...(version !== undefined ? { version } : {}) }, size: measured("du", bytes) });
const uvTool = (bytes: number, pkg: string): { installRoad: InstallRoad; size: Size } => ({ installRoad: { road: "uv", package: pkg }, size: measured("du", bytes) });
/** A release road at its pinned tag and assets; the bytes are the binary's. */
const github = (bytes: number, repo: string, go?: string): { installRoad: InstallRoad; size: Size } => ({ installRoad: pinnedRelease(repo, go), size: measured("unpacked", bytes) });
const tool = { kind: "tool", configPaths: [], floor: false } as const;

export const CATALOG: readonly CatalogEntry[] = [
  ...AGENT_MODULES,

  // --- tools on by default: both sources agree or one is overwhelming --------------------------------------------
  // The floor rows first, in the order the base stage installs them: a row waits only on rows above it.
  // curl leads because every road below that fetches a release types it, and a base image need not ship one: a
  // bare ubuntu container has no curl, where a provider's VM image does (measured on ubuntu:24.04, 2026-09-11).
  { ...tool, id: "curl", name: "curl", bin: "curl", ...apt(15748096, "curl"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 87, images: 4, road: "unmeasured" } },
  // Node is 208 MB and nothing on a fork needs it: the wsp an agent runs there is the daemon's own binary. Both rows
  // stay on by default, which decides only a computer that says nothing about them; what a computer ran is weighed
  // against the used floor either way, and the npm road brings node where a ticked row walks one. pnpm goes with it:
  // its road is npm, so a floor row for it would drag node back onto every image.
  { ...tool, id: "node", name: "Node 22 with npm", bin: "node", installRoad: { road: "script", script: nodeInstallScript(22, NODE_RELEASES[22]), bins: [LOCAL_BIN] }, floor: false, after: "curl", covers: ["node@22", "nodejs"], major: { name: "Node", version: "22" }, brings: [{ bin: "npm", version: "npm --version" }], signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 73, images: 5, road: "measured" }, size: measured("unpacked", 208449536) },
  { ...tool, id: "pnpm", name: "pnpm", bin: "pnpm", ...npm(20357120, "pnpm", "11.9.0"), floor: false, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 36, images: 3, road: "unmeasured" } },
  { ...tool, id: "uv", name: "uv", bin: "uv", installRoad: { road: "script", script: UV_INSTALL, bins: [LOCAL_BIN] }, floor: true, after: "curl", signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 46, images: 3, road: "unmeasured" }, size: measured("unpacked", 49660896) },
  { ...tool, id: "python", name: "Python 3.12", bin: "python3", installRoad: { road: "script", script: PYTHON_INSTALL, bins: [LOCAL_BIN] }, floor: true, after: "uv", covers: ["python@3.12"], major: { name: "Python", version: "3.12" }, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 107, images: 4, road: "unmeasured" }, size: measured("du", 108105728) },
  { ...tool, id: "git", name: "git", bin: "git", ...apt(123789312, "git"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 118, images: 5, road: "unmeasured" } },
  { ...tool, id: "jq", name: "jq", bin: "jq", ...apt(1170432, "jq"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 17, images: 5, road: "unmeasured" } },
  { ...tool, id: "ripgrep", name: "ripgrep", bin: "rg", ...apt(4666368, "ripgrep"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 10, images: 4, road: "unmeasured" } },
  { ...tool, id: "build-essential", name: "C toolchain with cmake and ninja", bin: "cc", ...apt(491381760, "build-essential", "cmake", "ninja-build"), floor: true, covers: ["gcc", "g++", "make"], brings: [{ bin: "cmake", version: "cmake --version" }, { bin: "ninja", version: "ninja --version" }], signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 15, images: 4, road: "unmeasured" } },
  { ...tool, id: "fd", name: "fd", bin: "fd", installRoad: { road: "script", script: FD_INSTALL, bins: [LOCAL_BIN] }, floor: true, after: APT_INDEX, covers: ["fd-find", "fdfind"], signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 0, images: 1, road: "unmeasured" }, size: measured("apt", 3024896) },
  { ...tool, id: "sqlite3", name: "sqlite3", bin: "sqlite3", ...apt(2845696, "sqlite3"), floor: true, covers: ["sqlite"], signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 5, images: 1, road: "unmeasured" } },
  { ...tool, id: "wget", name: "wget", bin: "wget", ...apt(12990464, "wget"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "zip", name: "zip and unzip", bin: "zip", ...apt(1019904, "zip", "unzip"), floor: true, brings: [{ bin: "unzip", version: "unzip -v" }], signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 7, images: 0, road: "unmeasured" } },
  { ...tool, id: "xz", name: "xz", bin: "xz", ...apt(1255424, "xz-utils"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "rsync", name: "rsync", bin: "rsync", ...apt(7237632, "rsync"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 2, images: 0, road: "unmeasured" } },
  // gh has no pinned release yet and agent-browser waits on a second data point: default-on through the tools stage.
  { ...tool, id: "gh", name: "GitHub CLI", bin: "gh", ...github(42188962, "cli/cli", "github.com/cli/cli/v2/cmd/gh"), signIn: SIGN_IN_ROWS.gh, defaultOn: true, source: { sessions: 100, images: 3, road: "unmeasured" } },
  { ...tool, id: "agent-browser", name: "agent-browser", bin: "agent-browser", ...npm(81702912, "agent-browser", "0.31.1"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 45, images: 0, road: "unmeasured", note: "sessions counted on one Mac only; on by default for this user until a second data point" } },

  // --- tools on request ---------------------------------------------------------------------------------------------
  // Half a gigabyte on every image that ticks it, and a guest whose kernel has no overlayfs cannot start it at all,
  // so it is a row a person asks for rather than one the floor puts on every image.
  { ...tool, id: "docker", name: "Docker engine and compose", bin: "docker", installRoad: { road: "script", script: DOCKER_INSTALL, bins: [APT_BIN] }, after: APT_INDEX, covers: ["docker-compose"], brings: [{ bin: "docker compose", version: "docker compose version" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 30, images: 3, road: "unmeasured" }, size: measured("df", 541765632) },
  { ...tool, id: "go", name: "Go", bin: "go", ...brew("go", 250752891), covers: ["golang"], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 9, images: 4, road: "measured" } },
  { ...tool, id: "rust", name: "Rust with cargo", bin: "cargo", installRoad: { road: "script", script: RUSTUP_INSTALL, bins: [CARGO_BIN] }, covers: ["rustup", "rustup-init"], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 4, images: 3, road: "unmeasured" }, size: measured("du", 1595346944) },
  { ...tool, id: "java", name: "Java 21", bin: "java", ...brew("openjdk@21", 613280230), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "measured" } },
  { ...tool, id: "maven", name: "Maven", bin: "mvn", ...brew("maven", 677043395), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "unmeasured" } },
  { ...tool, id: "gradle", name: "Gradle", bin: "gradle", ...brew("gradle", 885977407), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "measured" } },
  { ...tool, id: "bun", name: "Bun", bin: "bun", ...npm(79572992, "bun"), brings: [{ bin: "bunx", version: "bunx --version" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 5, images: 3, road: "unmeasured" } },
  { ...tool, id: "yarn", name: "Yarn", bin: "yarn", installRoad: { road: "script", script: YARN_INSTALL, bins: [LOCAL_BIN] }, after: "node", signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "unmeasured" }, size: measured("du", 3813376) },
  { ...tool, id: "ruff", name: "ruff", bin: "ruff", ...uvTool(24584192, "ruff"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 3, images: 3, road: "unmeasured" } },
  { ...tool, id: "black", name: "black", bin: "black", ...uvTool(8527872, "black"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "mypy", name: "mypy", bin: "mypy", ...uvTool(59564032, "mypy"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 1, images: 3, road: "unmeasured" } },
  { ...tool, id: "pyright", name: "pyright", bin: "pyright", ...uvTool(40140800, "pyright"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "pytest", name: "pytest", bin: "pytest", ...uvTool(7266304, "pytest"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 1, images: 3, road: "unmeasured" } },
  { ...tool, id: "prettier", name: "Prettier", bin: "prettier", ...npm(10113024, "prettier"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "eslint", name: "ESLint", bin: "eslint", ...npm(15249408, "eslint"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 1, images: 3, road: "unmeasured" } },
  { ...tool, id: "typescript", name: "TypeScript", bin: "tsc", ...npm(32022528, "typescript"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 8, images: 0, road: "unmeasured" } },
  { ...tool, id: "wrangler", name: "Cloudflare Wrangler", bin: "wrangler", ...npm(251080704, "wrangler"), covers: ["cloudflare-wrangler"], signIn: SIGN_IN_ROWS.wrangler, defaultOn: false, source: { sessions: 3, images: 0, road: "unmeasured" } },
  { ...tool, id: "cloudflared", name: "cloudflared", bin: "cloudflared", ...github(42455400, "cloudflare/cloudflared", "github.com/cloudflare/cloudflared/cmd/cloudflared"), signIn: SIGN_IN_ROWS.cloudflared, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "gcloud", name: "Google Cloud CLI", bin: "gcloud", installRoad: { road: "vendor", cask: GCLOUD, version: GCLOUD.version }, signIn: SIGN_IN_ROWS.gcloud, defaultOn: false, source: { sessions: 4, images: 0, road: "measured" }, size: measured("unpacked", 475987968) },
  { ...tool, id: "kubectl", name: "kubectl", bin: "kubectl", installRoad: { road: "vendor", cask: KUBECTL, version: KUBECTL.version }, covers: ["kubernetes-cli"], signIn: SIGN_IN_ROWS.kubectl, defaultOn: false, source: { sessions: 1, images: 1, road: "unmeasured" }, size: measured("unpacked", 61886626) },
  { ...tool, id: "aws", name: "AWS CLI", bin: "aws", ...brew("awscli", 319703017), signIn: SIGN_IN_ROWS.aws, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "vercel", name: "Vercel CLI", bin: "vercel", ...npm(338280448, "vercel"), signIn: SIGN_IN_ROWS.vercel, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "netlify", name: "Netlify CLI", bin: "netlify", ...npm(377982976, "netlify-cli"), signIn: SIGN_IN_ROWS.netlify, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "fly", name: "flyctl", bin: "fly", ...github(113168894, "superfly/flyctl", "github.com/superfly/flyctl"), signIn: SIGN_IN_ROWS.fly, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "supabase", name: "Supabase CLI", bin: "supabase", ...github(96900296, "supabase/cli"), signIn: SIGN_IN_ROWS.supabase, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "railway", name: "Railway CLI", bin: "railway", ...npm(28459008, "@railway/cli"), signIn: SIGN_IN_ROWS.railway, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "doppler", name: "Doppler CLI", bin: "doppler", ...github(12550328, "DopplerHQ/cli", "github.com/DopplerHQ/cli"), signIn: SIGN_IN_ROWS.doppler, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  // 1Password's package carries no Installed-Size, so the size is its one file, /usr/bin/op, unpacked from the deb.
  { ...tool, id: "op", name: "1Password CLI", bin: "op", installRoad: { road: "script", script: OP_INSTALL }, covers: ["1password-cli"], signIn: SIGN_IN_ROWS.op, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" }, size: measured("unpacked", 42950840) },
  { ...tool, id: "ffmpeg", name: "ffmpeg", bin: "ffmpeg", ...apt(512696320, "ffmpeg"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "yq", name: "yq", bin: "yq", ...github(14180512, "mikefarah/yq", "github.com/mikefarah/yq/v4"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "git-lfs", name: "Git LFS", bin: "git-lfs", ...apt(11213824, "git-lfs"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 2, road: "unmeasured" } },
  { ...tool, id: "tmux", name: "tmux", bin: "tmux", ...apt(1492992, "tmux"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "ruby", name: "Ruby 3.1 with bundler", bin: "ruby", ...apt(67206144, "ruby", "ruby-dev", "ruby-bundler"), covers: ["bundler"], brings: [{ bin: "bundle", version: "bundle --version" }, { bin: "gem", version: "gem --version" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "php", name: "PHP 8.2 with Composer", bin: "php", ...apt(33120256, "php-cli", "composer", "php-mbstring", "php-xml", "php-curl", "php-zip"), brings: [{ bin: "composer", version: "composer --version" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "postgresql-client", name: "PostgreSQL client", bin: "psql", ...apt(9606144, "postgresql-client"), covers: ["postgresql"], brings: [{ bin: "pg_dump", version: "pg_dump --version" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 1, road: "unmeasured" } },
  { ...tool, id: "redis-tools", name: "Redis tools", bin: "redis-cli", ...apt(6909952, "redis-tools"), covers: ["redis"], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 3, images: 1, road: "unmeasured" } },
  { ...tool, id: "golangci-lint", name: "golangci-lint", bin: "golangci-lint", ...github(41300128, "golangci/golangci-lint", "github.com/golangci/golangci-lint/v2/cmd/golangci-lint"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 2, images: 2, road: "unmeasured" } },
  { ...tool, id: "mise", name: "mise", bin: "mise", ...github(119660224, "jdx/mise"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 1, road: "unmeasured" } },
  { ...tool, id: "git-delta", name: "git-delta", bin: "delta", ...github(7151152, "dandavison/delta"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "shellcheck", name: "ShellCheck", bin: "shellcheck", ...apt(19442688, "shellcheck"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 4, images: 0, road: "unmeasured" } },
  { ...tool, id: "swift", name: "Swift 6.3", bin: "swift", installRoad: { road: "script", script: SWIFT_INSTALL, version: SWIFT.version }, after: APT_INDEX, brings: [{ bin: "swiftc", version: "swiftc --version" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 1, road: "unmeasured" }, size: measured("du", 3562135552) },
  { ...tool, id: "elixir", name: "Elixir 1.14 with Erlang", bin: "elixir", ...apt(33395712, "elixir"), covers: ["erlang"], brings: [{ bin: "mix", version: "mix --version" }, { bin: "erl", version: "erl +V" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 1, road: "unmeasured" } },
  // The first bazel --version fetches Bazel itself into ~/.cache/bazelisk; the du counts bazelisk and that Bazel.
  { ...tool, id: "bazel", name: "Bazel via bazelisk", bin: "bazel", ...github(72921088, "bazelbuild/bazelisk", "github.com/bazelbuild/bazelisk"), covers: ["bazelisk"], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 1, road: "unmeasured" }, size: measured("du", 72921088) },
  { ...tool, id: "llvm", name: "clang, clang-format, clang-tidy", bin: "clang", ...apt(750848000, "clang", "clang-format", "clang-tidy"), covers: ["llvm"], brings: [{ bin: "clang-format", version: "clang-format --version" }, { bin: "clang-tidy", version: "clang-tidy --version" }], signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 2, road: "unmeasured" } },
  // The du counts the global, Chromium with its headless shell and ffmpeg under ~/.cache/ms-playwright, and the browser's Debian packages.
  { ...tool, id: "playwright", name: "Chromium for Playwright", bin: "playwright", installRoad: { road: "script", script: PLAYWRIGHT_INSTALL, version: PLAYWRIGHT.version }, after: "node", covers: ["chromium"], depends: { npm: ["playwright", "@playwright/test", "playwright-core"] }, signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" }, size: measured("du", 1015808000) },
];

/** Directories that bind to the path they were built at, taken out of a copy of a project folder so they are
 * rebuilt where the copy now sits. One row per ecosystem, and the one home of the list: the copy verb is handed
 * these names and the seed menu labels the same ones "rebuilt on the box". */
export const PATH_BOUND_DIRS: readonly { ecosystem: string; dirs: readonly string[] }[] = [
  { ecosystem: "python", dirs: [".venv"] },
  { ecosystem: "next", dirs: [".next"] },
  { ecosystem: "turbo", dirs: [".turbo"] },
  { ecosystem: "node", dirs: [".cache", "node_modules/.cache"] },
];

/** Every path-bound directory, in the order the rows list them: what one copy is asked to take out. */
export const PATH_BOUND_DIR_NAMES: readonly string[] = PATH_BOUND_DIRS.flatMap(row => row.dirs);

export const CATALOG_AGENTS: readonly AgentEntry[] = CATALOG.filter((e): e is AgentEntry => e.kind === "agent");

const firstAgent = CATALOG_AGENTS[0];
if (firstAgent === undefined) throw new Error("the catalog has no agent");
/** The agent a thread runs when none is named and the composer's first pick: the catalog's first agent. */
export const DEFAULT_AGENT: AgentEntry = firstAgent;
export const CATALOG_TOOLS: readonly ToolEntry[] = CATALOG.filter((e): e is ToolEntry => e.kind === "tool");

/** The envs a golden carries for an agent on it: the variable that points it at its state home on the guest. */
export function guestEnv(a: AgentEntry): Record<string, string> {
  return a.stateHomeEnv !== undefined && a.guestStateHome !== undefined ? { [a.stateHomeEnv]: a.guestStateHome } : {};
}

/** An agent entry whose MCP config the catalog knows. */
export type McpAgent = AgentEntry & { mcp: McpConfig };
/** The agents whose config the catalog knows how to read a server from and place one in, in catalog order. */
export const MCP_AGENTS: readonly McpAgent[] = CATALOG_AGENTS.filter((a): a is McpAgent => a.mcp !== undefined);
/** Those agents' ids as one line, for the usage, the help and the refusal that all name the same set. */
export const MCP_AGENT_IDS: string = MCP_AGENTS.map(a => a.id).join(", ");
/** Whether an agent keeps a switch per server that wsp turns: its format module has one. */
export const mcpSwitch = (id: string): boolean => MCP_AGENTS.find(a => a.id === id)?.mcp.format.enable !== undefined;

/** How one server in that agent's config is signed in where it stands, off the agent's own module; nothing for an
 * agent with none. */
export function serverSignInRoad(agentId: string, name: string, reach: PageReach): ServerSignInRoad | undefined {
  const login = MCP_AGENTS.find(a => a.id === agentId)?.mcp.login;
  return login === undefined ? undefined : loginRoad(login, name, reach);
}

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(CATALOG.map(e => [e.id, e]));

/** What every golden gets in its base stage, whatever the Mac has: the entries flagged for the floor, in catalog order. */
export const BASE_FLOOR: readonly ToolEntry[] = CATALOG.filter((e): e is ToolEntry => e.kind === "tool" && e.floor);

/** The floor row an entry's install runs on top of: what its road says (the npm road on node, an apt package on the
 * index read once), else what the entry names (a script on `after`). */
export function installAfter(e: ToolEntry): string | undefined {
  return roadModule(e.installRoad).after ?? e.after;
}

const roadNames = (road: InstallRoad): readonly string[] => roadModule(road).names(road);

/** The catalog tool that installs this package by this road (a formula by brew, a global by npm), or nothing. */
export function catalogToolByRoad(road: RoadName, pkg: string): ToolEntry | undefined {
  return CATALOG_TOOLS.find(e => e.installRoad.road === road && roadNames(e.installRoad).includes(pkg));
}

/** Every tools row's id starts with the rung and a manager: `tools/<manager>/<package>`. */
const TOOLS_PREFIX = toolRowPrefix("").slice(0, -1);

/** The id a recipe row is known by on every computer: an agents row its agent, a tools row the catalog tool its
 * package names, when the catalog carries it; nothing for an MCP server's row, a tools row outside the catalog and
 * every other rung. The one rule the record's pins, the recipe file and the collector's rows are keyed by. */
export function catalogIdOfRow(e: { id: string }): string | undefined {
  const agent = agentOfRow(e);
  if (agent !== undefined) return agent;
  return e.id.startsWith(TOOLS_PREFIX) ? catalogToolFor(packageOf(e))?.id : undefined;
}

/** The catalog tool a project's dependency stands for, by the road the project installs it by: only a row that names
 * the package as meaning it, never a command or a cover word; or nothing. */
export function catalogToolForDependency(road: RoadName, pkg: string): ToolEntry | undefined {
  return CATALOG_TOOLS.find(e => (e.depends?.[road] ?? []).includes(pkg));
}

/** The catalog tool a package name the collector wrote stands for: by id, by the command it puts on PATH, by its
 * road's own name for it, by a name it covers, or by a command it brings along; or nothing. */
export function catalogToolFor(pkg: string): ToolEntry | undefined {
  return CATALOG_TOOLS.find(e => e.id === pkg || e.bin === pkg || roadNames(e.installRoad).includes(pkg) || (e.covers ?? []).includes(pkg) || (e.brings ?? []).some(b => b.bin === pkg));
}

/** The base row a recipe's tools row stands for, or nothing when the tool is not on the floor. */
export function baseEntryFor(pkg: string): ToolEntry | undefined {
  const e = catalogToolFor(pkg);
  return e?.floor === true ? e : undefined;
}

/** What a ticked row the floor covers says in the build: the base row's name, or both majors when the computer the
 * collector read differs from the one the floor pins (as many dot-separated parts of that version as the pin names).
 * The computer is named by the platform that was read, never by the one this code was written for: an image built
 * from a Linux computer says so. */
export function baseNote(e: ToolEntry, hereVersion: string | undefined, platform: "darwin" | "linux"): string {
  const own = `${e.name} is part of the base`;
  if (e.major === undefined || hereVersion === undefined) return own;
  const here = hereVersion.replace(/^v/, "").split(".").slice(0, e.major.version.split(".").length).join(".");
  return here === e.major.version ? own : `${e.major.name} ${e.major.version} is part of the base; ${thisComputer(platform)} runs ${e.major.name} ${here}`;
}

/** The entry by its id, or nothing. */
export function catalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/** An entry as the catalog names it; an id the catalog does not know reads as itself. */
export function agentName(id: string): string {
  return catalogEntry(id)?.name ?? id;
}

/** The agents with no mark: Crush's only published mark is under FSL-1.1, which does not come into this repo, and no
 * MIT or CC0 icon set carries it. */
export const UNMARKED_AGENTS: readonly string[] = ["crush"];

/** An agent's mark by its id; nothing for an id that is not an agent or has no mark. */
export function agentMark(id: string): AgentMark | undefined {
  const e = catalogEntry(id);
  return e?.kind === "agent" ? e.mark : undefined;
}

/** One row the Sign-ins screen can show, under the login id the collector files it: an entry's own sign-in (a
 * login to run, or a note about having none), or the keys row beside a login whose key files travel only by copy. */
export interface LoginRow {
  id: string;
  entry: CatalogEntry;
  signIn: SignIn;
  /** The key files this row copies; absent on the login itself. */
  keys?: KeyFiles;
}

export const LOGIN_ROWS: readonly LoginRow[] = CATALOG.flatMap((e): LoginRow[] => {
  const s = e.signIn;
  if (!hasLogin(s)) return mintsToken(s) || s.note !== undefined ? [{ id: loginIdOf(e.id), entry: e, signIn: s }] : [];
  return [{ id: loginIdOf(e.id), entry: e, signIn: s }, ...(s.keys === undefined ? [] : [{ id: keysIdOf(e.id), entry: e, signIn: keysRowOf(s.keys, s.status), keys: s.keys }])];
});

const LOGIN_ROW_BY_ID: ReadonlyMap<string, LoginRow> = new Map(LOGIN_ROWS.map(r => [r.id, r]));

/** The sign-in row filed under a login id, or nothing for a tool the catalog does not know. */
export function loginRow(id: string): LoginRow | undefined {
  return LOGIN_ROW_BY_ID.get(id);
}

/** The rung a manifest files a login row under. */
const LOGINS_RUNG = "logins/";

/** The sign-in a manifest's login row stands for, by the row's id or by the bare name at its end, which is the
 * login id the collector files it under and never an entry id. The one reader of that rule, so a row read in the
 * pack, in the vault step and in the job cannot come to mean three things. */
export function loginSignIn(row: string): SignIn | undefined {
  const name = row.startsWith(LOGINS_RUNG) ? row.slice(LOGINS_RUNG.length) : row;
  return name.includes("/") ? undefined : loginRow(name)?.signIn;
}

/** What an agent's login shares from the computer that runs the workspaces, or nothing: an agent whose login lives
 * there declares it, and that declaration is the only thing that makes a sign-in on that computer exist. */
export function sharedOn(agent: string): SharedLogin | undefined {
  const row = loginSignIn(agent);
  return row === undefined ? undefined : sharedLoginOf(row);
}

/** Which of the agents a computer reported sign in there once rather than in the image, in the order it named them. */
export function sharedAgentsOn(agents: readonly string[]): string[] {
  return agents.filter(id => sharedOn(id) !== undefined);
}

/** Exits 0 once an entry is on the machine. */
export function smokeOf(e: CatalogEntry): string {
  return `${e.bin} --version`;
}

/** How an entry installs, for its detail: the one line a person pastes, or the road's words where no one line does
 * it (a vendor's script of many lines, a release checked against its sum). */
export function installShown(e: CatalogEntry): { line: string } | { words: string } {
  const mod = roadModule(e.installRoad);
  const shown = mod.shown?.(e.installRoad, e.bin);
  if (shown !== undefined && mod.pastes === false) return { words: shown };
  const line = shown ?? installLine(e);
  return line.includes("\n") ? { words: mod.words } : { line };
}

/** The bash line an entry's road runs on the guest, from the road's module; an entry whose road has nothing to run is a
 * catalog error, since every entry promises its command. */
export function installLine(e: CatalogEntry): string {
  const line = roadModule(e.installRoad).install(e.installRoad, e.bin);
  if (typeof line !== "string") throw new Error(`${e.id}: ${line.note}`);
  return line;
}
