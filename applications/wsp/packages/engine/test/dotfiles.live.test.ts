// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, describe, expect, it } from "vitest";
import { applyDotfiles } from "../src/dotfiles.js";
import { SolariBackend } from "../src/solari-backend.js";
import { isReserved, LIVE, liveEnv } from "./live.js";

const TEST_LABEL = { wsp: "1", "wsp-test": "dotfiles-live" };

// Small (~52KB), stable, plain-shaped: top-level dotfiles, no installer, so
// this exercises the symlink + backup path end to end.
const REPO = "https://github.com/geerlingguy/dotfiles";

describe.runIf(LIVE)("dotfiles apply (live)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === TEST_LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  it("symlinks a plain repo into $HOME, backs up collisions, runs a preset", { timeout: 420_000 }, async () => {
    const machine = await backend.create({ kind: "sandbox", template: "base", cpu: 2, memMb: 4096, labels: TEST_LABEL });
    try {
      const seeded = await machine.exec("printf preexisting > /root/.vimrc");
      expect(seeded.exitCode).toBe(0);

      const result = await applyDotfiles(machine, REPO, { presets: ["tmux"] });
      expect(result.manager).toBe("plain");
      expect(result.steps.map(s => s.name)).toEqual(["clone", "list", "apply", "preset:tmux"]);
      expect(result.steps.map(s => s.exitCode)).toEqual([0, 0, 0, 0]);

      const check = await machine.exec(
        "readlink /root/.vimrc && cat /root/.dotfiles-backup/*/.vimrc && command -v tmux",
      );
      expect(check.exitCode).toBe(0);
      expect(check.stdout).toContain("/root/.dotfiles/.vimrc");
      expect(check.stdout).toContain("preexisting");
    } finally {
      await machine.kill().catch(() => {});
    }

    const leftovers = (await backend.list()).filter(
      x => x.labels["wsp-test"] === TEST_LABEL["wsp-test"] && x.state === "running",
    );
    expect(leftovers).toEqual([]);
  });
});
