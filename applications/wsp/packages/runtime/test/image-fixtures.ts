// SPDX-License-Identifier: AGPL-3.0-only
// What the image tests seal from and build copies with: one recipe with a
// vault, the small recipe it stands on, the exec answers a builder needs from a
// stub, and the hash of the empty archive the stub serves as every vault.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { GoldenImport } from "@wsp/engine";
import type { Recipe, RecipeDigest } from "@wsp/protocol";
import type { GoldenRecipe } from "../src/runtime.js";

/** The paths such a seal archives: a login's file and the secrets file the secrets step writes. */
export const VAULT_PATHS = ["/root/.codex/auth.json", "/etc/profile.d/wsp-secrets.sh"];

/** The exec answers a builder needs: a disk reading, the ready check, the context probe, and the vault paths it
 * holds. The seal's guard probe asks about the paths no image may hold, and a builder that answered it with one
 * would be refused, so only the probe naming the vault's own is answered. */
export const dfOk = (m: unknown, cmd: string) =>
  cmd.startsWith("df -Pk")
    ? { exitCode: 0, stdout: `${3000 * 1024}\n`, stderr: "" }
    : cmd === "echo ok"
      ? { exitCode: 0, stdout: "ok\n", stderr: "" }
      : cmd.includes("echo WSP_CTX")
        ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" }
        : cmd.startsWith("for p in ") && cmd.includes(VAULT_PATHS[1]!)
          ? { exitCode: 0, stdout: `${VAULT_PATHS[1]!}\n`, stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };

export const digestOf = (recipeHash: string): RecipeDigest => ({ ticks: [{ id: "agents/codex" }], files: [{ id: "agents/codex", dest: ".codexrc", path: "~/.codexrc", digest: `d-${recipeHash}` }] });
export const importOf = (recipeHash = "h1"): GoldenImport => ({
  recipeHash,
  recipe: digestOf(recipeHash),
  files: { count: 1, rungs: { shell: 1 }, bytes: 10, lands: [], skipped: [], pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [], cut: [], silenced: [], macPaths: [] }) },
  tools: [],
  agents: [],
});
export const SMALL: Recipe = { version: 1, at: "2026-09-12T00:00:00.000Z", histories: [], rows: [{ id: "codex", kind: "agent", on: true, source: { kind: "used", sessions: 3, calls: 12 } }] };
export const recipeWith = (o: { recipeHash?: string; vault?: boolean } = {}): GoldenRecipe => ({
  setup: "true",
  smoke: "true",
  import: importOf(o.recipeHash ?? "h1"),
  source: SMALL,
  ...(o.vault === false ? {} : { vaultPaths: VAULT_PATHS }),
});

/** The recipe a host composes off the record for a copy: no vault paths, since the copy is given the record's. */
export const COPY_RECIPE: GoldenRecipe = { setup: "true", smoke: "true", import: importOf("h1"), source: SMALL };

/** What the stub's guest tar comes down as: the empty archive its download server serves for any path. */
export const EMPTY_TGZ_SHA = createHash("sha256").update(gzipSync(Buffer.alloc(1024))).digest("hex");
