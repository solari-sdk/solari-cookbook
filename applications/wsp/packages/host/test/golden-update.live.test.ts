// SPDX-License-Identifier: AGPL-3.0-only
// Golden update end to end against the real account, from a fresh WSP_HOME:
// golden v1 from a small recipe, v2 by the fork road after the builder is
// gone (one dotfile and one tool added), v3 on the kept builder during its
// window (one dotfile added, one dropped from the recipe). Forks of each
// version are checked for what their recipe says, and for the dropped row
// still being on the disk: an update retires a row, it never uninstalls it. Only machines and snapshots this test
// created are ever touched, each by its recorded id.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "@wsp/collect";
import { SolariBackend, diffRecipes, isReserved, killUntilGone, type GoldenStage, type Machine } from "@wsp/engine";
import { createRuntime, jsonFileStore, type GoldenImport, type Runtime } from "@wsp/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { DAEMON_DEPLOYED_LINE, deployDaemon } from "../src/doctor.js";
import { stateWriterHere } from "../src/version.js";
import { importFor } from "../src/init-import.js";
import { goldenRecipeFor } from "../src/init-recipe.js";
import { deltaFor } from "../src/init-upgrade.js";
import { cleanupUntilGone, describeLeak } from "./live-cleanup.js";

const LABEL = { wsp: "1", "wsp-test": "golden-update-live" };

const GIT: ManifestEntry = { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 60, default: "bring", required: true, bring: true };
const CODEX: ManifestEntry = { rung: "agents", id: "agents/codex", label: "Codex", paths: ["~/.codex/config.toml"], bytes: 20, default: "bring", bring: true };
const ZSHRC: ManifestEntry = { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 30, default: "bring", bring: true };
const COWSAY: ManifestEntry = { rung: "tools", id: "tools/npm/cowsay", label: "cowsay", group: "npm globals", paths: [], bytes: 0, default: "bring", bring: true, version: "1.6.0" };
const STARSHIP: ManifestEntry = { rung: "shell", id: "shell/starship", label: "starship prompt", paths: ["~/.config/starship.toml"], bytes: 40, default: "bring", bring: true };

const RECIPE_A = [GIT, CODEX];
const RECIPE_B = [GIT, CODEX, ZSHRC, COWSAY];
const RECIPE_C = [GIT, CODEX, COWSAY, STARSHIP];

const PROOF =
  "export PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin; " +
  "echo GITCONFIG=$(test -s /root/.gitconfig && echo yes || echo no); echo ZSHRC=$(test -s /root/.zshrc && echo yes || echo no); " +
  "echo STARSHIP=$(test -s /root/.config/starship.toml && echo yes || echo no); " +
  'echo COWSAY=$( (command -v cowsay >/dev/null 2>&1 || test -x "$(npm prefix -g 2>/dev/null)/bin/cowsay") && echo yes || echo no); ' +
  "echo CODEX=$(codex --version 2>&1 | head -1)";

interface Frame {
  stage: GoldenStage;
  at: number;
  detail?: string;
}

describe.runIf(LIVE)("golden update (live: v1, v2 by fork, v3 on the kept builder, forks proved)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  const home = LIVE ? mkdtempSync(join(tmpdir(), "wsp-t102-home-")) : "";
  const statePath = join(home, "state", "state.json");
  const machines = new Set<string>();
  const snapshots = new Set<string>();
  const runtimes: Runtime[] = [];

  const print = (label: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[golden-update.live] ${label}`);
  };

  // Kills and deletes retry through a network drop for up to five minutes; what is left fails the run by id.
  afterAll(async () => {
    if (!LIVE) return;
    for (const rt of runtimes) await rt.close().catch((e: unknown) => print(`close: ${e instanceof Error ? e.message : String(e)}`));
    const leaked = await cleanupUntilGone(backend, machines, snapshots, { log: print });
    rmSync(home, { recursive: true, force: true });
    const leak = describeLeak(leaked);
    if (leak !== undefined) throw new Error(leak);
  }, 6 * 60_000);

  const importOf = (rows: readonly ManifestEntry[]): GoldenImport => importFor(rows, { home, secrets: new Map(), platform: "linux" });

  /** A runtime over this WSP_HOME with the recipe as wsp init would hand it, its frames stamped from `t0`. */
  const runtimeFor = (rows: readonly ManifestEntry[], frames: Frame[], t0: number): { rt: Runtime; imp: GoldenImport } => {
    const imp = importOf(rows);
    const rt = createRuntime({
      backend,
      store: jsonFileStore(statePath, stateWriterHere()),
      adapters: {},
      goldenRecipe: goldenRecipeFor(rows, { import: imp, deployDaemon: async m => deployDaemon(m).then(() => DAEMON_DEPLOYED_LINE) }),
      hostId: "golden-update-live",
    });
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push({ stage: e.stage, at: Date.now() - t0, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
    });
    runtimes.push(rt);
    return { rt, imp };
  };

  const show = (frames: Frame[]): string => frames.map(f => `  ${f.stage.padEnd(18)} ${String(f.at).padStart(7)}ms ${f.detail ?? ""}`).join("\n");

  /** From the first delta frame to ready: what is ours to bound; the fork boot and the seal are the provider's. */
  const deltaMs = (frames: Frame[]): number | undefined => {
    const first = frames.find(f => f.stage === "applying-setup");
    const ready = frames.find(f => f.stage === "ready");
    return first === undefined || ready === undefined ? undefined : ready.at - first.at;
  };

  const stageMs = (frames: Frame[], stage: GoldenStage): number | undefined => {
    const i = frames.findIndex(f => f.stage === stage);
    const next = frames.findIndex((f, j) => j > i && f.stage !== stage);
    return i < 0 || next < 0 ? undefined : frames[next]!.at - frames[i]!.at;
  };

  const forkAndProve = async (snapshotId: string, name: string): Promise<string> => {
    const t = Date.now();
    const fork: Machine = await backend.create({ kind: "sandbox", fromSnapshot: snapshotId, cpu: 2, memMb: 4096, labels: { ...LABEL, createdAt: new Date().toISOString() } });
    machines.add(fork.id);
    try {
      const proof = await fork.exec(PROOF, { timeoutMs: 120_000 });
      print(`fork of ${name} (${fork.id.slice(0, 24)}..) booted in ${Date.now() - t} ms:\n${proof.stdout.split("\n").map(l => `    ${l}`).join("\n")}`);
      return proof.stdout;
    } finally {
      await killUntilGone(backend, fork);
      machines.delete(fork.id);
    }
  };

  it("seals v1 and keeps the builder, updates to v2 on a fork and to v3 on the kept builder with the delta under a minute each, and forks of v3, v2 and v1 carry exactly their recipes", { timeout: 1_800_000 }, async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = wsp live\n\temail = live@example.invalid\n");
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "o4-mini"\n');
    writeFileSync(join(home, ".zshrc"), "export WSP_LIVE_ZSHRC=1\n");
    writeFileSync(join(home, ".config", "starship.toml"), "add_newline = false\n");
    const before = (await backend.list()).filter(m => !isReserved(m.labels)).map(m => m.id);

    // v1: a fresh builder from recipe A, sealed; the builder stays for its window.
    const t1 = Date.now();
    const f1: Frame[] = [];
    const a = runtimeFor(RECIPE_A, f1, t1);
    const b1 = await a.rt.golden.prepare();
    machines.add(b1.id);
    const sealed1 = await a.rt.golden.seal(b1.id);
    snapshots.add(sealed1.version.snapshotId);
    const v1Ms = Date.now() - t1;
    print(`v1 sealed in ${v1Ms} ms on builder ${b1.id.slice(0, 24)}..\n${show(f1)}`);
    expect(f1.at(-1)).toMatchObject({ stage: "sealed", detail: "v1; builder kept for one more change" });
    const kept1 = (await a.rt.golden.builders()).find(b => b.id === b1.id);
    expect(kept1).toMatchObject({ firstLife: true, sealed: { version: 1 } });
    expect((await backend.get(b1.id)).seen).toMatchObject({ state: "running" });
    expect(await a.rt.golden.recipe()).toMatchObject({ recipeHash: a.imp.recipeHash });

    // The builder goes, as it would once the window is over; the next update has to fork.
    await killUntilGone(backend, await backend.get(b1.id));
    machines.delete(b1.id);
    await a.rt.close();

    // v2: recipe B adds one dotfile and one tool; the fork road, under two minutes.
    const t2 = Date.now();
    const f2: Frame[] = [];
    const b = runtimeFor(RECIPE_B, f2, t2);
    expect(await b.rt.golden.builders()).toEqual([]);
    const currentA = await b.rt.golden.recipe();
    expect(currentA).toBeDefined();
    const diffAB = diffRecipes(currentA!, b.imp.recipe!);
    expect(diffAB.files.map(f => [f.dest, f.change])).toEqual([[".zshrc", "added"]]);
    expect(diffAB.tools.map(t => [t.id, t.change])).toEqual([["tools/npm/cowsay", "added"]]);
    const up2 = await b.rt.golden.upgrade({ delta: deltaFor(diffAB, b.imp, RECIPE_B, importOf) });
    const v2Ms = Date.now() - t2;
    snapshots.add(up2.version.snapshotId);
    const b2 = (await b.rt.golden.builders()).find(x => x.sealed?.version === 2);
    expect(b2).toBeDefined();
    machines.add(b2!.id);
    print(`v2 sealed by the ${up2.road} road in ${v2Ms} ms (delta ${deltaMs(f2)} ms); new builder ${b2!.id.slice(0, 24)}.. kept\n${show(f2)}`);
    expect(up2.road).toBe("fork");
    expect(up2.manifest).toMatchObject({ head: 2, versions: [{ version: 1 }, { version: 2 }] });
    expect(deltaMs(f2)).toBeLessThan(60_000);
    expect(f2[0]).toMatchObject({ stage: "creating", detail: "fork of golden v1" });
    await b.rt.close();

    // v3: recipe C adds a dotfile and drops one, during the kept builder's window: a re-snapshot of the same machine.
    const t3 = Date.now();
    const f3: Frame[] = [];
    const c = runtimeFor(RECIPE_C, f3, t3);
    expect(await c.rt.golden.builders()).toEqual([expect.objectContaining({ id: b2!.id, firstLife: true, sealed: expect.objectContaining({ version: 2 }) })]);
    const currentB = await c.rt.golden.recipe();
    const diffBC = diffRecipes(currentB!, c.imp.recipe!);
    expect(diffBC.files.map(f => [f.dest, f.change]).sort()).toEqual([[".config/starship.toml", "added"], [".zshrc", "removed"]]);
    const up3 = await c.rt.golden.upgrade({ delta: deltaFor(diffBC, c.imp, RECIPE_C, importOf) });
    const v3Ms = Date.now() - t3;
    snapshots.add(up3.version.snapshotId);
    const snapMs = stageMs(f3, "snapshotting");
    print(`v3 sealed by the ${up3.road} road in ${v3Ms} ms (delta ${deltaMs(f3)} ms); snapshot stage ${snapMs} ms\n${show(f3)}`);
    expect(deltaMs(f3)).toBeLessThan(60_000);
    expect(up3.road).toBe("builder");
    expect(f3[0]).toMatchObject({ stage: "creating", detail: "your builder from v2, kept since the save" });
    expect(f3.some(f => f.stage === "applying-setup" && f.detail === "1 row left on the image, retired: ~/.zshrc")).toBe(true);
    expect(up3.manifest).toMatchObject({ head: 3, versions: [{ version: 1 }, { version: 2 }, { version: 3 }] });
    expect(snapMs).toBeDefined();
    // The same machine, still running, now saved as v3.
    expect(await c.rt.golden.builders()).toEqual([expect.objectContaining({ id: b2!.id, sealed: expect.objectContaining({ version: 3 }) })]);
    expect((await backend.get(b2!.id)).seen).toMatchObject({ state: "running" });
    await c.rt.close();

    // The builder goes before the forks, so at most one machine of ours runs at a time.
    await killUntilGone(backend, await backend.get(b2!.id));
    machines.delete(b2!.id);

    const proof3 = await forkAndProve(up3.version.snapshotId, "v3");
    expect(proof3).toMatch(/GITCONFIG=yes/);
    // The row left the recipe at v3 and is retired on that version; the bytes v2 put there stay.
    expect(proof3).toMatch(/ZSHRC=yes/);
    expect(up3.version.retired).toEqual([{ id: "shell/zshrc", name: "~/.zshrc" }]);
    expect(proof3).toMatch(/STARSHIP=yes/);
    expect(proof3).toMatch(/COWSAY=yes/);
    expect(proof3).toMatch(/CODEX=codex/);
    const proof2 = await forkAndProve(up2.version.snapshotId, "v2");
    expect(proof2).toMatch(/ZSHRC=yes/);
    expect(proof2).toMatch(/COWSAY=yes/);
    expect(proof2).toMatch(/STARSHIP=no/);
    const proof1 = await forkAndProve(sealed1.version.snapshotId, "v1");
    expect(proof1).toMatch(/GITCONFIG=yes/);
    expect(proof1).toMatch(/ZSHRC=no/);
    expect(proof1).toMatch(/COWSAY=no/);
    expect(proof1).toMatch(/CODEX=codex/);

    for (const id of snapshots) await backend.deleteSnapshot(id);
    snapshots.clear();
    const after = (await backend.list()).filter(m => !isReserved(m.labels));
    expect(after.filter(m => m.labels["wsp-test"] === LABEL["wsp-test"])).toEqual([]);
    expect(after.filter(m => m.labels["wsp-owner"] !== undefined && !before.includes(m.id))).toEqual([]);
    print(`timings: v1 ${v1Ms} ms, v2 (fork road) ${v2Ms} ms with a ${deltaMs(f2)} ms delta, v3 (kept builder) ${v3Ms} ms with a ${deltaMs(f3)} ms delta and a ${snapMs} ms snapshot; left on the account (not ours): ${after.map(m => `${m.id.slice(0, 24)}.. ${m.state}`).join(", ") || "none"}`);
  });
});
