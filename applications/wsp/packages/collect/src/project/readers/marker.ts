// SPDX-License-Identifier: AGPL-3.0-only
// The manifests whose presence is the whole signal: a lockfile, a module file,
// a compose file. One rule reads them all and the table is what grows.
import type { ProjectFinding, ProjectReader } from "../reader.js";

/** A file that asks for a tool by being there, and that tool under the name its own ecosystem uses. */
const MARKERS: Readonly<Record<string, { name: string; label: string }>> = {
  "pnpm-lock.yaml": { name: "pnpm", label: "pnpm" },
  "yarn.lock": { name: "yarn", label: "Yarn" },
  "bun.lock": { name: "bun", label: "Bun" },
  "bun.lockb": { name: "bun", label: "Bun" },
  "package-lock.json": { name: "npm", label: "npm" },
  "pyproject.toml": { name: "python", label: "Python" },
  "uv.lock": { name: "uv", label: "uv" },
  "requirements.txt": { name: "python", label: "Python" },
  ".tool-versions": { name: "mise", label: "mise" },
  "mise.toml": { name: "mise", label: "mise" },
  ".mise.toml": { name: "mise", label: "mise" },
  "go.mod": { name: "go", label: "Go" },
  "Cargo.toml": { name: "rust", label: "Rust" },
  Gemfile: { name: "ruby", label: "Ruby" },
  "composer.json": { name: "php", label: "PHP" },
  Dockerfile: { name: "docker", label: "Docker" },
  "compose.yaml": { name: "docker", label: "Docker" },
  "compose.yml": { name: "docker", label: "Docker" },
  "docker-compose.yaml": { name: "docker", label: "Docker" },
  "docker-compose.yml": { name: "docker", label: "Docker" },
};

export const markerReader: ProjectReader = {
  id: "marker",
  files: Object.keys(MARKERS),
  reads: "presence",
  read(file): readonly ProjectFinding[] {
    const marker = MARKERS[file.path];
    return marker === undefined ? [] : [{ ...marker, why: `${file.path} needs ${marker.label}` }];
  },
};
