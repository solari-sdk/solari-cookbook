// SPDX-License-Identifier: AGPL-3.0-only
import { APT_ENV, CURL_NET } from "@wsp/catalog";

// Guest exec is bash -c with no HOME in the environment (measured live on
// Solari sandboxes); under set -u the first "$HOME" would abort the script.
export const PRELUDE = `set -euo pipefail
export HOME="\${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"`;

export interface PinnedBinary {
  name: string;
  version: string;
  urlBase: string;
  assets: { x86_64: { file: string; sha256: string }; aarch64: { file: string; sha256: string } };
}

// Release binaries are pinned and checksum-verified; curl|sh installers are
// banned, here and on every catalog road, because they execute unpinned
// remote code as root.
export function pinnedBinaryInstall(bin: PinnedBinary): string {
  return `${CURL_NET}
if ! command -v ${bin.name} >/dev/null 2>&1; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64) pkg=${bin.assets.x86_64.file} sha=${bin.assets.x86_64.sha256} ;;
    aarch64) pkg=${bin.assets.aarch64.file} sha=${bin.assets.aarch64.sha256} ;;
    *) echo "unsupported arch: $arch" >&2; exit 1 ;;
  esac
  curl -o "/tmp/$pkg" "${bin.urlBase}/$pkg"
  echo "$sha  /tmp/$pkg" | sha256sum -c -
  tar -xzf "/tmp/$pkg" -C /tmp ${bin.name}
  install -m 0755 /tmp/${bin.name} /usr/local/bin/${bin.name}
  rm -f "/tmp/$pkg" /tmp/${bin.name}
fi`;
}

export const CHEZMOI: PinnedBinary = {
  name: "chezmoi",
  version: "2.72.1",
  urlBase: "https://github.com/twpayne/chezmoi/releases/download/v2.72.1",
  assets: {
    x86_64: {
      file: "chezmoi_2.72.1_linux_amd64.tar.gz",
      sha256: "9f97d32caca166e5c92160ec3a9325519809c38963121cef38173142065c981f",
    },
    aarch64: {
      file: "chezmoi_2.72.1_linux_arm64.tar.gz",
      sha256: "75508ef41216b6d64f3145986b751729d7f92d09c6bad77d51cf2895ab35a508",
    },
  },
};

const STARSHIP: PinnedBinary = {
  name: "starship",
  version: "1.26.0",
  urlBase: "https://github.com/starship/starship/releases/download/v1.26.0",
  assets: {
    x86_64: {
      file: "starship-x86_64-unknown-linux-musl.tar.gz",
      sha256: "b7c232b0e8249d8e55a40beb79c5c43a7d370f3f9408bd215deb0170daeaadf3",
    },
    aarch64: {
      file: "starship-aarch64-unknown-linux-musl.tar.gz",
      sha256: "dc30189378d2f2e287384e8a692d3f95ad1df64cf0e8c36aa9201516028aed6b",
    },
  },
};

export const APT = (pkg: string, cmd = pkg): string =>
  `command -v ${cmd} >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq ${pkg}; }`;

export const DOTFILES_PRESETS = {
  zsh: `${PRELUDE}
${APT_ENV}
${APT("zsh")}
${pinnedBinaryInstall(STARSHIP)}
grep -qs 'starship init zsh' "$HOME/.zshrc" || printf '\\neval "$(starship init zsh)"\\n' >> "$HOME/.zshrc"
if command -v chsh >/dev/null 2>&1; then chsh -s "$(command -v zsh)" "$(id -un)" || true; fi
`,
  neovim: `${PRELUDE}
${APT_ENV}
${APT("neovim", "nvim")}
`,
  tmux: `${PRELUDE}
${APT_ENV}
${APT("tmux")}
`,
} as const;

export type DotfilesPreset = keyof typeof DOTFILES_PRESETS;
