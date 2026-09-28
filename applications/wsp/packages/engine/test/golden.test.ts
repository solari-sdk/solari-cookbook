import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UNMEASURED_ROAD, customInstallsFor, recipeDigest, toolInstallsFor, type BrewTable, type RecipeEntry } from "../src/golden-import.js";
import { diffRecipes, retiredBy, rowsToApply } from "../src/golden-diff.js";
import { BUILDER_IDLE_MS, CredentialOnBuilderError, MachineAliveError, SnapshotFailedError, applyDelta, applyGoldenImport, buildGolden, forkGolden, nextLeftBehind, nextSetupSha, nextMissing, nextSmoke, prepareBuilder, rollback, promoteVersion, sealGolden, smokeTally, snapshotUntilGone, templatesOf, upgradeBuilder, type GoldenDelta, type GoldenImport, type GoldenStage, type GoldenVersion, type ImportResult, type PackedFiles } from "../src/golden.js";
import { BUILDER_DISK_GB } from "../src/tool-sizes.js";
import { CLAUDE_INSTALL, CURL_NET, GOLDEN_SETUP, MCP_SERVERS_JSON, NEVER_IN_IMAGE, NODE_RELEASES, ROAD_STEPS, nodeInstallScript } from "@wsp/catalog";
import { credentialOnBuilderLine, diskSyncFailedLine, shellQuote, type RecipeDigest } from "@wsp/protocol";
import { NotFirstLifeError } from "../src/errors.js";
import { AGENT_INSTALLERS, HOMEBREW, NODE_PATH_LINE, TOOLS_PATH, type ToolInstall } from "../src/golden-import.js";
import { INLINE_EXEC_MS, machineAnswer } from "../src/exec-detached.js";
import { DISK_SYNC_CMD, DiskSyncError } from "../src/disk-sync.js";
import { MIB, USED_KB_CMD, installTools } from "../src/golden-tools.js";
import { READS_PER_EXEC } from "../src/exec-detached.js";
import { ALREADY_ON_MACHINE } from "../src/golden-base.js";
import { goldenName } from "../src/snapshot-names.js";
import { tarOf } from "../src/vault.js";
import { tarRead } from "./tar-read.js";
import type { ExecResult, Machine, MachineBackend, MachineShape, MachineSpec, SnapshotProgress, TemplateRow } from "../src/machine.js";

/** A fake whose kill() resolves like the provider's DELETE does: a call for
 * which `ignoreKill` answers true is accepted and changes nothing. */
function recordingBackend(
  execResults: Record<string, ExecResult> = {},
  opts: {
    ignoreKill?: (id: string, nth: number) => boolean;
    /** The provider's refusal of a kill, by machine and attempt; the machine stays as it was. */
    refuseKill?: (id: string, nth: number) => Error | undefined;
    built?: (spec: MachineSpec) => MachineShape;
    exec?: (cmd: string) => ExecResult;
    stream?: boolean;
    /** The provider copies the disk from any life, as a container's commit does; without it a resumed machine is refused as Solari refuses one. */
    snapshotsAnyLife?: boolean;
    snapshot?: (id: string, nth: number) => void;
    /** What the provider says of the snapshot as it writes it, each reading handed to the caller before it answers. */
    snapshotProgress?: SnapshotProgress[];
    state?: (id: string) => void;
    /** The backend promotes snapshots to templates; what each read of a template answers, by how many reads it has had. */
    templates?: boolean;
    templateStatus?: (id: string, nth: number) => TemplateRow["status"];
  } = {},
) {
  const created: MachineSpec[] = [];
  const snapshots: string[] = [];
  const killed: string[] = [];
  const deletedSnapshots: string[] = [];
  /** Every template the provider holds, and every promote asked of it. */
  const templates = new Map<string, TemplateRow>();
  const promoted: { snapshotId: string; name: string }[] = [];
  const deletedTemplates: string[] = [];
  const templateReads = new Map<string, number>();
  /** Every create/kill/snapshot in order, so sequencing under the machine cap is provable. */
  const timeline: string[] = [];
  const machines = new Map<string, Machine>();
  const gone = new Set<string>();
  let nextId = 0;
  const killCount = new Map<string, number>();
  /** The scripts that went through run(), per machine, and every inline exec with its bound. */
  const ran: { id: string; script: string }[] = [];
  const inline: { id: string; cmd: string; timeoutMs: number | undefined }[] = [];
  const answer = (cmd: string): ExecResult => opts.exec?.(cmd) ?? execResults[cmd] ?? (cmd === "echo ok" ? REACH_OK : { exitCode: 0, stdout: "", stderr: "" });
  const backend: MachineBackend = {
    capabilities: { liveCloneForks: true, pauseMode: "memory", replacesMachine: true, previewUrls: true, signedUrls: true, callbackRelay: true, diskSnapshots: true, images: true, snapshotsAnyLife: opts.snapshotsAnyLife === true, snapshotListing: false, templates: opts.templates === true, kept: false, copies: true, ownNetwork: true, sizes: [] },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" }, builderDiskGb: BUILDER_DISK_GB },
    async create(spec) {
      if (spec.template !== undefined && spec.template.startsWith("tpl_") && !templates.has(spec.template)) throw Object.assign(new Error(`no template ${spec.template}`), { kind: "missing", status: 404 });
      created.push(spec);
      const id = `m${++nextId}`;
      timeline.push(`create ${id}`);
      const machine: Machine = {
        id, kind: spec.kind, streamUrl: spec.kind === "desktop" ? `wss://fake/stream/${id}` : undefined,
        exec: async (cmd, o) => {
          inline.push({ id, cmd, timeoutMs: o?.timeoutMs });
          return answer(cmd);
        },
        run: async (script, o) => {
          ran.push({ id, script });
          const res = answer(script);
          if (opts.stream) for (const line of res.stdout.split("\n")) if (line !== "") o.onLine?.(line);
          return res;
        },
        snapshot: async (name, life, o) => {
          if (!life.firstLife && opts.snapshotsAnyLife !== true) throw new NotFirstLifeError(id, `snapshot ${name}`);
          timeline.push(`snapshot ${id}`);
          opts.snapshot?.(id, timeline.filter(t => t === `snapshot ${id}`).length);
          for (const p of opts.snapshotProgress ?? []) o?.onProgress?.(p);
          snapshots.push(name);
          return `snap_${name}`;
        },
        pause: async () => {}, resume: async () => {},
        kill: async () => {
          killed.push(id);
          timeline.push(`kill ${id}`);
          const nth = (killCount.get(id) ?? 0) + 1;
          killCount.set(id, nth);
          const refusal = opts.refuseKill?.(id, nth);
          if (refusal !== undefined) throw refusal;
          if (!opts.ignoreKill?.(id, nth)) gone.add(id);
        },
        state: async () => {
          opts.state?.(id);
          return gone.has(id) ? "gone" : "running";
        },
        downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
        ...(opts.built ? { describe: async () => opts.built!(spec) } : {}),
      };
      machines.set(id, machine);
      return machine;
    },
    async get(id) {
      const m = machines.get(id);
      if (!m || gone.has(id)) throw Object.assign(new Error(`no machine ${id}`), { kind: "missing", status: 404 });
      return m;
    },
    async list() { return []; },
    async deleteSnapshot(id) {
      if ([...templates.keys()].some(t => t === `tpl_${id}`)) throw Object.assign(new Error("SnapshotBacksTemplate"), { kind: "conflict", status: 409 });
      deletedSnapshots.push(id);
    },
    async promoteSnapshot(snapshotId, name) {
      timeline.push(`promote ${snapshotId}`);
      promoted.push({ snapshotId, name });
      const id = `tpl_${snapshotId}`;
      templates.set(id, { id, name, status: "ready" });
      return id;
    },
    async getTemplate(id) {
      const row = templates.get(id);
      if (row === undefined) throw Object.assign(new Error(`no template ${id}`), { kind: "missing", status: 404 });
      const nth = (templateReads.get(id) ?? 0) + 1;
      templateReads.set(id, nth);
      const status = opts.templateStatus?.(id, nth) ?? row.status;
      return { ...row, status, ...(status === "failed" ? { error: "restore copy failed" } : {}) };
    },
    async listTemplates() { return [{ id: "base", name: "base", status: "ready" }, ...templates.values()]; },
    async deleteTemplate(id) {
      deletedTemplates.push(id);
      templates.delete(id);
    },
  };
  return { backend, created, snapshots, killed, deletedSnapshots, timeline, ran, inline, gone, templates, promoted, deletedTemplates };
}

/** What the provider's snapshot call answers when it refuses: the 502 the backend maps, with the reply's request id. */
const refusedSnapshot = (requestId: string): Error => Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502, requestId });

/** What the recording backend's guest tar leaves behind, and the signed-URL road that brings it down: the backend
 * answers every download with these bytes, since only one archive is ever asked for in a seal. */
/** The archive a builder hands back at the seal, over the two paths the vault case asks for: a real one, since
 * the seal reads its members against those paths before it records anything. */
const VAULT_TGZ = tarOf([
  { path: "root/.config/gh/hosts.yml", mode: 0o600, content: "github.com:\n" },
  { path: "etc/profile.d/wsp-secrets.sh", mode: 0o600, content: "export A=1\n" },
]);
const vaultFetch = (): typeof globalThis.fetch => (async () => new Response(new Uint8Array(VAULT_TGZ), { status: 200 })) as typeof globalThis.fetch;

const FAST_KILL = { graceMs: 20, pollMs: 1 };
/** What a machine that still serves answers the reach check with. */
const REACH_OK: ExecResult = { exitCode: 0, stdout: "ok\n", stderr: "" };
/** The stage detail the machine context leaves when no agent is on the guest, whatever its archive weighs. */
const CONTEXT_WRITTEN = expect.stringMatching(/^installing-mcp:machine context: \d+(\.\d+)? KB written; no agent on the machine$/);
/** What a gzipped archive holds and one file out of it, read with this computer's tar. */
const namesIn = (tgz: Buffer): string[] => tarRead(["-tzf", "-"], tgz).toString("utf8").trim().split("\n");
const fileIn = (tgz: Buffer, path: string): string => tarRead(["-xzOf", "-", path], tgz).toString("utf8");

function stageRecorder() {
  const stages: string[] = [];
  const onStage = (stage: GoldenStage, detail?: string) => {
    stages.push(detail === undefined ? stage : `${stage}:${detail}`);
  };
  return { stages, onStage };
}

/** The base floor's own lines under its stage: the df warning, one per step, the loop's summary. The stage's closing line stays. */
const BASE_STEP = /^deploying-daemon:(free disk unknown|.* \(\d+\/\d+\)$|\d+ installed)/;
const sansBase = (stages: readonly string[]): string[] => stages.filter(s => !BASE_STEP.test(s));

describe("golden pipeline", () => {
  it("seals no version when the smoke fork fails, and leaves no machine or snapshot behind", async () => {
    const { backend, killed, deletedSnapshots } = recordingBackend({
      "boom --version": { exitCode: 127, stdout: "", stderr: "not found" },
    });
    await expect(
      buildGolden({ backend, hostId: "h1", setup: "true", smoke: "boom --version" }),
    ).rejects.toThrow(/smoke/);
    expect(deletedSnapshots).toEqual(["snap_wsp-h1-default-v1"]); // the image that failed smoke does not survive
    expect(killed).toEqual(["m1", "m2"]); // builder and smoke fork both gone
  });

  it("writes a complete manifest entry, sandbox kind by default, and kills builder and fork", async () => {
    const { backend, created, killed } = recordingBackend();
    const { manifest, version } = await buildGolden({
      backend, hostId: "h1", baseTemplate: "base", setup: "echo setup", smoke: "true",
    });
    expect(version.version).toBe(1);
    expect(version.snapshotId).toBe("snap_wsp-h1-default-v1");
    expect(version.baseTemplate).toBe("base");
    expect(version.kind).toBe("sandbox");
    expect(version.setupSha).toBe(createHash("sha256").update("echo setup").digest("hex"));
    expect(version.smoke).toEqual({ cmd: "true", exitCode: 0 });
    expect(Date.parse(version.createdAt)).not.toBeNaN();
    expect(manifest.head).toBe(1);
    expect(manifest.versions).toEqual([version]);
    expect(created.map(c => c.kind)).toEqual(["sandbox", "sandbox"]);
    expect(created[1]!.fromSnapshot).toBe("snap_wsp-h1-default-v1");
    expect(killed).toEqual(["m1", "m2"]);
  });

  it("stamps the builder as wsp-builder and the smoke fork as wsp-smoke with its own createdAt", async () => {
    const { backend, created } = recordingBackend();
    const labels = { wsp: "1", "wsp-owner": "h_me", createdAt: "2026-09-01T00:00:00.000Z" };
    await buildGolden({ backend, hostId: "h1", setup: "true", smoke: "true", labels });
    expect(created[0]!.labels).toEqual({ ...labels, "wsp-builder": "1" });
    expect(created[1]!.labels).toMatchObject({ wsp: "1", "wsp-owner": "h_me", "wsp-smoke": "1" });
    expect(created[1]!.labels).not.toHaveProperty("wsp-builder");
    expect(Date.parse(created[1]!.labels!["createdAt"]!)).toBeGreaterThan(Date.parse(labels.createdAt));
  });

  it("appends versions and rollback only moves head", async () => {
    const { backend } = recordingBackend();
    const one = await buildGolden({ backend, hostId: "h1", setup: "a", smoke: "true" });
    const two = await buildGolden({ backend, hostId: "h1", setup: "b", smoke: "true", manifest: one.manifest });
    expect(two.manifest.versions.map(v => v.version)).toEqual([1, 2]);
    expect(two.manifest.head).toBe(2);
    const rolled = rollback(two.manifest, 1);
    expect(rolled.head).toBe(1);
    expect(rolled.versions).toHaveLength(2);
    expect(two.manifest.head).toBe(2); // input untouched
  });

  it("fork passes envs/fromSnapshot, restores the sealed kind, and never mutates the manifest", async () => {
    const { backend, created } = recordingBackend();
    const { manifest } = await buildGolden({ backend, hostId: "h1", kind: "desktop", setup: "s", smoke: "true" });
    const before = JSON.stringify(manifest);
    const m = await forkGolden(backend, manifest, { envs: { FOO: "bar" }, labels: { wsp: "1" } });
    expect(m.id).toBe("m3");
    expect(m.kind).toBe("desktop");
    const forkSpec = created[2]!;
    expect(forkSpec.fromSnapshot).toBe("snap_wsp-h1-default-v1");
    expect(forkSpec.envs).toEqual({ FOO: "bar" });
    expect(forkSpec.labels).toEqual({ wsp: "1" });
    expect(forkSpec.template).toBeUndefined();
    expect(JSON.stringify(manifest)).toBe(before);
  });
});

describe("interactive golden: prepare then seal", () => {
  it("prepare boots a sandbox from the sandbox template with the builder disk, runs daemon then harness, and reports stages", async () => {
    const { ran, backend, created, timeline } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    const daemonOn: string[] = [];
    const builder = await prepareBuilder({
      backend,
      setup: "install harness",
      deployDaemon: async m => { daemonOn.push(m.id); },
      onStage,
    });
    // An idle-paused builder resumes not first-life and the seal would 502; kill fails loud instead.
    expect(created[0]).toMatchObject({ kind: "sandbox", template: "base", onIdle: "kill", diskGb: 20 });
    expect(builder.kind).toBe("sandbox");
    expect(builder.firstLife).toBe(true);
    expect(builder.machine.streamUrl).toBeUndefined();
    expect(daemonOn).toEqual(["m1"]);
    expect(sansBase(stages)).toEqual(["creating:sandbox from base", "deploying-daemon", "installing-harness", "ready"]);
    // The floor goes on before the daemon: the login shell's PATH first, then the rows the deploy's own steps type.
    const floor = ran.filter(r => r.id === "m1").map(r => r.script);
    expect(floor.findIndex(s => s.includes("> /etc/profile.d/wsp-golden.sh"))).toBe(0);
    // The index and curl lead, since the roads below fetch a release with curl and an image need not ship one.
    expect(floor.findIndex(s => s.includes("apt-get update -qq"))).toBe(1);
    expect(floor.findIndex(s => s.includes("apt-get install -y -qq curl"))).toBe(2);
    expect(floor.findIndex(s => s.includes("astral-sh/uv/releases"))).toBe(3);
    // Node is not on the floor any more: nothing in the base stage fetches it.
    expect(floor.some(s => s.includes("nodejs.org/dist"))).toBe(false);
    expect(timeline).toEqual(["create m1"]); // alive and waiting for the person
  });

  it("the builder's createdAt is taken before the create, so the age a person reads covers the whole prepare", async () => {
    const { backend } = recordingBackend();
    let createCalledAt = 0;
    const realCreate = backend.create.bind(backend);
    backend.create = async spec => {
      createCalledAt = Date.now();
      return realCreate(spec);
    };
    const builder = await prepareBuilder({ backend, setup: "true", deployDaemon: () => new Promise(r => setTimeout(r, 15)) });
    expect(Date.parse(builder.createdAt)).toBeLessThanOrEqual(createCalledAt);
  });

  it("a daemon hook that reports a detail gets it on a second deploying-daemon frame", async () => {
    const { backend } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", deployDaemon: async () => "node v22.23.2", onStage });
    expect(sansBase(stages)).toEqual(["creating:sandbox from base", "deploying-daemon", "deploying-daemon:node v22.23.2", "installing-harness", "ready"]);
  });

  it("prepare with kind desktop picks the desktop template and streams a display", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, kind: "desktop", setup: "true" });
    expect(created[0]).toMatchObject({ kind: "desktop", template: "default" });
    expect(builder.kind).toBe("desktop");
    expect(builder.machine.streamUrl).toBe("wss://fake/stream/m1");
  });

  it("only the builder idles to kill, after a window long enough for a person; the smoke fork keeps the provider default", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true" });
    await sealGolden(builder, { backend, hostId: "h1", smoke: "true" });
    expect(created[0]).toMatchObject({ onIdle: "kill", idleTimeoutMs: BUILDER_IDLE_MS });
    expect(BUILDER_IDLE_MS).toBeGreaterThanOrEqual(4 * 60 * 60_000);
    expect(created[1]).toMatchObject({ fromSnapshot: "snap_wsp-h1-default-v1" });
    expect(created[1]!.onIdle).toBeUndefined();
    expect(created[1]!.idleTimeoutMs).toBeUndefined();
  });

  it("prepare kills the machine and reports failed when the harness install fails, with the install's own last line as the reason", async () => {
    const { backend, killed } = recordingBackend({}, { exec: cmd => (cmd.includes("bad install") ? { exitCode: 1, stdout: "", stderr: "nope" } : { exitCode: 0, stdout: "", stderr: "" }) });
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend, setup: "bad install", onStage })).rejects.toThrow("golden setup failed: nope");
    expect(killed).toEqual(["m1"]);
    expect(stages.at(-1)).toBe("failed:golden setup failed: nope");
  });

  it("a setup the guard ended reads as its timeout, not as a bare exit code", async () => {
    const { backend } = recordingBackend({}, { exec: cmd => (cmd.includes("slow install") ? { exitCode: 124, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) });
    await expect(prepareBuilder({ backend, setup: "slow install" })).rejects.toThrow("golden setup failed: timed out after 900s");
  });

  it("seal snapshots, kills the builder before the smoke fork boots, and records the kind", async () => {
    const { backend, created, timeline } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, kind: "desktop", setup: "echo setup", onStage });
    const { manifest, version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "claude --version", onStage });
    expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "create m2", "kill m2"]);
    expect(created[1]).toMatchObject({ kind: "desktop", fromSnapshot: "snap_wsp-h1-default-v1" });
    expect(created[1]!.template).toBeUndefined();
    expect(version).toMatchObject({ version: 1, kind: "desktop", baseTemplate: "default", snapshotId: "snap_wsp-h1-default-v1" });
    expect(version.templateId).toBeUndefined();
    expect(version.setupSha).toBe(builder.setupSha);
    expect(manifest.head).toBe(1);
    expect(sansBase(stages)).toEqual([
      "creating:desktop from default", "deploying-daemon", "installing-harness", "ready",
      "snapshotting:syncing the disk", "snapshotting:snapshotting, usually under a minute", "smoke-forking:claude --version", "smoke-forking:1 agent answers: Claude Code", "sealed:v1",
    ]);
  });

  it("the smoke stage ends on what the checks proved, not on the last line an agent printed", async () => {
    const smoke = "claude --version && hermes --version";
    const banner = "Update available: 5343 commits behind, run 'hermes update'";
    const { backend } = recordingBackend({ [smoke]: { exitCode: 0, stdout: `2.1.263 (Claude Code)\n${banner}\n`, stderr: "" } }, { stream: true });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    await sealGolden(builder, { backend, hostId: "h1", smoke, onStage });
    const forking = stages.filter(s => s.startsWith("smoke-forking:"));
    expect(forking).toContain(`smoke-forking:${banner}`);
    expect(forking.at(-1)).toBe("smoke-forking:2 agents answer: Claude Code, Hermes Agent");
    expect(stages.at(-1)).toBe("sealed:v1");
  });

  it.each([
    ["true", "no agent to check; the fork booted"],
    ["codex --version", "1 agent answers: Codex"],
    ["aider --version && node --version", "2 agents answer: Aider, node --version"],
  ])("smokeTally(%j) is %j", (smoke, want) => {
    expect(smokeTally(smoke)).toBe(want);
  });

  it("seal records whether the image carries the browser shim, read on the smoke fork", async () => {
    const withShim = recordingBackend({}, { exec: cmd => (cmd === "test -x /usr/local/bin/wsp-open" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) });
    const b1 = await prepareBuilder({ backend: withShim.backend, setup: "true" });
    expect((await sealGolden(b1, { backend: withShim.backend, hostId: "h1", smoke: "true" })).version.browserShim).toBe(true);

    const without = recordingBackend({}, { exec: cmd => (cmd === "test -x /usr/local/bin/wsp-open" ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) });
    const b2 = await prepareBuilder({ backend: without.backend, setup: "true" });
    expect((await sealGolden(b2, { backend: without.backend, hostId: "h1", smoke: "true" })).version.browserShim).toBe(false);
  });

  it("seal reads the vault off the builder before it asks for the snapshot, and hands it back with the version", async () => {
    const paths = ["/root/.config/gh/hosts.yml", "/etc/profile.d/wsp-secrets.sh"];
    const order: string[] = [];
    const { backend, timeline } = recordingBackend({}, {
      exec: cmd => {
        if (cmd.startsWith("for p in ") && cmd.includes(paths[0]!)) {
          order.push("vault");
          return { exitCode: 0, stdout: `${paths.join("\n")}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      snapshot: () => order.push("snapshot"),
    });
    const b = await prepareBuilder({ backend, setup: "true" });
    const sealed = await sealGolden(b, { backend, hostId: "h1", smoke: "true", vaultPaths: paths, fetch: vaultFetch() });
    expect(order).toEqual(["vault", "snapshot"]);
    expect(timeline.indexOf("snapshot m1")).toBeGreaterThan(-1);
    expect(sealed.vault).toMatchObject({ paths: 2, sha256: createHash("sha256").update(VAULT_TGZ).digest("hex") });
    expect(sealed.vault!.tar.equals(VAULT_TGZ)).toBe(true);
  });

  it("a seal that names no vault paths takes none and asks the builder nothing about them", async () => {
    const asked: string[] = [];
    const { backend } = recordingBackend({}, { exec: cmd => (asked.push(cmd), { exitCode: 0, stdout: "", stderr: "" }) });
    const b = await prepareBuilder({ backend, setup: "true" });
    const sealed = await sealGolden(b, { backend, hostId: "h1", smoke: "true" });
    expect(sealed.vault).toBeUndefined();
    expect(asked.some(c => c.startsWith("tar czf"))).toBe(false);
    // The one probe such a seal runs is the guard's own, over the paths a builder may never hold.
    expect(asked.filter(c => c.startsWith("for p in "))).toHaveLength(1);
  });

  it("a vault the builder would not hand over leaves it alive and unsnapshotted, as a refused snapshot does", async () => {
    const { backend, timeline, killed } = recordingBackend({}, {
      exec: cmd => (cmd.startsWith("tar czf") ? { exitCode: 2, stdout: "", stderr: "tar: cannot read" } : { exitCode: 0, stdout: cmd.includes("/etc/profile.d/wsp-secrets.sh") ? "/etc/profile.d/wsp-secrets.sh\n" : "", stderr: "" }),
    });
    const b = await prepareBuilder({ backend, setup: "true" });
    await expect(sealGolden(b, { backend, hostId: "h1", smoke: "true", vaultPaths: ["/etc/profile.d/wsp-secrets.sh"], fetch: vaultFetch() })).rejects.toThrow(/vault export tar failed/);
    expect(timeline).toEqual(["create m1"]);
    expect(killed).toEqual([]);
  });

  it("a builder that will not say which vault paths it holds stops the seal, rather than sealing an image with no sign-ins in it", async () => {
    const { backend, timeline, killed } = recordingBackend({}, {
      exec: cmd => (cmd.startsWith("for p in ") && cmd.includes("/root/.codex/auth.json") ? { exitCode: 127, stdout: "", stderr: "bash: for: command not found" } : { exitCode: 0, stdout: "", stderr: "" }),
    });
    const b = await prepareBuilder({ backend, setup: "true" });
    await expect(sealGolden(b, { backend, hostId: "h1", smoke: "true", vaultPaths: ["/root/.codex/auth.json"], fetch: vaultFetch() })).rejects.toThrow(/would not say which/);
    expect(timeline).toEqual(["create m1"]);
    expect(killed).toEqual([]);
  });

  it("a builder holding a sign-in file is refused before the snapshot: nothing is sealed and the builder is left as it is", async () => {
    const { backend, timeline, killed } = recordingBackend({}, {
      exec: cmd => (cmd.includes("/root/.claude-cfg/.credentials.json") ? { exitCode: 0, stdout: "/root/.claude-cfg/.credentials.json\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }),
    });
    const b = await prepareBuilder({ backend, setup: "true" });
    const err = await sealGolden(b, { backend, hostId: "h1", smoke: "true", vaultPaths: ["/etc/profile.d/wsp-secrets.sh"], fetch: vaultFetch() }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(CredentialOnBuilderError);
    expect((err as CredentialOnBuilderError).paths).toEqual(["/root/.claude-cfg/.credentials.json"]);
    expect((err as Error).message).toBe(credentialOnBuilderLine(["/root/.claude-cfg/.credentials.json"]));
    expect(timeline).toEqual(["create m1"]);
    expect(killed).toEqual([]);
  });

  it("a builder holding none of them seals, and the paths it was asked about are the catalog's own", async () => {
    const asked: string[] = [];
    const { backend } = recordingBackend({}, { exec: cmd => (asked.push(cmd), { exitCode: 0, stdout: "", stderr: "" }) });
    const b = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(b, { backend, hostId: "h1", smoke: "true" });
    expect(version.version).toBe(1);
    const probe = asked.find(c => c.startsWith("for p in "))!;
    for (const path of NEVER_IN_IMAGE) expect(probe).toContain(path);
  });

  it("seal syncs the builder's disk before it asks for the snapshot, and says so on the snapshot stage first", async () => {
    const order: string[] = [];
    const { backend, inline } = recordingBackend({}, {
      exec: cmd => {
        if (cmd === DISK_SYNC_CMD) order.push("sync");
        return { exitCode: 0, stdout: cmd === DISK_SYNC_CMD ? "Dirty: 0\nWriteback: 0\n" : "", stderr: "" };
      },
      snapshot: () => order.push("snapshot"),
    });
    const { stages, onStage } = stageRecorder();
    const b = await prepareBuilder({ backend, setup: "true" });
    await sealGolden(b, { backend, hostId: "h1", smoke: "true", onStage });
    expect(order).toEqual(["sync", "snapshot"]);
    expect(inline.filter(x => x.cmd === DISK_SYNC_CMD)).toEqual([{ id: "m1", cmd: DISK_SYNC_CMD, timeoutMs: INLINE_EXEC_MS }]);
    expect(stages.filter(s => s.startsWith("snapshotting"))).toEqual(["snapshotting:syncing the disk", "snapshotting:snapshotting, usually under a minute"]);
  });

  it("a sync the builder fails stops the seal before the snapshot and leaves the builder alive, the sentence on the failed stage", async () => {
    const res = { exitCode: 1, stdout: "", stderr: "sync: Input/output error" };
    const { backend, timeline, killed } = recordingBackend({ [DISK_SYNC_CMD]: res });
    const { stages, onStage } = stageRecorder();
    const b = await prepareBuilder({ backend, setup: "true" });
    const err = await sealGolden(b, { backend, hostId: "h1", smoke: "true", onStage }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(DiskSyncError);
    expect(timeline).toEqual(["create m1"]);
    expect(killed).toEqual([]);
    expect(stages.at(-1)).toBe(`failed:${diskSyncFailedLine(machineAnswer(res))}`);
  });

  it("a disk a writer keeps dirty past the sync seals anyway, with what was left said on the snapshot stage", async () => {
    const { backend, timeline } = recordingBackend({ [DISK_SYNC_CMD]: { exitCode: 0, stdout: "Dirty: 12288\nWriteback: 0\n", stderr: "" } });
    const { stages, onStage } = stageRecorder();
    const b = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(b, { backend, hostId: "h1", smoke: "true", onStage });
    expect(version.snapshotId).toBe("snap_wsp-h1-default-v1");
    expect(timeline).toContain("snapshot m1");
    expect(stages.filter(s => s.startsWith("snapshotting"))).toEqual([
      "snapshotting:syncing the disk",
      "snapshotting:synced, Dirty 12 MB and Writeback 0 B remain; a writer is still running",
      "snapshotting:snapshotting, usually under a minute",
    ]);
  });

  it("seal records the disk the snapshot took, read once for the stage line and the version", async () => {
    const { backend } = recordingBackend({ [USED_KB_CMD]: { exitCode: 0, stdout: "13631488\n", stderr: "" } });
    const b = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(b, { backend, hostId: "h1", smoke: "true" });
    expect(version.usedBytes).toBe(13631488 * 1024);
  });

  it("a used column of zero is a disk nothing has been written to, not a df that could not be read", async () => {
    const { backend } = recordingBackend({ [USED_KB_CMD]: { exitCode: 0, stdout: "0\n", stderr: "" } });
    const b = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(b, { backend, hostId: "h1", smoke: "true" });
    expect(version.usedBytes).toBe(0);
  });

  it("seal stamps the logins it is given onto the version, name and state only", async () => {
    const { backend } = recordingBackend();
    const b = await prepareBuilder({ backend, setup: "true" });
    const logins = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "skipped" as const }];
    const { version } = await sealGolden(b, { backend, hostId: "h1", smoke: "true", logins });
    expect(version.logins).toEqual(logins);
    const b2 = await prepareBuilder({ backend, setup: "true" });
    expect((await sealGolden(b2, { backend, hostId: "h1", smoke: "true" })).version.logins).toBeUndefined();
  });

  it("seal retries a kill the provider accepted without acting on, and forks only once the builder reads gone", async () => {
    const { backend, timeline } = recordingBackend({}, { ignoreKill: (id, nth) => id === "m1" && nth === 1 });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", killConfirm: FAST_KILL, onStage });
    expect(version.version).toBe(1);
    expect(stages.at(-1)).toBe("sealed:v1");
    expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "kill m1", "create m2", "kill m2"]);
    expect(await builder.machine.state()).toBe("gone");
  });

  it("seal fails with a typed error when the builder outlives three kills, and never boots the smoke fork", async () => {
    const { backend, created, timeline, deletedSnapshots } = recordingBackend({}, { ignoreKill: () => true });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const err = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", killConfirm: FAST_KILL, onStage }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(MachineAliveError);
    expect(err).toMatchObject({ kind: "machineAlive", machineId: "m1", state: "running" });
    expect((err as Error).message).toMatch(/m1/);
    expect(created).toHaveLength(1);
    expect(timeline.filter(t => t === "kill m1").length).toBeGreaterThanOrEqual(2);
    expect(deletedSnapshots).toEqual(["snap_wsp-h1-default-v1"]);
    expect(stages.at(-1)).toMatch(/^failed:/);
  });

  it("a smoke fork that outlives its kills still seals the proven image, and the sealed stage names the leak", async () => {
    const { backend, timeline, deletedSnapshots } = recordingBackend({}, { ignoreKill: id => id === "m2" });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { manifest } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", killConfirm: FAST_KILL, onStage });
    expect(manifest.head).toBe(1);
    expect(deletedSnapshots).toEqual([]);
    expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "create m2", "kill m2", "kill m2", "kill m2"]);
    expect(stages.at(-1)).toMatch(/^sealed:v1; machine m2 is still running after three kills/);
  });

  it("a backend that refuses the seal's snapshot as notFirstLife ends it with that error, and the builder is left as it was", async () => {
    const { backend, timeline, snapshots } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const err = await sealGolden({ ...builder, firstLife: false }, { backend, hostId: "h1", smoke: "true" }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(NotFirstLifeError);
    expect((err as NotFirstLifeError).kind).toBe("notFirstLife");
    expect((err as NotFirstLifeError).machineId).toBe("m1");
    expect(snapshots).toEqual([]);
    expect(timeline).toEqual(["create m1"]);
  });

  it("seals a builder that was resumed on a backend whose snapshots are a copy of the disk", async () => {
    const { backend, snapshots } = recordingBackend({}, { snapshotsAnyLife: true });
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { manifest } = await sealGolden({ ...builder, firstLife: false }, { backend, hostId: "h1", smoke: "true" });
    expect(manifest.head).toBe(1);
    expect(snapshots).toEqual(["wsp-h1-default-v1"]);
  });

  it("asks for no root disk on a backend whose machines take no disk request, and boots from the image it names", async () => {
    const { backend, created } = recordingBackend();
    Object.assign(backend, {
      pricing: { ...backend.pricing, builderDiskGb: undefined },
      baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
    });
    const builder = await prepareBuilder({ backend, setup: "true" });
    await sealGolden(builder, { backend, hostId: "h1", smoke: "true" });
    expect(created[0]!.diskGb).toBeUndefined();
    expect(created[0]!.template).toBe("ubuntu:24.04");
    expect(created[1]!.diskGb).toBeUndefined();
  });

  it("a snapshot the provider refuses with its 502 is asked for three times while the builder reads running, each attempt a stage line with the provider's answer; then the seal fails typed and the builder is left as it was", async () => {
    const { backend, killed, timeline } = recordingBackend({}, { snapshot: (_id, nth) => { throw refusedSnapshot(`req_${nth}`); } });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "a" });
    const err = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage, snapshotRetryMs: 1 }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(SnapshotFailedError);
    expect(err).toMatchObject({ kind: "snapshotFailed", machineId: "m1", attempts: 3, builderState: "running", answer: { status: 502, message: "Failed to snapshot sandbox", requestId: "req_3" } });
    expect(timeline).toEqual(["create m1", "snapshot m1", "snapshot m1", "snapshot m1"]);
    expect(killed).toEqual([]);
    expect(sansBase(stages).slice(-4)).toEqual([
      "snapshotting:snapshotting, usually under a minute",
      "snapshotting:attempt 1 of 3 answered 502 Failed to snapshot sandbox (request req_1); the builder reads running, next attempt in 1ms",
      "snapshotting:attempt 2 of 3 answered 502 Failed to snapshot sandbox (request req_2); the builder reads running, next attempt in 1ms",
      "failed:the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_3) while the builder read running",
    ]);
  });

  it("a snapshot that lands on the second attempt seals as any other", async () => {
    const { backend, timeline } = recordingBackend({}, { snapshot: (_id, nth) => { if (nth === 1) throw refusedSnapshot("req_1"); } });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "a" });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage, snapshotRetryMs: 1 });
    expect(version.snapshotId).toBe("snap_wsp-h1-default-v1");
    expect(timeline).toEqual(["create m1", "snapshot m1", "snapshot m1", "kill m1", "create m2", "kill m2"]);
    expect(stages.at(-1)).toBe("sealed:v1");
  });

  it("a refused snapshot on a builder the provider answers 404 for ends at the first attempt: nothing is killed and the error says the provider no longer has it", async () => {
    const { backend, killed, timeline, gone } = recordingBackend({}, { snapshot: id => { gone.add(id); throw refusedSnapshot("req_1"); } });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "a" });
    const err = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage, snapshotRetryMs: 1 }).catch(e => e as unknown);
    expect(err).toMatchObject({ kind: "snapshotFailed", attempts: 1, builderState: "gone" });
    expect(timeline).toEqual(["create m1", "snapshot m1"]);
    expect(killed).toEqual([]);
    expect(stages.at(-1)).toBe("failed:the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_1) and no longer has the builder (404)");
  });

  it("a refused snapshot whose read of the builder fails with anything but 404 ends at once with the builder unread and untouched", async () => {
    const { backend, killed, timeline } = recordingBackend({}, { snapshot: () => { throw refusedSnapshot("req_1"); }, state: () => { throw Object.assign(new Error("upstream sad"), { kind: "transient", status: 503 }); } });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "a" });
    const err = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage, snapshotRetryMs: 1 }).catch(e => e as unknown);
    expect(err).toMatchObject({ kind: "snapshotFailed", attempts: 1, builderState: "unread", readError: "upstream sad" });
    expect(timeline).toEqual(["create m1", "snapshot m1"]);
    expect(killed).toEqual([]);
    expect(stages.at(-1)).toBe("failed:the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_1) and could not be read about the builder (upstream sad)");
  });

  it("any other snapshot failure is not asked again and leaves the builder as it was: a snapshot that failed changed nothing on it", async () => {
    const { backend, killed, timeline } = recordingBackend({}, { snapshot: () => { throw Object.assign(new Error("upstream sad"), { kind: "transient", status: 503 }); } });
    const builder = await prepareBuilder({ backend, setup: "a" });
    const err = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", snapshotRetryMs: 1 }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(SnapshotFailedError);
    expect((err as SnapshotFailedError).builderState).toBe("running");
    expect((err as Error).message).toBe("the snapshot failed 1 time: the provider answered 503 upstream sad (no request id from the provider, at " + (err as SnapshotFailedError).answer.at + ") while the builder read running");
    expect(timeline).toEqual(["create m1", "snapshot m1"]);
    expect(killed).toEqual([]);
  });

  it("a snapshot job that failed on a computer you own, with no status of its own, is reported as the provider's 500 and leaves the builder; the next seal snapshots the same builder", async () => {
    const { backend, killed, timeline } = recordingBackend({}, { snapshot: (_id, nth) => { if (nth === 1) throw new Error("machine.snapshotJob on spoo was not answered in 300s"); } });
    const builder = await prepareBuilder({ backend, setup: "a" });
    const err = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", snapshotRetryMs: 1 }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(SnapshotFailedError);
    expect((err as SnapshotFailedError).answer).toMatchObject({ status: 500, message: "machine.snapshotJob on spoo was not answered in 300s" });
    expect(killed).toEqual([]);
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", snapshotRetryMs: 1 });
    expect(version.snapshotId).toBe("snap_wsp-h1-default-v1");
    expect(timeline.slice(0, 3)).toEqual(["create m1", "snapshot m1", "snapshot m1"]);
  });

  it("what the provider says of the snapshot as it writes it reaches the stage as bytes written, over the whole once it is counted", async () => {
    const { backend } = recordingBackend({}, { snapshotProgress: [{ bytes: 0 }, { bytes: 1024 * MIB, total: 5 * 1024 * MIB }, { bytes: 5 * 1024 * MIB + 90 * MIB, total: 5 * 1024 * MIB }] });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage });
    expect(stages.filter(s => s.startsWith("snapshotting"))).toEqual([
      "snapshotting:syncing the disk",
      "snapshotting:snapshotting, usually under a minute",
      "snapshotting:snapshotting, 0 B written",
      "snapshotting:snapshotting, 1 GB of about 5 GB written",
      "snapshotting:snapshotting, 5.1 GB of about 5 GB written",
    ]);
  });

  it("the snapshot's size is what the backend says the machine wrote, where it can say, and df inside is never asked then", async () => {
    const { backend, inline } = recordingBackend({ [USED_KB_CMD]: { exitCode: 0, stdout: "50000000\n", stderr: "" } }, { built: () => ({ cpu: 2, memMb: 4096, usedBytes: 5284823040 }) });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage });
    expect(version.usedBytes).toBe(5284823040);
    expect(stages.filter(s => s.startsWith("snapshotting"))).toEqual(["snapshotting:syncing the disk", "snapshotting:snapshotting about 4.9 GB, usually under a minute"]);
    expect(inline.filter(x => x.cmd === USED_KB_CMD)).toEqual([]);
  });

  it("a failed seal kills every machine, drops the snapshot, and leaves the prior manifest untouched", async () => {
    const { backend, killed, deletedSnapshots } = recordingBackend({ smoke: { exitCode: 2, stdout: "", stderr: "broken" } });
    const { stages, onStage } = stageRecorder();
    const one = await buildGolden({ backend, hostId: "h1", setup: "a", smoke: "true" });
    const before = JSON.stringify(one.manifest);
    const builder = await prepareBuilder({ backend, setup: "b" });
    await expect(sealGolden(builder, { backend, hostId: "h1", smoke: "smoke", manifest: one.manifest, onStage })).rejects.toThrow(/smoke failed/);
    expect(JSON.stringify(one.manifest)).toBe(before);
    expect(killed).toEqual(["m1", "m2", "m3", "m4"]);
    expect(deletedSnapshots).toEqual(["snap_wsp-h1-default-v2"]);
    expect(stages.at(-1)).toMatch(/^failed:golden smoke failed/);
  });
});

describe("golden templates", () => {
  const FAST_WAIT = { readyMs: 50, pollMs: 1 };

  it("on a backend with templates the seal promotes the snapshot under wsp-<host>-<golden>-v<n> after the builder is killed, waits for ready, records the id, and the smoke fork boots from the template", async () => {
    const { backend, created, timeline, promoted } = recordingBackend({}, { templates: true });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "echo setup", onStage });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "claude --version", onStage, name: "work", templateWait: FAST_WAIT });
    expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "promote snap_wsp-h1-work-v1", "create m2", "kill m2"]);
    expect(promoted).toEqual([{ snapshotId: "snap_wsp-h1-work-v1", name: "wsp-h1-work-v1" }]);
    expect(created[1]).toMatchObject({ kind: "sandbox", template: "tpl_snap_wsp-h1-work-v1" });
    expect(created[1]!.fromSnapshot).toBeUndefined();
    expect(version).toMatchObject({ version: 1, snapshotId: "snap_wsp-h1-work-v1", templateId: "tpl_snap_wsp-h1-work-v1" });
    expect(sansBase(stages).slice(4)).toEqual([
      "snapshotting:syncing the disk", "snapshotting:snapshotting, usually under a minute", "promoting:saving the image", "promoting:the image is saved", "smoke-forking:claude --version", "smoke-forking:1 agent answers: Claude Code", "sealed:v1",
    ]);
  });

  it("the snapshot and its template carry the same name, the host and the golden in it, the golden defaulting to the store's default key: one rule", async () => {
    const { backend, promoted, snapshots } = recordingBackend({}, { templates: true });
    await buildGolden({ backend, hostId: "h1", setup: "true", smoke: "true" });
    expect(promoted.map(p => p.name)).toEqual(["wsp-h1-default-v1"]);
    expect(snapshots).toEqual(["wsp-h1-default-v1"]);
    expect(goldenName("h1", "default", 1)).toBe("wsp-h1-default-v1");
    expect(goldenName("9f3a1c2b", "default", 12)).toBe("wsp-9f3a1c2b-default-v12");
    expect(goldenName("9f3a1c2b", "default", 12)).toMatch(/^[a-z0-9-]+$/);
  });

  it("a template still building is read again until ready, each read a promoting line", async () => {
    const { backend } = recordingBackend({}, { templates: true, templateStatus: (_id, nth) => (nth < 3 ? "building" : "ready") });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage, templateWait: FAST_WAIT });
    expect(version.templateId).toBe("tpl_snap_wsp-h1-default-v1");
    expect(stages.filter(s => s.startsWith("promoting"))).toEqual([
      "promoting:saving the image", "promoting:saving the image, the provider says building; asking again", "promoting:saving the image, the provider says building; asking again", "promoting:the image is saved",
    ]);
  });

  it("a rollback the provider refuses is its own line on the stage that failed, with the machine named in left; the failure's line stays the failure's own", async () => {
    const refusal = Object.assign(new Error("getaddrinfo ENOTFOUND api.getsolari.com"), { code: "ENOTFOUND" });
    const { backend } = recordingBackend({ "claude --version": { exitCode: 1, stdout: "", stderr: "the fork did not boot" } }, { templates: true, refuseKill: id => (id === "m2" ? refusal : undefined) });
    const frames: { stage: string; detail: string | undefined; left: readonly string[] | undefined }[] = [];
    const builder = await prepareBuilder({ backend, setup: "true" });
    await expect(sealGolden(builder, { backend, hostId: "h1", smoke: "claude --version", onStage: (stage, detail, _step, left) => frames.push({ stage, detail, left }), templateWait: FAST_WAIT })).rejects.toThrow(/the fork did not boot/);
    const failed = frames.at(-1)!;
    expect(failed.stage).toBe("failed");
    expect(failed.detail).toMatch(/^golden smoke failed .*the fork did not boot$/);
    expect(failed.detail).not.toContain("ENOTFOUND");
    expect(failed.left).toEqual(["m2"]);
    expect(frames.at(-2)).toEqual({ stage: "smoke-forking", detail: "the machine could not be removed and bills on: getaddrinfo ENOTFOUND api.getsolari.com", left: undefined });
  });

  it("the seal's lines say what a person can use: the snapshot's size read off the builder's disk and that the image is being saved, never the snapshot's or the template's name", async () => {
    const { backend } = recordingBackend({ [USED_KB_CMD]: { exitCode: 0, stdout: "13631488\n", stderr: "" } }, { templates: true });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage, templateWait: FAST_WAIT });
    expect(stages.filter(s => s.startsWith("snapshotting"))).toEqual(["snapshotting:syncing the disk", "snapshotting:snapshotting about 13 GB, usually under a minute"]);
    expect(stages.filter(s => s.startsWith("promoting"))).toEqual(["promoting:saving the image", "promoting:the image is saved"]);
    expect(stages.some(s => s.includes("wsp-h1") || s.includes("tpl_"))).toBe(false);
  });

  it("a template the provider fails ends the seal with its reason before any smoke fork, and the template goes before the snapshot", async () => {
    const { backend, created, deletedSnapshots, deletedTemplates } = recordingBackend({}, { templates: true, templateStatus: () => "failed" });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    await expect(sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage, templateWait: FAST_WAIT })).rejects.toThrow("the provider failed the template tpl_snap_wsp-h1-default-v1: restore copy failed");
    expect(created).toHaveLength(1);
    expect(deletedTemplates).toEqual(["tpl_snap_wsp-h1-default-v1"]);
    expect(deletedSnapshots).toEqual(["snap_wsp-h1-default-v1"]);
    expect(stages.at(-1)).toBe("failed:the provider failed the template tpl_snap_wsp-h1-default-v1: restore copy failed");
  });

  it("a template that never reads ready inside the wait ends the seal naming the last status and the wait", async () => {
    const { backend } = recordingBackend({}, { templates: true, templateStatus: () => "building" });
    const builder = await prepareBuilder({ backend, setup: "true" });
    await expect(sealGolden(builder, { backend, hostId: "h1", smoke: "true", templateWait: { readyMs: 20, pollMs: 1 } })).rejects.toThrow("the template tpl_snap_wsp-h1-default-v1 still reads building after 20ms");
  });

  it("forkGolden and the update's builder boot a durable version from its template and a version without one from its snapshot", async () => {
    const { backend, created } = recordingBackend({}, { templates: true });
    const { manifest, version } = await buildGolden({ backend, hostId: "h1", setup: "true", smoke: "true" });
    await forkGolden(backend, manifest);
    await upgradeBuilder({ backend, head: version, delta: { import: { recipeHash: "h2", tools: [], agents: [] }, retired: [], retiredOnImage: [] }, setup: "true" });
    expect(created.slice(2).map(c => [c.template, c.fromSnapshot])).toEqual([["tpl_snap_wsp-h1-default-v1", undefined], ["tpl_snap_wsp-h1-default-v1", undefined]]);
    const { templateId: _t, ...volatile } = version;
    await forkGolden(backend, { head: 1, versions: [volatile] });
    await upgradeBuilder({ backend, head: volatile, delta: { import: { recipeHash: "h3", tools: [], agents: [] }, retired: [], retiredOnImage: [] }, setup: "true" });
    expect(created.slice(4).map(c => [c.template, c.fromSnapshot])).toEqual([[undefined, "snap_wsp-h1-default-v1"], [undefined, "snap_wsp-h1-default-v1"]]);
  });

  it("a backend whose capabilities lack templates, or that lacks one of the calls, has no template road", async () => {
    const { backend } = recordingBackend({}, { templates: true });
    expect(templatesOf(backend)).toBeDefined();
    expect(templatesOf(recordingBackend().backend)).toBeUndefined();
    const { deleteTemplate: _d, ...partial } = backend;
    expect(templatesOf(partial)).toBeUndefined();
  });

  it("promoteVersion always mints a fresh template under this host's name, never adopting one by name, and counts the templates that already carry it", async () => {
    const { backend, promoted, templates } = recordingBackend({}, { templates: true });
    templates.set("tpl_his", { id: "tpl_his", name: "wsp-default-v1", status: "ready" });
    templates.set("tpl_other_host", { id: "tpl_other_host", name: "wsp-h1-default-v1", status: "ready" });
    const road = templatesOf(backend)!;
    expect(await promoteVersion(road, "snap_v1", "wsp-h1-default-v1", FAST_WAIT)).toEqual({ templateId: "tpl_snap_v1", sharing: 1 });
    expect(await promoteVersion(road, "snap_v2", "wsp-h1-default-v2", FAST_WAIT)).toEqual({ templateId: "tpl_snap_v2", sharing: 0 });
    expect(promoted).toEqual([{ snapshotId: "snap_v1", name: "wsp-h1-default-v1" }, { snapshotId: "snap_v2", name: "wsp-h1-default-v2" }]);
    expect(templates.has("tpl_his")).toBe(true);
  });

  it("promoteVersion deletes the template it promoted when the ready wait fails or runs out, so nothing stands on the snapshot unrecorded, and the failure keeps the provider's words", async () => {
    const failed = recordingBackend({}, { templates: true, templateStatus: () => "failed" });
    await expect(promoteVersion(templatesOf(failed.backend)!, "snap_v1", "wsp-h1-default-v1", FAST_WAIT)).rejects.toThrow("the provider failed the template tpl_snap_v1: restore copy failed");
    expect(failed.deletedTemplates).toEqual(["tpl_snap_v1"]);
    expect(failed.templates.size).toBe(0);
    const slow = recordingBackend({}, { templates: true, templateStatus: () => "building" });
    await expect(promoteVersion(templatesOf(slow.backend)!, "snap_v1", "wsp-h1-default-v1", { readyMs: 20, pollMs: 1 })).rejects.toThrow("the template tpl_snap_v1 still reads building after 20ms");
    expect(slow.deletedTemplates).toEqual(["tpl_snap_v1"]);
  });

  it("a smoke that fails after the template read ready still deletes the template before the snapshot", async () => {
    const { backend, deletedSnapshots, deletedTemplates } = recordingBackend({ smoke: { exitCode: 2, stdout: "", stderr: "broken" } }, { templates: true });
    const builder = await prepareBuilder({ backend, setup: "true" });
    await expect(sealGolden(builder, { backend, hostId: "h1", smoke: "smoke", templateWait: FAST_WAIT })).rejects.toThrow(/smoke failed/);
    expect(deletedTemplates).toEqual(["tpl_snap_wsp-h1-default-v1"]);
    expect(deletedSnapshots).toEqual(["snap_wsp-h1-default-v1"]);
  });

  it("promoteVersion leaves the count out when the provider will not give the listing, and the promote still lands", async () => {
    const { backend } = recordingBackend({}, { templates: true });
    backend.listTemplates = async () => {
      throw Object.assign(new Error("upstream unavailable"), { kind: "unavailable", status: 502 });
    };
    expect(await promoteVersion(templatesOf(backend)!, "snap_v1", "wsp-h1-default-v1", FAST_WAIT)).toEqual({ templateId: "tpl_snap_v1" });
  });
});

describe("golden disk", () => {
  it("every create asks for the 20 GB disk: the builder, the smoke fork, a workspace fork and an upgrade fork", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { manifest, version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true" });
    await forkGolden(backend, manifest);
    await upgradeBuilder({ backend, head: version, delta: { import: { recipeHash: "h2", tools: [], agents: [] }, retired: [], retiredOnImage: [] }, setup: "true" });
    expect(created.map(c => c.diskGb)).toEqual([BUILDER_DISK_GB, BUILDER_DISK_GB, BUILDER_DISK_GB, BUILDER_DISK_GB]);
    expect(BUILDER_DISK_GB).toBe(20);
  });
});

describe("golden size", () => {
  /** A provider that clamps memory to 2048 MB whatever is asked. */
  const clamped = (spec: MachineSpec): MachineShape => ({ cpu: spec.cpu ?? 2, memMb: 2048, createdAt: "2026-09-02T00:00:00.000Z" });

  it("prepare asks for an explicit size, the pricing default when none is named, and records what the provider built", async () => {
    const { backend, created } = recordingBackend({}, { built: clamped });
    const builder = await prepareBuilder({ backend, setup: "true" });
    expect(created[0]).toMatchObject({ cpu: 2, memMb: 4096 });
    expect(builder.size).toEqual({ cpu: 2, memMb: 2048 });
  });

  it("a backend that cannot describe machines is taken at its word on the request", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true", memMb: 8192 });
    expect(created[0]).toMatchObject({ cpu: 2, memMb: 8192 });
    expect(builder.size).toEqual({ cpu: 2, memMb: 8192 });
  });

  it("seal forks the smoke at the builder's size and records that size on the version", async () => {
    const { backend, created } = recordingBackend({}, { built: clamped });
    const builder = await prepareBuilder({ backend, setup: "true", memMb: 8192 });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true" });
    expect(created[1]).toMatchObject({ fromSnapshot: "snap_wsp-h1-default-v1", cpu: 2, memMb: 2048 });
    expect(version.size).toEqual({ cpu: 2, memMb: 2048 });
  });

  it("forkGolden inherits the sealed size unless overridden", async () => {
    const { backend, created } = recordingBackend();
    const { manifest } = await buildGolden({ backend, hostId: "h1", setup: "s", smoke: "true", memMb: 8192 });
    expect(manifest.versions[0]!.size).toEqual({ cpu: 2, memMb: 8192 });
    await forkGolden(backend, manifest);
    await forkGolden(backend, manifest, { cpu: 4 });
    expect(created[2]).toMatchObject({ cpu: 2, memMb: 8192 });
    expect(created[3]).toMatchObject({ cpu: 4, memMb: 8192 });
  });
});

describe("golden import stages", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const FREE_KB_CMD = "df -Pk /root | awk 'NR==2{print $4}'";
  const mb = (n: number) => String(n * 1024);
  const SWEEP_NEEDLE = "rm -rf /root/.npm /root/.cache/uv /root/.cache/go-build /root/.cache/node-gyp";

  function importOf(over: Partial<GoldenImport> = {}): GoldenImport {
    return {
      recipeHash: "h1",
      files: {
        count: 3,
        rungs: { identity: 1, shell: 2 },
        lands: [],
        bytes: 4096,
        skipped: [{ id: "shell/bashrc", path: "~/.bashrc", note: "no longer on this computer" }],
        pack: async () => ({ tar: Buffer.from("tgz-bytes"), bytes: 1200, unpacked: 4096, skipped: [], cut: [], silenced: [], macPaths: [] }),
      },
      tools: [
        { id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: "brew-bootstrap" },
        { id: "tools/brew/gh", label: "gh", manager: "brew", cmd: "brew install gh", after: "tools/homebrew" },
        { id: "tools/npm/bun", label: "bun@1.4.0", manager: "npm", cmd: "npm install -g bun@1.4.0" },
      ],
      agents: [
        { id: "agents/claude", name: "Claude Code", install: "claude-install", smoke: "claude --version", road: "script" as const },
        { id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version", road: "npm" as const },
      ],
      ...over,
    };
  }

  /** The fake answers exec by substring match, first hit wins; `free` is what df reports. */
  function backendFor(answers: [string, ExecResult | (() => ExecResult)][] = [], free: string | (() => string) = mb(3000)) {
    const cmds: string[] = [];
    const puts: Buffer[] = [];
    const rb = recordingBackend({}, {
      exec: cmd => {
        cmds.push(cmd);
        const hit = answers.find(([needle]) => cmd.includes(needle));
        if (hit) return typeof hit[1] === "function" ? hit[1]() : hit[1];
        if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${typeof free === "function" ? free() : free}\n`, stderr: "" };
        if (cmd === "echo ok") return REACH_OK;
        if (cmd.includes("echo WSP_CTX")) return { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" };
        return ok;
      },
    });
    const fetchStub: typeof fetch = async (_url, init) => {
      puts.push(Buffer.from(init?.body as Uint8Array));
      return new Response(null, { status: 200 });
    };
    return { ...rb, cmds, puts, fetch: fetchStub };
  }

  it("writes the machine context after the stages: the plan's own skips in its facts, one hook per installed agent, a claimed hook named in the result", async () => {
    const probe = "WSP_CTX\nKERNEL 6.6.30\nDISK 20466256 11720704\nOVERLAY no\nAGENT claude\nAGENT codex\nAGENT pi\nCONFLICT pi\nSHELL zsh\nWSP_CTX_END\n";
    const { backend, cmds, puts, fetch } = backendFor([["echo WSP_CTX", { exitCode: 0, stdout: probe, stderr: "" }]]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const skippedTools = [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ skippedTools, onResult: r => void results.push(r) }) });
    expect(results[0]!.tools[0]).toEqual({ id: "tools/brew-cask/raycast", label: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" });
    expect(results[0]!.context).toEqual([
      { agent: "claude", outcome: "written", path: "/etc/claude-code/CLAUDE.md", skill: "/etc/claude-code/.claude/skills/wsp-machine/SKILL.md" },
      { agent: "codex", outcome: "written", path: "/etc/codex/requirements.toml", skill: "/etc/codex/skills/wsp-machine/SKILL.md" },
      { agent: "pi", outcome: "fallback", path: "/root/.pi/agent/extensions/wsp-machine.ts", note: "~/.pi/agent/APPEND_SYSTEM.md already exists", skill: "/root/.pi/agent/skills/wsp-machine/SKILL.md" },
    ]);
    expect(results[0]!.contextFailure).toBeUndefined();
    expect(stages.at(-2)).toMatch(/^installing-mcp:machine context: \d+(\.\d+)? KB written for Claude Code, Codex; Pi by its fallback \(~\/\.pi\/agent\/APPEND_SYSTEM\.md already exists\)$/);
    // The texts go up as one archive after the person's files and are untarred at the root before the reach check.
    const write = cmds.findIndex(c => c.includes("tar xzf - -C '/' "));
    expect(write).toBeGreaterThan(cmds.findIndex(c => c.includes("echo WSP_CTX")));
    expect(cmds.indexOf("echo ok")).toBeGreaterThan(write);
    expect(cmds.some(c => c.includes("base64 --decode"))).toBe(false);
    expect(puts).toHaveLength(2);
    const tgz = puts[1]!;
    const skill = fileIn(tgz, "etc/wsp/skills/wsp-machine/SKILL.md");
    expect(skill).toContain("- This machine is a golden builder, not a workspace yet.");
    expect(skill).toContain("- Golden: not sealed yet.");
    expect(skill).toContain("- Tools that did not install: Raycast (macOS app, no Linux build).");
    expect(namesIn(tgz)).toContain("etc/wsp/machine-context.json");
    expect(namesIn(tgz).some(n => n.endsWith("APPEND_SYSTEM.md"))).toBe(false);
  });

  it("a refused context upload is a failure the result counts, not the end of the build", async () => {
    const { backend, cmds } = backendFor();
    const puts: Buffer[] = [];
    // The person's files go up first and land; the context archive is the second PUT.
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      puts.push(Buffer.from(init?.body as Uint8Array));
      return puts.length === 2 ? new Response(JSON.stringify({ error: "Payload Too Large", limit: 1024 }), { status: 413 }) : new Response(null, { status: 200 });
    };
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    const failure = "write failed: vault import upload failed: HTTP 413 Payload Too Large; the upload takes at most 1024 bytes per PUT";
    expect(stages).toContain(`installing-mcp:machine context: not written (${failure})`);
    expect(results[0]!.context).toEqual([]);
    expect(results[0]!.contextFailure).toBe(failure);
    // The stage is applied only once the context landed, so a later attach runs the write again.
    expect(builder.import?.applied).not.toContain("installing-mcp");
    expect(cmds.at(-1)).toBe("echo ok");
  });

  it("a context write that failed on the build runs again on attach, and the MCP stage is marked applied only once it landed", async () => {
    const { backend, cmds, puts, fetch: accept } = backendFor();
    // The person's files are the first PUT; the build's context archive is the second and is refused, the attach's goes through.
    const refused = new Set([1]);
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (!refused.has(puts.length)) return accept(url, init);
      puts.push(Buffer.from(init?.body as Uint8Array));
      return new Response(JSON.stringify({ error: "Payload Too Large", limit: 1024 }), { status: 413 });
    };
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    expect(builder.import?.applied).toEqual(["applying-setup", "uploading-files", "installing-harness", "installing-tools"]);
    const before = { cmds: cmds.length, puts: puts.length };
    const { stages, onStage } = stageRecorder();
    const again = await applyGoldenImport(builder.machine, { import: importOf(), setup: "true", ledger: builder.import, fetch, onStage });
    expect(stages).toEqual([
      "applying-setup:already applied",
      "uploading-files:already applied",
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:none configured",
      CONTEXT_WRITTEN,
    ]);
    expect(puts).toHaveLength(before.puts + 1);
    expect(namesIn(puts.at(-1)!)).toContain("etc/wsp/machine-context.json");
    expect(cmds.slice(before.cmds).map(c => (c.includes("echo WSP_CTX") ? "probe" : c.includes("tar xzf - -C '/' ") ? "write" : c))).toEqual(["probe", "write"]);
    expect(again.ledger.applied).toEqual(["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"]);
    // With the context on the machine, the next attach runs nothing.
    const third = stageRecorder();
    await applyGoldenImport(builder.machine, { import: importOf(), setup: "true", ledger: again.ledger, fetch, onStage: third.onStage });
    expect(third.stages.at(-1)).toBe("installing-mcp:already applied");
    expect(puts).toHaveLength(before.puts + 1);

    // A retry that fails again leaves the stage unmarked, so the attach after it tries once more.
    refused.add(puts.length + 1).add(puts.length + 2);
    const other = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const rec = stageRecorder();
    const still = await applyGoldenImport(other.machine, { import: importOf(), setup: "true", ledger: other.import, fetch, onStage: rec.onStage });
    expect(rec.stages.at(-1)).toMatch(/^installing-mcp:machine context: not written \(write failed: .*HTTP 413/);
    expect(still.ledger.applied).not.toContain("installing-mcp");
  });

  it("a retried context write names what the build left off the machine, and hands its outcome over in place of a result", async () => {
    const { backend, puts, fetch: accept } = backendFor();
    const refused = new Set([1]);
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (!refused.has(puts.length)) return accept(url, init);
      puts.push(Buffer.from(init?.body as Uint8Array));
      return new Response(JSON.stringify({ error: "Payload Too Large", limit: 1024 }), { status: 413 });
    };
    const skippedTools = [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }];
    const skippedAgents = [{ id: "agents/zed", name: "Zed", note: "no installer known" }];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ skippedTools, skippedAgents }) });
    expect(builder.import?.missingTools).toEqual([{ id: "tools/brew-cask/raycast", name: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" }]);
    const results: ImportResult[] = [];
    const outcomes: Pick<ImportResult, "context" | "contextFailure">[] = [];
    const plan = () => importOf({ skippedTools, skippedAgents, onResult: r => void results.push(r), onContext: o => void outcomes.push(o) });
    const again = await applyGoldenImport(builder.machine, { import: plan(), setup: "true", ledger: builder.import, fetch });
    // The skipped stages ran on the build: the ledger's tools, the plan's agents and files are the facts the guest gets.
    const tgz = puts.at(-1)!;
    expect(JSON.parse(fileIn(tgz, "etc/wsp/machine-context.json"))).toEqual({
      tools: [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }],
      agents: [{ id: "agents/zed", label: "Zed", note: "no installer known" }],
      files: [{ path: "~/.bashrc", note: "no longer on this computer" }],
    });
    const skill = fileIn(tgz, "etc/wsp/skills/wsp-machine/SKILL.md");
    expect(skill).toContain("- Tools that did not install: Raycast (macOS app, no Linux build).");
    expect(skill).toContain("- Agents that did not install: Zed (no installer known).");
    // The attach reports no result, so the saved one from the build stands; the write's outcome alone goes out.
    expect(results).toEqual([]);
    expect(outcomes).toEqual([{ context: [] }]);
    expect(again.result.tools).toEqual([]);
    expect(again.ledger.applied).toContain("installing-mcp");

    // A retry that fails again hands the new reason over the same way.
    refused.add(puts.length + 1).add(puts.length + 2);
    const other = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ skippedTools, skippedAgents }) });
    await applyGoldenImport(other.machine, { import: plan(), setup: "true", ledger: other.import, fetch });
    expect(results).toEqual([]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toEqual({ context: [], contextFailure: expect.stringMatching(/^write failed: .*HTTP 413/) });
  });

  it("a quiet attach whose MCP rewrite is refused hands nothing over: the build's write landed and its saved result stands", async () => {
    const { backend, puts, fetch: accept } = backendFor();
    const refused = new Set<number>();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (!refused.has(puts.length)) return accept(url, init);
      puts.push(Buffer.from(init?.body as Uint8Array));
      return new Response(JSON.stringify({ error: "Payload Too Large", limit: 1024 }), { status: 413 });
    };
    const mcp = { agents: [], guestHome: "/root", rewrites: [], binDirs: [], tools: [] };
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ mcp }) });
    expect(builder.import?.applied).toContain("installing-mcp");
    const outcomes: Pick<ImportResult, "context" | "contextFailure">[] = [];
    // The MCP plan rewrites the context on every attach; this one is refused.
    refused.add(puts.length);
    const { stages, onStage } = stageRecorder();
    const again = await applyGoldenImport(builder.machine, { import: importOf({ mcp, onContext: o => void outcomes.push(o) }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(stages.at(-1)).toMatch(/^installing-mcp:machine context: not written \(write failed: .*HTTP 413/);
    expect(again.ledger.applied).toContain("installing-mcp");
    expect(outcomes).toEqual([]);

    // A rewrite that lands is handed over as before: the same outcome the build saved.
    await applyGoldenImport(builder.machine, { import: importOf({ mcp, onContext: o => void outcomes.push(o) }), setup: "true", ledger: again.ledger, fetch });
    expect(outcomes).toEqual([{ context: [] }]);
  });

  it("an archive over one upload part says how many parts it went up in", async () => {
    const { backend, puts, fetch } = backendFor();
    const stages: string[] = [];
    const big = importOf({ files: { ...importOf().files!, pack: async () => ({ tar: Buffer.alloc(33 * 1024 * 1024), bytes: 33 * 1024 * 1024, unpacked: 4096, skipped: [], cut: [], silenced: [], macPaths: [] }) } });
    await prepareBuilder({ backend, setup: "true", fetch, onStage: (s, d) => void stages.push(`${s}:${d ?? ""}`), import: big });
    expect(puts).toHaveLength(3);
    expect(stages).toContainEqual("uploading-files:part 1 of 2, 32 MB of 33 MB");
    expect(stages).toContainEqual("uploading-files:part 2 of 2, 33 MB of 33 MB");
    expect(stages).toContainEqual(expect.stringMatching(/^uploading-files:33 MB in 2 parts in \d+(\.\d)?s; 2.9 GB free$/));
  });

  it("runs setup, upload, agents and then tools in order after the daemon, with a detail on every frame, and checks the machine still answers", async () => {
    const { backend, cmds, puts, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({
      backend, setup: "true", deployDaemon: async () => "node v22", fetch, onStage,
      import: importOf({ onResult: r => void results.push(r) }),
    });
    expect(sansBase(stages)).toEqual([
      "creating:sandbox from base",
      "deploying-daemon", "deploying-daemon:node v22; 2.9 GB free",
      "applying-setup:3 files: identity 1, shell 2",
      "applying-setup:1 KB packed; skipped ~/.bashrc (no longer on this computer)",
      "uploading-files:1 KB",
      expect.stringMatching(/^uploading-files:1 KB in \d+(\.\d)?s; 2.9 GB free$/),
      "installing-harness",
      "installing-harness:Claude Code (1/2)", "installing-harness:Codex (2/2)",
      "installing-harness:Claude Code, Codex installed; caches swept; 2.9 GB free",
      "installing-tools:Homebrew (1/3)", "installing-tools:gh (2/3)", "installing-tools:bun@1.4.0 (3/3)",
      "installing-tools:3 installed; caches swept; 2.9 GB free",
      "installing-mcp:none configured",
      CONTEXT_WRITTEN,
      "ready",
    ]);
    expect(puts[0]).toEqual(Buffer.from("tgz-bytes"));
    expect(puts).toHaveLength(2);
    const untar = cmds.find(c => c.includes("tar xzf"))!;
    expect(untar).toMatch(/-C '\/root' --no-same-owner/);
    expect(cmds.filter(c => c.includes("tar xzf")).at(-1)).toMatch(/-C '\/' --no-same-owner/);
    expect(cmds.indexOf(FREE_KB_CMD)).toBeLessThan(cmds.indexOf(untar));
    const tool = cmds.find(c => c.includes("brew install gh"))!;
    expect(tool).toMatch(/\nsetsid bash -c 'brew install gh' &\np=\$!\n/);
    expect(tool).toMatch(/while \[ \$t -lt 600 \]/);
    expect(cmds.filter(c => c.includes("brew install gh") || c.includes("brew-bootstrap") || c.includes("bun@1.4.0"))).toHaveLength(3);
    const agent = cmds.find(c => c.includes("codex-install"))!;
    expect(agent).toMatch(/\nsetsid bash -c 'set -euo pipefail\nexport npm_config_fetch_timeout=/);
    expect(agent).toContain(`${CURL_NET}\nexport PATH="/usr/local/bin:$PATH"\ncodex-install`);
    expect(agent).toMatch(/while \[ \$t -lt 900 \]/);
    // Agents and their checks run with the Node the golden installed ahead of any the image shipped.
    expect(cmds).toContain('export PATH="/usr/local/bin:$PATH"\nclaude --version');
    expect(cmds).toContain('export PATH="/usr/local/bin:$PATH"\ncodex --version');
    expect(cmds.indexOf("true")).toBeLessThan(cmds.indexOf(agent));
    // Agents are the point and tools the long tail: the agents go on first, so a tools stage that fills the disk cannot starve them.
    expect(cmds.indexOf(agent)).toBeLessThan(cmds.indexOf(tool));
    // The reach check is the last thing on the machine before the hand-off.
    expect(cmds.at(-1)).toBe("echo ok");
    expect(builder.import).toEqual({ recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "claude --version && codex --version" });
    expect(builder.setupSha).toBe(createHash("sha256").update("true\nclaude-install\ncodex-install").digest("hex"));
    expect(results).toEqual([{
      recipeHash: "h1",
      base: expect.any(Array),
      files: { bytes: 1200, skipped: [{ id: "shell/bashrc", path: "~/.bashrc", note: "no longer on this computer" }], cut: [] },
      homebrew: HOMEBREW,
      tools: [
        { id: "tools/homebrew", label: "Homebrew", outcome: "installed", ms: expect.any(Number), bytes: 0 },
        { id: "tools/brew/gh", label: "gh", outcome: "installed", ms: expect.any(Number), bytes: 0 },
        { id: "tools/npm/bun", label: "bun@1.4.0", outcome: "installed", ms: expect.any(Number), bytes: 0 },
      ],
      agents: [
        { id: "agents/claude", name: "Claude Code", outcome: "installed", ms: expect.any(Number) },
        { id: "agents/codex", name: "Codex", outcome: "installed", ms: expect.any(Number) },
      ],
      context: [],
    }]);
  });

  it("every command that can outlive one exec goes through run, and every inline exec is bounded at the measured cap", async () => {
    let lockedOnce = false;
    const { backend, ran, inline, fetch } = backendFor([
      ["brew install gh", () => {
        if (lockedOnce) return ok;
        lockedOnce = true;
        return { exitCode: 1, stdout: "", stderr: "Error: A `brew install glibc` process has already locked /home/linuxbrew/.linuxbrew/Cellar/x.\n" };
      }],
      ["NODE_HAVE", { exitCode: 0, stdout: "NODE_HAVE v18\nNODE_INSTALLED v22.0.0\n", stderr: "" }],
    ]);
    const shell = { shell: "zsh" as const, frameworks: [], cmd: "install-zsh" };
    const node = { floor: 22, version: "v22.0.0", agents: ["Codex"], cmd: "echo NODE_HAVE v$(node -v); node-install" };
    const builder = await prepareBuilder({ backend, setup: "the-setup", deployDaemon: async () => "node v22", fetch, import: importOf({ shell, node }) });
    await sealGolden(builder, { backend, hostId: "h1", smoke: "unused" });
    const scripts = ran.filter(r => r.id === "m1").map(r => r.script);
    const oneOf = (needle: string) => {
      const hits = scripts.filter(s => s.includes(needle));
      expect(hits, needle).toHaveLength(1);
      return hits[0]!;
    };
    for (const guardedBody of ["the-setup", "install-zsh", "node-install", "claude-install", "codex-install", "brew-bootstrap", "bun@1.4.0", "autoremove", "cleanup -s --prune=all"]) {
      expect(oneOf(guardedBody)).toMatch(/\nsetsid bash -c '/);
    }
    expect(scripts.filter(s => s.includes("brew install gh"))).toHaveLength(2);
    expect(oneOf("flock -w 600")).toContain("/home/linuxbrew/.linuxbrew/var/homebrew/locks/*.lock");
    expect(scripts.filter(s => s.includes("tar xzf"))).toHaveLength(2);
    expect(scripts).toContain('export PATH="/usr/local/bin:$PATH"\nclaude --version');
    expect(ran.filter(r => r.id === "m2").map(r => r.script)).toEqual(["claude --version && codex --version"]);
    const inlineCmds = inline.map(i => i.cmd);
    expect(inlineCmds).toContain(FREE_KB_CMD);
    expect(inlineCmds).toContain("rm -f /tmp/wsp-vault-*.tgz");
    expect(inlineCmds).toContain("echo ok");
    expect(inlineCmds).toContain("test -x /usr/local/bin/wsp-open");
    for (const i of inline) {
      expect(i.timeoutMs, i.cmd).toBeLessThanOrEqual(INLINE_EXEC_MS);
      // The base floor's versions read is a --version call per row, inline and bounded like the rest.
      if (i.cmd.includes('echo "VERSION curl:')) continue;
      expect(i.cmd, "a long command ran inline").not.toMatch(/setsid bash -c|tar |the-setup|--version/);
    }
  });

  it("the lines a run writes stream into its stage frames, named for the tool or agent", async () => {
    const rb = recordingBackend({}, {
      stream: true,
      exec: cmd => {
        if (cmd.includes("brew install gh")) return { exitCode: 0, stdout: "==> Fetching gh\n==> Pouring gh\n", stderr: "" };
        if (cmd.includes("claude-install")) return { exitCode: 0, stdout: "claude 1.2.3 installed\n", stderr: "" };
        if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${mb(3000)}\n`, stderr: "" };
        if (cmd === "echo ok") return REACH_OK;
        return ok;
      },
    });
    const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 200 });
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend: rb.backend, setup: "true", fetch, onStage, import: importOf() });
    expect(stages.slice(stages.indexOf("installing-tools:gh (2/3)"), stages.indexOf("installing-tools:gh (2/3)") + 3)).toEqual([
      "installing-tools:gh (2/3)", "installing-tools:gh: ==> Fetching gh", "installing-tools:gh: ==> Pouring gh",
    ]);
    expect(stages).toContain("installing-harness:Claude Code: claude 1.2.3 installed");
  });

  it("the shell step runs after the pack and before the files land, guarded on the guest, and names what it did on the setup frame", async () => {
    const { backend, cmds, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const shell = { shell: "zsh" as const, frameworks: ["shell/oh-my-zsh", "shell/antidote"], cmd: "set -euo pipefail\ninstall-zsh-and-frameworks" };
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ shell }) });
    const step = cmds.find(c => c.includes("install-zsh-and-frameworks"))!;
    expect(step).toMatch(/\nsetsid bash -c 'set -euo pipefail\ninstall-zsh-and-frameworks' &\np=\$!\n/);
    expect(step).toContain("while [ $t -lt 300 ]");
    const untar = cmds.find(c => c.includes("tar xzf"))!;
    expect(cmds.indexOf(step)).toBeLessThan(cmds.indexOf(untar));
    expect(cmds.indexOf(step)).toBeLessThan(cmds.indexOf(cmds.find(c => c.includes("claude-install"))!));
    expect(stages.slice(stages.indexOf("applying-setup:1 KB packed; skipped ~/.bashrc (no longer on this computer)"), stages.indexOf("uploading-files:1 KB") + 1)).toEqual([
      "applying-setup:1 KB packed; skipped ~/.bashrc (no longer on this computer)",
      "applying-setup:zsh: installing, with shell/oh-my-zsh, shell/antidote",
      "applying-setup:zsh installed as the login shell; shell/oh-my-zsh, shell/antidote reinstalled; 2.9 GB free",
      "uploading-files:1 KB",
    ]);
  });

  it("a shell step that fails is a warning on the setup frame with its reason; the files still land and the build goes on", async () => {
    const { backend, cmds, fetch } = backendFor([["install-zsh", { exitCode: 100, stdout: "", stderr: "E: Unable to locate package zsh\n" }]]);
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ shell: { shell: "zsh", frameworks: [], cmd: "install-zsh" } }) });
    expect(stages).toContain("applying-setup:zsh step failed, chsh skipped: E: Unable to locate package zsh");
    expect(cmds.some(c => c.includes("tar xzf"))).toBe(true);
    expect(stages.at(-1)).toBe("ready");
    expect(builder.import?.applied).toContain("uploading-files");
  });

  it("after the tools and the agents are on, the login shell is started once interactively under the guard; what it prints to stderr is the version's shell noise, first line and count, and the golden still seals; a quiet shell records none", async () => {
    const noisy = backendFor([["zsh -lic true", { exitCode: 0, stdout: "", stderr: "zsh: command not found: starship\nzsh eza plugin: eza not found.\n" }]]);
    const { stages, onStage } = stageRecorder();
    const shell = { shell: "zsh" as const, frameworks: [], cmd: "install-zsh" };
    const builder = await prepareBuilder({ backend: noisy.backend, setup: "true", fetch: noisy.fetch, onStage, import: importOf({ shell }) });
    const at = (needle: string): number => {
      const i = noisy.cmds.findIndex(c => c.includes(needle));
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const check = noisy.cmds[at("zsh -lic true")]!;
    // A login shell like the app's terminal: profile.d puts the tools on PATH before the rc files are read.
    expect(check).toContain('TERM=xterm-256color zsh -lic true </dev/null');
    expect(check).toMatch(/\nsetsid bash -c '/);
    // A tool or an agent the rc calls is on the machine by then: the check runs after the last install of each stage.
    for (const before of ["tar xzf", "claude-install", "codex-install", "brew install gh", "bun@1.4.0", "autoremove"]) expect(at("zsh -lic true"), before).toBeGreaterThan(at(before));
    expect(stages.some(l => l.startsWith("installing-mcp:shell noise: zsh: command not found: starship, 2 lines; machine context:"))).toBe(true);
    expect(builder.import?.shellNoise).toBe("zsh: command not found: starship, 2 lines");
    expect((await sealGolden(builder, { backend: noisy.backend, hostId: "h1", smoke: "true" })).version.shellNoise).toBe("zsh: command not found: starship, 2 lines");

    const quiet = backendFor();
    const q = stageRecorder();
    const b = await prepareBuilder({ backend: quiet.backend, setup: "true", fetch: quiet.fetch, onStage: q.onStage, import: importOf({ shell }) });
    expect(q.stages.some(l => l.startsWith("installing-mcp:zsh starts quiet; machine context:"))).toBe(true);
    const hung = backendFor([["zsh -lic true", { exitCode: 124, stdout: "", stderr: "" }]]);
    const h = await prepareBuilder({ backend: hung.backend, setup: "true", fetch: hung.fetch, import: importOf({ shell }) });
    expect(h.import?.shellNoise).toBe("timed out after 60s");
    expect(b.import).not.toHaveProperty("shellNoise");
    expect((await sealGolden(b, { backend: quiet.backend, hostId: "h1", smoke: "true" })).version).not.toHaveProperty("shellNoise");
    const none = backendFor();
    await prepareBuilder({ backend: none.backend, setup: "true", fetch: none.fetch, import: importOf() });
    expect(none.cmds.some(c => c.includes("-lic true"))).toBe(false);
  });

  it("a builder that already carries the files does not run the shell step again", async () => {
    const { backend, cmds, fetch } = backendFor();
    const imp = importOf({ shell: { shell: "zsh", frameworks: [], cmd: "install-zsh" } });
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: imp });
    expect(cmds.filter(c => c.includes("install-zsh"))).toHaveLength(1);
    await applyGoldenImport(builder.machine, { import: imp, setup: "true", ledger: builder.import, fetch });
    expect(cmds.filter(c => c.includes("install-zsh"))).toHaveLength(1);
  });

  it("a tool that fails is a warning in the detail and the next one still runs; the build and the seal go on", async () => {
    const { backend, fetch } = backendFor([
      // stdout ends on a progress line; the reason is the last stderr line, not that.
      ["brew install gh", { exitCode: 1, stdout: "==> Installing gh dependency: oniguruma\n", stderr: "Error: gh: no bottle available!\n" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(stages).toContain("installing-tools:2 installed, 1 failed: gh (Error: gh: no bottle available!); caches swept; 2.9 GB free");
    expect(results[0]!.tools[1]).toEqual({ id: "tools/brew/gh", label: "gh", outcome: "failed", note: "Error: gh: no bottle available!", ms: expect.any(Number) });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "should-not-run" });
    expect(version.smoke.cmd).toBe("claude --version && codex --version");
  });

  it("a row outside the catalog that fails is listed as failed with its reason, and the golden still seals", async () => {
    const custom = customInstallsFor([{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" }]);
    // The needle is the line the row installs with: the prelude around it is quoted again by the guard.
    const { backend, fetch } = backendFor([["brew install just", { exitCode: 1, stdout: "", stderr: "Error: no formula just\n" }]]);
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ tools: [...importOf().tools, ...custom], onResult: r => void results.push(r) }) });
    expect(results[0]!.tools.at(-1)).toEqual({ id: "tools/custom/just", label: "just", outcome: "failed", note: "Error: no formula just", ms: expect.any(Number) });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "should-not-run" });
    expect(version.version).toBe(1);
  });

  it("a road install names the road it took: the result carries it and the stage summary says so", async () => {
    const { backend, fetch } = backendFor([
      ["releases/tags/v0.1.0", { exitCode: 0, stdout: `WSP_ROAD release diskbloom_0.1.0_linux_amd64.tar.gz ${"a".repeat(64)} v0.1.0\n`, stderr: "" }],
      ["releases/tags/v1.13.1", { exitCode: 0, stdout: "go: downloading\nWSP_ROAD go github.com/TheZoraiz/ascii-image-converter@v1.13.1\n", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const roads = [
      { id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", manager: "release" as const, cmd: "curl https://api.github.com/repos/Zingzy/diskbloom/releases/tags/v0.1.0" },
      { id: "tools/brew/thezoraiz/ascii-image-converter/ascii-image-converter", label: "ascii-image-converter", manager: "release" as const, cmd: "curl https://api.github.com/repos/TheZoraiz/ascii-image-converter/releases/tags/v1.13.1" },
    ];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: [...importOf().tools, ...roads], onResult: r => void results.push(r) }) });
    expect(stages).toContain("installing-tools:5 installed (diskbloom from its release, ascii-image-converter with go install); caches swept; 2.9 GB free");
    expect(results[0]!.tools.slice(3)).toEqual([
      { id: roads[0]!.id, label: "diskbloom", outcome: "installed", road: { kind: "release", from: "diskbloom_0.1.0_linux_amd64.tar.gz", sha256: "a".repeat(64), tag: "v0.1.0" }, ms: expect.any(Number), bytes: 0 },
      { id: roads[1]!.id, label: "ascii-image-converter", outcome: "installed", road: { kind: "go", from: "github.com/TheZoraiz/ascii-image-converter@v1.13.1" }, ms: expect.any(Number), bytes: 0 },
    ]);
    // A brew install carries no road: it took the one its plan named.
    expect(results[0]!.tools[1]).not.toHaveProperty("road");
  });

  it("a catalog tool this computer has no row for installs by its catalog road on the guest: the pinned asset is downloaded, the road recorded, and the tally says the road is unmeasured", async () => {
    const { backend, cmds, fetch, inline } = backendFor([
      ["cli/cli/releases/download/v2.101.0", { exitCode: 0, stdout: `WSP_ROAD release gh_2.101.0_linux_amd64.tar.gz ${"b".repeat(64)} v2.101.0\n`, stderr: "" }],
    ]);
    const plan = toolInstallsFor([
      { rung: "tools", id: "tools/catalog/gh", label: "GitHub CLI", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes" },
      { rung: "tools", id: "tools/npm/wrangler", label: "wrangler", paths: [], bytes: 0, default: "bring", bring: true, version: "4.1.0" },
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: plan.installs, onResult: r => void results.push(r) }) });
    const road = cmds.find(c => c.includes("cli/cli/releases/download/v2.101.0"))!;
    expect(road).toContain(`install -m 0755 "$bin" "/usr/local/bin/$name"`);
    // The sum the catalog pinned is checked on the guest before anything the download carries is unpacked.
    expect(road).toContain("sha256sum -c -");
    expect(road).not.toContain("api.github.com");
    expect(inline.filter(c => c.cmd.includes('echo "missing')).at(-1)!.cmd).toContain(`for b in 'node' 'gh'; do`);
    expect(results[0]!.tools).toEqual([
      { id: "tools/manager/npm", label: "Node 22 with npm", outcome: "installed", ms: expect.any(Number), bytes: 0 },
      { id: "tools/npm/wrangler", label: "wrangler", outcome: "installed", ms: expect.any(Number), bytes: 0 },
      { id: "tools/catalog/gh", label: "GitHub CLI", outcome: "installed", note: UNMEASURED_ROAD, road: { kind: "release", from: "gh_2.101.0_linux_amd64.tar.gz", sha256: "b".repeat(64), tag: "v2.101.0" }, ms: expect.any(Number), bytes: 0, pin: { tag: "v2.101.0", sha256: "b".repeat(64) } },
    ]);
    expect(stages).toContain(`installing-tools:3 installed (GitHub CLI from its release (${UNMEASURED_ROAD})); caches swept; 2.9 GB free`);
  });

  it("after the checks the stage reads every installed row's version back in one run: a package road's pin is what its line printed, a release keeps the tag and sum its own line said, a road that installs latest is marked so, and one line names them all", async () => {
    const { backend, cmds, fetch } = backendFor([
      ["cli/cli/releases/download/v2.101.0", { exitCode: 0, stdout: `WSP_ROAD release gh_2.101.0_linux_amd64.tar.gz ${"b".repeat(64)} v2.101.0\n`, stderr: "" }],
      ["wsp-version", { exitCode: 0, stdout: "wsp-version 0 4.1.0\nwsp-version 1 3.3a-3\n", stderr: "" }],
    ]);
    const plan = toolInstallsFor([
      { rung: "tools", id: "tools/npm/wrangler", label: "wrangler", paths: [], bytes: 0, default: "bring", bring: true, version: "4.1.0" },
      { rung: "tools", id: "tools/catalog/tmux", label: "tmux", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes" },
      { rung: "tools", id: "tools/catalog/gh", label: "GitHub CLI", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes" },
    ]);
    const recipe: RecipeDigest = { ticks: [{ id: "tools/catalog/gh", road: "release", installer: "k".repeat(64) }, { id: "tools/catalog/tmux", road: "apt", installer: "j".repeat(64) }, { id: "tools/npm/wrangler", version: "4.1.0", road: "npm", installer: "i".repeat(64) }], files: [] };
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: plan.installs, recipe, onResult: r => void results.push(r) }) });
    // One run on the tools PATH, each row's own line in plan order; the release row is not in it, since its install already said its tag and sum.
    const read = cmds.find(c => c.includes("wsp-version"))!;
    expect(read).toMatch(/^export PATH=\/root\/\.local\/bin:/);
    expect(read).toContain(`printf 'wsp-version %s %s\\n' 0 "$( ( node -p 'require(process.argv[1] + "/package.json").version' "$(npm root -g)/"'wrangler' ) 2>/dev/null | head -n 1 )"`);
    expect(read).toContain("printf 'wsp-version %s %s\\n' 1 \"$( ( dpkg-query -W -f='${Version}\\n' 'tmux' 2>/dev/null ) 2>/dev/null | head -n 1 )\"");
    expect(read).not.toContain("gh");
    expect(Object.fromEntries(results[0]!.tools.map(t => [t.id, t.pin]))).toEqual({
      "tools/npm/wrangler": { tag: "4.1.0" },
      "tools/apt-index": undefined,
      "tools/catalog/tmux": { tag: "3.3a-3", latest: true },
      "tools/catalog/gh": { tag: "v2.101.0", sha256: "b".repeat(64) },
    });
    expect(stages).toContain("installing-tools:pinned: wrangler 4.1.0, GitHub CLI v2.101.0; installs latest on every place: tmux 3.3a-3 by apt");
    expect(builder.import?.recipe?.ticks).toEqual([
      { id: "tools/catalog/gh", road: "release", installer: "k".repeat(64), pin: { tag: "v2.101.0", sha256: "b".repeat(64) } },
      { id: "tools/catalog/tmux", road: "apt", installer: "j".repeat(64), pin: { tag: "3.3a-3", latest: true } },
      { id: "tools/npm/wrangler", version: "4.1.0", road: "npm", installer: "i".repeat(64), pin: { tag: "4.1.0" } },
    ]);
    // A read that printed nothing for a row records no pin for it, and a run that failed records none and says so.
    const { backend: b2, fetch: f2 } = backendFor([["wsp-version", { exitCode: 0, stdout: "wsp-version 1 3.3a-3\n", stderr: "" }]]);
    const quiet = await prepareBuilder({ backend: b2, setup: "true", fetch: f2, import: importOf({ tools: plan.installs, recipe }) });
    expect(quiet.import?.recipe?.ticks.find(t => t.id === "tools/npm/wrangler")).not.toHaveProperty("pin");
    expect(quiet.import?.recipe?.ticks.find(t => t.id === "tools/catalog/tmux")?.pin).toEqual({ tag: "3.3a-3", latest: true });
    const { backend: b3, fetch: f3 } = backendFor([["wsp-version", { exitCode: 1, stdout: "", stderr: "bash: printf: broken" }]]);
    const failed = stageRecorder();
    const unread = await prepareBuilder({ backend: b3, setup: "true", fetch: f3, onStage: failed.onStage, import: importOf({ tools: plan.installs, recipe }) });
    expect(unread.import?.recipe?.ticks.filter(t => t.pin !== undefined).map(t => t.id)).toEqual([]);
    expect(failed.stages).toContain("installing-tools:the versions could not be read back (bash: printf: broken): wrangler, tmux record no pin");
  });

  it("the harness stage reads each installed agent's version back once its check passes, stamps the ledger, and its closing line names the pinned and the latest", async () => {
    const { backend, fetch } = backendFor([
      ["npm root -g", { exitCode: 0, stdout: "0.153.0\n", stderr: "" }],
      ["'claude' --version", { exitCode: 0, stdout: "2.1.3\n", stderr: "" }],
    ]);
    const recipe: RecipeDigest = { ticks: [{ id: "agents/claude" }, { id: "agents/codex" }], files: [] };
    const { stages, onStage } = stageRecorder();
    const agents = [{ id: "agents/claude", ...AGENT_INSTALLERS["claude"]! }, { id: "agents/codex", ...AGENT_INSTALLERS["codex"]! }];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ agents, recipe }) });
    // Both lines name the version they install, so both pins are fixed and no row reads as installing latest.
    expect(builder.import?.recipe?.ticks).toEqual([{ id: "agents/claude", pin: { tag: "2.1.3" } }, { id: "agents/codex", pin: { tag: "0.153.0" } }]);
    const closing = stages.find(s => s.startsWith("installing-harness:Claude Code, Codex installed"))!;
    expect(closing).toContain("; pinned: Claude Code 2.1.3, Codex 0.153.0; ");
    expect(closing).not.toContain("installs latest on every place");
  });

  it("the tools stage stamps the pin a release install recorded on the ledger's digest, so the sealed version says which release the row is fixed to", async () => {
    const { backend, fetch } = backendFor([["cli/cli/releases/download/v2.101.0", { exitCode: 0, stdout: `WSP_ROAD release gh_2.101.0_linux_amd64.tar.gz ${"b".repeat(64)} v2.101.0\n`, stderr: "" }]]);
    const plan = toolInstallsFor([{ rung: "tools", id: "tools/catalog/gh", label: "GitHub CLI", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes" }]);
    const recipe: RecipeDigest = { ticks: [{ id: "agents/claude" }, { id: "tools/catalog/gh", road: "release", installer: "i".repeat(64) }], files: [] };
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ tools: plan.installs, recipe }) });
    expect(builder.import?.recipe?.ticks).toEqual([{ id: "agents/claude" }, { id: "tools/catalog/gh", road: "release", installer: "i".repeat(64), pin: { tag: "v2.101.0", sha256: "b".repeat(64) } }]);
    // The digest handed in is left as the caller planned it.
    expect(recipe.ticks[1]).not.toHaveProperty("pin");
    // A road that printed no sum, or a tool that did not install, stamps nothing.
    const { backend: b2, fetch: f2 } = backendFor([["cli/cli/releases/download/v2.101.0", { exitCode: 0, stdout: "WSP_ROAD go github.com/cli/cli/v2/cmd/gh@v2.101.0\n", stderr: "" }]]);
    const viaGo = await prepareBuilder({ backend: b2, setup: "true", fetch: f2, import: importOf({ tools: plan.installs, recipe }) });
    expect(viaGo.import?.recipe).toEqual(recipe);
  });

  it("a catalog go row beside a go row on the guest: Homebrew installs go once, the go row runs after it, and the tally counts each install once", async () => {
    const { backend, cmds, fetch } = backendFor();
    const plan = toolInstallsFor([
      { rung: "tools", id: "tools/catalog/go", label: "Go", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes" },
      { rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], bytes: 0, default: "bring", bring: true },
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: plan.installs, onResult: r => void results.push(r) }) });
    expect(cmds.filter(c => c.includes("brew install go'"))).toHaveLength(1);
    expect(cmds.indexOf(cmds.find(c => c.includes("brew install go'"))!)).toBeLessThan(cmds.indexOf(cmds.find(c => c.includes("go install golang.org/x/tools/gopls@v0.16.2"))!));
    expect(results[0]!.tools.map(t => [t.id, t.outcome])).toEqual([
      ["tools/homebrew", "installed"], ["tools/brew-toolchain/glibc", "installed"], ["tools/brew-toolchain/gcc", "installed"], ["tools/catalog/go", "installed"], ["tools/go/gopls", "installed"],
    ]);
    expect(stages).toContain("installing-tools:5 installed; caches swept; 2.9 GB free");
  });

  it("a catalog row with a version on the guest: the road that pins installs at it; the road that cannot says in the result and the tally what it installed instead", async () => {
    const { backend, cmds, fetch } = backendFor();
    const plan = toolInstallsFor([
      { rung: "tools", id: "tools/catalog/wrangler", label: "Cloudflare Wrangler", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes", version: "4.1.0" },
      { rung: "tools", id: "tools/catalog/tmux", label: "tmux", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes", version: "3.5a" },
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: plan.installs, onResult: r => void results.push(r) }) });
    expect(cmds.some(c => c.includes("npm install -g wrangler@4.1.0"))).toBe(true);
    const tmuxNote = `${UNMEASURED_ROAD}; 3.5a asked, installed by apt at its current version`;
    expect(results[0]!.tools).toEqual([
      { id: "tools/manager/npm", label: "Node 22 with npm", outcome: "installed", ms: expect.any(Number), bytes: 0 },
      { id: "tools/catalog/wrangler", label: "Cloudflare Wrangler", outcome: "installed", note: UNMEASURED_ROAD, ms: expect.any(Number), bytes: 0 },
      { id: "tools/apt-index", label: "apt index", outcome: "installed", ms: expect.any(Number), bytes: 0 },
      { id: "tools/catalog/tmux", label: "tmux", outcome: "installed", note: tmuxNote, ms: expect.any(Number), bytes: 0 },
    ]);
    expect(stages).toContain(`installing-tools:4 installed (Cloudflare Wrangler (${UNMEASURED_ROAD}), tmux (${tmuxNote})); caches swept; 2.9 GB free`);
  });

  it("the tally names every install once: a tool carrying both a road and a note keeps its notes inside its own brackets, so no note reads as a nameless tool", async () => {
    const { backend, fetch } = backendFor([
      ["cli/cli/releases/download/v2.101.0", { exitCode: 0, stdout: `WSP_ROAD release gh_2.101.0_linux_amd64.tar.gz ${"c".repeat(64)} v2.101.0\n`, stderr: "" }],
    ]);
    const plan = toolInstallsFor([
      { rung: "tools", id: "tools/catalog/gh", label: "GitHub CLI", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes" },
      { rung: "tools", id: "tools/catalog/tmux", label: "tmux", paths: [], bytes: 0, default: "skip", bring: true, linux: "yes", version: "3.5a" },
    ]);
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: plan.installs }) });
    const tmuxNote = `${UNMEASURED_ROAD}; 3.5a asked, installed by apt at its current version`;
    const tally = stages.find(s => s.startsWith("installing-tools:3 installed"))!;
    expect(tally).toBe(`installing-tools:3 installed (GitHub CLI from its release (${UNMEASURED_ROAD}), tmux (${tmuxNote})); caches swept; 2.9 GB free`);
    // With the bracketed notes off, every comma left separates two named tools: the list names two, not four.
    expect(tally.replace(/ \([^()]*\)/g, "")).toBe("installing-tools:3 installed (GitHub CLI from its release, tmux); caches swept; 2.9 GB free");
  });

  it("after the loop every install that names its command is checked with command -v on the tools PATH: one not there is failed with the reason, in the result and the summary", async () => {
    const { backend, fetch, inline } = backendFor([
      ["releases/tags/v0.4.1", { exitCode: 0, stdout: `WSP_ROAD release spoo_0.4.1_linux_amd64.tar.gz ${"a".repeat(64)} v0.4.1\n`, stderr: "" }],
      ['echo "missing', { exitCode: 0, stdout: "missing spoo\n", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const tools: ToolInstall[] = [
      ...importOf().tools,
      { id: "tools/go/gopls", label: "gopls", manager: "go", cmd: "go install gopls", bin: "gopls" },
      { id: "tools/cli/spoo", label: "spoo", manager: "release", cmd: "curl https://api.github.com/repos/spoo-me/spoo-cli/releases/tags/v0.4.1", bin: "spoo" },
    ];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools, onResult: r => void results.push(r) }) });
    const check = inline.filter(c => c.cmd.includes('echo "missing')).at(-1)!;
    expect(check.cmd).toMatch(/^export PATH=\/root\/\.local\/bin:.*\/usr\/local\/bin.*\n/);
    expect(check.cmd).toContain(`for b in 'gopls' 'spoo'; do command -v "$b" >/dev/null 2>&1 || echo "missing $b"; done`);
    expect(check.timeoutMs).toBe(INLINE_EXEC_MS);
    expect(results[0]!.tools.find(t => t.id === "tools/cli/spoo")).toEqual({ id: "tools/cli/spoo", label: "spoo", outcome: "failed", note: "spoo is not on PATH after the install", ms: expect.any(Number), bytes: 0 });
    expect(results[0]!.tools.find(t => t.id === "tools/go/gopls")).toMatchObject({ outcome: "installed" });
    expect(stages).toContain("installing-tools:4 installed, 1 failed: spoo (spoo is not on PATH after the install); caches swept; 2.9 GB free");
    // Nothing of the person's named its command: the only check is the base floor's.
    const plain = backendFor();
    await prepareBuilder({ backend: plain.backend, setup: "true", fetch: plain.fetch, onStage: stageRecorder().onStage, import: importOf() });
    const checks = plain.inline.filter(c => c.cmd.includes('echo "missing'));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.cmd).toContain(`for b in 'curl' 'uv' 'python3' 'git' 'jq' 'rg' 'cc' 'fd' 'sqlite3' 'wget' 'zip' 'xz' 'rsync'; do`);
  });

  it("two tap roads whose go module is named otherwise land under the row's command and pass the check: the road is kept, on the fake guest end to end", async () => {
    const { backend, cmds, fetch, inline } = backendFor([
      ["releases/tags/v0.4.1", { exitCode: 0, stdout: "go: downloading\nWSP_ROAD go github.com/spoo-me/spoo-cli@v0.4.1\n", stderr: "" }],
      ["releases/tags/v0.2.0", { exitCode: 0, stdout: "WSP_ROAD go github.com/Zingzy/bloom-cli@v0.2.0\n", stderr: "" }],
    ]);
    const table: BrewTable = new Map([
      ["zingzy/tap/bloom", { name: "bloom", fullName: "zingzy/tap/bloom", deps: [], macosOnly: false, source: { repo: "Zingzy/bloom-cli", tag: "v0.2.0" } }],
      ["spoo-me/tap/spoo", { name: "spoo", fullName: "spoo-me/tap/spoo", deps: [], macosOnly: false, source: { repo: "spoo-me/spoo-cli", tag: "v0.4.1" } }],
    ]);
    const plan = toolInstallsFor([
      { rung: "tools", id: "tools/brew/zingzy/tap/bloom", label: "bloom", paths: [], bytes: 0, default: "bring", bring: true, linux: "unknown" },
      { rung: "tools", id: "tools/brew/spoo-me/tap/spoo", label: "spoo", paths: [], bytes: 0, default: "bring", bring: true, linux: "unknown" },
    ], table);
    expect(plan.installs.map(i => [i.id, i.bin])).toEqual([["tools/brew/zingzy/tap/bloom", "bloom"], ["tools/brew/spoo-me/tap/spoo", "spoo"]]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: plan.installs, onResult: r => void results.push(r) }) });
    expect(cmds.find(c => c.includes("releases/tags/v0.2.0"))).toContain(`mv '\\''/usr/local/bin/bloom-cli'\\'' "/usr/local/bin/$name"`);
    expect(cmds.find(c => c.includes("releases/tags/v0.4.1"))).toContain(`mv '\\''/usr/local/bin/spoo-cli'\\'' "/usr/local/bin/$name"`);
    expect(inline.filter(c => c.cmd.includes('echo "missing')).at(-1)!.cmd).toContain(`for b in 'bloom' 'spoo'; do`);
    expect(results[0]!.tools).toEqual([
      { id: "tools/brew/zingzy/tap/bloom", label: "bloom", outcome: "installed", road: { kind: "go", from: "github.com/Zingzy/bloom-cli@v0.2.0" }, ms: expect.any(Number), bytes: 0 },
      { id: "tools/brew/spoo-me/tap/spoo", label: "spoo", outcome: "installed", road: { kind: "go", from: "github.com/spoo-me/spoo-cli@v0.4.1" }, ms: expect.any(Number), bytes: 0 },
    ]);
    expect(stages).toContain("installing-tools:2 installed (bloom with go install, spoo with go install); caches swept; 2.9 GB free");
  });

  it("a check that itself fails counts every named tool as failed, with the check's reason, and says so in a stage line: an unverified tool is not installed", async () => {
    const { backend, fetch } = backendFor([
      ["releases/tags/v0.4.1", { exitCode: 0, stdout: `WSP_ROAD release spoo_0.4.1_linux_amd64.tar.gz ${"a".repeat(64)} v0.4.1\n`, stderr: "" }],
      ["command -v \"$b\"", { exitCode: 124, stdout: "", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const tools: ToolInstall[] = [
      ...importOf().tools,
      { id: "tools/go/gopls", label: "gopls", manager: "go", cmd: "go install gopls", bin: "gopls" },
      { id: "tools/cli/spoo", label: "spoo", manager: "release", cmd: "curl https://api.github.com/repos/spoo-me/spoo-cli/releases/tags/v0.4.1", bin: "spoo" },
    ];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools, onResult: r => void results.push(r) }) });
    expect(results[0]!.tools.slice(3)).toEqual([
      { id: "tools/go/gopls", label: "gopls", outcome: "failed", note: "gopls could not be checked on PATH: timed out after 20s", ms: expect.any(Number), bytes: 0 },
      { id: "tools/cli/spoo", label: "spoo", outcome: "failed", note: "spoo could not be checked on PATH: timed out after 20s", ms: expect.any(Number), bytes: 0 },
    ]);
    expect(stages).toContain("installing-tools:the PATH check failed (timed out after 20s): gopls, spoo count as failed");
    expect(stages).toContain("installing-tools:3 installed, 2 failed: gopls (gopls could not be checked on PATH: timed out after 20s), spoo (spoo could not be checked on PATH: timed out after 20s); caches swept; 2.9 GB free");
  });

  it("an agent that fails refuses the seal with the installer's reason, kills the builder, reports the result, and never starts the tools", async () => {
    const { backend, cmds, killed, fetch } = backendFor([["codex-install", { exitCode: 124, stdout: "", stderr: "" }]]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow(/an agent did not install/);
    expect(stages.at(-1)).toBe("failed:an agent did not install, so nothing is sealed:\nCodex: timed out after 900s");
    expect(killed).toEqual(["m1"]);
    expect(results[0]!.agents).toEqual([
      { id: "agents/claude", name: "Claude Code", outcome: "installed", ms: expect.any(Number) },
      { id: "agents/codex", name: "Codex", outcome: "failed", note: "timed out after 900s", ms: expect.any(Number) },
    ]);
    expect(cmds.some(c => c.includes("brew-bootstrap") || c.includes("brew install gh") || c.includes("bun@1.4.0"))).toBe(false);
  });

  it("when every ticked agent fails the build stops, names each agent and its reason, kills the builder, and still reports the result", async () => {
    const { backend, killed, fetch } = backendFor([
      ["claude-install", { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" }],
      ["codex-install", { exitCode: 124, stdout: "", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow(/2 agents did not install/);
    expect(stages.at(-1)).toBe(["failed:2 agents did not install, so nothing is sealed:", "Claude Code: curl: (6) Could not resolve host", "Codex: timed out after 900s"].join("\n"));
    expect(killed).toEqual(["m1"]);
    expect(results[0]!.agents.map(a => a.outcome)).toEqual(["failed", "failed"]);
  });

  it("a machine that stops answering after the installs is not sealed: the builder is killed and the result still reported", async () => {
    const { backend, cmds, killed, fetch } = backendFor([["echo ok", { exitCode: 1, stdout: "", stderr: "" }]]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow(/stopped answering commands after the installs \(exit 1\)/);
    expect(stages.at(-1)).toBe("failed:the machine stopped answering commands after the installs (exit 1); nothing is sealed");
    expect(killed).toEqual(["m1"]);
    expect(results[0]!.tools.map(t => t.outcome)).toEqual(["installed", "installed", "installed"]);
    // Every install ran before the check; the check is what the hand-off would have trusted.
    expect(cmds.indexOf("echo ok")).toBeGreaterThan(cmds.findIndex(c => c.includes("bun@1.4.0")));
    // A machine that answers with exit 0 and the wrong words is not serving either.
    const mute = backendFor([["echo ok", { exitCode: 0, stdout: "", stderr: "" }]]);
    await expect(prepareBuilder({ backend: mute.backend, setup: "true", fetch: mute.fetch, import: importOf() })).rejects.toThrow(/stopped answering commands after the installs \(exit 0\)/);
  });

  it("the Node step runs once before the agents: kept when the guest meets the floor, installed and said so when not, and a failure fails the agents above the guest's major and with them the seal", async () => {
    const node = { floor: 22, version: "22.23.2", agents: ["Pi"], cmd: "node-step" };
    const agents = [
      { id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version", node: 16, road: "npm" as const },
      { id: "agents/pi", name: "Pi", install: "pi-install", smoke: "pi --version", node: 22, road: "npm" as const },
    ];
    const kept = backendFor([["node-step", { exitCode: 0, stdout: "NODE_HAVE v22.1.0\nNODE_KEPT v22.1.0\n", stderr: "" }]]);
    const k = stageRecorder();
    const b1 = await prepareBuilder({ backend: kept.backend, setup: "true", fetch: kept.fetch, onStage: k.onStage, import: importOf({ node, agents }) });
    expect(k.stages.slice(k.stages.indexOf("installing-harness"))).toEqual([
      "installing-harness", "installing-harness:Node for Pi", "installing-harness:Node v22.1.0 kept; Pi run on it",
      "installing-harness:Codex (1/2)", "installing-harness:Pi (2/2)", "installing-harness:Codex, Pi installed; caches swept; 2.9 GB free",
      "installing-tools:Homebrew (1/3)", "installing-tools:gh (2/3)", "installing-tools:bun@1.4.0 (3/3)", "installing-tools:3 installed; caches swept; 2.9 GB free", "installing-mcp:none configured", CONTEXT_WRITTEN, "ready",
    ]);
    expect(kept.cmds.indexOf(kept.cmds.find(c => c.includes("node-step"))!)).toBeLessThan(kept.cmds.indexOf(kept.cmds.find(c => c.includes("codex-install"))!));
    expect(b1.setupSha).toBe(createHash("sha256").update("true\nnode-step\ncodex-install\npi-install").digest("hex"));

    const installed = backendFor([["node-step", { exitCode: 0, stdout: "NODE_HAVE v18.20.4\nNODE_INSTALLED v22.23.2\n", stderr: "" }]]);
    const i = stageRecorder();
    await prepareBuilder({ backend: installed.backend, setup: "true", fetch: installed.fetch, onStage: i.onStage, import: importOf({ node, agents }) });
    expect(i.stages).toContain("installing-harness:Node v22.23.2 installed for Pi (the base had v18)");

    const failed = backendFor([["node-step", { exitCode: 22, stdout: "NODE_HAVE v18.20.4\n", stderr: "curl: (22) The requested URL returned error: 404" }]]);
    const f = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend: failed.backend, setup: "true", fetch: failed.fetch, onStage: f.onStage, import: importOf({ node, agents, onResult: r => void results.push(r) }) })).rejects.toThrow(/an agent did not install/);
    expect(f.stages).toContain("installing-harness:Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404");
    expect(f.stages.at(-1)).toBe("failed:an agent did not install, so nothing is sealed:\nPi: Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404");
    expect(failed.cmds.some(c => c.includes("pi-install"))).toBe(false);
    expect(failed.cmds.some(c => c.includes("codex-install"))).toBe(true);
    expect(results[0]!.agents).toEqual([
      { id: "agents/codex", name: "Codex", outcome: "installed", ms: expect.any(Number) },
      { id: "agents/pi", name: "Pi", outcome: "failed", note: "Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404", ms: 0 },
    ]);
  });

  it("the Node floor and every agent installer run under the road table's network lines, so the bare curl their scripts type gets the function's flags", async () => {
    const node = { floor: 22, version: "22.23.2", agents: ["Pi"], cmd: "node-step" };
    const agents = [{ id: "agents/pi", name: "Pi", install: "pi-install", smoke: "pi --version", node: 22, road: "npm" as const }];
    const { backend, cmds, fetch } = backendFor([["node-step", { exitCode: 0, stdout: "NODE_HAVE v22.1.0\nNODE_KEPT v22.1.0\n", stderr: "" }]]);
    await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ node, agents }) });
    for (const needle of ["node-step", "pi-install"]) {
      const run = cmds.find(c => c.includes(needle))!;
      expect(run, needle).toBeDefined();
      for (const line of ROAD_STEPS.script.env) expect(run, needle).toContain(line);
      expect(run.indexOf(CURL_NET), needle).toBeLessThan(run.indexOf(needle));
      expect(run.indexOf("set -euo pipefail"), needle).toBeLessThan(run.indexOf(needle));
    }
    // The two scripts that reach this path type curl with no flags of their own.
    for (const script of [nodeInstallScript(22, NODE_RELEASES[22]), AGENT_INSTALLERS["aider"]!.install]) {
      expect(script).toContain("curl -o");
      expect(script).not.toMatch(/\bcurl +-[A-Za-z]*[fsSL]\b/);
    }
  });

  it("the setup line and the catalog's own agent installers run under the guard with the road lines: the harness binary is downloaded, checked against its pinned sum and installed with no pipe into a shell, Codex's npm carries the fetch clock", async () => {
    const { backend, cmds, fetch } = backendFor();
    const agents = (["claude", "codex"] as const).map(id => ({ id: `agents/${id}`, ...AGENT_INSTALLERS[id]! }));
    const builder = await prepareBuilder({ backend, setup: GOLDEN_SETUP, fetch, import: importOf({ agents }) });
    const runs = cmds.filter(c => c.includes("claude-code-releases/"));
    // Once as the setup line, once as the Claude Code row, whose text is the setup's less the removal under the home.
    expect(runs.map(r => r.includes(NODE_PATH_LINE))).toEqual([false, true]);
    for (const [run, path, script] of [[runs[0]!, [], GOLDEN_SETUP], [runs[1]!, [NODE_PATH_LINE], CLAUDE_INSTALL]] as const) {
      expect(run).toContain(`setsid bash -c ${shellQuote([...ROAD_STEPS.script.env, ...path, script].join("\n"))} &`);
      expect(run).toMatch(/while \[ \$t -lt 900 \]/);
      expect(run).not.toMatch(/\|\s*(bash|sh)\b/);
      const at = (needle: string) => { const i = run.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
      expect(at(CURL_NET)).toBeLessThan(at("curl -o /tmp/claude"));
      expect(at("curl -o /tmp/claude")).toBeLessThan(at("sha256sum -c -"));
      expect(at("sha256sum -c -")).toBeLessThan(at("install -D -m 0755 /tmp/claude"));
    }
    const codex = cmds.filter(c => c.includes("npm install -g @openai/codex@"));
    expect(codex).toHaveLength(1);
    expect(codex[0]).toContain(`${ROAD_STEPS.npm.env.join("\n")}\n`);
    expect(codex[0]!.indexOf(ROAD_STEPS.npm.env[0]!)).toBeLessThan(codex[0]!.indexOf("npm install -g @openai/codex@"));
    expect(builder.setupSha).toBe(createHash("sha256").update(`${GOLDEN_SETUP}\n${CLAUDE_INSTALL}\n${AGENT_INSTALLERS["codex"]!.install}`).digest("hex"));
  });

  it("a failure's reason is Homebrew's Error: line, not the advice line that follows it", async () => {
    const { backend, fetch } = backendFor([
      ["brew install gh", { exitCode: 1, stdout: "==> Fetching downloads for: gh\n", stderr: "Error: gh: A `brew install gh` process has already locked /home/linuxbrew/.linuxbrew/Cellar/gcc.\nPlease wait for it to finish or terminate it to continue.\n" }],
    ]);
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ onResult: r => void results.push(r) }) });
    expect(results[0]!.tools[1]!.note).toBe("Error: gh: A `brew install gh` process has already locked /home/linuxbrew/.linuxbrew/Cellar/gcc.");
  });

  it("an agent set aside at plan time lands in the result as skipped, counts as ticked for the zero check, and is named in the detail", async () => {
    const aside = [{ id: "agents/zed", name: "Zed", note: "no installer known" }];
    const { backend, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const b = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ skippedAgents: aside, onResult: r => void results.push(r) }) });
    expect(results[0]!.agents[0]).toEqual({ id: "agents/zed", name: "Zed", outcome: "skipped", note: "no installer known" });
    expect(stages).toContain("installing-harness:Claude Code, Codex installed; Zed skipped (no installer known); caches swept; 2.9 GB free");
    expect(b.import?.smoke).toBe("claude --version && codex --version");

    const only = backendFor();
    const rec = stageRecorder();
    await expect(prepareBuilder({ backend: only.backend, setup: "true", fetch: only.fetch, onStage: rec.onStage, import: importOf({ agents: [], skippedAgents: aside }) })).rejects.toThrow(/no agent installed/);
    expect(rec.stages.at(-1)).toBe("failed:no agent installed, so there is nothing to seal:\nZed: no installer known");
    expect(only.killed).toEqual(["m1"]);
  });

  it("an agent does not start under the agents' floor: it is recorded failed with the reading, which ends the build as any missing agent does", async () => {
    let agentsStarted = false;
    const { backend, cmds, killed, fetch } = backendFor([["claude-install", () => ((agentsStarted = true), ok)]], () => mb(agentsStarted ? 500 : 3000));
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow("an agent did not install, so nothing is sealed:\nCodex: 500 MB free, keeping 800 MB free");
    expect(results[0]!.agents.map(a => [a.id, a.outcome, a.note])).toEqual([
      ["agents/claude", "installed", undefined],
      ["agents/codex", "failed", "500 MB free, keeping 800 MB free"],
    ]);
    expect(cmds.some(c => c.includes("codex-install"))).toBe(false);
    expect(killed).toEqual(["m1"]);
    expect(stages.at(-1)).toBe("failed:an agent did not install, so nothing is sealed:\nCodex: 500 MB free, keeping 800 MB free");
  });

  it("when Homebrew itself fails, every brew formula is skipped rather than tried", async () => {
    const { backend, cmds, fetch } = backendFor([["brew-bootstrap", { exitCode: 1, stdout: "", stderr: "git: not found" }]]);
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages).toContain("installing-tools:1 installed, 1 failed: Homebrew (git: not found), 1 skipped: gh (Homebrew did not install); caches swept; 2.9 GB free");
    // No Homebrew, nothing of its to clean.
    expect(cmds.some(c => c.includes("brew autoremove") || c.includes("brew cleanup"))).toBe(false);
  });

  it("a tool that hits its timeout is recorded failed with the seconds, the guard kills its session and every descendant before the next tool, and the next tool runs", async () => {
    const { backend, cmds, fetch } = backendFor([["brew install gh", { exitCode: 124, stdout: "==> Downloading gh\n", stderr: "" }]]);
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/brew/gh", "failed", "timed out after 600s"],
      ["tools/npm/bun", "installed", undefined],
    ]);
    expect(stages).toContain("installing-tools:2 installed, 1 failed: gh (timed out after 600s); caches swept; 2.9 GB free");
    const guard = cmds.find(c => c.includes("brew install gh"))!;
    // The install runs in its own session; at the timeout that session's group and everything descended from it
    // (found through /proc by parent pid, since su starts its command in a session of its own) get TERM, then KILL.
    expect(guard).toMatch(/^tree\(\) \{\n/);
    expect(guard).toContain("for f in /proc/[0-9]*/stat");
    expect(guard).toMatch(/\nsetsid bash -c '.*' &\np=\$!\n/s);
    expect(guard).toContain('v="$p $(tree $p)"\n  kill -TERM -- -$p $v');
    expect(guard).toContain("kill -KILL -- -$p $v");
    // The guard returns 124 only once the tree is gone, so the next brew never meets a lock the last one still holds.
    expect(guard).toMatch(/kill -KILL[^\n]*\n\s+t=0; while \[ \$t -lt 10 \] && kill -0 \$v[^\n]*\n\s+exit 124\n/);
    expect(guard).not.toMatch(/pkill|killall/);
  });

  it("a download road that hits its limit is tried once more and the frames say so; the second run's success is an install", async () => {
    let tries = 0;
    const { backend, cmds, fetch } = backendFor([["npm install -g bun@1.4.0", () => (++tries === 1 ? { exitCode: 124, stdout: "", stderr: "" } : ok)]]);
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(tries).toBe(2);
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/brew/gh", "installed", undefined],
      ["tools/npm/bun", "installed", undefined],
    ]);
    expect(stages).toContain("installing-tools:bun@1.4.0: timed out after 300s; trying once more");
    // The step's script opens with the road's network clock, and the guard's limit is the road's, not one number for every tool.
    const guards = cmds.filter(c => c.includes("npm install -g bun@1.4.0"));
    expect(guards).toHaveLength(2);
    for (const g of guards) {
      expect(g).toContain("export npm_config_fetch_timeout=60000 npm_config_fetch_retries=1 npm_config_fetch_retry_maxtimeout=10000\nnpm install -g bun@1.4.0");
      expect(g).toContain("while [ $t -lt 300 ]");
    }
    const brew = cmds.find(c => c.includes("brew install gh"))!;
    expect(brew).toContain("while [ $t -lt 600 ]");
    expect(brew).not.toContain("npm_config_fetch_timeout");
  });

  it("a download road that hits its limit twice is recorded failed with both timeouts, and the compile roads are not tried again", async () => {
    const { backend, cmds, fetch } = backendFor([["npm install -g bun@1.4.0", { exitCode: 124, stdout: "", stderr: "" }]]);
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(results[0]!.tools.find(t => t.id === "tools/npm/bun")).toMatchObject({ outcome: "failed", note: "timed out after 300s, twice" });
    expect(stages).toContain("installing-tools:2 installed, 1 failed: bun@1.4.0 (timed out after 300s, twice); caches swept; 2.9 GB free");
    expect(cmds.filter(c => c.includes("npm install -g bun@1.4.0"))).toHaveLength(2);
  });

  it("every frame of a step names the step and the line a person reads for it, so a screen can clock the step; the stage's own lines name none", async () => {
    const frames: { detail?: string; step?: { label: string; command: string } }[] = [];
    const rb = recordingBackend({}, {
      stream: true,
      exec: cmd => (cmd.includes("brew install gh") ? { exitCode: 0, stdout: "==> Downloading gh\n==> Pouring gh\n", stderr: "" } : cmd === FREE_KB_CMD ? { exitCode: 0, stdout: `${mb(3000)}\n`, stderr: "" } : cmd === "echo ok" ? REACH_OK : cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" } : ok),
    });
    const fetchStub: typeof fetch = async () => new Response(null, { status: 200 });
    const onStage = (stage: GoldenStage, detail?: string, step?: { label: string; command: string }) => {
      if (stage === "installing-tools") frames.push({ ...(detail !== undefined ? { detail } : {}), ...(step !== undefined ? { step } : {}) });
    };
    await prepareBuilder({ backend: rb.backend, setup: "true", fetch: fetchStub, onStage, import: importOf({ tools: [{ id: "tools/brew/gh", label: "gh", manager: "brew", cmd: "su -c 'brew install gh'", shown: "brew install gh" }, { id: "tools/npm/bun", label: "bun@1.4.0", manager: "npm", cmd: "npm install -g bun@1.4.0" }] }) });
    const gh = { label: "gh", command: "brew install gh" };
    expect(frames.slice(0, 3)).toEqual([
      { detail: "gh (1/2)", step: gh },
      { detail: "gh: ==> Downloading gh", step: gh },
      { detail: "gh: ==> Pouring gh", step: gh },
    ]);
    // A step with no line of its own is read by its command.
    expect(frames).toContainEqual({ detail: "bun@1.4.0 (2/2)", step: { label: "bun@1.4.0", command: "npm install -g bun@1.4.0" } });
    expect(frames.at(-1)!.step).toBeUndefined();
    expect(frames.at(-1)!.detail).toMatch(/^2 installed/);
  });

  it("a cellar lock error waits once for every Homebrew lock to clear, then tries the tool once more", async () => {
    let tries = 0;
    const locked = { exitCode: 1, stdout: "", stderr: "Error: A `brew install glibc` process has already locked /home/linuxbrew/.linuxbrew/Cellar/linux-headers@6.8.\nPlease wait for it to finish or terminate it to continue." };
    const { backend, cmds, fetch } = backendFor([["brew install gh", () => (++tries === 1 ? locked : ok)]]);
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(tries).toBe(2);
    const at = (needle: string) => cmds.findIndex(c => c.includes(needle));
    const wait = cmds.find(c => c.includes("flock -w"))!;
    expect(wait).toBe('for l in /home/linuxbrew/.linuxbrew/var/homebrew/locks/*.lock; do [ -e "$l" ] && flock -w 600 "$l" true; done; true');
    expect(cmds.filter(c => c.includes("flock -w"))).toHaveLength(1);
    expect(at("brew install gh")).toBeLessThan(at("flock -w"));
    expect(cmds.lastIndexOf(cmds.find(c => c.includes("brew install gh"))!)).toBeGreaterThan(at("flock -w"));
    expect(stages).toContain("installing-tools:gh: another brew holds its cellar; waiting for it, then once more");
    expect(results[0]!.tools.find(t => t.id === "tools/brew/gh")).toMatchObject({ outcome: "installed" });
    // A second lock error is the tool's failure, with Homebrew's line as the reason.
    const again = backendFor([["brew install gh", locked]]);
    const more: ImportResult[] = [];
    await prepareBuilder({ backend: again.backend, setup: "true", fetch: again.fetch, import: importOf({ onResult: r => void more.push(r) }) });
    expect(again.cmds.filter(c => c.includes("flock -w"))).toHaveLength(1);
    expect(again.cmds.filter(c => c.includes("brew install gh"))).toHaveLength(2);
    expect(more[0]!.tools.find(t => t.id === "tools/brew/gh")).toMatchObject({ outcome: "failed", note: "Error: A `brew install glibc` process has already locked /home/linuxbrew/.linuxbrew/Cellar/linux-headers@6.8." });
  });

  it("after the loop Homebrew autoremoves then cleans up, both guarded, and the detail says what that freed; archives a failed export left in /tmp go before the first tool", async () => {
    let cleaned = false;
    const { backend, cmds, fetch } = backendFor(
      [["brew cleanup -s --prune=all", () => ((cleaned = true), ok)]],
      () => mb(cleaned ? 4000 : 3000),
    );
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    const at = (needle: string) => cmds.findIndex(c => c.includes(needle));
    const autoremove = cmds[at("brew autoremove")]!;
    expect(autoremove).toMatch(/^tree\(\) \{\n/);
    expect(autoremove).toMatch(/\nsetsid bash -c 'export PATH=.*su -s \/bin\/bash linuxbrew -c .*brew autoremove.* &\np=\$!\n/s);
    expect(autoremove).not.toContain("HOMEBREW_NO_INSTALL_CLEANUP");
    expect(at("bun@1.4.0")).toBeLessThan(at("brew autoremove"));
    expect(at("brew autoremove")).toBeLessThan(at("brew cleanup -s --prune=all"));
    expect(at("brew cleanup -s --prune=all")).toBeLessThan(cmds.indexOf("echo ok"));
    expect(stages).toContain("installing-tools:3 installed; Homebrew cleanup freed 1000 MB; caches swept; 3.9 GB free");
    const sweep = cmds.lastIndexOf("rm -f /tmp/wsp-vault-*.tgz");
    expect(sweep).toBeGreaterThan(at("tar xzf"));
    expect(sweep).toBeLessThan(at("brew-bootstrap"));
    // A cleanup that fails is named, and the tools it followed still count.
    const failing = backendFor([["brew cleanup -s --prune=all", { exitCode: 1, stdout: "", stderr: "Error: Permission denied @ apply2files" }]]);
    const rec = stageRecorder();
    await prepareBuilder({ backend: failing.backend, setup: "true", fetch: failing.fetch, onStage: rec.onStage, import: importOf() });
    expect(rec.stages).toContain("installing-tools:3 installed; Homebrew cleanup failed (Error: Permission denied @ apply2files); caches swept; 2.9 GB free");
  });

  it("after the agents and again after the tools the install caches are swept under the guard, and the closing line says what came back and what is free", async () => {
    let sweeps = 0;
    const { backend, cmds, fetch } = backendFor(
      [["rm -rf /root/.npm /root/.cache/uv /root/.cache/go-build /root/.cache/node-gyp", () => ((sweeps += 1), ok)]],
      () => mb(3000 + sweeps * 700),
    );
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    const sweepCmds = cmds.filter(c => c.includes("rm -rf /root/.npm /root/.cache/uv /root/.cache/go-build /root/.cache/node-gyp"));
    // Once after the base floor, once after the agents, once after the tools.
    expect(sweepCmds).toHaveLength(3);
    for (const sweep of sweepCmds) {
      expect(sweep).toMatch(/\nsetsid bash -c 'set -euo pipefail\nexport PATH=\/root\/\.local\/bin:/);
      expect(sweep).toContain("if command -v go >/dev/null 2>&1; then go clean -cache -modcache; fi");
      expect(sweep).toContain("if command -v apt-get >/dev/null 2>&1; then apt-get clean; fi");
      expect(sweep).toMatch(/while \[ \$t -lt 300 \]/);
    }
    const at = (needle: string) => cmds.findIndex(c => c.includes(needle));
    const sweepsAt = cmds.flatMap((c, i) => (c.includes("rm -rf /root/.npm /root/.cache/uv /root/.cache/go-build /root/.cache/node-gyp") ? [i] : []));
    // The base's caches go before the daemon; the agents' before the tools stage reads the disk against its floor; the tools' after Homebrew's own housekeeping.
    expect(sweepsAt[0]).toBeLessThan(at("the-setup") < 0 ? at("claude-install") : at("the-setup"));
    expect(at("codex-install")).toBeLessThan(sweepsAt[1]!);
    expect(sweepsAt[1]).toBeLessThan(at("brew-bootstrap"));
    expect(at("brew cleanup -s --prune=all")).toBeLessThan(sweepsAt[2]!);
    expect(sweepsAt[2]).toBeLessThan(cmds.indexOf("echo ok"));
    // Each closing line carries what the sweep gave back and the df reading the stage left.
    expect(stages).toContain("deploying-daemon:15 installed; caches swept, 700 MB back; 3.6 GB free");
    expect(stages).toContain("installing-harness:Claude Code, Codex installed; caches swept, 700 MB back; 4.3 GB free");
    expect(stages).toContain("installing-tools:3 installed; caches swept, 700 MB back; 5 GB free");
    // A sweep that fails is named, and the build goes on to the next stage.
    const failing = backendFor([["rm -rf /root/.npm /root/.cache/uv /root/.cache/go-build /root/.cache/node-gyp", { exitCode: 1, stdout: "", stderr: "rm: cannot remove '/root/.npm': Device or resource busy" }]]);
    const rec = stageRecorder();
    const builder = await prepareBuilder({ backend: failing.backend, setup: "true", fetch: failing.fetch, onStage: rec.onStage, import: importOf() });
    expect(rec.stages).toContain("installing-harness:Claude Code, Codex installed; cache sweep failed (rm: cannot remove '/root/.npm': Device or resource busy); 2.9 GB free");
    expect(rec.stages).toContain("installing-tools:3 installed; cache sweep failed (rm: cannot remove '/root/.npm': Device or resource busy); 2.9 GB free");
    expect(builder.import?.applied).toContain("installing-tools");
  });

  it("stops installing tools when the disk drops under the tools floor and stays there after the cleanup", async () => {
    let bootstrapped = false;
    let cleanups = 0;
    let sweeps = 0;
    // The base floor and the two agents (a sweep each), the upload and Homebrew read a roomy disk; the first formula reads it low, and the cleanup gives little back.
    const { backend, cmds, fetch } = backendFor(
      [["brew-bootstrap", () => ((bootstrapped = true), ok)], ["brew cleanup -s --prune=all", () => (cleanups++, ok)], [SWEEP_NEEDLE, () => (sweeps++, ok)]],
      () => mb(!bootstrapped ? 3000 : cleanups === 0 ? 1800 : sweeps === 2 ? 1900 : 1950),
    );
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    const at = (needle: string) => cmds.findIndex(c => c.includes(needle));
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages).toContain("installing-tools:1.8 GB free, under the 2 GB floor; cleaning up before skipping");
    expect(stages).toContain("installing-tools:Homebrew cleanup freed 100 MB; caches swept, 50 MB back; 1.9 GB free");
    expect(stages).toContain("installing-tools:1 installed, 2 skipped: gh, bun@1.4.0 (1.9 GB free after cleanup, keeping 2 GB free); caches swept; 1.9 GB free");
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/brew/gh", "skipped", "1.9 GB free after cleanup, keeping 2 GB free"],
      ["tools/npm/bun", "skipped", "1.9 GB free after cleanup, keeping 2 GB free"],
    ]);
    // The cleanup at the floor is guarded, autoremove first, the sweep after Homebrew, and runs once in the loop; the housekeeping after the loop still runs.
    expect(cmds[at("brew cleanup -s --prune=all")]!).toMatch(/^tree\(\) \{\n/);
    expect(at("brew autoremove")).toBeGreaterThan(at("brew-bootstrap"));
    expect(at("brew autoremove")).toBeLessThan(at("brew cleanup -s --prune=all"));
    const sweepsAt = cmds.flatMap((c, i) => (c.includes(SWEEP_NEEDLE) ? [i] : []));
    expect(sweepsAt[2]).toBeGreaterThan(at("brew cleanup -s --prune=all"));
    expect(sweepsAt[2]).toBeLessThan(cmds.length - 1 - [...cmds].reverse().findIndex(c => c.includes("brew cleanup -s --prune=all")));
    expect(cleanups).toBe(2);
    expect(sweeps).toBe(4);
  });

  it("at the first reading under the floor the cleanup runs and df is read again: the install goes on when the floor clears, and a later dip skips without another cleanup", async () => {
    let bootstrapped = false;
    let cleanups = 0;
    let ghDone = false;
    const { backend, cmds, fetch } = backendFor(
      [["brew-bootstrap", () => ((bootstrapped = true), ok)], ["brew cleanup -s --prune=all", () => (cleanups++, ok)], ["brew install gh", () => ((ghDone = true), ok)]],
      () => mb(!bootstrapped ? 3000 : ghDone ? 500 : cleanups === 0 ? 1800 : 4200),
    );
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    const at = (needle: string) => cmds.findIndex(c => c.includes(needle));
    expect(at("brew cleanup -s --prune=all")).toBeGreaterThan(at("brew-bootstrap"));
    expect(at("brew cleanup -s --prune=all")).toBeLessThan(at("brew install gh"));
    expect(stages.filter(s => s.startsWith("installing-tools"))).toEqual([
      "installing-tools:Homebrew (1/3)",
      "installing-tools:1.8 GB free, under the 2 GB floor; cleaning up before skipping",
      "installing-tools:Homebrew cleanup freed 2.3 GB; caches swept; 4.1 GB free",
      "installing-tools:gh (2/3)",
      "installing-tools:2 installed, 1 skipped: bun@1.4.0 (500 MB free, keeping 2 GB free); caches swept; 500 MB free",
    ]);
    expect(results[0]!.tools.map(t => [t.id, t.outcome])).toEqual([["tools/homebrew", "installed"], ["tools/brew/gh", "installed"], ["tools/npm/bun", "skipped"]]);
    // One rescue in the loop, one housekeeping after it; the base, the agents, the rescue and the tools each sweep.
    expect(cleanups).toBe(2);
    expect(cmds.filter(c => c.includes(SWEEP_NEEDLE))).toHaveLength(4);
  });

  it("under the floor with no Homebrew on the machine the cache sweep alone runs, and the install goes on when it clears the floor", async () => {
    let bootstrapped = false;
    let sweeps = 0;
    const failing = { exitCode: 1, stdout: "", stderr: "Error: bootstrap failed" };
    const { backend, cmds, fetch } = backendFor(
      [["brew-bootstrap", () => ((bootstrapped = true), failing)], [SWEEP_NEEDLE, () => (sweeps++, ok)]],
      () => mb(!bootstrapped ? 3000 : sweeps === 2 ? 1800 : 2500),
    );
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(cmds.some(c => c.includes("brew cleanup -s --prune=all"))).toBe(false);
    expect(stages.filter(s => s.startsWith("installing-tools"))).toEqual([
      "installing-tools:Homebrew (1/3)",
      "installing-tools:1.8 GB free, under the 2 GB floor; cleaning up before skipping",
      "installing-tools:caches swept, 700 MB back; 2.4 GB free",
      "installing-tools:bun@1.4.0 (3/3)",
      "installing-tools:1 installed, 1 failed: Homebrew (Error: bootstrap failed), 1 skipped: gh (Homebrew did not install); caches swept; 2.4 GB free",
    ]);
    expect(results[0]!.tools.map(t => [t.id, t.outcome])).toEqual([["tools/homebrew", "failed"], ["tools/brew/gh", "skipped"], ["tools/npm/bun", "installed"]]);
    // The base's sweep, the agents' sweep, the rescue in the loop, the housekeeping after it.
    expect(sweeps).toBe(4);
  });

  it("when df cannot be read after the cleanup the tools left are skipped, and the row says the rescue ran and what was unknown", async () => {
    let bootstrapped = false;
    let cleanups = 0;
    const broken = { exitCode: 1, stdout: "", stderr: "df: /root: Input/output error" };
    const { backend, cmds, fetch } = backendFor([
      ["brew-bootstrap", () => ((bootstrapped = true), ok)],
      ["brew cleanup -s --prune=all", () => (cleanups++, ok)],
      [FREE_KB_CMD, () => (cleanups === 0 ? { exitCode: 0, stdout: `${mb(bootstrapped ? 1800 : 3000)}\n`, stderr: "" } : broken)],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages.filter(s => s.startsWith("installing-tools"))).toEqual([
      "installing-tools:Homebrew (1/3)",
      "installing-tools:1.8 GB free, under the 2 GB floor; cleaning up before skipping",
      "installing-tools:caches swept; df failed: df: /root: Input/output error",
      "installing-tools:1 installed, 2 skipped: gh, bun@1.4.0 (1.8 GB free before cleanup and unknown after (df failed: df: /root: Input/output error), keeping 2 GB free); caches swept",
    ]);
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/brew/gh", "skipped", "1.8 GB free before cleanup and unknown after (df failed: df: /root: Input/output error), keeping 2 GB free"],
      ["tools/npm/bun", "skipped", "1.8 GB free before cleanup and unknown after (df failed: df: /root: Input/output error), keeping 2 GB free"],
    ]);
  });

  it("a full disk is a reading of zero, not an unknown one: the cleanup runs once and the tools left are skipped at the floor", async () => {
    let bootstrapped = false;
    const { backend, cmds, fetch } = backendFor([["brew-bootstrap", () => ((bootstrapped = true), ok)]], () => mb(bootstrapped ? 0 : 3000));
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(stages.filter(s => s.startsWith("installing-tools"))).toEqual([
      "installing-tools:Homebrew (1/3)",
      "installing-tools:0 B free, under the 2 GB floor; cleaning up before skipping",
      "installing-tools:caches swept; 0 B free",
      "installing-tools:1 installed, 2 skipped: gh, bun@1.4.0 (0 B free after cleanup, keeping 2 GB free); caches swept; 0 B free",
    ]);
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/brew/gh", "skipped", "0 B free after cleanup, keeping 2 GB free"],
      ["tools/npm/bun", "skipped", "0 B free after cleanup, keeping 2 GB free"],
    ]);
  });

  it("a Homebrew cleanup that fails at the floor is named in the rescue's line, and the skip still carries the reading after it", async () => {
    let bootstrapped = false;
    const failing = { exitCode: 1, stdout: "", stderr: "Error: Permission denied @ apply2files" };
    const { backend, cmds, fetch } = backendFor(
      [["brew-bootstrap", () => ((bootstrapped = true), ok)], ["brew cleanup -s --prune=all", failing]],
      () => mb(bootstrapped ? 1800 : 3000),
    );
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages.filter(s => s.startsWith("installing-tools"))).toEqual([
      "installing-tools:Homebrew (1/3)",
      "installing-tools:1.8 GB free, under the 2 GB floor; cleaning up before skipping",
      "installing-tools:Homebrew cleanup failed (Error: Permission denied @ apply2files); caches swept; 1.8 GB free",
      "installing-tools:1 installed, 2 skipped: gh, bun@1.4.0 (1.8 GB free after cleanup, keeping 2 GB free); Homebrew cleanup failed (Error: Permission denied @ apply2files); caches swept; 1.8 GB free",
    ]);
    expect(results[0]!.tools.map(t => [t.id, t.outcome])).toEqual([["tools/homebrew", "installed"], ["tools/brew/gh", "skipped"], ["tools/npm/bun", "skipped"]]);
  });

  it("refuses to upload when the archive and its contents would not fit, kills the builder, and says why", async () => {
    const { backend, killed, puts, fetch } = backendFor([], mb(100));
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() })).rejects.toThrow(/1 KB packed and 4 KB unpacked.*256 MB.*100 MB free/);
    expect(puts).toEqual([]);
    expect(killed).toEqual(["m1"]);
    expect(stages.at(-1)).toMatch(/^failed:your files need 1 KB packed and 4 KB unpacked, plus 256 MB of headroom, but the machine has 100 MB free/);
    // The check reads the archive, not the recipe's estimate: a small tar of a large estimate still fits.
    const roomy = backendFor([], mb(3000));
    await expect(prepareBuilder({ backend: roomy.backend, setup: "true", fetch: roomy.fetch, import: importOf({ files: { ...importOf().files!, bytes: 10 * 1024 * 1024 * 1024 } }) })).resolves.toBeDefined();
  });

  it("a df that fails is a warning that names itself, once per stage, and the build goes on", async () => {
    const { backend, cmds, puts, fetch } = backendFor([[FREE_KB_CMD, { exitCode: 1, stdout: "", stderr: "df: /root: No such file or directory" }]]);
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(stages).toContain("uploading-files:free disk unknown (df failed: df: /root: No such file or directory); uploading 1 KB anyway");
    expect(stages.filter(s => s.startsWith("installing-tools:free disk unknown"))).toEqual(["installing-tools:free disk unknown (df failed: df: /root: No such file or directory); installing without the 2 GB floor"]);
    expect(puts).toHaveLength(2);
    expect(cmds.filter(c => c.includes("brew install gh") || c.includes("brew-bootstrap") || c.includes("bun@1.4.0"))).toHaveLength(3);
    expect(builder.import?.applied).toContain("installing-harness");
  });

  it("a df that exits 0 printing something it cannot use names what it printed", async () => {
    const words = backendFor([[FREE_KB_CMD, { exitCode: 0, stdout: "abc\n", stderr: "" }]]);
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend: words.backend, setup: "true", fetch: words.fetch, onStage, import: importOf() });
    expect(stages.filter(s => s.includes("free disk unknown"))).toEqual([
      "deploying-daemon:free disk unknown (df answered abc); installing without the 2 GB floor",
      "uploading-files:free disk unknown (df answered abc); uploading 1 KB anyway",
      "installing-tools:free disk unknown (df answered abc); installing without the 2 GB floor",
    ]);
  });

  it("a df that exits 0 printing nothing is a failure, since the pipe exits as awk does", async () => {
    const silent = backendFor([[FREE_KB_CMD, { exitCode: 0, stdout: "", stderr: "df: /root: No such file or directory" }]]);
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend: silent.backend, setup: "true", fetch: silent.fetch, onStage, import: importOf() });
    expect(stages.filter(s => s.includes("free disk unknown"))).toEqual([
      "deploying-daemon:free disk unknown (df failed: df: /root: No such file or directory); installing without the 2 GB floor",
      "uploading-files:free disk unknown (df failed: df: /root: No such file or directory); uploading 1 KB anyway",
      "installing-tools:free disk unknown (df failed: df: /root: No such file or directory); installing without the 2 GB floor",
    ]);
  });

  it("an exec that rejects under the free read throws out of the install loop before anything installs", async () => {
    const ran: string[] = [];
    const machine = {
      id: "spoo",
      kind: "sandbox",
      exec: async (cmd: string) => {
        if (cmd === FREE_KB_CMD) throw new Error("exec lost the machine");
        return ok;
      },
      run: async (script: string) => {
        ran.push(script);
        return ok;
      },
    } as unknown as Machine;
    await expect(installTools(machine, [{ id: "tools/brew/gh", label: "gh", manager: "brew", cmd: "brew install gh" }], () => {})).rejects.toThrow("exec lost the machine");
    expect(ran).toEqual([]);
  });

  it("a tool waits on the install it needs: a manager that did not install skips its rows with the manager's name", async () => {
    const tools: ToolInstall[] = [
      { id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: "brew-bootstrap" },
      { id: "tools/manager/pipx", label: "pipx", manager: "brew", cmd: "brew install pipx", after: "tools/homebrew" },
      { id: "tools/pipx/black", label: "black 24.1.0", manager: "pipx", cmd: "pipx install black==24.1.0", after: "tools/manager/pipx" },
      { id: "tools/npm/bun", label: "bun@1.4.0", manager: "npm", cmd: "npm install -g bun@1.4.0" },
    ];
    const { backend, cmds, fetch } = backendFor([["brew install pipx", { exitCode: 1, stdout: "", stderr: "Error: pipx: no bottle" }]]);
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ tools, onResult: r => void results.push(r) }) });
    expect(cmds.some(c => c.includes("pipx install black"))).toBe(false);
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/manager/pipx", "failed", "Error: pipx: no bottle"],
      ["tools/pipx/black", "skipped", "pipx did not install"],
      ["tools/npm/bun", "installed", undefined],
    ]);
  });

  it("a failure packing or extracting the files is fatal with its reason", async () => {
    const packFails = importOf({ files: { count: 1, rungs: { shell: 1 }, lands: [], bytes: 10, skipped: [], pack: async () => { throw new Error("Keychain: user cancelled"); } } });
    const a = backendFor();
    await expect(prepareBuilder({ backend: a.backend, setup: "true", fetch: a.fetch, import: packFails })).rejects.toThrow(/Keychain: user cancelled/);
    expect(a.killed).toEqual(["m1"]);

    const b = backendFor([["tar xzf", { exitCode: 2, stdout: "", stderr: "gzip: stdin: not in gzip format" }]]);
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend: b.backend, setup: "true", fetch: b.fetch, onStage, import: importOf() })).rejects.toThrow(/not in gzip format/);
    expect(stages.at(-1)).toMatch(/^failed:vault import untar failed/);
    expect(b.killed).toEqual(["m1"]);
  });

  it("with nothing ticked the file stages still report, and no agent means a smoke of true", async () => {
    const { backend, cmds, puts, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: { recipeHash: "h0", tools: [], agents: [] } });
    expect(sansBase(stages)).toEqual([
      "creating:sandbox from base",
      "deploying-daemon", "deploying-daemon:2.9 GB free",
      "applying-setup:nothing ticked",
      "uploading-files:nothing to upload",
      "installing-harness",
      "installing-harness:no agent ticked",
      "installing-tools:nothing ticked",
      "installing-mcp:none configured",
      CONTEXT_WRITTEN,
      "ready",
    ]);
    expect(puts).toHaveLength(1);
    // The harness ran, so the context is written and the machine is asked whether it still answers before the hand-off.
    const setupAt = cmds.findIndex(c => c.includes("\ntrue' &"));
    expect(cmds.slice(setupAt).map(c => (c.includes("echo WSP_CTX") ? "probe" : c.includes("tar xzf - -C '/' ") ? "write" : c.includes("\ntrue' &") ? "setup" : c))).toEqual(["setup", "probe", "write", "echo ok"]);
    expect(builder.import?.smoke).toBe("true");

    let result: ImportResult | undefined;
    const gone = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ files: { count: 0, rungs: {}, lands: [], bytes: 0, skipped: [{ id: "shell/zshrc", path: "~/.zshrc", note: "no longer on this computer" }], pack: async () => { throw new Error("must not pack"); } }, onResult: r => (result = r) }) });
    expect(stages).toContain("applying-setup:nothing left to pack; skipped ~/.zshrc (no longer on this computer)");
    expect(gone.import?.applied).toContain("uploading-files");
    // No pack ran, so nothing was cut: the result says nothing about it rather than claiming an empty cut.
    expect(result?.files).toEqual({ bytes: 0, skipped: [{ id: "shell/zshrc", path: "~/.zshrc", note: "no longer on this computer" }] });
    expect(result?.files).not.toHaveProperty("cut");
  });

  it("applying the same recipe again to a builder that has it skips every stage and runs nothing", async () => {
    const { backend, cmds, fetch } = backendFor();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = cmds.length;
    const { stages, onStage } = stageRecorder();
    const again = await applyGoldenImport(builder.machine, { import: importOf(), setup: "true", ledger: builder.import, fetch, onStage });
    expect(cmds.length).toBe(before);
    expect(stages).toEqual([
      "applying-setup:already applied",
      "uploading-files:already applied",
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
    ]);
    expect(again.ledger).toEqual(builder.import);
    // Nothing ran, so there is no result to report; the saved list from the first run stands.
    const results: ImportResult[] = [];
    await applyGoldenImport(builder.machine, { import: importOf({ onResult: r => void results.push(r) }), setup: "true", ledger: builder.import, fetch });
    expect(results).toEqual([]);

    const other = await applyGoldenImport(builder.machine, { import: importOf({ recipeHash: "h2" }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(cmds.length).toBeGreaterThan(before);
    expect(other.ledger.recipeHash).toBe("h2");
  });

  it("an attach with an MCP plan runs the config edit and the reach check, and still reports no result: the saved list from the build stands", async () => {
    const { backend, cmds, fetch } = backendFor();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = cmds.length;
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const mcp = { agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: ["/root/.claude-cfg/.claude.json"], format: MCP_SERVERS_JSON, keep: ["github"], drop: [] }], aside: [] }], guestHome: "/root", rewrites: [], binDirs: [], tools: [] };
    await applyGoldenImport(builder.machine, { import: importOf({ mcp, onResult: r => void results.push(r) }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(results).toEqual([]);
    expect(stages.slice(0, 5)).toEqual(["applying-setup:already applied", "uploading-files:already applied", "installing-harness:already applied", "installing-tools:already applied", "installing-mcp:Claude Code 1"]);
    expect(stages.at(-2)).toBe("installing-mcp:github skipped (the config edit did not run (exit 0)); 2.9 GB free");
    expect(stages.at(-1)).toMatch(/^installing-mcp:1 skipped; machine context: \d+(\.\d+)? KB written; no agent on the machine$/);
    expect(cmds.length).toBeGreaterThan(before);
    expect(cmds.at(-1)).toBe("echo ok");
  });

  it("applying the same recipe to a builder that has it uploads its volatile files again, so the golden carries the latest copy; nothing else runs", async () => {
    const { backend, cmds, puts, fetch } = backendFor();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = { cmds: cmds.length, puts: puts.length };
    const { stages, onStage } = stageRecorder();
    const volatile = {
      paths: ["~/.claude.json", "~/.claude/plugins/installed_plugins.json"],
      pack: async () => ({ tar: Buffer.from("volatile-tgz"), bytes: 300, unpacked: 2048, skipped: [], cut: [], silenced: [], macPaths: [] }),
    };
    const results: ImportResult[] = [];
    const again = await applyGoldenImport(builder.machine, { import: importOf({ files: { ...importOf().files!, volatile }, onResult: r => void results.push(r) }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(puts.slice(before.puts).map(b => b.toString())).toEqual(["volatile-tgz"]);
    expect(cmds.slice(before.cmds).filter(c => c.includes("tar xzf"))).toHaveLength(1);
    expect(stages).toEqual([
      "applying-setup:already applied",
      "uploading-files:2 volatile files, 300 B",
      expect.stringMatching(/^uploading-files:~\/\.claude\.json, ~\/\.claude\/plugins\/installed_plugins\.json re-imported, 300 B in \d+\.\ds; 2.9 GB free$/),
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
    ]);
    expect(again.ledger).toEqual(builder.import);
    // The saved result from the first run stands: a re-import of state files changes no cut and no install.
    expect(results).toEqual([]);
  });

  it("a volatile re-import that fails on attach is reported on the stage and never fails the attach: the ledger stands and nothing else runs", async () => {
    let free = mb(3000);
    const { backend, cmds, puts, fetch } = backendFor([], () => free);
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = { cmds: cmds.length, puts: puts.length };
    // A default recipe leaves about 250 MB free after the install stages, under the 256 MiB upload headroom.
    free = mb(200);
    const volatile = { paths: ["~/.claude.json"], pack: async () => ({ tar: Buffer.from("volatile-tgz"), bytes: 300, unpacked: 2048, skipped: [], cut: [], silenced: [], macPaths: [] }) };
    const { stages, onStage } = stageRecorder();
    const again = await applyGoldenImport(builder.machine, { import: importOf({ files: { ...importOf().files!, volatile } }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(puts.length).toBe(before.puts);
    expect(stages).toEqual([
      "applying-setup:already applied",
      "uploading-files:1 volatile file, 300 B",
      expect.stringMatching(/^uploading-files:~\/\.claude\.json not re-imported: your files need 300 B packed and 2 KB unpacked, plus 256 MB of headroom, but the machine has 200 MB free$/),
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
    ]);
    expect(again.ledger).toEqual(builder.import);
    // A pack that throws takes the same road.
    const broken = { paths: ["~/.claude.json"], pack: async (): Promise<PackedFiles> => { throw new Error("EACCES: permission denied"); } };
    const rec = stageRecorder();
    await applyGoldenImport(builder.machine, { import: importOf({ files: { ...importOf().files!, volatile: broken } }), setup: "true", ledger: builder.import, fetch, onStage: rec.onStage });
    expect(rec.stages).toContain("uploading-files:~/.claude.json not re-imported: EACCES: permission denied");
  });

  it("without an import the harness path is unchanged", async () => {
    const { backend } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "echo setup", onStage });
    expect(sansBase(stages)).toEqual(["creating:sandbox from base", "deploying-daemon", "installing-harness", "ready"]);
    expect(builder.import).toBeUndefined();
    expect(builder.setupSha).toBe(createHash("sha256").update("echo setup").digest("hex"));
  });

  it("the ledger names every tool not on the image with its cause and reason, plan-time skips, failures and run-time skips alike, and the seal stamps them on the version", async () => {
    const { backend, fetch } = backendFor([["brew-bootstrap", { exitCode: 1, stdout: "", stderr: "git: not found" }]]);
    const skippedTools = [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ skippedTools }) });
    const want = [
      { id: "tools/brew-cask/raycast", name: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" },
      { id: "tools/homebrew", name: "Homebrew", outcome: "failed", note: "git: not found" },
      { id: "tools/brew/gh", name: "gh", outcome: "skipped", note: "Homebrew did not install" },
    ];
    expect(builder.import?.missingTools).toEqual(want);
    expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.missingTools).toEqual(want);
  });

  it("a base floor row that failed reaches the ledger and the sealed version with its name, outcome and reason, one shape with the tools stage", async () => {
    const { backend, fetch } = backendFor([["apt-get install -y -qq fd-find", { exitCode: 100, stdout: "", stderr: "E: Unable to locate package fd-find" }]]);
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const fd = { id: "base/fd", name: "fd", outcome: "failed", note: "E: Unable to locate package fd-find" };
    expect(builder.import?.missingTools).toEqual([fd]);
    expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.missingTools).toEqual([fd]);
  });

  it("the rc calls the pack silenced land on the ledger and the seal stamps them on the version, with the stage line naming them; a pack that silenced nothing leaves both without", async () => {
    const { backend, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const pack = async () => ({ tar: Buffer.from("tgz-bytes"), bytes: 1200, unpacked: 4096, skipped: [], cut: [], silenced: ["starship", "eza", "diskbloom"], macPaths: [] });
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ files: { ...importOf().files!, pack } }) });
    expect(builder.import?.silenced).toEqual(["starship", "eza", "diskbloom"]);
    expect(stages).toContain("applying-setup:1 KB packed; skipped ~/.bashrc (no longer on this computer); silenced in the shell: starship, eza, diskbloom");
    expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.silenced).toEqual(["starship", "eza", "diskbloom"]);
    const again = await applyGoldenImport(builder.machine, { import: importOf(), setup: "true", ledger: builder.import, fetch });
    expect(again.ledger.silenced).toEqual(["starship", "eza", "diskbloom"]);
    const quiet = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    expect(quiet.import).not.toHaveProperty("silenced");
    expect((await sealGolden(quiet, { backend, hostId: "h1", smoke: "true" })).version).not.toHaveProperty("silenced");
  });

  it("the stage line names what became of every Mac path the copied files carried, and says nothing where none did", async () => {
    const { backend, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const macPaths = ["/opt/homebrew/bin/gh now gh", "/Applications/Docker.app/Contents/Resources/bin out of .zshrc"];
    const pack = async () => ({ tar: Buffer.from("tgz-bytes"), bytes: 1200, unpacked: 4096, skipped: [], cut: [], silenced: [], macPaths });
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ files: { ...importOf().files!, pack } }) });
    expect(stages).toContain("applying-setup:1 KB packed; skipped ~/.bashrc (no longer on this computer); Mac paths: /opt/homebrew/bin/gh now gh, /Applications/Docker.app/Contents/Resources/bin out of .zshrc");
    const { stages: quiet, onStage: onQuiet } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage: onQuiet, import: importOf() });
    expect(quiet.some(l => l.includes("Mac paths"))).toBe(false);
  });

  it("a builder whose tools all installed records no missing list, and its version carries none", async () => {
    const { backend, fetch } = backendFor();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    expect(builder.import?.missingTools).toBeUndefined();
    expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.missingTools).toBeUndefined();
  });

  it("an attach whose tools stage is already applied carries the earlier missing list", async () => {
    const { backend, fetch } = backendFor();
    const skippedTools = [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ skippedTools }) });
    const again = await applyGoldenImport(builder.machine, { import: importOf(), setup: "true", ledger: builder.import, fetch });
    expect(again.ledger.missingTools).toEqual([{ id: "tools/brew-cask/raycast", name: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" }]);
  });

  it("the ledger carries what the pack left off the image, the seal stamps it on the version, and an attach whose files are already there keeps it", async () => {
    const { backend, fetch } = backendFor();
    const leftBehind = [{ id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: /opt/homebrew/bin/terminal-notifier" }];
    const files = { ...importOf().files!, pack: async () => ({ tar: Buffer.from("tgz-bytes"), bytes: 1200, unpacked: 4096, skipped: [...leftBehind], cut: [], silenced: [], macPaths: [], leftBehind }) };
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ files }) });
    expect(builder.import?.leftBehind).toEqual(leftBehind);
    expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.leftBehind).toEqual(leftBehind);
    const again = await applyGoldenImport(builder.machine, { import: importOf(), setup: "true", ledger: builder.import, fetch });
    expect(again.ledger.leftBehind).toEqual(leftBehind);
    const clean = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    expect(clean.import?.leftBehind).toBeUndefined();
    expect((await sealGolden(clean, { backend, hostId: "h1", smoke: "true" })).version.leftBehind).toBeUndefined();
  });

  describe("golden update", () => {
    const SNAPSHOT: RecipeDigest = { ticks: [], files: [] };
    const head: GoldenVersion = { version: 1, snapshotId: "snap_wsp-h1-default-v1", baseTemplate: "base", kind: "desktop", setupSha: "s1", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "claude --version && gemini --version", exitCode: 0 }, size: { cpu: 2, memMb: 8192 }, base: [{ name: "node", version: "22.23.2" }, { name: "jq", version: "1.7.1" }] };
    const deltaOf = (over: Partial<GoldenDelta> = {}): GoldenDelta => ({
      import: importOf({ recipeHash: "h2", recipe: SNAPSHOT, tools: [{ id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "brew install jq" }], agents: [{ id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version", road: "npm" as const }] }),
      retired: [
        { id: "shell/zshrc", name: "~/.zshrc" },
        { id: "tools/npm/bun", name: "bun" },
        { id: "agents/gemini", name: "Gemini CLI" },
        { id: "agents/claude", name: "Claude Code" },
      ],
      retiredOnImage: [
        { id: "shell/zshrc", name: "~/.zshrc" },
        { id: "tools/npm/bun", name: "bun" },
        { id: "agents/gemini", name: "Gemini CLI" },
        { id: "agents/claude", name: "Claude Code" },
      ],
      ...over,
    });

    it("a seal that keeps the builder snapshots it, boots and kills the fork, and leaves the builder running", async () => {
      const { backend, killed, timeline, fetch } = backendFor();
      const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ recipe: SNAPSHOT }) });
      const { stages, onStage } = stageRecorder();
      const result = await sealGolden(builder, { backend, hostId: "h1", smoke: "unused", keepBuilder: true, onStage });
      expect(result.builderKept).toBe(true);
      expect(result.version.version).toBe(1);
      expect(killed).toEqual(["m2"]);
      expect(timeline).toEqual(["create m1", "snapshot m1", "create m2", "kill m2"]);
      expect(stages.at(-1)).toBe("sealed:v1; builder kept for one more change");
      expect(builder.import?.recipe).toEqual(SNAPSHOT);
    });

    it("a seal without the option consumes the builder as before, and says nothing about keeping it", async () => {
      const { backend, killed } = recordingBackend();
      const builder = await prepareBuilder({ backend, setup: "true" });
      const { stages, onStage } = stageRecorder();
      const result = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", onStage });
      expect(result.builderKept).toBe(false);
      expect(killed).toEqual(["m1", "m2"]);
      expect(stages.at(-1)).toBe("sealed:v1");
    });

    it("when the account cap refuses the fork beside a kept builder, the builder is killed first and the fork tried again", async () => {
      const { backend, killed, timeline } = recordingBackend();
      let refused = false;
      const capped = {
        ...backend,
        create: async (spec: Parameters<typeof backend.create>[0]) => {
          if (spec.fromSnapshot !== undefined && !refused) {
            refused = true;
            throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
          }
          return backend.create(spec);
        },
      };
      const builder = await prepareBuilder({ backend: capped, setup: "true" });
      const { stages, onStage } = stageRecorder();
      const result = await sealGolden(builder, { backend: capped, hostId: "h1", smoke: "true", keepBuilder: true, onStage });
      expect(result.builderKept).toBe(false);
      expect(killed).toEqual(["m1", "m2"]);
      expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "create m2", "kill m2"]);
      expect(stages).toContain("smoke-forking:true; the account is at its machine cap, so the builder is not kept");
      expect(stages.at(-1)).toBe("sealed:v1");
    });

    it("a smoke that fails on a kept builder still kills the builder and drops the snapshot", async () => {
      const { backend, killed, deletedSnapshots } = recordingBackend({ "boom --version": { exitCode: 127, stdout: "", stderr: "not found" } });
      const builder = await prepareBuilder({ backend, setup: "true" });
      await expect(sealGolden(builder, { backend, hostId: "h1", smoke: "boom --version", keepBuilder: true })).rejects.toThrow(/smoke/);
      expect(killed).toEqual(["m1", "m2"]);
      expect(deletedSnapshots).toEqual(["snap_wsp-h1-default-v1"]);
    });

    it("applyDelta leaves every dropped row on the image, names them once, then runs the delta's stages and folds the retired agents out of the smoke", async () => {
      const { backend, cmds, ran, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const { stages, onStage } = stageRecorder();
      const { ledger } = await applyDelta(machine, deltaOf(), { setup: "true", previousSmoke: head.smoke.cmd, previousBase: head.base, fetch, onStage });
      // Nothing an earlier version installed is taken off: no uninstall, no rm of a file the recipe dropped.
      expect(ran.filter(r => /uninstall|\brm -rf -- /.test(r.script))).toEqual([]);
      expect(cmds.filter(c => /uninstall|\brm -rf -- /.test(c))).toEqual([]);
      expect(stages.slice(0, 1)).toEqual(["applying-setup:4 rows left on the image, retired: ~/.zshrc, bun, Gemini CLI, Claude Code"]);
      expect(stages.slice(1)).toEqual([
        "applying-setup:3 files: identity 1, shell 2",
        "applying-setup:1 KB packed; skipped ~/.bashrc (no longer on this computer)",
        "uploading-files:1 KB",
        expect.stringMatching(/^uploading-files:1 KB in /),
        "installing-harness",
        "installing-harness:Codex (1/1)",
        "installing-harness:Codex installed; caches swept; 2.9 GB free",
        "installing-tools:jq (1/1)",
        "installing-tools:1 installed; caches swept; 2.9 GB free",
        "installing-mcp:none configured",
        CONTEXT_WRITTEN,
      ]);
      expect(cmds[0]).toBe(FREE_KB_CMD);
      // Both agents are still on the image, but the recipe stopped asking for them, so their checks leave the smoke.
      expect(ledger).toEqual({ recipeHash: "h2", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "codex --version", recipe: SNAPSHOT });
    });

    it("an update of an image sealed with the harness under the home takes that file off, so the one it installs in /usr/local/bin is the one every PATH finds", async () => {
      const { backend, ran, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      await applyDelta(machine, deltaOf({ retired: [], retiredOnImage: [] }), { setup: GOLDEN_SETUP, previousSmoke: "true", previousBase: head.base, fetch });
      // The machine's disk as the scripts it ran leave it, from an image whose harness sits first on TOOLS_PATH.
      const disk = new Set(["/root/.local/bin/claude"]);
      for (const { script } of ran) {
        for (const line of script.split("\n")) {
          const removed = /^rm -f (\S+)$/.exec(line)?.[1];
          if (removed !== undefined) disk.delete(removed);
          const installed = /^install -D -m 0755 \S+ ([^\s']+)/.exec(line)?.[1];
          if (installed !== undefined) disk.add(installed);
        }
      }
      expect([...disk]).toEqual(["/usr/local/bin/claude"]);
    });

    it("a delta carries the head's pins onto the rows it leaves alone, and the rows it runs again record what they read now", async () => {
      const { backend, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const recipe: RecipeDigest = { ticks: [{ id: "tools/brew/jq", road: "brew", installer: "a" }, { id: "tools/catalog/gh", road: "release", installer: "k" }, { id: "agents/codex" }], files: [] };
      const previous: RecipeDigest = { ticks: recipe.ticks.map(t => ({ ...t, pin: { tag: `was-${t.id}` } })), files: [] };
      const delta = deltaOf({ import: importOf({ recipeHash: "h2", recipe, tools: [{ id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "brew install jq", pin: { read: "brew list --versions jq", fixed: false, words: "with Homebrew" } }], agents: [] }), retired: [], retiredOnImage: [] });
      const { ledger } = await applyDelta(machine, delta, { setup: "true", previousSmoke: "true", previousBase: head.base, previousRecipe: previous, fetch });
      // jq ran again and its read printed nothing, so it records no pin; gh and the agent did not run and keep the head's.
      expect(ledger.recipe?.ticks).toEqual([
        { id: "tools/brew/jq", road: "brew", installer: "a" },
        { id: "tools/catalog/gh", road: "release", installer: "k", pin: { tag: "was-tools/catalog/gh" } },
        { id: "agents/codex", pin: { tag: "was-agents/codex" } },
      ]);
      // Without the head's digest nothing is carried, as a version sealed before pins were read gives nothing to carry.
      const bare = await applyDelta(await backend.create({ kind: "sandbox", template: "base" }), delta, { setup: "true", previousSmoke: "true", previousBase: head.base, fetch });
      expect(bare.ledger.recipe?.ticks.every(t => t.pin === undefined)).toBe(true);
    });

    it("a delta that retires nothing goes straight to the stages", async () => {
      const { backend, cmds, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const { stages, onStage } = stageRecorder();
      await applyDelta(machine, deltaOf({ retired: [], retiredOnImage: [] }), { setup: "true", previousSmoke: "true", previousBase: head.base, fetch, onStage });
      expect(stages[0]).toBe("applying-setup:3 files: identity 1, shell 2");
      expect(cmds[0]).toBe(FREE_KB_CMD);
    });

    it("an update whose agents changed writes the machine context again after its stages: the added agent gets its hook, and it and the removed one leave the facts", async () => {
      // The fork carries the previous version's facts, which name both agents as not installed.
      const prior = { tools: [], agents: [{ id: "agents/codex", label: "Codex", note: "no installer" }, { id: "agents/gemini", label: "Gemini CLI", note: "no installer" }], files: [] };
      const probe = `WSP_CTX\nAGENT claude\nAGENT codex\nFACTS ${Buffer.from(JSON.stringify(prior)).toString("base64")}\nWSP_CTX_END\n`;
      const { backend, cmds, puts, fetch } = backendFor([["echo WSP_CTX", { exitCode: 0, stdout: probe, stderr: "" }]]);
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const { stages, onStage } = stageRecorder();
      const { ledger } = await applyDelta(machine, deltaOf(), { setup: "true", previousSmoke: head.smoke.cmd, previousBase: head.base, fetch, onStage });
      expect(stages.at(-1)).toMatch(/^installing-mcp:machine context: \d+(\.\d+)? KB written for Claude Code, Codex$/);
      expect(ledger.applied).toContain("installing-mcp");
      const write = cmds.findIndex(c => c.includes("tar xzf - -C '/' "));
      expect(write).toBeGreaterThan(cmds.findIndex(c => c.includes("codex-install")));
      expect(write).toBeGreaterThan(cmds.findIndex(c => c.includes("npm uninstall -g @google/gemini-cli")));
      const tgz = puts.at(-1)!;
      expect(namesIn(tgz)).toContain("etc/codex/requirements.toml");
      expect(JSON.parse(fileIn(tgz, "etc/wsp/machine-context.json"))).toEqual({ tools: [], agents: [], files: [{ path: "~/.bashrc", note: "no longer on this computer" }] });
    });

    it.each([
      ["true", [], "true", "true"],
      ["a --version && b --version", ["b --version"], "true", "a --version"],
      ["a --version", [], "a --version && c --version", "a --version && c --version"],
      ["true", [], "x --version", "x --version"],
      ["a --version", ["a --version"], "true", "true"],
    ])("nextSmoke(%j, %j, %j) is %j", (previous, removed, added, want) => {
      expect(nextSmoke(previous, removed, added)).toBe(want);
    });

    const gopls = { id: "tools/brew/gopls", name: "gopls", outcome: "skipped" as const, note: "no Linux bottle" };
    const bun = { id: "tools/npm/bun", name: "bun", outcome: "skipped" as const, note: "no Linux bottle known" };
    const jq = { id: "tools/brew/jq", name: "jq", outcome: "failed" as const, note: "exit 1: no bottle available" };
    const raycast = { id: "tools/brew-cask/raycast", name: "Raycast", outcome: "skipped" as const, note: "macOS app, no Linux build" };
    it.each([
      [[], [], []],
      [[gopls, bun, jq], [], [gopls]],
      [[gopls], [raycast], [gopls, raycast]],
      [[jq], [jq], [jq]],
    ])("nextMissing(%j, delta, %j) is %j", (previous, fresh, want) => {
      expect(nextMissing(previous, deltaOf(), fresh)).toEqual(want);
    });

    it("nextMissing drops the tool whose id the delta addressed, not every tool sharing its label", () => {
      const brewGh = { id: "tools/brew/gh", name: "gh", outcome: "skipped" as const, note: "no Linux bottle" };
      const cliGh = { id: "tools/cli/gh", name: "gh", outcome: "failed" as const, note: "exit 1: download refused" };
      const retired = deltaOf({ retired: [{ id: "tools/brew/gh", name: "gh" }], retiredOnImage: [{ id: "tools/brew/gh", name: "gh" }] });
      expect(nextMissing([brewGh, cliGh], retired, [])).toEqual([cliGh]);
      const replanned = deltaOf({ import: { ...deltaOf().import, tools: [{ id: "tools/cli/gh", label: "gh", manager: "script", cmd: "install-gh" }] } });
      expect(nextMissing([brewGh, cliGh], replanned, [])).toEqual([brewGh]);
      const setAside = deltaOf({ import: { ...deltaOf().import, tools: [], skippedTools: [{ id: "tools/cli/gh", label: "gh", note: "no Linux build" }] } });
      expect(nextMissing([brewGh, cliGh], setAside, [])).toEqual([brewGh]);
    });

    it("applyDelta keeps the previous version's missing tools the delta neither retired nor planned again, beside what this run skipped or failed", async () => {
      const { backend, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const previousMissing = [gopls, bun, jq];
      const replanned = deltaOf({ import: { ...deltaOf().import, tools: [], skippedTools: [{ id: "tools/brew/jq", label: "jq", note: "no Linux bottle known" }] } });
      const { ledger } = await applyDelta(machine, replanned, { setup: "true", previousSmoke: head.smoke.cmd, previousBase: head.base, previousMissing, fetch });
      expect(ledger.missingTools).toEqual([gopls, { id: "tools/brew/jq", name: "jq", outcome: "skipped", note: "no Linux bottle known" }]);
      const clean = await applyDelta(await backend.create({ kind: "sandbox", template: "base" }), deltaOf(), { setup: "true", previousSmoke: head.smoke.cmd, previousBase: head.base, previousMissing: [bun, jq], fetch });
      expect(clean.ledger.missingTools).toBeUndefined();
    });

    it("nextLeftBehind keeps the previous version's notes for rows the delta neither planned again nor retired, beside what this pack left behind", () => {
      const hook = { id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: ~/.claude/hooks/gone" };
      const codexNote = { id: "agents/codex", path: "~/.codex/config.toml", note: "hook left behind: ~/x" };
      // deltaOf retires agents/claude and plans agents/codex again.
      expect(nextLeftBehind([hook, codexNote], deltaOf(), [])).toEqual([]);
      const untouched = deltaOf({ retired: [], retiredOnImage: [], import: { ...deltaOf().import, agents: [] } });
      expect(nextLeftBehind([hook], untouched, [])).toEqual([hook]);
      const replanned = deltaOf({ retired: [], retiredOnImage: [], import: { ...deltaOf().import, agents: [{ id: "agents/claude", name: "Claude Code", install: "claude-install", smoke: "claude --version", road: "script" as const }] } });
      const fresh = { ...hook, note: "hook left behind: ~/.claude/hooks/new" };
      expect(nextLeftBehind([hook], replanned, [fresh])).toEqual([fresh]);
    });

    it("applyDelta and upgradeBuilder carry the head's left-behind notes through that rule, and the next seal stamps them", async () => {
      const { backend, fetch } = backendFor();
      const hook = { id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: ~/.claude/hooks/gone" };
      const untouched = deltaOf({ retired: [], retiredOnImage: [], import: { ...deltaOf().import, agents: [] } });
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const { ledger } = await applyDelta(machine, untouched, { setup: "true", previousSmoke: head.smoke.cmd, previousBase: head.base, previousLeftBehind: [hook], fetch });
      expect(ledger.leftBehind).toEqual([hook]);
      const builder = await upgradeBuilder({ backend, head: { ...head, leftBehind: [hook] }, delta: untouched, setup: "true", fetch });
      expect(builder.import?.leftBehind).toEqual([hook]);
      expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.leftBehind).toEqual([hook]);
    });

    it("upgradeBuilder hands the head's missing tools to the delta, so the next version still names them", async () => {
      const { backend, fetch } = backendFor();
      const builder = await upgradeBuilder({ backend, head: { ...head, missingTools: [gopls] }, delta: deltaOf({ retired: [], retiredOnImage: [] }), setup: "true", fetch });
      expect(builder.import?.missingTools).toEqual([gopls]);
      expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.missingTools).toEqual([gopls]);
    });

    it("the seal records the floor read on the builder, an upgrade's fork carries its head's, and a version without one is refused before any machine boots", async () => {
      const read = "VERSION curl: curl 8.5.0\nVERSION jq: jq-1.7.1\n";
      const { backend, created } = recordingBackend({}, { exec: cmd => (cmd.includes("VERSION curl:") && !cmd.includes("WSP_CTX") ? { exitCode: 0, stdout: read, stderr: "" } : cmd === FREE_KB_CMD ? { exitCode: 0, stdout: `${mb(3000)}\n`, stderr: "" } : cmd === "echo ok" ? REACH_OK : ok) });
      const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 200 });
      const floor = [{ name: "curl", version: "8.5.0" }, { name: "jq", version: "1.7.1" }];
      const builder = await prepareBuilder({ backend, setup: "true" });
      expect(builder.base).toEqual(floor);
      const v1 = await sealGolden(builder, { backend, hostId: "h1", smoke: "true" });
      expect(v1.version.base).toEqual(floor);
      const b2 = await upgradeBuilder({ backend, head: v1.version, delta: deltaOf({ retired: [], retiredOnImage: [] }), setup: "true", fetch });
      expect(b2.base).toEqual(floor);
      expect((await sealGolden(b2, { backend, hostId: "h1", smoke: "true", manifest: v1.manifest })).version.base).toEqual(floor);

      const booted = created.length;
      const { base: _floor, ...preFloor } = v1.version;
      await expect(upgradeBuilder({ backend, head: preFloor, delta: deltaOf({ retired: [], retiredOnImage: [] }), setup: "true", fetch })).rejects.toThrow("golden v1 was sealed before the base tools existed and cannot take an update; run wsp init and pick the rebuild");
      expect(created).toHaveLength(booted);
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      await expect(applyDelta(machine, deltaOf({ retired: [], retiredOnImage: [] }), { setup: "true", previousSmoke: "true", previousBase: undefined, fetch })).rejects.toThrow("this golden was sealed before the base tools existed and cannot take an update; run wsp init and pick the rebuild");
    });

    it("an update on a version with the floor reports a newly ticked covered row as the base's, by the planner's note", async () => {
      const { backend, cmds, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const results: ImportResult[] = [];
      const delta = deltaOf({ retired: [], import: importOf({ recipeHash: "h2", recipe: SNAPSHOT, tools: [], agents: [], baseTools: [{ id: "tools/brew/jq", label: "jq", note: "jq is part of the base" }], onResult: r => void results.push(r) }) });
      await applyDelta(machine, delta, { setup: "true", previousSmoke: "true", previousBase: head.base, fetch });
      expect(results.at(-1)!.tools).toEqual([{ id: "tools/brew/jq", label: "jq", outcome: "installed", note: "jq is part of the base" }]);
      expect(cmds.some(c => c.includes("apt-get install") || c.includes("brew install"))).toBe(false);
    });

    it("upgradeBuilder forks the head at its kind and size as a builder, applies only the delta, and returns a first-life builder with the new ledger", async () => {
      const { backend, created, cmds, fetch } = backendFor();
      const { stages, onStage } = stageRecorder();
      const labels = { wsp: "1", "wsp-builder": "1", "wsp-owner": "h_me", createdAt: "2026-09-04T00:00:00.000Z" };
      const builder = await upgradeBuilder({ backend, head, delta: deltaOf({ retired: [], retiredOnImage: [] }), setup: "true", fetch, onStage, labels });
      expect(created[0]).toMatchObject({ kind: "desktop", fromSnapshot: "snap_wsp-h1-default-v1", cpu: 2, memMb: 8192, onIdle: "kill", idleTimeoutMs: BUILDER_IDLE_MS, labels });
      expect(created[0]!.template).toBeUndefined();
      expect(stages[0]).toBe("creating:fork of golden v1");
      expect(stages.at(-1)).toBe("ready");
      expect(cmds.filter(c => c.includes("brew install jq"))).toHaveLength(1);
      expect(cmds.some(c => c.includes("brew-bootstrap"))).toBe(false);
      expect(builder).toMatchObject({ kind: "desktop", baseTemplate: "base", firstLife: true, size: { cpu: 2, memMb: 8192 } });
      expect(builder.import).toEqual({ recipeHash: "h2", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "claude --version && gemini --version && codex --version", recipe: SNAPSHOT });
      // The version's sha chains the previous version's with what this delta ran, so v(n+1)'s sha says both.
      expect(builder.setupSha).toBe(nextSetupSha("s1", "true", deltaOf({ retired: [], retiredOnImage: [] }).import));
      expect(builder.setupSha).toBe(createHash("sha256").update(`s1\n${createHash("sha256").update("true\ncodex-install").digest("hex")}`).digest("hex"));
    });

    it("an upgrade whose delta fails kills the fork and reports the failure", async () => {
      const { backend, killed, fetch } = backendFor([], mb(1));
      const { stages, onStage } = stageRecorder();
      await expect(upgradeBuilder({ backend, head, delta: deltaOf(), setup: "true", fetch, onStage })).rejects.toThrow(/your files need/);
      expect(killed).toEqual(["m1"]);
      expect(stages.at(-1)).toMatch(/^failed:your files need/);
    });

    const ROAD_TABLE: BrewTable = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], macosOnly: false, source: { repo: "zingzy/diskbloom", tag: "v1.2.0" } }]]);
    const entry = (rung: string, id: string, over: Partial<RecipeEntry> = {}): RecipeEntry => ({ rung, id, label: id.slice(id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", bring: true, ...over });
    const planOf = (rows: RecipeEntry[], recipeHash: string, results: ImportResult[]): GoldenImport => ({
      recipeHash,
      recipe: recipeDigest(rows, [], [], new Map()),
      tools: toolInstallsFor(rows, ROAD_TABLE).installs,
      agents: [],
      onResult: r => void results.push(r),
    });
    /** As wsp init plans an update: the rows the diff names, planned like a first build, hashed as the whole recipe. */
    const deltaBetween = (from: RecipeEntry[], to: RecipeEntry[], recipeHash: string, results: ImportResult[] = []): GoldenDelta => {
      const diff = diffRecipes(recipeDigest(from, [], [], new Map()), recipeDigest(to, [], [], new Map()));
      const rows = rowsToApply(diff);
      return { import: { ...planOf(to.filter(e => rows.has(e.id)), recipeHash, results), recipe: recipeDigest(to, [], [], new Map()) }, retired: retiredBy(diff), retiredOnImage: retiredBy(diff) };
    };

    it("a binary row toggled after the seal: ticked, the next version installs it; unticked, the version after retires it and leaves it on the image; a Homebrew formula and a road tool each way", async () => {
      const { backend, cmds, fetch } = backendFor();
      const { stages, onStage } = stageRecorder();
      const results: ImportResult[] = [];
      const base = [entry("shell", "shell/zshrc", { paths: ["~/.zshrc"], bytes: 10 })];
      const binaries = [entry("tools", "tools/brew/gh", { linux: "yes" }), entry("tools", "tools/brew/zingzy/tap/diskbloom", { linux: "unknown" })];
      // The setup line runs on every harness stage; what this counts is the rows.
      const guardedCmds = (from: number) => cmds.slice(from).filter(c => c.includes("setsid bash -c") && !c.includes("\ntrue' &"));

      const v1 = await sealGolden(await prepareBuilder({ backend, setup: "true", fetch, import: planOf(base, "h1", results) }), { backend, hostId: "h1", smoke: "true" });
      const n1 = cmds.length;
      expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);

      const up = deltaBetween(base, [...base, ...binaries], "h2", results);
      expect(up.retired).toEqual([]);
      const b2 = await upgradeBuilder({ backend, head: v1.version, delta: up, setup: "true", fetch, onStage });
      const installs = guardedCmds(n1);
      expect(installs.some(c => c.includes("brew install gh"))).toBe(true);
      expect(installs.some(c => c.includes("name='\\''diskbloom'\\''") && c.includes('install -m 0755 "$bin" "/usr/local/bin/$name"'))).toBe(true);
      expect(installs.some(c => c.includes("uninstall"))).toBe(false);
      expect(results.at(-1)!.tools.filter(t => binaries.some(b => b.id === t.id)).map(t => [t.id, t.outcome])).toEqual([["tools/brew/gh", "installed"], ["tools/brew/zingzy/tap/diskbloom", "installed"]]);
      expect(results.at(-1)!.retired).toBeUndefined();
      const v2 = await sealGolden(b2, { backend, hostId: "h1", smoke: "true", manifest: v1.manifest });
      expect(v2.version.version).toBe(2);

      const n2 = cmds.length;
      stages.length = 0;
      const down = deltaBetween([...base, ...binaries], base, "h3", results);
      expect(down.import.tools).toEqual([]);
      expect(down.import.files).toBeUndefined();
      const b3 = await upgradeBuilder({ backend, head: v2.version, delta: down, setup: "true", fetch, onStage });
      // Nothing runs on the machine for the two rows that left the recipe: they keep their bytes and the version records them.
      expect(guardedCmds(n2)).toEqual([]);
      expect(cmds.slice(n2).some(c => c.includes("brew install") || c.includes("uninstall"))).toBe(false);
      expect(stages).toContain("applying-setup:2 rows left on the image, retired: gh, diskbloom");
      expect(results.at(-1)).toEqual({
        recipeHash: "h3",
        files: { bytes: 0, skipped: [] },
        tools: [],
        agents: [],
        retired: [
          { id: "tools/brew/gh", name: "gh" },
          { id: "tools/brew/zingzy/tap/diskbloom", name: "diskbloom" },
        ],
        context: [],
      });
      const v3 = await sealGolden(b3, { backend, hostId: "h1", smoke: "true", manifest: v2.manifest });
      expect(v3.version.version).toBe(3);
      // The lineage carries what v3's image holds that its recipe does not ask for.
      expect(v3.version.retired).toEqual([{ id: "tools/brew/gh", name: "gh" }, { id: "tools/brew/zingzy/tap/diskbloom", name: "diskbloom" }]);
      expect(v2.version.retired).toBeUndefined();
      expect(b3.import).toEqual({ recipeHash: "h3", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "true", recipe: recipeDigest(base, [], [], new Map()) });
    });

    it("every retired row is in the result beside what the delta installed, so the run's list says what the image still carries", async () => {
      const { backend, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const results: ImportResult[] = [];
      const delta = deltaOf();
      delta.import.onResult = r => void results.push(r);
      await applyDelta(machine, delta, { setup: "true", previousSmoke: head.smoke.cmd, previousBase: head.base, fetch });
      expect(results).toHaveLength(1);
      expect(results[0]!.tools.map(t => [t.id, t.outcome])).toEqual([["tools/brew/jq", "installed"]]);
      expect(results[0]!.retired).toEqual(deltaOf().retired);
    });

    it("a retired tools row whose last segment is an agent's name leaves that agent's check in the smoke", async () => {
      const { backend, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const named = deltaOf({ retired: [{ id: "tools/brew/claude", name: "claude" }], retiredOnImage: [{ id: "tools/brew/claude", name: "claude" }] });
      const { ledger } = await applyDelta(machine, named, { setup: "true", previousSmoke: head.smoke.cmd, previousBase: head.base, fetch });
      expect(ledger.smoke).toBe("claude --version && gemini --version && codex --version");
    });

    it("the builder an update forks carries the rows the new recipe dropped, and the version it seals records them", async () => {
      const { backend, fetch } = backendFor();
      const builder = await upgradeBuilder({ backend, head, delta: deltaOf(), setup: "true", fetch });
      expect(builder.retired).toEqual(deltaOf().retired);
      const sealed = await sealGolden(builder, { backend, hostId: "h1", smoke: "true", manifest: { head: 1, versions: [head] } });
      expect(sealed.version).toMatchObject({ version: 2, parentSnapshotId: head.snapshotId, retired: deltaOf().retired });
    });
  });
});

describe("the tools loop on a machine that is not a fresh builder", () => {
  const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
  const FREE = "df -Pk /root | awk 'NR==2{print $4}'";

  /** A machine that answers df from plenty and everything else with exit 0, recording what it was sent. */
  function loopMachine() {
    const calls: string[] = [];
    const machine = {
      id: "spoo",
      kind: "sandbox",
      exec: async (cmd: string) => {
        calls.push(cmd);
        return cmd === FREE ? { exitCode: 0, stdout: `${9_000_000}\n`, stderr: "" } : ok;
      },
      run: async (script: string) => {
        calls.push(script);
        return ok;
      },
    } as unknown as Machine;
    return { machine, calls };
  }

  const steps: ToolInstall[] = [
    { id: "agents/node", label: "Node 22.23.2", manager: "script", cmd: "install node" },
    { id: "agents/codex", label: "Codex", manager: "npm", cmd: "install codex", after: "agents/node", bin: "codex" },
  ];

  it("reads the checks a page at a time, so a recipe with a dozen of them never asks one exec to run them all", async () => {
    // A check can be a brew list of about a second, which is why the presence read is paged: one read of twenty
    // of them reaches the inline bound, and a bound reached there used to fail every checked row on the machine.
    const many: ToolInstall[] = Array.from({ length: 20 }, (_, i) => ({ id: `tools/brew/f${i}`, label: `f${i}`, manager: "brew", cmd: `install f${i}`, check: `brew list --versions f${i}` }));
    const { machine, calls } = loopMachine();
    const { tools } = await installTools(machine, many, () => {}, "installing-tools");
    const reads = calls.filter(c => c.includes("wsp-check"));
    // Twenty checks, eight to a page: three pages, and every page opens with the tools PATH.
    expect(reads).toHaveLength(Math.ceil(many.length / READS_PER_EXEC));
    for (const read of reads) expect(read.split("\n").filter(l => l.includes("wsp-check")).length).toBeLessThanOrEqual(READS_PER_EXEC);
    // No exec carries the lot, which is what reached the bound and failed every checked row at once.
    expect(reads.some(r => r.split("\n").filter(l => l.includes("wsp-check")).length === many.length)).toBe(false);
    expect(reads.every(r => r.startsWith(`export PATH=${TOOLS_PATH}`))).toBe(true);
    expect(tools.every(t => t.outcome === "installed")).toBe(true);
  });

  it("fails only the rows of a page it could not run, not every checked row on the machine", async () => {
    const many: ToolInstall[] = Array.from({ length: 20 }, (_, i) => ({ id: `tools/brew/f${i}`, label: `f${i}`, manager: "brew", cmd: `install f${i}`, check: `brew list --versions f${i}` }));
    let read = 0;
    const calls: string[] = [];
    const machine = {
      id: "spoo",
      kind: "sandbox",
      // The second page of checks runs its deadline out, as a page of brew lists on a slow box would.
      exec: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === FREE) return { exitCode: 0, stdout: `${9_000_000}\n`, stderr: "" };
        if (!cmd.includes("wsp-check")) return ok;
        return ++read === 2 ? { exitCode: 124, stdout: "", stderr: "" } : ok;
      },
      run: async () => ok,
    } as unknown as Machine;
    const { tools } = await installTools(machine, many, () => {}, "installing-tools");
    expect(calls.filter(c => c.includes("wsp-check"))).toHaveLength(Math.ceil(many.length / READS_PER_EXEC));
    const failed = tools.filter(t => t.outcome === "failed");
    // The eight rows that page carried, and no others: the rows on either side of it kept what they landed as.
    expect(failed).toHaveLength(READS_PER_EXEC);
    expect(failed.map(t => t.label)).toEqual(many.slice(8, 16).map(t => t.label));
    for (const t of failed) expect(t.note).toContain("the check could not be run");
    expect(tools.filter(t => t.outcome === "installed")).toHaveLength(many.length - READS_PER_EXEC);
  });

  it("keeps the shared Homebrew step as it landed when a formula of its own failed, since its check reads what it installs", async () => {
    // The plan a recipe with two formulae gets: Homebrew, its toolchain, the shared step, then each formula. One
    // formula's install fails; the dependencies the shared step put on are there, and that row did its work.
    const plan = toolInstallsFor([
      { rung: "tools", id: "tools/brew/gh", label: "gh", paths: [], bytes: 0, default: "bring", bring: true },
      { rung: "tools", id: "tools/brew/yq", label: "yq", paths: [], bytes: 0, default: "bring", bring: true },
    ]).installs;
    const shared = plan.find(t => t.id === "tools/brew-shared")!;
    // The check reads the dependencies, derived the way the install derives them, not the formulae themselves.
    expect(shared.check).toContain("deps --for-each");
    expect(shared.check).toContain("list --versions $shared");
    const calls: string[] = [];
    const machine = {
      id: "spoo",
      kind: "sandbox",
      exec: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === FREE) return { exitCode: 0, stdout: `${9_000_000}\n`, stderr: "" };
        if (!cmd.includes("wsp-check")) return ok;
        // gh is not installed, so its own check fails; every other check on the page passes.
        const at = cmd.split("\n").findIndex(l => l.includes("list --versions gh"));
        return at === -1 ? ok : { exitCode: 0, stdout: `wsp-check ${at - 1} Error: No available formula gh\n`, stderr: "" };
      },
      run: async (script: string) => (script.includes("install gh") ? { exitCode: 1, stdout: "", stderr: "Error: gh did not build" } : ok),
    } as unknown as Machine;
    const { tools } = await installTools(machine, plan, () => {});
    const row = (id: string) => tools.find(t => t.id === id)!;
    expect(row("tools/brew/gh").outcome).toBe("failed");
    expect(row("tools/brew-shared").outcome).toBe("installed");
    expect(row("tools/brew/yq").outcome).toBe("installed");
  });

  it("pushes a step the caller already found on the machine as installed, runs nothing for it, and lets what waits on it run", async () => {
    const { machine, calls } = loopMachine();
    const { tools } = await installTools(machine, steps, () => {}, "installing-tools", { present: new Set(["agents/node"]) });
    expect(tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["agents/node", "installed", ALREADY_ON_MACHINE],
      ["agents/codex", "installed", undefined],
    ]);
    expect(calls.some(c => c.includes("install node"))).toBe(false);
    expect(calls.some(c => c.includes("install codex"))).toBe(true);
  });

  it("keeps the caches where the machine is somebody's own computer, and sweeps them where it becomes an image", async () => {
    const kept = loopMachine();
    await installTools(kept.machine, steps, () => {}, "installing-tools", { caches: "keep" });
    for (const needle of ["/root/.npm", "apt-get clean", "go clean -cache"]) expect(kept.calls.some(c => c.includes(needle)), needle).toBe(false);
    const swept = loopMachine();
    await installTools(swept.machine, steps, () => {}, "installing-tools");
    for (const needle of ["/root/.npm", "apt-get clean"]) expect(swept.calls.some(c => c.includes(needle)), needle).toBe(true);
  });

  it("hands each row to the caller watching the moment its outcome exists, in the order the loop reached them", async () => {
    const { machine } = loopMachine();
    const seen: string[] = [];
    const { tools } = await installTools(machine, steps, () => {}, "installing-tools", { onTool: t => void seen.push(t.id) });
    expect(seen).toEqual(["agents/node", "agents/codex"]);
    expect(tools.map(t => t.id)).toEqual(seen);
  });
});

describe("the manifest of what the recipe wrote into home", () => {
  const recipe: RecipeDigest = {
    ticks: [],
    files: [
      { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d1" },
      { id: "agents/claude", path: "~/.claude", dest: ".claude", digest: "d2" },
      { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d1" },
    ],
  };
  const ON_DISK: Record<string, string> = { ".zshrc": "a".repeat(64), ".claude/settings.json": "b".repeat(64), ".claude/CLAUDE.md": "c".repeat(64) };
  const hashing = (cmd: string): boolean => cmd.startsWith("cd '/root'") && cmd.includes("sha256sum");
  const hashed = (cmd: string): ExecResult =>
    hashing(cmd) ? { exitCode: 0, stdout: `${Object.entries(ON_DISK).map(([p, h]) => `${h}  ${p}`).join("\n")}\n`, stderr: "" } : cmd === "echo ok" ? REACH_OK : { exitCode: 0, stdout: "", stderr: "" };

  it("the seal hashes every file the recipe writes into home on the builder, each path once, and the version records them", async () => {
    const { backend, inline, timeline } = recordingBackend({}, { exec: hashed });
    const builder = await prepareBuilder({ backend, setup: "true", import: { recipeHash: "h1", recipe, tools: [], agents: [] } });
    const { version } = await sealGolden(builder, { backend, hostId: "h1", smoke: "true" });
    expect(version.owned).toEqual([
      { path: ".claude/CLAUDE.md", sha256: ON_DISK[".claude/CLAUDE.md"] },
      { path: ".claude/settings.json", sha256: ON_DISK[".claude/settings.json"] },
      { path: ".zshrc", sha256: ON_DISK[".zshrc"] },
    ]);
    // The recipe's own list of written paths, deduplicated and nothing else; a directory row travels as its files.
    const read = inline.filter(i => hashing(i.cmd));
    expect(read).toHaveLength(1);
    expect(read[0]!.cmd).toContain("find '.claude' '.zshrc' -type f -print0");
    // Read off the disk the snapshot then takes, on the builder and not on the smoke fork.
    expect(read[0]!.id).toBe("m1");
    expect(timeline.indexOf("snapshot m1")).toBeGreaterThan(-1);
  });

  it("a golden built from no recipe records no files of its own, so its forks move image the old way", async () => {
    const { backend } = recordingBackend({}, { exec: hashed });
    const builder = await prepareBuilder({ backend, setup: "true" });
    expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.owned).toBeUndefined();
  });

  it("a recipe that writes no file records an empty list, which is not the same as recording none", async () => {
    const { backend } = recordingBackend({}, { exec: hashed });
    const builder = await prepareBuilder({ backend, setup: "true", import: { recipeHash: "h1", recipe: { ticks: [], files: [] }, tools: [], agents: [] } });
    expect((await sealGolden(builder, { backend, hostId: "h1", smoke: "true" })).version.owned).toEqual([]);
  });
});

describe("snapshotUntilGone", () => {
  const QUICK = { graceMs: 30, pollMs: 1 };
  /** A provider whose DELETE answers as asked and whose listing answers each read off the queue, the last one again. */
  function provider(del: () => void, reads: (readonly string[] | Error)[], listing = true) {
    const seen = { deletes: 0, reads: 0 };
    const backend = {
      capabilities: { snapshotListing: listing },
      async deleteSnapshot() {
        seen.deletes++;
        del();
      },
      async listSnapshots() {
        const r = reads[Math.min(seen.reads++, reads.length - 1)]!;
        if (r instanceof Error) throw r;
        return r.map(id => ({ id, sizeBytes: 1 }));
      },
    } as unknown as MachineBackend;
    return { backend, seen };
  }

  it("answers deleted once the listing no longer holds the id, a failed read counting as one that still does", async () => {
    const { backend, seen } = provider(() => {}, [["snap_1", "snap_2"], new Error("GET /snapshots answered 502"), ["snap_2"]]);
    expect(await snapshotUntilGone(backend, "snap_1", QUICK)).toEqual({ verdict: "deleted" });
    expect(seen).toEqual({ deletes: 1, reads: 3 });
  });

  it("answers missing without a read when the provider had already lost the snapshot, and throws any other refusal", async () => {
    const lost = provider(() => {
      throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
    }, [["snap_1"]]);
    expect(await snapshotUntilGone(lost.backend, "snap_1", QUICK)).toEqual({ verdict: "missing" });
    expect(lost.seen.reads).toBe(0);
    const refused = provider(() => {
      throw Object.assign(new Error("SnapshotHasChildren"), { kind: "conflict", status: 409 });
    }, [["snap_1"]]);
    await expect(snapshotUntilGone(refused.backend, "snap_1", QUICK)).rejects.toMatchObject({ status: 409 });
    expect(refused.seen.reads).toBe(0);
  });

  it("answers listed with the window it read for when the id outlives it, and deleted on the DELETE alone where the provider lists nothing", async () => {
    const held = provider(() => {}, [["snap_1"]]);
    expect(await snapshotUntilGone(held.backend, "snap_1", QUICK)).toEqual({ verdict: "listed", graceMs: QUICK.graceMs });
    expect(held.seen.reads).toBeGreaterThan(1);
    const unlisted = provider(() => {}, [["snap_1"]], false);
    expect(await snapshotUntilGone(unlisted.backend, "snap_1", QUICK)).toEqual({ verdict: "deleted" });
    expect(unlisted.seen.reads).toBe(0);
  });
});
