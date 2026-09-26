// SPDX-License-Identifier: AGPL-3.0-only
// One writer for everything under the owner's state folder. A token, a pairing
// code, a device record or a login file is this user's alone, so every one of
// them is written through a 0600 temporary file and a rename under folders that
// stand at 0700, and a folder an older build left wider is repaired rather than
// trusted. Node fs and nothing else, in a package of its own with no
// dependencies, because the host record and the host lock are written by the
// tool server's own graph, which may not load the runtime.
import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** What a folder of the owner's stands at, and what a file of the owner's is written with. */
export const OWN_DIR_MODE = 0o700;
export const OWN_FILE_MODE = 0o600;

/** A folder of the owner's: made when it is not there, and repaired when it stands at anything else, since a
 * folder an older build made at the umask's word is the one another login on this computer reads through. */
export function ownFolder(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: OWN_DIR_MODE });
  if ((statSync(dir).mode & 0o777) !== OWN_DIR_MODE) chmodSync(dir, OWN_DIR_MODE);
}

/** One file of the owner's, written under `root` at `rel`. The folder handed in and every folder between it and
 * the file are made or repaired to 0700; nothing above `root` is touched, so a state file under a person's own
 * home never chmods that home. The bytes land through a 0600 temporary file and a rename, so a file that stood at
 * 0644 is replaced rather than rewritten and its old mode goes with it. Synchronous, as every caller is. */
export function writeOwn(root: string, rel: string, bytes: string | Uint8Array): void {
  const target = join(root, rel);
  ownFolder(root);
  let at = root;
  for (const part of relative(root, dirname(target)).split(sep)) {
    if (part === "") continue;
    at = join(at, part);
    ownFolder(at);
  }
  const tmp = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, bytes, { mode: OWN_FILE_MODE });
  // writeFileSync's mode is the umask's to narrow.
  chmodSync(tmp, OWN_FILE_MODE);
  renameSync(tmp, target);
}
