// SPDX-License-Identifier: AGPL-3.0-only
// wsp init twice from two processes on one WSP_HOME against the real account: the
// second run attaches to the first run's builder, skips every stage, and the account
// holds one builder for this state file. Every machine is killed by its recorded id;
// machines this test did not make are only ever read off the listing, since a
// per-machine GET resets the provider's idle timer (measured).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SolariBackend, killUntilGone } from "@wsp/engine";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

// One non-Claude agent on and no tool beyond the base: with the one dotfile the fake HOME holds, enough to give the
// run four real stages without Homebrew.
const RECIPE = {
  version: 1,
  at: "2026-09-06T00:00:00.000Z",
  histories: [],
  rows: [{ id: "codex", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.codex/config.toml"], bin: false } }],
};

interface State {
  owner?: { id?: { id?: string } };
  builders?: Record<string, { id: string; firstLife?: boolean; building?: true; heldBy?: { pid: number }; import?: { applied: string[] } }>;
}

const scrub = (s: string): string => s.replace(/slr_live_\S+/g, "slr_live_[hidden]");

describe.runIf(LIVE)("builder reuse across processes (live: wsp init twice on one WSP_HOME)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  const home = LIVE ? mkdtempSync(join(tmpdir(), "wsp-t95-home-")) : "";
  const statePath = join(home, "state", "state.json");
  const children: ChildProcess[] = [];
  const mine = new Set<string>();

  const print = (label: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[builder-reuse.live] ${label}`);
  };

  const readState = (): State => (existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : {});

  const stop = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise<void>(r => child.once("exit", () => r()));
    child.kill("SIGTERM");
    await gone;
  };

  const spawnInit = (recipeFile: string): { child: ChildProcess; output: string[] } => {
    const output: string[] = [];
    const child = spawn(process.execPath, [BIN, "init", "--recipe", recipeFile, "--yes", "--port", "0", "--ws-port", "0", "--state", statePath], {
      cwd: home,
      env: { ...process.env, SOLARI_API_KEY: env.SOLARI_API_KEY, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, HOME: home, WSP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    return { child, output };
  };

  /** Runs `wsp init --recipe --yes` and resolves once `needle` is printed, with everything printed so far. */
  const runInit = (recipeFile: string, needle = "This terminal reports the save."): { child: ChildProcess; handedOff: Promise<string> } => {
    const { child, output } = spawnInit(recipeFile);
    const handedOff = new Promise<string>((resolve, reject) => {
      const check = (): void => {
        if (output.join("").includes(needle)) resolve(output.join(""));
      };
      child.stdout?.on("data", check);
      child.stderr?.on("data", check);
      child.once("exit", (code, signal) => reject(new Error(`wsp init exited before "${needle}" (code ${code}, signal ${signal}):\n${scrub(output.join(""))}`)));
    });
    return { child, handedOff };
  };

  /** Runs `wsp init --recipe --yes` to its exit; one that starts serving instead is stopped and reported as such. */
  const runToExit = (recipeFile: string): Promise<{ code: number | null; output: string }> =>
    new Promise(resolve => {
      const { child, output } = spawnInit(recipeFile);
      const onData = (): void => {
        if (output.join("").includes("This terminal reports the save.")) void stop(child).then(() => resolve({ code: null, output: `${output.join("")}\n[the process began serving; stopped by the test]` }));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", code => resolve({ code, output: output.join("") }));
    });

  // A failing assertion must not leave a serving host behind for the next scenario to refuse against.
  afterEach(async () => {
    for (const child of children.splice(0)) await stop(child);
  });

  afterAll(async () => {
    if (!LIVE) return;
    for (const child of children) await stop(child);
    for (const id of Object.keys(readState().builders ?? {})) mine.add(id);
    for (const id of mine) {
      await backend
        .get(id)
        .then(m => killUntilGone(backend, m))
        .catch((e: unknown) => {
          if ((e as { kind?: string }).kind !== "missing") print(`kill ${id}: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("the second init attaches to the first run's builder, skips every stage, and the account holds one builder for this state file", { timeout: 1_500_000 }, async () => {
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = wsp live\n\temail = live@example.invalid\n");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "model = \"o4-mini\"\n");
    const recipeFile = join(home, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(RECIPE));

    const t1 = Date.now();
    const first = runInit(recipeFile);
    const out1 = await first.handedOff;
    const run1Ms = Date.now() - t1;
    const afterFirst = readState();
    const owner = afterFirst.owner?.id?.id;
    const recorded = Object.values(afterFirst.builders ?? {});
    for (const b of recorded) mine.add(b.id);
    print(`run 1: hand-off after ${run1Ms} ms; created ${recorded.map(b => b.id).join(", ") || "nothing"}; owner ${owner ?? "none"}`);
    print(`run 1 output:\n${scrub(out1)}`);
    expect(recorded).toHaveLength(1);
    const builderId = recorded[0]!.id;
    expect(recorded[0]).toMatchObject({ firstLife: true, import: { applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools"] } });
    expect(out1).toMatch(/Boot a \d+ vCPU/);
    expect(out1).not.toContain("Attaching to your earlier builder");

    // The first process dies the way a crash or a Ctrl-C would; the builder outlives it.
    await stop(first.child);
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);

    const t2 = Date.now();
    const second = runInit(recipeFile);
    const out2 = await second.handedOff;
    const run2Ms = Date.now() - t2;
    print(`run 2: hand-off after ${run2Ms} ms`);
    print(`run 2 output:\n${scrub(out2)}`);
    expect(out2).toContain(`Attaching to your earlier builder: default (${builderId})`);
    expect(out2).not.toMatch(/Boot a \d+ vCPU/);
    expect(out2).not.toContain("Creating the machine");
    expect(out2.match(/(Setup applied|Files copied|Tools installed|Agents installed)\s+already applied/g)).toHaveLength(4);
    expect(out2).toContain("Ready");

    const afterSecond = readState();
    expect(Object.keys(afterSecond.builders ?? {})).toEqual([builderId]);
    expect(afterSecond.builders?.[builderId]).toMatchObject({ firstLife: true });
    for (const b of Object.values(afterSecond.builders ?? {})) mine.add(b.id);

    // Only the listing is read for the account view; the one running machine of this owner is the builder.
    const ours = (await backend.list()).filter(m => m.labels["wsp-owner"] === owner && m.state === "running");
    print(`running machines wearing owner ${owner}: ${ours.map(m => m.id).join(", ") || "none"}`);
    expect(ours.map(m => m.id)).toEqual([builderId]);
    expect(ours[0]!.labels).toMatchObject({ wsp: "1", "wsp-builder": "1" });

    await stop(second.child);
    // The per-machine GET view is what the owner check reads; this is the one reading of its metadata on the real provider.
    const handle = await backend.get(builderId);
    print(`get(${builderId.slice(0, 24)}..) labels: ${JSON.stringify(handle.labels)} seen: ${JSON.stringify(handle.seen)}`);
    expect(handle.labels).toMatchObject({ "wsp-owner": owner, "wsp-builder": "1", wsp: "1" });
    expect(handle.seen).toMatchObject({ state: "running" });
    const tKill = Date.now();
    await killUntilGone(backend, handle);
    mine.delete(builderId);
    print(`killed ${builderId} by recorded id in ${Date.now() - tKill} ms; timings: run 1 ${run1Ms} ms, run 2 ${run2Ms} ms`);
    const left = (await backend.list()).filter(m => m.labels["wsp-owner"] === owner && m.state !== "gone");
    expect(left).toEqual([]);
  });

  it("a process stopped mid-prepare leaves a placeholder its dead holder cannot finish: the next init, at once and again after a minute, lists it, boots nothing and kills nothing; the machine is stopped by its recorded id", { timeout: 900_000 }, async () => {
    const recipeFile = join(home, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(RECIPE));
    const before = new Set(Object.keys(readState().builders ?? {}));

    const t1 = Date.now();
    const a = runInit(recipeFile, "Installing agents");
    await a.handedOff;
    const midPrepareMs = Date.now() - t1;
    const placeholder = Object.values(readState().builders ?? {}).find(b => !before.has(b.id));
    expect(placeholder).toBeDefined();
    const id = placeholder!.id;
    mine.add(id);
    print(`mid-prepare: created ${id} after ${midPrepareMs} ms; record ${JSON.stringify({ ...placeholder, id: id.slice(0, 24) })}`);
    expect(placeholder).toMatchObject({ building: true, firstLife: true, heldBy: { pid: a.child.pid } });
    await stop(a.child);
    const owner = readState().owner?.id?.id;

    const t2 = Date.now();
    const b = await runToExit(recipeFile);
    print(`init within a second (after ${t2 - t1} ms): exit ${b.code}\n${scrub(b.output)}`);
    expect(b.code).toBe(1);
    expect(b.output).toContain(`default (${id})`);
    expect(b.output).toContain("its setup never finished");
    expect(b.output).toContain("Kill it first");
    expect(b.output).not.toContain("Attaching");
    expect(b.output).not.toMatch(/Boot a \d+ vCPU/);

    await new Promise(r => setTimeout(r, 60_000));
    const c = await runToExit(recipeFile);
    print(`init after a minute: exit ${c.code}\n${scrub(c.output)}`);
    expect(c.code).toBe(1);
    expect(c.output).toContain("its setup never finished");
    expect(c.output).not.toContain("Attaching");

    const ours = (await backend.list()).filter(m => m.labels["wsp-owner"] === owner && m.state === "running");
    expect(ours.map(m => m.id)).toEqual([id]);
    const tKill = Date.now();
    await killUntilGone(backend, await backend.get(id));
    mine.delete(id);
    print(`killed ${id} by recorded id in ${Date.now() - tKill} ms`);
    expect((await backend.list()).filter(m => m.labels["wsp-owner"] === owner && m.state !== "gone")).toEqual([]);
  });
});
