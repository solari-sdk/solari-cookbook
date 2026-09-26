// SPDX-License-Identifier: AGPL-3.0-only
import { shellQuote } from "@wsp/protocol";
import { APT_ENV } from "@wsp/catalog";
import { CHEZMOI, DOTFILES_PRESETS, PRELUDE, pinnedBinaryInstall } from "./dotfiles-presets.js";
import type { Machine } from "./machine.js";

export type DotfilesManager = "chezmoi" | "yadm" | "stow" | "plain";

/** One entry of the cloned repo's listing, path relative to the repo root,
 * at most two segments deep (enough for .config/yadm and stow packages). */
export interface RepoEntry {
  path: string;
  kind: "file" | "dir";
}

export interface DotfilesStep {
  name: string;
  exitCode: number;
}

export interface DotfilesResult {
  manager: DotfilesManager;
  steps: DotfilesStep[];
}

export interface ApplyDotfilesOptions {
  presets?: string[];
  timeoutMs?: number;
}

const GITHUB_USERNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37})?$/;

// Clones are anonymous https only: wsp never holds a git credential, so ssh
// remotes, credentialed URLs, and private repos are all out of scope for v1.
export function resolveDotfilesSource(source: string): string {
  if (GITHUB_USERNAME.test(source)) return `https://github.com/${source}/dotfiles`;
  if (source.startsWith("git@") || source.startsWith("ssh://")) {
    throw new Error(
      `dotfiles source must be an https URL: ssh remotes need a credential and wsp never holds one (got ${JSON.stringify(source)})`,
    );
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(
      `dotfiles source must be an https git URL or a bare GitHub username, got ${JSON.stringify(source)}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("dotfiles URL carries a credential: the clone is anonymous https and wsp never holds a git credential");
  }
  if (url.protocol !== "https:") {
    throw new Error(`dotfiles source must use https, got ${url.protocol}// (credentialed transports are unsupported)`);
  }
  return source;
}

const PLUMBING = new Set([".git", ".github", ".gitignore", ".gitattributes", ".gitmodules"]);

/** Top-level dirs whose every child is a dotfile: the stow packages. */
export function stowPackages(listing: RepoEntry[]): string[] {
  return listing
    .filter(e => e.kind === "dir" && !e.path.includes("/") && !e.path.startsWith("."))
    .filter(dir => {
      const children = listing.filter(c => c.path.startsWith(`${dir.path}/`));
      return children.length > 0 && children.every(c => c.path.slice(dir.path.length + 1).startsWith("."));
    })
    .map(dir => dir.path);
}

export function detectManager(listing: RepoEntry[]): DotfilesManager {
  const top = listing.filter(e => !e.path.includes("/"));
  if (top.some(e => e.path.startsWith(".chezmoi"))) return "chezmoi";
  if (top.some(e => e.path === "bootstrap") || listing.some(e => e.path === ".config/yadm")) return "yadm";
  const topDotfiles = top.filter(e => e.path.startsWith(".") && !PLUMBING.has(e.path));
  if (topDotfiles.length === 0 && stowPackages(listing).length > 0) return "stow";
  return "plain";
}

export function parseListing(stdout: string): RepoEntry[] {
  return stdout
    .split("\n")
    .filter(line => line.length > 2)
    .map(line => ({ path: line.slice(2), kind: line.startsWith("d") ? ("dir" as const) : ("file" as const) }));
}

const CLONE_DIR = `"$HOME/.dotfiles"`;

export function cloneScript(url: string): string {
  return `${PRELUDE}
export GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq git; }
rm -rf ${CLONE_DIR}
git clone --depth 1 ${shellQuote(url)} ${CLONE_DIR}
`;
}

// GNU find only (guests are Debian-family); %P is the path minus the root.
export const LIST_SCRIPT = `${PRELUDE}
cd ${CLONE_DIR}
find . -mindepth 1 -maxdepth 2 -name .git -prune -o -type d -printf 'd %P\\n' -o -printf 'f %P\\n'
`;

// chezmoi and yadm re-clone from the URL themselves so origin stays correct
// for later pulls; stow and plain consume the detection clone in ~/.dotfiles.
export function applyScript(manager: DotfilesManager, url: string, listing: RepoEntry[] = []): string {
  switch (manager) {
    case "chezmoi":
      return `${PRELUDE}
export GIT_TERMINAL_PROMPT=0
${pinnedBinaryInstall(CHEZMOI)}
chezmoi init --apply ${shellQuote(url)}
`;
    case "yadm":
      return `${PRELUDE}
export GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive
command -v yadm >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq yadm; }
yadm clone --no-bootstrap ${shellQuote(url)}
if [ -x "$HOME/.config/yadm/bootstrap" ]; then yadm bootstrap
elif [ -x "$HOME/bootstrap" ]; then "$HOME/bootstrap"
fi
`;
    case "stow":
      return `${PRELUDE}
${APT_ENV}
command -v stow >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq stow; }
cd ${CLONE_DIR}
stow --verbose --target "$HOME" ${stowPackages(listing).map(shellQuote).join(" ")}
`;
    case "plain":
      return `${PRELUDE}
cd ${CLONE_DIR}
for f in install.sh setup.sh bootstrap.sh; do
  if [ -f "$f" ]; then bash "$f"; exit 0; fi
done
backup="$HOME/.dotfiles-backup/$(date +%Y%m%d%H%M%S)"
for f in .*; do
  case "$f" in .|..|.git|.github|.gitignore|.gitattributes|.gitmodules) continue ;; esac
  if [ -e "$HOME/$f" ] || [ -L "$HOME/$f" ]; then
    mkdir -p "$backup"
    mv "$HOME/$f" "$backup/$f"
  fi
  ln -s "$HOME/.dotfiles/$f" "$HOME/$f"
done
`;
  }
}

const PRIVATE_HINTS = /repository .* not found|authentication failed|could not read username|terminal prompts disabled|invalid username or (password|token)/i;

export async function applyDotfiles(
  machine: Machine,
  source: string,
  opts: ApplyDotfilesOptions = {},
): Promise<DotfilesResult> {
  const url = resolveDotfilesSource(source);
  const presets = opts.presets ?? [];
  for (const p of presets) {
    if (!(p in DOTFILES_PRESETS)) {
      throw new Error(`unknown preset ${JSON.stringify(p)}: available ${Object.keys(DOTFILES_PRESETS).join(", ")}`);
    }
  }

  const steps: DotfilesStep[] = [];
  const run = async (name: string, script: string) => {
    const res = await machine.run(script, { deadlineMs: opts.timeoutMs ?? 300_000 });
    steps.push({ name, exitCode: res.exitCode });
    if (res.exitCode !== 0) {
      const hint =
        (name === "clone" || name === "apply") && PRIVATE_HINTS.test(res.stderr)
          ? " (private repos are not supported in v1: wsp clones anonymously over https)"
          : "";
      throw new Error(`dotfiles ${name} failed (exit ${res.exitCode})${hint}: ${res.stderr.slice(-500)}`);
    }
    return res;
  };

  await run("clone", cloneScript(url));
  const listing = await run("list", LIST_SCRIPT);
  const entries = parseListing(listing.stdout);
  const manager = detectManager(entries);
  await run("apply", applyScript(manager, url, entries));
  for (const p of presets) await run(`preset:${p}`, DOTFILES_PRESETS[p as keyof typeof DOTFILES_PRESETS]);
  return { manager, steps };
}
