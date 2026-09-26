// SPDX-License-Identifier: AGPL-3.0-only
// The daemon content gate can only be met on the tree that lands. Its sha is
// cut on main right before the squash, one landing at a time, so a branch
// that changes the daemon cannot carry the line while it is a branch, and a
// gate that fails there says nothing about the branch while hiding a real
// failure behind an expected one.

/**
 * Whether the daemon content gate fails here rather than printing the sha it would ask for. On main in ci, and in
 * the landing gate, which runs on this computer with no ci variable of its own; not on a pull request, where
 * GITHUB_REF names the merge ref, nor on a ticket branch.
 */
export function contentGateEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.GITHUB_ACTIONS) return true;
  return env.GITHUB_REF === "refs/heads/main";
}
