// SPDX-License-Identifier: AGPL-3.0-only
// The repository a folder on this computer sits in: the nearest folder up the
// tree holding a .git entry, a folder or a worktree's file alike. What a
// thread opened with no workspace named is matched to a project by.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function gitRootOf(folder: string): string | undefined {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
}
