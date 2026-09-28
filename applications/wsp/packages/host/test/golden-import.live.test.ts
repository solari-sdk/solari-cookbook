// SPDX-License-Identifier: AGPL-3.0-only
// Golden import end to end against the real account: a trimmed recipe of this
// Mac (one dotfile, one Homebrew formula, one non-Claude agent, Claude on its
// sanctioned line) is applied on a fresh builder, sealed, and forked. The fork
// is proved to carry the dotfile, the tool and the agent binary. Only machines
// this test created are ever touched; a running machine from another session
// is left alone, so this never runs the host's account sweep.
import { homedir } from "node:os";
import { SolariBackend, isReserved, type GoldenStage } from "@wsp/engine";
import { createRuntime, memoryStore, type ImportResult } from "@wsp/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { DAEMON_DEPLOYED_LINE, deployDaemon } from "../src/doctor.js";
import { importFor } from "../src/init-import.js";
import { goldenRecipeFor } from "../src/init-recipe.js";
import type { ManifestEntry } from "@wsp/collect";
import { createOn, projectOn } from "./verbs-fixture.js";

const LABEL = { wsp: "1", "wsp-test": "golden-import-live" };

// A slice of this Mac's real recipe: enough to prove each carried thing without
// a full Homebrew replay. Logins are left out so no Keychain dialog is raised.
const BRING: ManifestEntry[] = [
  { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 225, default: "bring", required: true, bring: true },
  { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 6436, default: "bring", bring: true },
  { rung: "tools", id: "tools/brew/jq", label: "jq", paths: [], bytes: 0, default: "bring", group: "Homebrew", linux: "yes", bring: true },
  { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude/settings.json"], bytes: 100, default: "bring", bring: true },
  { rung: "agents", id: "agents/codex", label: "Codex", paths: ["~/.codex/config.toml"], bytes: 100, default: "bring", bring: true },
];

describe.runIf(LIVE)("golden import (live: apply a trimmed recipe, seal, fork, prove)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  const mine = new Set<string>();

  afterAll(async () => {
    if (!LIVE) return;
    for (const id of mine) await backend.get(id).then(m => m.kill()).catch(() => {});
  });

  it("applies files, tools and agents; the fork carries the dotfile, jq, and codex", { timeout: 1_200_000 }, async () => {
    const t0 = Date.now();
    const stages: { stage: GoldenStage; at: number; detail?: string }[] = [];
    let result: ImportResult | undefined;
    const imp = importFor(BRING, { home: homedir(), secrets: new Map(), platform: "darwin", onResult: r => (result = r) });
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: {},
      goldenRecipe: goldenRecipeFor(BRING, {
        import: imp,
        deployDaemon: async m => deployDaemon(m).then(() => DAEMON_DEPLOYED_LINE),
      }),
    });
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") stages.push({ stage: e.stage, at: Date.now() - t0, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
    });

    const print = (label: string) =>
      // eslint-disable-next-line no-console
      console.log(`[golden-import.live] ${label}\n` + stages.map(s => `  ${s.stage.padEnd(18)} ${String(s.at).padStart(7)}ms ${s.detail ?? ""}`).join("\n"));

    const builder = await rt.golden.prepare().catch((e: unknown) => {
      print(`prepare FAILED: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    mine.add(builder.id);
    const readyAt = stages.find(s => s.stage === "ready")!.at;
    print(`ready in ${readyAt}ms; tools=${JSON.stringify(result?.tools)} agents=${JSON.stringify(result?.agents)} files=${JSON.stringify(result?.files)}`);

    let workspaceId: string | undefined;
    try {
      expect(stages.map(s => s.stage)).toEqual([
        "creating", "deploying-daemon", "deploying-daemon",
        "applying-setup", "applying-setup", "uploading-files", "uploading-files",
        // bare harness line, the Node step (asked for and kept or installed), Claude, Codex, summary
        "installing-harness", "installing-harness", "installing-harness", "installing-harness", "installing-harness", "installing-harness",
        // Homebrew, its glibc and gcc, jq, summary
        "installing-tools", "installing-tools", "installing-tools", "installing-tools", "installing-tools",
        "ready",
      ]);
      const uploadFrame = stages.find(s => s.stage === "uploading-files" && /in [\d.]+s$/.test(s.detail ?? ""));
      expect(stages.some(s => s.stage === "installing-harness" && /^Node v\S+ (kept|installed)/.test(s.detail ?? ""))).toBe(true);
      expect(result?.tools.find(t => t.id === "tools/brew/jq")?.outcome).toBe("installed");
      expect(result?.agents.find(a => a.id === "agents/codex")?.outcome).toBe("installed");

      const free = await (await backend.get(builder.id)).exec("df -Pk /root | awk 'NR==2{print $4}'", { timeoutMs: 30_000 });
      print(`free on the builder after tools and agents: ${(Number(free.stdout.trim()) / 1024).toFixed(0)} MB`);
      const tSeal = Date.now();
      const { version } = await rt.golden.seal(builder.id);
      const sealMs = Date.now() - tSeal;
      expect(version.smoke).toMatchObject({ exitCode: 0 });

      const ws = await createOn(rt, { golden: version.snapshotId, name: "t87-fork", envs: {}, labels: LABEL });
      workspaceId = ws.id;
      mine.add(ws.machineId);
      const fork = await backend.get(ws.machineId);
      const proof = await fork.exec(
        "export PATH=/root/.local/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin; " +
          "echo DOTFILE=$(test -s /root/.zshrc && echo yes); echo GIT=$(git config --global user.name); " +
          "echo JQ=$(jq --version 2>&1); echo CODEX=$(codex --version 2>&1 | head -1)",
        { timeoutMs: 120_000 },
      );
      print(`prepare=${readyAt}ms seal=${sealMs}ms upload=${uploadFrame?.detail ?? "?"} files=${result?.files?.bytes ?? 0}B\n  fork proof:\n${proof.stdout.split("\n").map(l => `    ${l}`).join("\n")}`);
      expect(proof.stdout).toMatch(/DOTFILE=yes/);
      expect(proof.stdout).toMatch(/JQ=jq-/);
      expect(proof.stdout).toMatch(/CODEX=/);
      expect(proof.stdout).not.toMatch(/CODEX=$/m);

      await rt.workspaces.delete(workspaceId);
      workspaceId = undefined;
      await backend.deleteSnapshot(version.snapshotId).catch(() => {});
    } finally {
      if (workspaceId) await rt.workspaces.delete(workspaceId).catch(() => {});
    }

    // Only this test's machines are gone; a machine from another session stays put.
    const survivors = (await backend.list()).filter(m => m.labels["wsp-test"] === LABEL["wsp-test"] && m.state !== "gone");
    expect(survivors).toEqual([]);
    const others = (await backend.list()).filter(m => !isReserved(m.labels) && m.labels["wsp-test"] !== LABEL["wsp-test"]);
    // eslint-disable-next-line no-console
    console.log(`[golden-import.live] left on the account (not ours): ${others.map(m => `${m.id.slice(0, 40)}… ${m.state}`).join(", ") || "none"}`);
  });
});
