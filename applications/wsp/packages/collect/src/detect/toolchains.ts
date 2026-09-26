// SPDX-License-Identifier: AGPL-3.0-only
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { entry, exists, firstLine, found } from "./common.js";

interface Manager {
  id: string;
  label: (host: Host) => Promise<string>;
  /** Installed when the binary is on PATH or one of the markers exists. */
  bin?: string;
  markers?: string[];
  /** The pins that travel; the installs never do. */
  pins: string[];
}

const plain = (s: string) => async () => s;

const MANAGERS: readonly Manager[] = [
  { id: "mise", label: plain("mise pins"), bin: "mise", markers: ["~/.config/mise/config.toml"], pins: ["~/.config/mise/config.toml", "~/.tool-versions"] },
  { id: "asdf", label: plain("asdf pins"), bin: "asdf", markers: ["~/.asdf"], pins: ["~/.tool-versions", "~/.asdfrc"] },
  {
    id: "fnm", bin: "fnm", pins: ["~/.node-version", "~/.nvmrc"],
    label: async host => {
      const v = firstLine(await host.exec.run("fnm", ["current"]));
      return v === undefined ? "fnm" : `fnm (node ${v})`;
    },
  },
  {
    id: "nvm", markers: ["~/.nvm"], pins: ["~/.nvmrc"],
    label: async host => {
      const alias = firstLine(await host.fs.readText(`${host.home}/.nvm/alias/default`));
      return alias === undefined ? "nvm" : `nvm (default ${alias})`;
    },
  },
  { id: "pyenv", label: plain("pyenv (global python)"), bin: "pyenv", markers: ["~/.pyenv"], pins: ["~/.pyenv/version"] },
  { id: "uv", label: plain("uv (python versions)"), bin: "uv", pins: ["~/.config/uv/uv.toml", "~/.python-version"] },
  { id: "rustup", label: plain("rustup default toolchain"), markers: ["~/.rustup/settings.toml"], pins: ["~/.rustup/settings.toml", "~/.cargo/config.toml"] },
  {
    id: "go", bin: "go", pins: ["~/.config/go/env"],
    label: async host => {
      const m = /go(\d+(?:\.\d+)*)/.exec(firstLine(await host.exec.run("go", ["version"])) ?? "");
      return m === null ? "go" : `go ${m[1]}`;
    },
  },
];

export async function detectToolchains(host: Host): Promise<ManifestEntry[]> {
  const rows: ManifestEntry[] = [];
  for (const m of MANAGERS) {
    let hit = m.bin !== undefined && (await host.exec.which(m.bin));
    for (const marker of m.markers ?? []) hit = hit || (await exists(host, marker));
    if (!hit) continue;
    rows.push(entry({ rung: "toolchains", id: `toolchains/${m.id}`, label: await m.label(host), ...(await found(host, m.pins)) }));
  }
  return rows;
}
