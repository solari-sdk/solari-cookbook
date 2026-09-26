// SPDX-License-Identifier: AGPL-3.0-only
// One row per ecosystem for the files a folder seeds a project with: which of
// the paths git ignores travel as configuration, which the computer rebuilds,
// which hold a database, which never leave this computer and which are the
// operating system's own noise. The install each ecosystem runs fresh on the
// computer sits on the same row, keyed by the lockfile at the project root.
// Adding a language is adding a row here; nothing outside this file names a
// file pattern, so no road can tick a path one way and pack it another.

/** How a row's pattern matches a path git ignores, relative to the project folder: a pattern with no slash matches
 * the last segment anywhere under it; a pattern with a slash matches the path's tail at a segment boundary; a
 * trailing slash matches a directory only; `*` matches within one segment and never across a slash. */
export type SeedPattern = string;

/** What a matched path is to a seed: `config` travels and starts ticked, `rebuilt` is what the computer makes
 * again, `data` is a database nothing may copy under a running service, `never` is a login that does not leave
 * this computer whatever anybody ticks, and `junk` is metadata no menu shows. */
export type SeedKind = "config" | "rebuilt" | "data" | "never" | "junk";

export interface SeedInstall {
  /** The lockfile at the project root that picks this install. */
  lockfile: string;
  /** The command, run in the project folder on the computer that holds it. */
  run: string;
  /** Where this install keeps its own shared store, and the flag that points it there, for a road that hard links
   * out of that store into the project. A store outside the checkout's own btrfs subvolume cannot link into it
   * (EXDEV) and silently copies every file instead, so the store sits inside the checkout, a plain directory and
   * never a subvolume of its own, which a snapshot of the checkout would not carry. `dir` is relative to the
   * project folder. Absent where the road links nothing out of a store. */
  store?: { flag: string; dir: string };
}

export interface SeedRow {
  /** The ecosystem: node, next, python, rails, rust, go, vercel, terraform, android, certificates, agents, logins,
   * databases, finder. */
  id: string;
  name: string;
  /** Patterns by kind; a path is judged by the first row whose pattern matches it, rows in the order below. */
  patterns: Partial<Record<SeedKind, readonly SeedPattern[]>>;
  /** Paths this row's own patterns would match and that it does not claim, read before them. */
  except?: readonly SeedPattern[];
  /** Folders the collapsed ignore listing is opened for, so a config file inside one gets its own row. */
  opens?: readonly string[];
  /** One example path per kind the row names, which the catalog's own test asserts this row and this kind judge. */
  examples: Partial<Record<SeedKind, readonly string[]>>;
  /** How this ecosystem's dependencies are installed fresh on the computer, first lockfile found wins; absent,
   * this ecosystem has nothing to install. */
  installs?: readonly SeedInstall[];
}

/** The rows, in the order a path is judged by: the logins first, so a credential is never read as another row's
 * configuration, then the operating system's noise, then the ecosystems. */
export const SEED_ROWS: readonly SeedRow[] = [
  {
    id: "logins",
    name: "logins",
    // A tool's own login: it is signed in once per computer (the image carries the sign-in), so a copy of one
    // here would be a second place the person's credential lives for nothing.
    patterns: { never: [".credentials.json", "auth.json", ".git-credentials", ".netrc", "hosts.yml", ".aws/credentials"] },
    examples: { never: [".credentials.json", ".config/gh/hosts.yml", ".aws/credentials"] },
  },
  {
    id: "finder",
    name: "Finder metadata",
    patterns: { junk: [".DS_Store", "Thumbs.db"] },
    examples: { junk: [".DS_Store", "components/.DS_Store"] },
  },
  {
    id: "next",
    name: "Next",
    patterns: { config: [".env*.local"], rebuilt: [".next/", "next-env.d.ts"] },
    examples: { config: [".env.local", ".env.development.local"], rebuilt: [".next", "next-env.d.ts"] },
  },
  {
    id: "node",
    name: "Node",
    patterns: {
      config: [".env", ".env.*", ".npmrc"],
      rebuilt: ["node_modules/", ".pnpm-store/", ".cache/", ".turbo/", "dist/", "build/", "out/", "coverage/", "*.tsbuildinfo"],
    },
    // A sample env file is committed and carries nothing; where a repo ignores one it is no row's, so the menu
    // shows it unticked as a path the catalog does not carry.
    except: [".env.example", ".env.sample"],
    examples: { config: [".env", ".env.production", "apps/web/.npmrc"], rebuilt: ["node_modules", "packages/host/dist", "tsconfig.tsbuildinfo"] },
    installs: [
      { lockfile: "package-lock.json", run: "npm ci" },
      { lockfile: "pnpm-lock.yaml", run: "pnpm install --frozen-lockfile", store: { flag: "--store-dir", dir: ".pnpm-store" } },
      { lockfile: "yarn.lock", run: "yarn install --frozen-lockfile" },
      // The text lockfile bun writes since 1.2, before the binary one: a repo carrying both is one bun wrote today.
      { lockfile: "bun.lock", run: "bun install --frozen-lockfile" },
      { lockfile: "bun.lockb", run: "bun install --frozen-lockfile" },
    ],
  },
  {
    id: "python",
    name: "Python",
    patterns: {
      config: [".envrc", ".pypirc", "local_settings.py"],
      rebuilt: [".venv/", "venv/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "*.egg-info/"],
      data: ["db.sqlite3"],
    },
    examples: { config: [".envrc", "app/local_settings.py"], rebuilt: [".venv", "app/__pycache__", "wsp.egg-info"], data: ["db.sqlite3"] },
    installs: [
      { lockfile: "uv.lock", run: "uv sync --frozen" },
      { lockfile: "poetry.lock", run: "poetry install" },
    ],
  },
  {
    id: "rails",
    name: "Rails",
    patterns: { config: ["config/master.key", "config/credentials/*.key"], rebuilt: ["tmp/", "log/"] },
    examples: { config: ["config/master.key", "config/credentials/production.key"], rebuilt: ["tmp", "log"] },
  },
  {
    id: "rust",
    name: "Rust",
    patterns: { rebuilt: ["target/"] },
    examples: { rebuilt: ["target", "daemon/target"] },
    installs: [{ lockfile: "Cargo.lock", run: "cargo fetch --locked" }],
  },
  {
    id: "go",
    name: "Go",
    patterns: {},
    examples: {},
    installs: [{ lockfile: "go.sum", run: "go mod download" }],
  },
  {
    id: "vercel",
    name: "Vercel",
    patterns: { config: [".vercel/"] },
    examples: { config: [".vercel"] },
  },
  {
    id: "terraform",
    name: "Terraform",
    patterns: { config: ["*.tfvars", "*.auto.tfvars"], rebuilt: [".terraform/"] },
    examples: { config: ["prod.tfvars", "infra/stage.auto.tfvars"], rebuilt: [".terraform"] },
  },
  {
    id: "android",
    name: "Android",
    patterns: { config: ["local.properties", "*.keystore", "*.jks"], rebuilt: [".gradle/"] },
    examples: { config: ["local.properties", "app/release.keystore"], rebuilt: [".gradle"] },
  },
  {
    id: "certificates",
    name: "certificates",
    patterns: { config: ["*.pem", "*.key", "*.crt", "*.p12"] },
    examples: { config: ["certs/local.pem", "certs/local.crt"] },
  },
  {
    id: "agents",
    name: "agents",
    patterns: { config: [".claude/settings.local.json", "CLAUDE.local.md"], rebuilt: [".claude/.cc-writes/"] },
    opens: [".claude/"],
    examples: { config: [".claude/settings.local.json", "CLAUDE.local.md"], rebuilt: [".claude/.cc-writes"] },
  },
  {
    id: "databases",
    name: "databases",
    patterns: { data: ["*.sqlite", "*.sqlite3", "*.db", "*.duckdb", "pgdata/", "postgres-data/", "mongo-data/", "redis-data/"] },
    examples: { data: ["dev.db", "var/app.sqlite3", "pgdata"] },
  },
];

/** Every kind a row may name, in the order the rows are read for it: a login is looked for before anything else,
 * so a path that is both a credential and another row's configuration is a credential. */
const KINDS: readonly SeedKind[] = ["never", "junk", "config", "rebuilt", "data"];

/** Whether one pattern matches one path, both relative to the project folder. A pattern with a trailing slash asks
 * for a directory; one with no slash in it matches any segment of the path's tail; one with slashes matches the
 * tail at a segment boundary. `*` stops at a slash, as a shell's own glob does inside one segment. */
function matches(pattern: SeedPattern, path: string, dir: boolean): boolean {
  const wantsDir = pattern.endsWith("/");
  if (wantsDir && !dir) return false;
  const want = wantsDir ? pattern.slice(0, -1) : pattern;
  const segment = (text: string): RegExp => new RegExp(`^${text.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  const parts = path.split("/");
  if (!want.includes("/")) return parts.some(part => segment(want).test(part));
  const tail = want.split("/");
  if (tail.length > parts.length) return false;
  return tail.every((piece, i) => segment(piece).test(parts[parts.length - tail.length + i]!));
}

/** The row and kind for one ignored path, or nothing for a path no row names, which a menu shows unticked as one
 * the catalog does not carry. The kinds are read in KINDS order and the rows in catalog order inside each, so a
 * login is never taken for configuration and a path two ecosystems name belongs to the first of them. */
export function seedRowFor(path: string, dir: boolean): { row: SeedRow; kind: SeedKind } | undefined {
  const at = path.replace(/^\.\//, "").replace(/\/+$/, "");
  for (const kind of KINDS) {
    for (const row of SEED_ROWS) {
      if ((row.except ?? []).some(pattern => matches(pattern, at, dir))) continue;
      if ((row.patterns[kind] ?? []).some(pattern => matches(pattern, at, dir))) return { row, kind };
    }
  }
  return undefined;
}

/** The installs the project folder's own root names, in catalog order, one per ecosystem: the first lockfile a row
 * lists that is there wins for that row, so a repo carrying both an npm and a pnpm lockfile installs once. Empty
 * when no row's lockfile is at the root, which is a project with nothing to install. */
export function seedInstallsFor(rootNames: readonly string[]): readonly { row: SeedRow; install: SeedInstall }[] {
  const found: { row: SeedRow; install: SeedInstall }[] = [];
  for (const row of SEED_ROWS) {
    const install = (row.installs ?? []).find(i => rootNames.includes(i.lockfile));
    if (install !== undefined) found.push({ row, install });
  }
  return found;
}
