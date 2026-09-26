// SPDX-License-Identifier: AGPL-3.0-only
// This computer's side of the image: the export a person keeps, sealed to a
// passphrase they type and written here. The vault's bytes reach this file and
// nowhere else on this computer; the passphrase is used once and kept nowhere.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { passphraseCipher } from "@wsp/engine";
import type { SealedImageExport } from "@wsp/protocol";
import type { ImageExporter } from "@wsp/runtime";

/** The destination an export names, absolute; something already standing there is refused, as a project export
 * refuses one, since neither ever writes over a person's file. */
export function exportDestination(dest: string): string {
  const path = resolve(dest);
  if (existsSync(path)) throw Object.assign(new Error(`${path} already exists on this computer; name a file that does not`), { kind: "exists" });
  return path;
}

/** The export lander the host wires into the runtime: the vault and the record sealed to the passphrase, one file,
 * readable by this person alone. */
export const imageExporter: ImageExporter = async ({ image, tar, dest, passphrase }): Promise<SealedImageExport> => {
  const path = exportDestination(dest);
  const sealed = passphraseCipher.seal(tar, image, passphrase);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sealed, { mode: 0o600 });
  return { path, bytes: sealed.length, hash: createHash("sha256").update(sealed).digest("hex") };
};
