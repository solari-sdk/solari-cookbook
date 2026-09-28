// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { GUEST_USER_ENV, TOOLS_PATH, DAEMON_ENV_FILE, type ProvisionPlan, type ToolInstall } from "@wsp/engine";
import { PLACE_WORKSPACE_PATH } from "@wsp/protocol";
import { daemonUnderTest, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { assetDir, assetProof, daemonBinaryHere } from "../src/assets.js";
import { hostPlatform } from "../src/verbs.js";
import { DAEMON_TARGETS, daemonBinaryIn, daemonTargetHere, GUEST_DAEMON_TARGETS } from "../src/daemon-binary.js";
import { agentSignInWord, agentVersionWord, probePath, doctorRowRefusal, EXIT_CODES, noSuchPlaceRefusal, noSuchProjectLine, plural, projectNeedsReaddLine, THIS_COMPUTER, type PlaceProvision, type ProjectView, HERE_PLACE_ID, HOMEBREW_PREFIX, DAEMON_MEMORY_MAX_PERCENT, DAEMON_VERSION, GUEST_DAEMON_DIR, GUEST_WSP_BIN, GUEST_WSP_PATH, guestWspShim, machineLacksShort, NO_SYSTEMD_LINE, placeUpdateLine, signInRefusalLine, wspBinIn, type HarnessCatalogAnswer, type PlaceCapacity, type PlaceView } from "@wsp/protocol";
import { copyKey, createRuntime, localExecStream, memoryStore, rotateDaemonTokenScript, writeDaemonTokenScript, type HarnessAdapterFactory, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isReserved, LocalBackend, NoProviderBackend } from "@wsp/engine";
import {
  connectDaemonSocket,
  DAEMON_UNIT,
  DAEMON_UNIT_PATH,
  daemonLogCommand,
  daemonBinaryOn,
  daemonExecLine,
  daemonFlags,
  daemonUnit,
  daemonSupervisorScript,
  DAEMON_LOG_PATH,
  GUEST_SUPERVISOR_PATH,
  daemonPidPath,
  supervisorPidPath,
  deployDaemon,
  deployScript,
  stopDaemonScript,
  previewHostSuffix,
  VITE_ALLOWED_HOSTS_ENV,
  deployFailureLine,
  joinedPlace,
  removeDaemonScript,
  GUEST_ENVS,
  claudeEnvs,
  CLOUD_PLACE,
  CONTAINER_PLACE,
  openShimScript,
  packBundle,
  preflightScript,
  cleanOrphans,
  doctor,
  doctorOverHost,
  hostDoctor,
  localDoctor,
  localPrompt,
  promoteGoldens,
  placesBehindLines,
  forkDoctor,
  hereDaemonLines,
  toolsInside,
  vaultKeysLines,
  computerDoctor,
  doctorProject,
  roomLeft,
  sshDaemonPlace,
  stageDaemonBundle,
  tarPackCommand,
  verifyNoneLeft,
  type DaemonSocket,
} from "../src/doctor.js";
import { agentName, catalogEntry, GUEST_HOME, VAULT_VARIABLES } from "@wsp/catalog";
import { daemonFixLine, releaseUpdateLine } from "../src/daemon-fix.js";
import { redact } from "../src/init-log.js";
import { captured, copyingFake, createOn, projectOn } from "./verbs-fixture.js";
import { commandPage, COMMANDS_FOR_HELP, doctorRow, localWiring, SHARED_FLAGS, type CliIO } from "../src/cli.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("isReserved", () => {
  it("treats any poc-labelled machine as untouchable, not only poc=ttl-test", () => {
    expect(isReserved({ poc: "ttl-test" })).toBe(true);
    expect(isReserved({ poc: "p1", wsp: "1" })).toBe(true);
    expect(isReserved({ wsp: "1", "wsp-doctor": "1" })).toBe(false);
    expect(isReserved({})).toBe(false);
  });
});

describe("promoteGoldens", () => {
  const version = (n: number, templateId?: string) => ({ version: n, snapshotId: `snap_golden-v${n}`, ...(templateId !== undefined ? { templateId } : {}), baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } });
  const io = () => {
    const lines: string[] = [];
    return { lines, io: { log: (l: string) => void lines.push(l) } };
  };

  it("promotes a fresh template for every version without one, says each one with how many templates already carry its name, and notes the count", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 3, versions: [version(1), version(2), version(3, "tpl_three")] });
    for (const n of [1, 2, 3]) backend.snapshots.push({ id: `snap_golden-v${n}`, sizeBytes: 8e9 });
    // A template already under this version's own name, from a run that recorded nothing: counted, never adopted.
    backend.templates.set("tpl_stale", { id: "tpl_stale", name: "wsp-h1-default-v1", status: "ready", snapshotId: "snap_golden-v1" });
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "h1" });
    const { lines, io: cli } = io();
    expect(await promoteGoldens(rt, cli)).toBe("2 promoted");
    expect(lines).toEqual([
      "image default v1: template tpl_wsp-h1-default-v1 promoted and recorded; 1 other template carries its name",
      "image default v2: template tpl_wsp-h1-default-v2 promoted and recorded",
    ]);
    expect(backend.promoted).toEqual([{ snapshotId: "snap_golden-v1", name: "wsp-h1-default-v1" }, { snapshotId: "snap_golden-v2", name: "wsp-h1-default-v2" }]);
    expect(((await store.get("goldens", copyKey("default", "default"))) as { versions: { templateId?: string }[] }).versions.map(v => v.templateId)).toEqual(["tpl_wsp-h1-default-v1", "tpl_wsp-h1-default-v2", "tpl_three"]);
    expect(await promoteGoldens(rt, cli)).toBe("every version already has a template");
  });

  it("never fails the doctor: a version whose snapshot the provider lost is one line and the rest are still recorded, a provider error on the template road is one line, and the reach loop below gets its turn", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 2, versions: [version(1), version(2)] });
    // v1's snapshot is not in the provider's listing: the vanish the ticket is about.
    backend.snapshots.push({ id: "snap_golden-v2", sizeBytes: 8e9 });
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "h1" });
    const { lines, io: cli } = io();
    await expect(promoteGoldens(rt, cli)).resolves.toBe("1 promoted, 1 not made durable");
    expect(lines).toEqual([
      "image default v1: no template recorded, its snapshot is gone at the provider",
      "image default v2: template tpl_wsp-h1-default-v2 promoted and recorded",
    ]);
    expect(((await store.get("goldens", copyKey("default", "default"))) as { versions: { templateId?: string }[] }).versions.map(v => v.templateId)).toEqual([undefined, "tpl_wsp-h1-default-v2"]);

    backend.promoteSnapshot = async () => {
      throw Object.assign(new Error("upstream unavailable"), { kind: "unavailable", status: 502 });
    };
    backend.snapshots.push({ id: "snap_golden-v1", sizeBytes: 8e9 });
    const again = io();
    await expect(promoteGoldens(rt, again.io)).resolves.toBe("1 not made durable");
    expect(again.lines).toEqual(["image default v1: no template recorded, upstream unavailable"]);

    const broken = { golden: { promote: async () => Promise.reject(new Error("state file unreadable")) } } as unknown as Runtime;
    await expect(promoteGoldens(broken, again.io)).resolves.toBe("not made durable: state file unreadable");
  });

  it("on a store with no golden yet the note says there is none", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "h1" });
    const { lines, io: cli } = io();
    expect(await promoteGoldens(rt, cli)).toBe("no image to make durable");
    expect(lines).toEqual([]);
  });

  it("says so on a backend without templates and touches nothing", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const { lines, io: cli } = io();
    expect(await promoteGoldens(rt, cli)).toBe("this backend has no templates; image versions stay as snapshots");
    expect(lines).toEqual([]);
    expect(backend.promoted).toEqual([]);
  });
});

describe("cleanOrphans", () => {
  const GB = 1e9;
  /** Long past OWN_GRACE_MS whenever the suite runs, so only the mark and the record decide these rows. */
  const OLD = "2026-09-01T00:00:00.000Z";
  const version = (n: number, templateId?: string) => ({ version: n, snapshotId: `snap_wsp-h1-default-v${n}`, ...(templateId !== undefined ? { templateId } : {}), baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } });
  const io = () => {
    const lines: string[] = [];
    return { lines, io: { log: (l: string) => void lines.push(l) } };
  };

  /** One version this host records, one snapshot and one template it left behind, one snapshot named before the
   * mark existed and one another host sealed. */
  async function account() {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version(1, "tpl_wsp-h1-default-v1")] });
    backend.snapshots.push(
      { id: "snap_wsp-h1-default-v1", name: "wsp-h1-default-v1", sizeBytes: 12 * GB, createdAt: OLD },
      { id: "snap_orphan", name: "wsp-h1-default-v9", sizeBytes: 20 * GB, createdAt: OLD },
      { id: "snap_before", name: "golden-v1", sizeBytes: 21 * GB, createdAt: OLD },
      { id: "snap_other", name: "wsp-zz9-default-v1", sizeBytes: 7 * GB, createdAt: OLD },
    );
    for (const t of [
      { id: "tpl_wsp-h1-default-v1", name: "wsp-h1-default-v1", snapshotId: "snap_wsp-h1-default-v1" },
      // Standing on the orphan snapshot, so the provider refuses that snapshot until this template goes first.
      { id: "tpl_wsp-h1-old-v1", name: "wsp-h1-old-v1", snapshotId: "snap_orphan" },
      // The provider's own image: no mark of this host, so it is named and left, and the line for it is printed.
      { id: "base", name: "base", snapshotId: "" },
    ]) backend.templates.set(t.id, { ...t, status: "ready", createdAt: OLD });
    return { backend, rt: createRuntime({ backend, store, adapters: {}, hostId: "box:h1" }) };
  }

  it("without --yes it splits the listing, names every orphan and every row left alone, and deletes nothing", async () => {
    const { backend, rt } = await account();
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, false)).toBe("1 orphan snapshot and 1 orphan template, 20.0 GB, saving about $1.00/month; wsp doctor --yes deletes them");
    expect(lines).toEqual([
      "storage: 4 snapshots, 60.0 GB; about $2.50/month above the free 10 GB from 2026-10-01. 1 kept here, 12.0 GB; 1 this host's with nothing recording them, 20.0 GB; 2 not this host's, 28.0 GB",
      "  orphan template wsp-h1-old-v1 (tpl_wsp-h1-old-v1)",
      "  orphan snapshot wsp-h1-default-v9 (snap_orphan), 20.0 GB",
      "  left alone, no mark of this host: template base (base)",
      "  left alone, no mark of this host: snapshot golden-v1 (snap_before), 21.0 GB",
      "  left alone, no mark of this host: snapshot wsp-zz9-default-v1 (snap_other), 7.0 GB",
    ]);
    expect(backend.snapshots).toHaveLength(4);
    expect([...backend.templates.keys()]).toHaveLength(3);
  });

  it("on --yes it deletes this host's orphans and nothing else: the row from before the mark and another host's both stay", async () => {
    const { backend, rt } = await account();
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("deleted 1 snapshot and 1 template");
    expect(lines).toContain("deleting 1 orphan snapshot and 1 orphan template, 20.0 GB, saving about $1.00/month");
    // No state path given, so the offer names none rather than inventing one.
    expect(lines.some(l => l.includes("records them"))).toBe(false);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_before", "snap_other"]);
    expect([...backend.templates.keys()]).toEqual(["tpl_wsp-h1-default-v1", "base"]);
  });

  it("the offer names the state file that decided, since a run under another --state reads the usual file's goldens as recorded by nothing", async () => {
    const { backend, rt } = await account();
    const { io: cli } = io();
    expect(await cleanOrphans(rt, cli, false, "/tmp/scratch.json")).toBe("1 orphan snapshot and 1 orphan template, 20.0 GB, saving about $1.00/month; nothing in /tmp/scratch.json records them; wsp doctor --yes deletes them");
    expect(await cleanOrphans(rt, cli, true, "/tmp/scratch.json")).toBe("deleted 1 snapshot and 1 template");
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_before", "snap_other"]);
  });

  it("a delete the provider refuses names the row that stayed and never fails the step", async () => {
    const { backend, rt } = await account();
    await backend.create({ kind: "sandbox", fromSnapshot: "snap_orphan" });
    const { io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("deleted 1 template; wsp-h1-default-v9 (snap_orphan) stayed (SnapshotHasChildren)");
    expect(backend.snapshots.map(r => r.id)).toContain("snap_orphan");
  });

  it("with nothing of this host's left behind the step says so and still prints the line", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version(1)] });
    backend.snapshots.push({ id: "snap_wsp-h1-default-v1", name: "wsp-h1-default-v1", sizeBytes: 8 * GB });
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "box:h1" });
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("no orphan of this host");
    expect(lines).toEqual(["storage: 1 snapshot, 8.0 GB; inside the free 10 GB, nothing to pay from 2026-10-01"]);
  });

  it("the doctor runs the step before it forks anything, so --yes clears this host's orphans even on a run that cannot build a golden", async () => {
    const { backend, rt } = await account();
    const lines: string[] = [];
    const cli = { log: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), ask: noPrompt, askSecret: noPrompt };
    // No golden and no key, so the run fails at the golden step; the storage step ran first either way. The fork
    // road is the one a named cloud row takes, and the only one that reads a provider's storage at all.
    expect(await forkDoctor(rt, cli, { yes: true, statePath: "/tmp/state.json" })).toBe(1);
    expect(lines.some(l => l.includes("nothing in /tmp/state.json records them"))).toBe(true);
    expect(lines).toContain("  orphan snapshot wsp-h1-default-v9 (snap_orphan), 20.0 GB");
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_before", "snap_other"]);
    expect(lines.some(l => l.includes("snapshot storage") && l.includes("deleted 1 snapshot and 1 template"))).toBe(true);
  });

  it("without --yes the same run names them and deletes nothing", async () => {
    const { backend, rt } = await account();
    const lines: string[] = [];
    const cli = { log: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), ask: noPrompt, askSecret: noPrompt };
    expect(await forkDoctor(rt, cli, {})).toBe(1);
    expect(backend.snapshots).toHaveLength(4);
    expect(lines.some(l => l.includes("wsp doctor --yes deletes them"))).toBe(true);
  });

  it("says so on a backend that lists no snapshots, and a listing the provider refuses is one line, never a failure", async () => {
    const bare = stubBackend();
    const { listSnapshots: _l, ...rest } = bare;
    const rt = createRuntime({ backend: { ...rest, capabilities: { ...bare.capabilities, snapshotListing: false } }, store: memoryStore(), adapters: {}, hostId: "box:h1" });
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("this backend lists no snapshots; nothing to split by owner");
    expect(lines).toEqual([]);

    const { backend, rt: live } = await account();
    backend.listSnapshots = async () => {
      throw new Error("502 Bad Gateway");
    };
    expect(await cleanOrphans(live, cli, true)).toBe("listing not read: 502 Bad Gateway");
  });
});

describe("roomLeft", () => {
  const counting = (capacity: Partial<PlaceCapacity>) => ({ capacity: () => Promise.resolve({ cores: 2, memMb: 4096, memRoomMb: 1024, machineMemMb: 2048, diskFreeBytes: 0, images: [], machines: { running: 1, paused: 0 }, ...capacity }) });

  it("reads the cores and the memory the forks there hold, in one note", async () => {
    expect(await roomLeft(counting({ cpuTaken: 1, memTakenMb: 1024 }))).toBe("2 cores, 1 in use by forks, 1 free; 4 GB, 1 GB in use by forks, 3 GB free");
  });

  it("says nothing where the computer counts no room, answers none, or is not a computer that forks", async () => {
    expect(await roomLeft(counting({}))).toBe("");
    expect(await roomLeft({ capacity: () => Promise.reject(new Error("link gone")) })).toBe("");
    expect(await roomLeft({})).toBe("");
  });
});

describe("the doctor's line for a place behind this wsp", () => {
  const listing = (places: Partial<PlaceView>[]) => ({ places: { list: async () => places as PlaceView[] } }) as never;

  it("names each computer running an older daemon than this wsp deploys, with the flag that moves it", async () => {
    const lines = await placesBehindLines(listing([
      { id: "p_1", kind: "computer", name: "spoo", default: true, daemonVersion: DAEMON_VERSION - 5 },
      { id: "p_2", kind: "computer", name: "laptop", default: false, daemonVersion: DAEMON_VERSION },
    ]));
    expect(lines).toEqual([`spoo is behind: daemon ${DAEMON_VERSION - 5}, host ${DAEMON_VERSION}; wsp add spoo --update puts this wsp's daemon on it`]);
    // One line per computer, and the fix half is a command a person can type.
    expect(lines[0]).toContain(placeUpdateLine("spoo"));
  });

  it("puts this computer first where the binary staged beside this wsp is behind, with the line that stages the right one", async () => {
    // A host rebuilt without its daemon binary runs beside the one that was there before, which knows none of this
    // wsp's verbs; the reading is this computer's own and is said before anything else the run says.
    const here = { version: async () => DAEMON_VERSION - 1, fix: "npm i -g @zingzy/wsp" };
    const lines = await placesBehindLines(listing([{ id: "p_1", kind: "computer", name: "spoo", default: true, daemonVersion: DAEMON_VERSION - 5 }]), Date.now(), here);
    expect(lines[0]).toBe(`this computer's wsp daemon is version ${DAEMON_VERSION - 1} and this wsp needs ${DAEMON_VERSION}; npm i -g @zingzy/wsp stages the right one`);
    expect(lines).toHaveLength(2);
    // Level with this wsp, and a daemon that will not start at all, both say nothing: the roads that need it say so
    // themselves, and the reading a run opens with must not fail on the daemon it is reading.
    expect(await hereDaemonLines({ version: async () => DAEMON_VERSION, fix: "x" })).toEqual([]);
    expect(await hereDaemonLines({ version: async () => Promise.reject(new Error("the daemon did not start")), fix: "x" })).toEqual([]);
    expect(await hereDaemonLines()).toEqual([]);
  });

  it("reads the line that stages the binary off the road this wsp was installed by", async () => {
    expect(daemonFixLine({ argv: ["/usr/local/bin/node", "/usr/local/lib/node_modules/@zingzy/wsp/dist/bin.js"] })).toBe("npm i -g @zingzy/wsp");
    expect(daemonFixLine({ argv: ["/n", "/x"], shim: "/Applications/wsp.app/Contents/Resources/bin/wsp" })).toBe("updating the wsp app");
    expect(daemonFixLine({ argv: ["/n", "/Users/dev/wsp/packages/wspx/dist/bin.js"] })).toBe("a cargo build of the daemon and node packages/wspx/scripts/daemon-binary.mjs --from its binary");
  });

  it("reads the line that gets a newer release off the same road, pinned to that release where the road takes a version", () => {
    expect(releaseUpdateLine({ argv: ["/usr/local/bin/node", "/usr/local/lib/node_modules/@zingzy/wsp/dist/bin.js"] }, "0.3.0")).toBe("npm i -g @zingzy/wsp@0.3.0");
    expect(releaseUpdateLine({ argv: ["/n", "/x"], shim: "/Applications/wsp.app/Contents/Resources/bin/wsp" }, "0.3.0")).toBe("updating the wsp app");
    expect(releaseUpdateLine({ argv: ["/n", "/Users/dev/wsp/packages/wspx/dist/bin.js"] }, "0.3.0")).toBe("a pull of the checkout and a build");
  });

  it("says nothing where every place is level, where none has reported, and on a host holding no places at all", async () => {
    expect(await placesBehindLines(listing([{ id: "p_1", kind: "computer", name: "spoo", default: true, daemonVersion: DAEMON_VERSION }]))).toEqual([]);
    expect(await placesBehindLines(listing([{ id: "solari", kind: "provider", name: "solari", default: false }]))).toEqual([]);
    expect(await placesBehindLines(listing([]))).toEqual([]);
    expect(await placesBehindLines({} as never)).toEqual([]);
  });
});

describe("verifyNoneLeft", () => {
  const at = (ms: number): string => new Date(Date.now() - ms).toISOString();

  it("counts only machines wearing this host's owner stamp, names another host's in one line, and fails on its own", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "h1" });
    const owner = await rt.owner();
    const lines: string[] = [];
    // A second host's builders standing on the same account while this host runs the doctor.
    const b1 = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": "h_other", createdAt: at(60_000) } });
    const b2 = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": "h_other", createdAt: at(60_000) } });
    const unowned = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: at(60_000) } });
    await backend.create({ kind: "sandbox", labels: { poc: "ttl-test", wsp: "1" } });

    await expect(verifyNoneLeft(backend, owner, l => lines.push(l))).resolves.toBe("workspace deleted, no machines of this host left");
    expect(lines).toEqual([`left alone 3 machines this host did not make: ${b1.id} (owner h_other), ${b2.id} (owner h_other), ${unowned.id} (no owner)`]);

    // One of this host's own is the failure the check exists for, and the line still names the others.
    const mine = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": owner, createdAt: at(60_000) } });
    lines.length = 0;
    await expect(verifyNoneLeft(backend, owner, l => lines.push(l))).rejects.toThrow(`machines still up: ${mine.id}`);
    expect(lines).toHaveLength(1);
  });

  it("on an account with nothing standing the note is the one the release table quotes, and no line is logged", async () => {
    const backend = stubBackend();
    const lines: string[] = [];
    await expect(verifyNoneLeft(backend, "h_me", l => lines.push(l))).resolves.toBe("workspace deleted, no machines left on the account");
    expect(lines).toEqual([]);
  });

  it("the fork this host makes wears the stamp the check counts by, so a workspace left behind still fails it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    const rt = createRuntime({ backend, store, adapters: {} });
    const view = await createOn(rt, { golden: SEALED_GOLDEN.versions[0]!.snapshotId, name: "doctor-fork" });
    expect(backend.machines[0]?.spec.labels?.["wsp-owner"]).toBe(await rt.owner());
    await expect(verifyNoneLeft(backend, await rt.owner(), () => {})).rejects.toThrow(`machines still up: ${view.machineId}`);
    await rt.workspaces.delete(view.id);
    await expect(verifyNoneLeft(backend, await rt.owner(), () => {})).resolves.toBe("workspace deleted, no machines left on the account");
    await rt.close();
  });
});

/** A wsp command folder for a test to stage, shaped as npm lays the published command out: its package.json beside
 * a dist folder the bin reads its version through. The layout tests use this stand-in; the handshake test below is
 * the one that reads the real bundle. */
function fakeCliDir(root: string): string {
  const cli = join(root, "cli");
  mkdirSync(join(cli, "dist"), { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@zingzy/wsp", version: "9.9.9" }));
  writeFileSync(join(cli, "dist", "bin.js"), 'import "./chunk-1.js";\n');
  writeFileSync(join(cli, "dist", "chunk-1.js"), "export const y = 2;\n");
  writeFileSync(join(cli, "tsup.config.ts"), "// never travels\n");
  return cli;
}

/** A daemon asset folder holding a stand-in binary per target, each saying which one it is. */
function fakeDaemonDir(root: string, triples: readonly string[] = DAEMON_TARGETS.map(t => t.triple)): string {
  const daemon = join(root, "daemon");
  for (const triple of triples) {
    mkdirSync(join(daemon, triple), { recursive: true });
    writeFileSync(daemonBinaryIn(daemon, triple), `#!/bin/sh\necho ${triple}\n`, { mode: 0o755 });
  }
  return daemon;
}

/** One chip a guest can be, for every line that names the binary by its own path. */
const GUEST_TARGET = GUEST_DAEMON_TARGETS[0]!;

describe("stageDaemonBundle", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stages one static binary per chip a guest can be, the wsp command and the browser shim, and nothing built on the machine", async () => {
    dir = tmp("wsp-doctor-");
    const stage = join(dir, "stage");
    await stageDaemonBundle(stage, CLOUD_PLACE, fakeDaemonDir(dir), fakeCliDir(dir));
    // Exactly these: no dist, no start script, no package.json, nothing for an npm install to read.
    expect(readdirSync(stage).sort()).toEqual(["wsp", "wsp-open"]);
    for (const target of GUEST_DAEMON_TARGETS) {
      const bin = daemonBinaryOn(stage, target);
      expect(statSync(bin).mode & 0o111).toBe(0o111);
      // The right binary under each chip's triple: the deploy's case reads the chip off uname and keeps that folder.
      expect(execFileSync(bin, { encoding: "utf8" }).trim()).toBe(target.triple);
    }
    // The darwin binaries stay behind: a guest is Linux, and a bundle carries what a guest can be.
    expect(readdirSync(dirname(daemonBinaryOn(stage, GUEST_TARGET))).length).toBe(1);
    expect(readdirSync(join(stage, "wsp", "assets", "daemon")).sort()).toEqual(GUEST_DAEMON_TARGETS.map(t => t.triple).sort());
    // The browser shim rides along and posts to the socket the daemon's flags name.
    expect(readFileSync(join(stage, "wsp-open"), "utf8")).toBe(openShimScript(CLOUD_PLACE));
    expect(statSync(join(stage, "wsp-open")).mode & 0o111).toBe(0o111);
    expect(daemonFlags(CLOUD_PLACE)).toContain(CLOUD_PLACE.openSocket);
  });

  it("lays the daemon where the wsp command in the bundle reads one, so the box's own join finds it", async () => {
    dir = tmp("wsp-bundle-lookup-");
    const stage = join(dir, "stage");
    // This computer's own chip, since the lookup under test is the one a box does for itself off its own row.
    const here = daemonTargetHere()!;
    await stageDaemonBundle(stage, sshDaemonPlace({ home: "/home/maya", path: "/usr/bin" }), fakeDaemonDir(dir), fakeCliDir(dir), [here]);
    // The box runs the command out of the bundle's own dist folder and asks the asset table for the daemon beside
    // it; the bundle is that command as npm lays it out, so there is one path and not a second spelling of it.
    expect(daemonBinaryHere(join(stage, "wsp", "dist"))).toBe(daemonBinaryOn(stage, here));
    expect(existsSync(daemonBinaryOn(stage, here))).toBe(true);
  });

  it("gives a fork two lines onto the binary the bundle carries, written on the machine where the chip is known", async () => {
    dir = tmp("wsp-bundle-cli-");
    const daemonDir = fakeDaemonDir(dir);
    const stage = join(dir, "stage");
    await stageDaemonBundle(stage, CLOUD_PLACE, daemonDir, fakeCliDir(dir));

    // A fork carries no node and no packed command; the binaries ride under that command's own assets all the same,
    // one folder per chip, and the deploy drops the ones the machine is not.
    expect(existsSync(join(stage, "wsp", "dist", "bin.js"))).toBe(false);
    for (const target of GUEST_DAEMON_TARGETS) expect(existsSync(daemonBinaryOn(stage, target))).toBe(true);

    // The shim is written in the arm for the chip, since the path it names carries that chip's target triple.
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    for (const target of GUEST_DAEMON_TARGETS) {
      expect(script).toContain(guestWspShim(daemonBinaryOn(CLOUD_PLACE.dir, target)));
    }
    expect(script).toContain(`chmod 0755 ${GUEST_WSP_PATH}`);
    expect(GUEST_WSP_PATH).toBe("/usr/local/bin/wsp");
    expect(script.split("\n")).toContain(`tar --no-same-owner -xzf ${GUEST_DAEMON_DIR}.tgz -C ${GUEST_DAEMON_DIR}`);
    // And it goes when the rest of wsp does.
    expect(removeDaemonScript(CLOUD_PLACE)).toContain(GUEST_WSP_PATH);
  });

  it("carries the wsp command whole where the place says a machine somebody owns still runs it on node", async () => {
    dir = tmp("wsp-bundle-node-cli-");
    const daemonDir = fakeDaemonDir(dir);
    // The published build is split across chunk files bin.js imports by name, so the folder travels whole.
    const cliDir = fakeCliDir(dir);
    const place = sshDaemonPlace({ home: "/home/maya", path: "/usr/bin" });

    const stage = join(dir, "stage");
    await stageDaemonBundle(stage, place, daemonDir, cliDir);

    expect(readFileSync(join(stage, "wsp", "dist", "bin.js"), "utf8")).toContain("./chunk-1.js");
    expect(existsSync(join(stage, "wsp", "dist", "chunk-1.js"))).toBe(true);
    // The command travels as the package npm installs it, package.json beside dist, since the bin reads its own
    // version through that file: a bundle that carried dist alone had it read the daemon bundle's manifest, which
    // names no version, and an MCP server announcing none is refused its handshake.
    expect(JSON.parse(readFileSync(join(stage, "wsp", "package.json"), "utf8"))).toMatchObject({ version: "9.9.9" });
    expect(existsSync(join(stage, "wsp", "tsup.config.ts"))).toBe(false);
    expect(existsSync(join(stage, relative(place.dir, wspBinIn(place.dir))))).toBe(true);
    // Nothing installs a shim there: the word wsp on that computer is the person's own to spell.
    expect(deployScript(place, "aabbcc")).not.toContain(GUEST_WSP_PATH);
  });

  it("the wsp command in the bundle answers an MCP handshake with its version, run from where the bundle puts it", async () => {
    dir = tmp("wsp-bundle-mcp-");
    const daemonDir = fakeDaemonDir(dir);
    const stage = join(dir, "stage");
    // The real command bundle on purpose, since the bug was in the built bin's own reading of its version: it needs
    // packages/wspx built, which the gate does before any test runs; the fork's path is the protocol's, under the stage.
    const place = sshDaemonPlace({ home: "/home/maya", path: "/usr/bin" });
    await stageDaemonBundle(stage, place, daemonDir);
    const bin = join(stage, relative(place.dir, wspBinIn(place.dir)));
    const { version } = JSON.parse(readFileSync(join(assetDir("cli"), "package.json"), "utf8")) as { version: string };
    const home = join(dir, "guest-home");
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, [bin, "mcp", "--host", "http://127.0.0.1:1"], { env: { PATH: process.env["PATH"] ?? "", HOME: home, WSP_HOME: join(home, ".wsp") }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } })}\n`);
    const code = await new Promise<number | null>(done => child.once("close", done));
    expect(err).toBe("");
    expect(code).toBe(0);
    const reply = JSON.parse(out.split("\n")[0]!) as { result: { serverInfo: unknown } };
    // The client checks serverInfo against the protocol's schema, which wants a version string; a missing one is a
    // server that never connects, which is what a thread on a fork read as the wsp tools not being there.
    expect(reply.result.serverInfo).toEqual({ name: "wsp", version });
  });

  it("names an asset folder that was never built rather than failing halfway through a copy", async () => {
    dir = tmp("wsp-bundle-unbuilt-");
    const empty = join(dir, "never-built");
    mkdirSync(empty, { recursive: true });
    await expect(stageDaemonBundle(join(dir, "stage"), CLOUD_PLACE, fakeDaemonDir(dir), empty)).rejects.toThrow(`wsp command bundle missing: ${join(empty, assetProof("cli"))}`);
    expect(existsSync(join(dir, "stage"))).toBe(false);
    // A daemon folder with one chip's binary and not the other is refused by the missing file's own path, before
    // a byte is staged: a bundle short of one chip would deploy to half the guests.
    const half = fakeDaemonDir(join(dir, "half"), [GUEST_DAEMON_TARGETS[0]!.triple]);
    await expect(stageDaemonBundle(join(dir, "stage"), CLOUD_PLACE, half, fakeCliDir(dir))).rejects.toThrow(`wsp-daemon binary missing: ${daemonBinaryIn(half, GUEST_DAEMON_TARGETS[1]!.triple)}`);
    expect(existsSync(join(dir, "stage"))).toBe(false);
  });
});

describe("the recipe's tools read from inside the workspace", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A folder with one script per command a case wants a workspace to answer, so the read runs under a real shell
   * and decides what a shell decides. */
  function scratch(commands: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "wsp-inside-"));
    dirs.push(dir);
    for (const name of commands) {
      writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, name), 0o755);
    }
    return dir;
  }

  /** A workspace whose execs a real bash answers, with that folder ahead of the tools PATH the read exports. */
  const workspaceWith = (dir: string): { exec: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      exec: async cmd => {
        asked.push(cmd);
        const res = spawnSync("bash", ["-c", cmd.replaceAll(PLACE_WORKSPACE_PATH, `${dir}:${PLACE_WORKSPACE_PATH}`)], { encoding: "utf8" });
        return { exitCode: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
      },
    };
  };

  const step = (over: Partial<ToolInstall> & Pick<ToolInstall, "id" | "label">): ToolInstall => ({ manager: "script", cmd: `install ${over.id}`, ...over });
  /** The three shapes the step reads, and one nothing can be asked about: a formula by its road's own test, a
   * command by the command, and an index refresh that answers no read of its own. */
  const plan = {
    steps: [
      step({ id: "tools/brew/gh", label: "gh", manager: "brew", present: "true", bins: [`${HOMEBREW_PREFIX}/bin`] }),
      step({ id: "tools/brew/node", label: "node", bin: "node", bins: ["/usr/local/bin"] }),
      step({ id: "tools/npm/agent-browser", label: "agent-browser", manager: "npm", bin: "agent-browser" }),
      step({ id: "tools/apt-index", label: "apt index", manager: "apt" }),
    ],
  };

  it("reads the plan's steps by the presence rule the recipe job runs, and says the path a command answered from outside its own road's directories", async () => {
    const dir = scratch(["node", "agent-browser"]);
    const machine = workspaceWith(dir);
    const said = await toolsInside(machine, plan);
    // Three steps were askable and all three answered; the fourth says nothing that can be read.
    expect(said).toBe(`3 answered inside; node answers from ${join(dir, "node")}, outside where its own installer puts it (/usr/local/bin)`);
    // On the order a workspace on a computer somebody owns boots with, which is what a thread there reads too:
    // a copy of one of these tools under the shared home does not answer ahead of the recipe's own.
    expect(machine.asked[0]).toContain(`export PATH=${PLACE_WORKSPACE_PATH}`);
    expect(machine.asked[0]).not.toContain(`export PATH=${TOOLS_PATH}`);
    // The formula row is read by its road's own test and never by a command of its name, which is another road's work.
    expect(machine.asked[0]).not.toContain("command -v 'gh'");
  });

  it("fails naming the rows that did not answer, which is a tool the recipe installed and no workspace can run", async () => {
    const machine = workspaceWith(scratch(["node"]));
    await expect(toolsInside(machine, plan)).rejects.toThrow("agent-browser did not answer inside the workspace, though the recipe installed it on the machine");
  });

  it("adds the computers row's own reading to a row it found missing that the row read present, and the line that reads the computer again", async () => {
    const machine = workspaceWith(scratch(["node"]));
    const provision: PlaceProvision = {
      state: "done",
      addId: "a_1",
      recipeAt: "2026-09-18T10:00:00.000Z",
      startedAt: "2026-09-18T10:00:00.000Z",
      finishedAt: "2026-09-18T10:04:00.000Z",
      rows: [{ id: "tools/npm/agent-browser", label: "agent-browser", outcome: "present" }],
    };
    await expect(toolsInside(machine, plan, { name: "spoo", provision })).rejects.toThrow(
      "agent-browser (the computers row read it present at 2026-09-18T10:04:00.000Z; wsp add spoo --update reads it again) did not answer inside the workspace",
    );
  });

  it("says there is nothing to read where the plan holds no step anything can be asked about, and asks the workspace nothing", async () => {
    const machine = workspaceWith(scratch([]));
    expect(await toolsInside(machine, { steps: [step({ id: "tools/apt-index", label: "apt index", manager: "apt" })] })).toBe(
      "the recipe plans no tool this can ask a workspace for, so there is nothing to read inside",
    );
    expect(await toolsInside(machine, { steps: [] })).toContain("nothing to read inside");
    expect(machine.asked).toEqual([]);
  });
});

describe("the doctor's line for the vault", () => {
  it("says every variable the vault may hold by name, held or not, which agent reads which and which of two it reads first, and never a value", () => {
    const lines = vaultKeysLines(() => ({ ANTHROPIC_API_KEY: "sk-ant-x-notreal", OPENAI_API_KEY: "" }));
    // Every variable the catalog's own rows declare, in one order, so two runs read the same list.
    expect(lines).toHaveLength(VAULT_VARIABLES.size);
    expect(lines).toEqual([
      "ANTHROPIC_API_KEY held (Claude Code reads it after CLAUDE_CODE_OAUTH_TOKEN)",
      "CLAUDE_CODE_OAUTH_TOKEN not held (Claude Code reads it first)",
      "GEMINI_API_KEY not held (Gemini CLI reads it)",
      "OPENAI_API_KEY not held (Codex reads it)",
    ]);
    // An empty value is no key, and no line carries what a value is.
    for (const line of lines) expect(line).not.toContain("sk-ant");
  });
});


describe("the doctor's computer road", () => {
  const computer = (over: Partial<PlaceView> = {}): PlaceView => ({ id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true, daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], ...over });
  const project = (over: Partial<ProjectView> = {}): ProjectView => ({
    id: "pr_1",
    name: "spoo-landing",
    computer: "p_1",
    source: { kind: "git", url: "https://github.com/Zingzy/wsp.git" },
    path: "/srv/spoo-landing",
    remote: "https://github.com/Zingzy/wsp.git",
    defaultBranch: "main",
    memoryKey: "k",
    memoryDir: "/root/.wsp/projects/pr_1/memory",
    createdAt: "2026-09-18T09:00:00.000Z",
    ...over,
  });

  /** A host holding one computer, some projects on it and a workspace road that records what it was asked for. */
  function fakeHost(o: { projects: readonly ProjectView[]; places?: readonly PlaceView[]; inside?: (cmd: string) => { exitCode: number; stdout: string; stderr: string } }) {
    const created: { project: string; name: string; size?: unknown }[] = [];
    const deleted: string[] = [];
    const execs: string[] = [];
    const rt = {
      places: { list: async () => o.places ?? [computer()] },
      projects: { list: async () => [...o.projects] },
      workspaces: {
        create: async (spec: { project: string; name: string; size?: unknown }) => {
          created.push(spec);
          return { id: "w_1", name: spec.name };
        },
        exec: async (_id: string, cmd: string) => {
          execs.push(cmd);
          return o.inside?.(cmd) ?? { exitCode: 0, stdout: "", stderr: "" };
        },
        delete: async (id: string) => void deleted.push(id),
      },
    } as unknown as Parameters<typeof computerDoctor>[0];
    return { rt, created, deleted, execs };
  }

  /** The one step of a plan these cases read inside: a command the workspace answers for, or does not. */
  const onePlan: ProvisionPlan = { recipeAt: "2026-09-18T09:00:00.000Z", path: probePath(GUEST_HOME), skipped: [], steps: [{ id: "tools/npm/agent-browser", label: "agent-browser", manager: "npm", cmd: "install", bin: "agent-browser" }] };
  const answering = () => ({ exitCode: 0, stdout: "wsp-present 0 /usr/local/bin/agent-browser\n", stderr: "" });

  it("proves the computer in order: it answers, the vault, the agents there, a workspace of a project whose checkout stands, the tools inside and the delete", async () => {
    const host = fakeHost({ projects: [project({ id: "pr_old", name: "old-one" }), project({ checkout: "/root/.wsp/projects/pr_1/checkout" })], inside: answering });
    const io = captured();
    expect(await computerDoctor(host.rt, io, computer(), { vault: () => ({}), plan: async () => onePlan }, 7)).toBe(0);
    // Every step of the road, in the order the run took them.
    expect(io.lines.filter(l => /^(spoo answers|the vault's keys|agents there|a workspace made there|the recipe's tools inside|deleted)\b/.test(l)).map(l => l.split(/\s\s+/)[0])).toEqual([
      "spoo answers",
      "the vault's keys",
      "agents there",
      "a workspace made there",
      "the recipe's tools inside",
      "deleted",
    ]);
    // The workspace is made of the project whose checkout stands, at the size anybody gets there without asking.
    expect(host.created).toEqual([{ project: "pr_1", name: `doctor-${(7).toString(36)}` }]);
    // The tools were read inside that workspace, on the order a workspace there boots with.
    expect(host.execs.some(cmd => cmd.includes(`export PATH=${PLACE_WORKSPACE_PATH}`) && cmd.includes("agent-browser"))).toBe(true);
    expect(host.deleted).toEqual(["w_1"]);
    // Each agent the computer reported, by its catalog name. This one reported no version and no sign-in, which
    // is a daemon older than those fields, so the name is the whole of the line.
    for (const id of ["claude", "codex"]) expect(io.lines).toContain(`${agentName(id)} on spoo`);
    expect(io.lines.at(-1)).toContain("DOCTOR PASS");
  });

  it("says each agent's version and whether a sign-in stands there, in the words the computers table says them in", async () => {
    const host = fakeHost({ projects: [project({ checkout: "/root/c" })], inside: answering });
    const io = captured();
    const said = computer({
      agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" },
      signIns: { claude: "vault-key", codex: "none" },
    });
    expect(await computerDoctor(host.rt, io, said, { vault: () => ({}), plan: async () => onePlan }, 7)).toBe(0);
    expect(io.lines).toContain(`${agentName("claude")} on spoo: 2.1.270, your key`);
    expect(io.lines).toContain(`${agentName("codex")} on spoo: 0.153.0, not signed in`);
    // The words are the protocol's own, so this step and the table cannot say them two ways.
    expect(io.lines).toContain(`${agentName("codex")} on spoo: ${agentVersionWord("codex-cli 0.153.0")}, ${agentSignInWord("none")}`);
    // An agent with no sign-in of its own is a person's to see to, never this run's to fail on.
    expect(io.lines.filter(l => /^agents there\b/.test(l)).at(0)).toContain(plural(2, "agent"));
    expect(io.lines.at(-1)).toContain("DOCTOR PASS");
  });

  it("says the computer reported no agent where it reported none, and still passes", async () => {
    const host = fakeHost({ projects: [project({ checkout: "/root/c" })], inside: answering });
    const io = captured();
    expect(await computerDoctor(host.rt, io, computer({ agents: [] }), { vault: () => ({}), plan: async () => onePlan }, 7)).toBe(0);
    expect(io.lines.filter(l => /^agents there\b/.test(l)).at(0)).toContain("the computer reported no agent");
    expect(io.lines.at(-1)).toContain("DOCTOR PASS");
  });

  it("deletes the workspace it made on the way out of a failure too", async () => {
    const host = fakeHost({ projects: [project({ checkout: "/root/c" })], inside: () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    const io = captured();
    expect(await computerDoctor(host.rt, io, computer(), { vault: () => ({}), plan: async () => onePlan })).toBe(1);
    expect(io.errors.join("\n")).toContain("agent-browser did not answer inside the workspace");
    expect(host.deleted).toEqual(["w_1"]);
  });

  it("fails the workspace step with the line that records the project again where no project there has a checkout, and with the line that adds one where there is no project at all", async () => {
    const one = fakeHost({ projects: [project()] });
    const io = captured();
    expect(await computerDoctor(one.rt, io, computer(), { vault: () => ({}) })).toBe(1);
    expect(io.errors.join("\n")).toContain(projectNeedsReaddLine("spoo-landing", "spoo", { kind: "git", url: "https://github.com/Zingzy/wsp.git" }));
    expect(one.created).toEqual([]);

    const none = fakeHost({ projects: [] });
    const empty = captured();
    expect(await computerDoctor(none.rt, empty, computer(), { vault: () => ({}) })).toBe(1);
    expect(empty.errors.join("\n")).toContain("spoo holds no project, and a workspace is a copy of one; wsp add <url> --on spoo records one");
  });

  it("makes its workspace of the project --project names, and refuses a word that names none there", async () => {
    const host = fakeHost({ projects: [project({ checkout: "/root/a" }), project({ id: "pr_2", name: "www", checkout: "/root/b" })], inside: answering });
    const io = captured();
    expect(await computerDoctor(host.rt, io, computer(), { vault: () => ({}), plan: async () => onePlan, project: "www" }, 7)).toBe(0);
    expect(host.created[0]!.project).toBe("pr_2");
    const wrong = captured();
    expect(await computerDoctor(host.rt, wrong, computer(), { vault: () => ({}), project: "nope" })).toBe(1);
    expect(wrong.errors.join("\n")).toContain(noSuchProjectLine("nope", ["spoo-landing", "www"]));
  });

  it("fails the first step in the computer's own words when it is not answering, and says a behind daemon and goes on when it is", async () => {
    const off = fakeHost({ projects: [project({ checkout: "/root/a" })] });
    const io = captured();
    expect(await computerDoctor(off.rt, io, computer({ present: false, lastSeenAt: new Date(7 - 60_000).toISOString() }), { vault: () => ({}) }, 7)).toBe(1);
    expect(io.errors.join("\n")).toContain("spoo is not answering");
    expect(off.created).toEqual([]);

    const behind = fakeHost({ projects: [project({ checkout: "/root/a" })], inside: answering });
    const said = captured();
    expect(await computerDoctor(behind.rt, said, computer({ daemonVersion: DAEMON_VERSION - 1 }), { vault: () => ({}), plan: async () => onePlan }, 7)).toBe(0);
    expect(said.lines).toContain(`spoo is behind: daemon ${DAEMON_VERSION - 1}, host ${DAEMON_VERSION}; ${placeUpdateLine("spoo")} puts this wsp's daemon on it`);
    expect(behind.created).toHaveLength(1);
  });

  it("says what stands in for the recipe on a host that wired no plan, and on a computer whose recipe was never written here", async () => {
    const host = fakeHost({ projects: [project({ checkout: "/root/a" })] });
    const io = captured();
    expect(await computerDoctor(host.rt, io, computer(), { vault: () => ({}) })).toBe(0);
    expect(io.lines.some(l => l.includes("this host wired no recipe plan, so there is nothing to read inside"))).toBe(true);
    const noRecipe = captured();
    expect(await computerDoctor(host.rt, noRecipe, computer(), { vault: () => ({}), plan: async () => ({ noRecipe: "/Users/dev/.wsp/recipe.json" }) })).toBe(0);
    expect(noRecipe.lines.some(l => l.includes("this computer holds no recipe at /Users/dev/.wsp/recipe.json"))).toBe(true);
  });
});


describe("which road wsp doctor takes", () => {
  const computer = (over: Partial<PlaceView> = {}): PlaceView => ({ id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true, daemonVersion: DAEMON_VERSION, ...over });

  /** A host whose local workspace answers a thread, holding the places a case names. The fork road's own first
   * step throws here: no road that bills may run without its row being named. */
  function fakeHost(places: readonly PlaceView[]) {
    const created: string[] = [];
    const rt = {
      places: { list: async () => [...places] },
      projects: {
        // One project on the computer joined here, cloned once at its add, which is what a workspace there copies.
        list: async () => [{ id: "pr_1", name: "spoo-landing", computer: "p_1", checkout: "/root/.wsp/projects/pr_1/checkout", source: { kind: "git", url: "https://github.com/Zingzy/wsp.git" } }],
        add: async (o: { source: string }) => ({ id: "pr_local", name: "local", computer: HERE_PLACE_ID, source: { kind: "folder", path: o.source } }),
        remove: async () => ({ said: "gone" }),
      },
      workspaces: {
        list: async () => [],
        create: async (spec: { project: string; name: string }) => {
          created.push(spec.name);
          return { id: `w_${created.length}`, name: spec.name };
        },
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        delete: async () => {},
      },
      harnesses: { list: async () => [{ harness: "claude", label: "Claude Code", source: "harness", version: "2.1.270" }] },
      sessions: {
        start: async (_id: string, o: { prompt: string }) => ({ finished: Promise.resolve({ status: "completed", text: o.prompt.split(": ").at(-1) }) }),
      },
      // The fork road's own steps: a run that reaches the image is a run that named a cloud row, and no case here
      // may fork or bill, so the step that reads the image says which road ran.
      golden: {
        promote: async () => undefined,
        storage: async () => undefined,
        orphans: async () => undefined,
        get: async () => {
          throw new Error("the fork road ran, and nothing named its row");
        },
      },
    } as unknown as Runtime;
    return { rt, created };
  }

  it("with no word takes the local road here and no other: a computer somebody joined is proved by the host holding its link", async () => {
    const host = fakeHost([computer({ id: HERE_PLACE_ID, name: "this computer", kind: "computer", takesForks: false }), computer(), { id: "solari", kind: "provider", name: "solari", default: false }]);
    const io = captured();
    expect(await doctor(host.rt, io, { vault: () => ({}), plan: async () => ({ recipeAt: "2026-09-18T09:00:00.000Z", path: probePath(GUEST_HOME), skipped: [], steps: [] }) })).toBe(0);
    expect(io.lines.some(l => l.includes(`proving a thread on ${THIS_COMPUTER}`))).toBe(true);
    // Nothing of the computer road runs in this process: its link is held by the host that computer dials.
    expect(io.lines.some(l => l.includes("a computer you added"))).toBe(false);
    expect(io.lines.some(l => l.toLowerCase().includes("forked from it"))).toBe(false);
  });

  it("with this computer's own row named takes the local road, since its projects are folders worked in place", async () => {
    const host = fakeHost([]);
    const io = captured();
    expect(await doctor(host.rt, io, { computer: computer({ id: HERE_PLACE_ID, name: "this computer", takesForks: false }), vault: () => ({}) })).toBe(0);
    expect(io.lines.some(l => l.includes(`proving a thread on ${THIS_COMPUTER}`))).toBe(true);
    expect(io.lines.some(l => l.includes("a computer you added"))).toBe(false);
  });

  it("with a cloud row named takes the fork road, which is the one that bills", async () => {
    const host = fakeHost([]);
    const io = captured();
    expect(await doctor(host.rt, io, { computer: { id: "solari", kind: "provider", name: "solari", default: false } })).toBe(1);
    expect(io.errors.join("\n")).toContain("the fork road ran, and nothing named its row");
  });

  it("opens every road with the newest release, the one that bills included", async () => {
    const latest = "0.3.0; this is 0.2.0, npm i -g @zingzy/wsp@0.3.0 gets it";
    const bare = captured();
    expect(await doctor(fakeHost([]).rt, bare, { latest, vault: () => ({}) })).toBe(0);
    expect(bare.lines[0]).toBe(`latest release ${latest}`);
    expect(bare.lines.filter(l => l.startsWith("latest release"))).toHaveLength(1);
    const cloud = captured();
    expect(await doctor(fakeHost([]).rt, cloud, { latest, computer: { id: "solari", kind: "provider", name: "solari", default: false } })).toBe(1);
    expect(cloud.lines[0]).toBe(`latest release ${latest}`);
  });
});


describe("what a road of the doctor's leaves open", () => {
  it("a wiring built the doctor's way lets go of a turn it is reading when it closes, so nothing it opened holds this process", async () => {
    const home = tmp("wsp-doctor-handles-");
    const statePath = join(home, "state.json");
    const runDir = join(home, "runs");
    // Counted, not named: the runner holds timers of its own, and what this case is about is the one this wiring
    // adds. The list goes into the failure so a run that drifts says what it was holding.
    const held = (): string[] => process.getActiveResourcesInfo().filter(kind => kind === "Timeout");
    const before = held().length;
    // The wiring the doctor command builds: this computer's own, with the run folder beside the state file it was
    // given and a sink that keeps the daemon's own stderr off the person's screen.
    const local = localWiring(home, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, undefined, statePath, undefined, () => {});
    const stream = local.execStream()("sleep 300", { env: {} });
    // A turn left running here is what a doctor's runtime re-opens on a state a host is serving: the poll that
    // reads it is a timer, and a timer nobody stopped holds the loop after the last line is printed.
    await vi.waitFor(() => expect(held().length).toBeGreaterThan(before));
    await local.close?.();
    expect(held().length, `left open: ${process.getActiveResourcesInfo().join(", ")}`).toBe(before);
    // The turn itself is left running, as a turn on this computer always is; this process is simply done reading it.
    stream.kill();
    await new Promise(resolve => setTimeout(resolve, 50));
    rmSync(home, { recursive: true, force: true });
  }, 20_000);
});

describe("the doctor's computer road over the host that holds the link", () => {
  const computer = (over: Partial<PlaceView> = {}): PlaceView => ({ id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true, ...over });

  /** A host client as this road drives one: the frames it pushes, what it was asked and how many times it
   * subscribed. `answer` is what the request comes to, and it may push frames of its own before it settles. */
  function fakeClient(answer: (op: string, params: Record<string, unknown>, push: (frame: Record<string, unknown>) => void) => Promise<Record<string, unknown>>, onSubscribe?: (push: (frame: Record<string, unknown>) => void) => void) {
    const listeners = new Set<(frame: Record<string, unknown>) => void>();
    const asked: { op: string; params: Record<string, unknown> }[] = [];
    let subscribed = 0;
    const push = (frame: Record<string, unknown>): void => {
      for (const fn of [...listeners]) fn(frame);
    };
    const client = {
      request: async <T extends Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
        asked.push({ op, params });
        return (await answer(op, params, push)) as T;
      },
      events: async (): Promise<void> => {
        subscribed++;
        onSubscribe?.(push);
      },
      onFrame: (fn: (frame: Record<string, unknown>) => void): (() => void) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
    };
    return { client, asked, listeners, subscribed: () => subscribed };
  }

  const line = (doctorId: string, words: string, stream: "out" | "err" = "out"): Record<string, unknown> => ({ type: "doctor.line", doctorId, line: words, stream });

  it("prints every line of the road as the host says it, by the stream it was said on, and exits with what the host's road came to", async () => {
    const { client, asked, subscribed } = fakeClient(async (op, params, push) => {
      const id = params["doctorId"] as string;
      push(line(id, "spoo answers"));
      // A line of somebody else's run on the same socket: this one prints its own and no others.
      push(line("d_other", "another run's line"));
      push(line(id, "DOCTOR FAIL: spoo", "err"));
      return { ok: true, code: 1 };
    });
    const io = captured();
    expect(await hostDoctor(client, io, computer(), { project: "spoo-landing" })).toBe(1);
    expect(io.lines).toEqual(["spoo answers"]);
    expect(io.errors).toEqual(["DOCTOR FAIL: spoo"]);
    // One subscription, and the request carries the computer, the id its lines ride and the project.
    expect(subscribed()).toBe(1);
    expect(asked).toEqual([{ op: "places.doctor", params: { placeId: "p_1", doctorId: expect.stringMatching(/^d_[0-9a-f]{12}$/), project: "spoo-landing" } }]);
  });

  it("is listening before it subscribes and before it asks, so no line said between them is lost", async () => {
    const order: string[] = [];
    const { client } = fakeClient(async (op, params, push) => {
      order.push("request");
      push(line(params["doctorId"] as string, "said with the reply"));
      return { ok: true, code: 0 };
    });
    const io = captured();
    const watched = {
      ...client,
      events: async () => {
        order.push("events");
        await client.events();
      },
      onFrame: (fn: (frame: Record<string, unknown>) => void): (() => void) => {
        order.push("onFrame");
        return client.onFrame(fn);
      },
    };
    expect(await hostDoctor(watched, io, computer())).toBe(0);
    expect(order).toEqual(["onFrame", "events", "request"]);
    expect(io.lines).toEqual(["said with the reply"]);
  });

  it("names no project where the line named none", async () => {
    const { client, asked } = fakeClient(async () => ({ ok: true, code: 0 }));
    expect(await hostDoctor(client, captured(), computer())).toBe(0);
    expect(Object.keys(asked[0]!.params).sort()).toEqual(["doctorId", "placeId"]);
  });

  it("a socket the host closed mid-road is the host's own sentence and the class its error carries", async () => {
    const closed = fakeClient(async () => {
      throw new Error("the host stopped");
    });
    const io = captured();
    expect(await hostDoctor(closed.client, io, computer())).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual(["the host stopped"]);
    const refused = fakeClient(async () => {
      throw Object.assign(new Error(doctorRowRefusal("spoo")), { kind: "usage" });
    });
    const said = captured();
    expect(await hostDoctor(refused.client, said, computer())).toBe(EXIT_CODES.usage);
    expect(said.errors).toEqual([doctorRowRefusal("spoo")]);
  });

  it("proves every computer joined to this one in the order the host listed them, and never its own row or a cloud row", async () => {
    const codes = new Map<string, number>([
      ["p_1", 0],
      ["p_2", 1],
      ["p_3", 0],
    ]);
    const { client, asked } = fakeClient(async (_op, params) => ({ ok: true, code: codes.get(params["placeId"] as string) ?? 0 }));
    const rows = [
      computer({ id: HERE_PLACE_ID, name: "this computer" }),
      computer({ id: "p_1", name: "one" }),
      { id: "solari", kind: "provider", name: "solari", default: false } as PlaceView,
      computer({ id: "p_2", name: "two" }),
      computer({ id: "p_3", name: "three" }),
    ];
    // The worst of them is what the line exits with, as a run that named no computer has always answered.
    expect(await doctorOverHost(client, captured(), rows)).toBe(1);
    expect(asked.map(a => a.params["placeId"])).toEqual(["p_1", "p_2", "p_3"]);
  });
});

describe("the words wsp doctor says about itself", () => {
  const row = COMMANDS_FOR_HELP["doctor"]!;

  it("names the computer it takes, what each road does and which one bills, on its usage, its about and its terminal-only line", () => {
    expect(row.usage).toBe("wsp doctor [<computer>] [--project <name>] [--local] [--yes]");
    expect(row.about).toBe(
      "prove a computer end to end. With no word, this computer and then every computer you added, forking nothing and billing nothing. With a computer's name, that one: a joined computer is proved by the host that computer dials, which makes a short-lived workspace there and reads the recipe's tools inside it, and this line prints what the host says; a cloud account gets your image forked, wsp put on the fork, a file coming back and the teardown, which forks a live machine and bills while it runs. --local proves this computer alone: a thread here and its reply, no machine, no key. --project names the project the workspace is made of, by name, on the computer named",
    );
    // The line says which process walks the computer road, since that is what a person reads when they wonder why
    // a host has to be up for it.
    expect(row.about).toContain("proved by the host that computer dials");
    // The line a person reads when they aim this at a host somewhere else: what it does here is what it says.
    expect(row.cliOnly).toBe("runs for minutes, makes and deletes a workspace on the computer you named, and on a cloud account forks a live machine that bills while it runs; a person decides that at a terminal");
  });

  it("carries a row of its own for the two flags that shape which road it takes", () => {
    const says = (name: string): string | undefined => SHARED_FLAGS.find(f => f.name === name && f.on.includes("doctor"))?.says;
    expect(says("local")).toBe("prove this computer alone: a thread here and its reply, with no machine, no key, nothing forked and nothing billed");
    expect(says("project")).toBe("the project the doctor's workspace is made of, by name, on the computer named; the first project there whose checkout stands when absent");
    // And the flag rows are in the page a person reads for this line.
    for (const flag of ["--local", "--project", "--yes"]) expect(commandPage("doctor", row)).toContain(flag);
  });
});

describe("the word wsp doctor takes", () => {
  const row = (over: Partial<PlaceView>): PlaceView => ({ id: "p_1", kind: "computer", name: "spoo", default: false, ...over });
  const places = [row({ id: HERE_PLACE_ID, name: "zingzys-macbook-pro.local", default: true }), row({}), row({ id: "solari", kind: "provider", name: "solari" })];

  it("picks the row the word names, by the name a person types or the id the wire keys it by", () => {
    expect(doctorRow(places, "spoo").id).toBe("p_1");
    expect(doctorRow(places, "p_1").name).toBe("spoo");
    expect(doctorRow(places, "solari").kind).toBe("provider");
    expect(doctorRow(places, HERE_PLACE_ID).id).toBe(HERE_PLACE_ID);
  });

  it("refuses a word that names no row of this host, with the rows it holds and the line that lists them", () => {
    // The same refusal every road that takes a place word gives, and the line a person runs to read the names.
    expect(() => doctorRow(places, "nosuchbox")).toThrow(noSuchPlaceRefusal("nosuchbox", ["zingzys-macbook-pro.local", "spoo", "solari"]));
    expect(() => doctorRow(places, "nosuchbox")).toThrow("Run wsp computers to read the ones this host holds.");
    // A host that has joined no computer holds its own row all the same, so the names are never an empty list.
    expect(() => doctorRow([places[0]!], "spoo")).toThrow(noSuchPlaceRefusal("spoo", ["zingzys-macbook-pro.local"]));
  });
});

describe("browser shim in the guest", () => {
  it("is installed as BROWSER and as xdg-open, first on PATH, and login shells lose the image's DISPLAY", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    // Not in every machine's envs: an old golden without the shim would otherwise point tools at a missing file.
    expect(GUEST_ENVS["BROWSER"]).toBeUndefined();
    expect(claudeEnvs({ browserShim: true })["BROWSER"]).toBe("/usr/local/bin/wsp-open");
    expect(claudeEnvs({ browserShim: false })["BROWSER"]).toBeUndefined();
    expect(claudeEnvs({})["BROWSER"]).toBeUndefined();
    expect(claudeEnvs({ browserShim: true })).toEqual({ CLAUDE_CONFIG_DIR: "/root/.claude-cfg", ...GUEST_ENVS, BROWSER: "/usr/local/bin/wsp-open" });
    expect(script).toContain("install -m 0755 /root/wsp-daemon/wsp-open /usr/local/bin/wsp-open");
    expect(script).toContain("ln -sfn /usr/local/bin/wsp-open /usr/local/bin/xdg-open");
    expect(script).toContain("mkdir -p /etc/profile.d && printf 'export BROWSER=%s\\nunset DISPLAY\\n' /usr/local/bin/wsp-open > /etc/profile.d/wsp-open.sh");
    expect(TOOLS_PATH.split(":").indexOf("/usr/local/bin")).toBeLessThan(TOOLS_PATH.split(":").indexOf("/usr/bin"));
    // The shim runs before umask 077 so the file it installs stays world-executable.
    expect(script.indexOf("install -m 0755")).toBeLessThan(script.indexOf("umask 077"));
  });
});

describe("guest environment", () => {
  it("exports HOME and USER before anything runs, so the daemon started here hands them on, and never pins SHELL", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    const lines = script.split("\n");
    expect(lines.indexOf("export HOME=/root USER=root")).toBeGreaterThan(-1);
    expect(lines.indexOf("export HOME=/root USER=root")).toBeLessThan(lines.findIndex(l => l.startsWith("mkdir")));
    expect(script).not.toContain("SHELL");
  });

  it("with a preview host suffix, login shells and the daemon's ptys both learn the hosts Vite may answer for", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc", ".preview.example.com");
    expect(VITE_ALLOWED_HOSTS_ENV).toBe("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS");
    expect(script).toContain("printf 'export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=%s\\n' '.preview.example.com' > /etc/profile.d/wsp-preview.sh");
    const lines = script.split("\n");
    const exported = lines.indexOf("export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='.preview.example.com'");
    expect(exported).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(lines.indexOf("systemctl daemon-reload"));
    // The daemon's own copy comes from its unit: a restart inherits nothing from the exec that deployed it.
    expect(daemonUnit(CLOUD_PLACE, GUEST_TARGET, ".preview.example.com")).toContain("Environment=__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.preview.example.com");
    // Without a suffix nothing is written: a backend with no preview edge has no host to allow.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).not.toContain("VITE");
    expect(daemonUnit(CLOUD_PLACE, GUEST_TARGET)).not.toContain("VITE");
  });

  it("the suffix is the preview host with the machine-and-port label cut off, and nothing on a backend without preview URLs", async () => {
    const backend = stubBackend();
    const bare = await backend.create({ kind: "sandbox" });
    await expect(previewHostSuffix(bare)).resolves.toBeUndefined();
    const ports: number[] = [];
    const withEdge = { ...bare, previewUrl: async (port: number) => { ports.push(port); return { url: `https://m1-${port}.preview.example.com/?pt_token=x`, token: "x", expiresAt: 0 }; } };
    await expect(previewHostSuffix(withEdge)).resolves.toBe(".preview.example.com");
    expect(ports).toEqual([7070]);
    const flat = { ...bare, previewUrl: async () => ({ url: "https://localhost/", token: "x", expiresAt: 0 }) };
    await expect(previewHostSuffix(flat)).resolves.toBeUndefined();
    // A machine reached at a published port answers with an address: a dev server allowlist entry is for a name.
    const published = { ...bare, previewUrl: async () => ({ url: "http://127.0.0.1:49155", token: "", expiresAt: 0 }) };
    await expect(previewHostSuffix(published)).resolves.toBeUndefined();
  });
});

describe("what a deploy that would not come up says", () => {
  it("names the commands it was running, as they ran, with the machine's own last words first", () => {
    const said = deployFailureLine(CLOUD_PLACE, { exitCode: 1, stdout: "WSP_READY\n", stderr: "boom" }, ".preview.example.com");
    expect(said.startsWith("daemon deploy failed: WSP_READY")).toBe(true);
    // The unit printed is the unit that ran: the deploy states the dev server allowlist on it, and a near copy
    // without that line would send the next person to read a file that does not match what is on the machine.
    expect(said).toContain(`Environment=${VITE_ALLOWED_HOSTS_ENV}=.preview.example.com`);
    expect(said).toContain(daemonUnit(CLOUD_PLACE, GUEST_TARGET, ".preview.example.com"));
    // A fork's token is written by a line of its own and a box's is landed over the byte road; no start line has it.
    expect(said).not.toContain("aabbcc");
    expect(deployFailureLine(CLOUD_PLACE, { exitCode: 1, stdout: "", stderr: "" }, ".preview.example.com")).not.toContain("aabbcc");
  });

  const SPOO = joinedPlace({ home: "/root", path: "/usr/bin:/bin" }, { hostUrls: ["http://100.129.166.28:4640"], codeFile: "/root/.wsp/join-code", name: "spoo" });
  const SSH_FORWARD_NOISE = ["bind [127.0.0.1]:8080: Address already in use", "channel_setup_fwd_listener_tcpip: cannot listen to port: 8080", "Could not request local forwarding."];

  it("says a joined computer's failure in one sentence: the step it stopped in and the box's own refusal, never the script", () => {
    // The live failure of 2026-09-24: the apparmor line was stdout before the join, the join's refusal its stderr.
    const said = deployFailureLine(SPOO, {
      exitCode: 1,
      stdout: ["WSP_STEP files", "WSP_STEP login", "WSP_STEP agent", "the wsp-workspace apparmor profile is loaded, so workspaces isolate here", "WSP_READY", ""].join("\n"),
      stderr: [...SSH_FORWARD_NOISE, "the host at http://100.129.166.28:4640 did not answer in 20s", ""].join("\n"),
    });
    expect(said).toBe("spoo took wsp but could not connect back: the host at http://100.129.166.28:4640 did not answer in 20s");
    expect(said).not.toContain('case "$(uname -m)"');
  });

  it("names the step the last marker opened, with the box's last line and not ssh's own", () => {
    const tar = deployFailureLine(SPOO, { exitCode: 2, stdout: "WSP_STEP files\n", stderr: "tar: /root/.wsp/daemon.tgz: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n" });
    expect(tar).toBe("spoo did not take wsp's files: tar: /root/.wsp/daemon.tgz: Cannot open: No such file or directory");
    const chip = deployFailureLine(SPOO, { exitCode: 1, stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\n", stderr: "unsupported arch: riscv64\n" });
    expect(chip).toBe("spoo did not set up wsp's agent: unsupported arch: riscv64");
    // A box that wrote nothing of its own on stderr: ssh's forward warnings are not its words.
    const quiet = deployFailureLine(SPOO, { exitCode: 0, stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nWSP_READY\nPLACE_JOINED\nDAEMON_DOWN\n", stderr: `${SSH_FORWARD_NOISE.join("\n")}\n` });
    expect(quiet).toBe("spoo took wsp but could not connect back: it said nothing about why (exit 0)");
  });

  it("reads the line that says why, not tar's closing line, on a full disk", () => {
    const full = deployFailureLine(SPOO, { exitCode: 2, stdout: "WSP_STEP files\n", stderr: "tar: ./daemon/x86_64/wsp-daemon: Cannot write: No space left on device\ntar: Exiting with failure status due to previous errors\n" });
    expect(full).toBe("spoo did not take wsp's files: tar: ./daemon/x86_64/wsp-daemon: Cannot write: No space left on device");
  });

  it("names the agent's start once the box printed that it joined, since it did connect back", () => {
    const said = deployFailureLine(SPOO, {
      exitCode: 1,
      stdout: ["WSP_STEP files", "WSP_STEP login", "WSP_STEP agent", "WSP_READY", "spoo joined the wsp at http://100.129.166.28:4640; it dials that host on its own from now on.", ""].join("\n"),
      stderr: "systemctl enable --now wsp-place-abc exited 1 and said: Job for wsp-place-abc.service failed\n",
    });
    expect(said).toBe("spoo connected back but its agent did not start: systemctl enable --now wsp-place-abc exited 1 and said: Job for wsp-place-abc.service failed");
  });

  it("takes a marker only when it is one of the steps, word for word", () => {
    const stray = deployFailureLine(SPOO, { exitCode: 1, stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP whatever\nsomething mentions WSP_READY here\n", stderr: "boom\r\n" });
    expect(stray).toBe("spoo did not take wsp's login files: boom");
  });

  it("holds the sentence to 300 characters and keeps a box's own line that merely mentions a port", () => {
    expect(deployFailureLine(SPOO, { exitCode: 1, stdout: "WSP_READY\n", stderr: `${"x".repeat(3000)}\n` }).length).toBeLessThanOrEqual(300);
    expect(deployFailureLine(SPOO, { exitCode: 1, stdout: "WSP_READY\n", stderr: "wsp: cannot listen to port: 4400\n" })).toBe("spoo took wsp but could not connect back: wsp: cannot listen to port: 4400");
  });

  it("marks each step of a joined computer's deploy and no step of a fork's, so the daemon's content stands", async () => {
    const lines = deployScript(SPOO, "aabbcc").split("\n");
    const at = (line: string): number => lines.findIndex(l => l.startsWith(line));
    expect(at("echo WSP_STEP files")).toBeGreaterThan(-1);
    expect(at("echo WSP_STEP files")).toBeLessThan(at("tar --no-same-owner -xzf"));
    expect(at("tar --no-same-owner -xzf")).toBeLessThan(at("echo WSP_STEP login"));
    expect(at("echo WSP_STEP login")).toBeLessThan(at("mkdir -p '/root/.wsp' && printf"));
    expect(at("echo WSP_STEP agent")).toBeLessThan(at('case "$(uname -m)" in'));
    for (const place of [CLOUD_PLACE, CONTAINER_PLACE, sshDaemonPlace({ home: "/home/maya", path: "/usr/bin" })]) expect(deployScript(place, "aabbcc")).not.toContain("WSP_STEP");
    const dir = mkdtempSync(join(tmpdir(), "wsp-deploy-joined-"));
    try {
      writeFileSync(join(dir, "deploy.sh"), deployScript(SPOO, "aabbcc"));
      await promisify(execFile)("bash", ["-n", join(dir, "deploy.sh")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deployScript", () => {
  it("is valid bash (a live run died on '&;' once; bash -n guards the shape)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-deploy-script-"));
    try {
      for (const [name, script] of [["deploy.sh", deployScript(CLOUD_PLACE, "aabbcc")], ["deploy-entrypoint.sh", deployScript(CONTAINER_PLACE, "aabbcc")]] as const) {
        const path = join(dir, name);
        writeFileSync(path, script);
        await promisify(execFile)("bash", ["-n", path]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the supervisor road's pid reads survive a machine that never had a daemon", async () => {
    // set -e ends a script on an assignment whose substitution failed; a live deploy died on exactly this line.
    // One pair per chip, since the lines that start the daemon sit inside the arm for the chip they name.
    const reads = deployScript(CONTAINER_PLACE, "aabbcc").split("\n").filter(line => /^(old|sup)="\$\(cat /.test(line));
    expect(reads).toHaveLength(2 * GUEST_DAEMON_TARGETS.length);
    const { stdout } = await promisify(execFile)("bash", ["-ec", `${reads.join("\n")}\necho SURVIVED`]);
    expect(stdout).toContain("SURVIVED");
  });

  it("writes the token the way the rotation does, owner-only, in the one shape the run log redacts", () => {
    const token = "aabbccddeeff00112233445566778899";
    const script = deployScript(CLOUD_PLACE, token);
    expect(script).toContain(writeDaemonTokenScript(token));
    expect(script.indexOf("umask 077")).toBeLessThan(script.indexOf("systemctl restart"));
    expect(redact(script)).not.toContain(token);
    expect(redact(rotateDaemonTokenScript(token))).not.toContain(token);
  });

  it("keeps the binary for the chip the guest says it is and drops the other, by the one word uname prints", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    const lines = script.split("\n");
    const unpack = lines.indexOf("tar --no-same-owner -xzf /root/wsp-daemon.tgz -C /root/wsp-daemon");
    expect(unpack).toBeGreaterThan(-1);
    expect(unpack).toBeLessThan(lines.indexOf('case "$(uname -m)" in'));
    expect(lines).toContain("  x86_64)");
    expect(lines).toContain("  aarch64)");
    expect(lines).toContain(`rm -rf ${dirname(daemonBinaryOn(CLOUD_PLACE.dir, GUEST_DAEMON_TARGETS[1]!))}`);
    expect(lines).toContain(`rm -rf ${dirname(daemonBinaryOn(CLOUD_PLACE.dir, GUEST_DAEMON_TARGETS[0]!))}`);
    expect(lines).toContain('  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;');
    // Nothing is fetched, compiled or installed: the binary is the whole of the daemon.
    for (const word of ["npm install", "node_pin", "nodejs.org", "curl", "NODE_VERSION", "cc make"]) expect(script, word).not.toContain(word);
    expect(script).not.toMatch(/apt|nvm|\| *sh\b|\| *bash\b/);
  });

  /** The case as the deploy runs it, under a stand-in uname, against a folder holding both chips' binaries. */
  function pickedFor(unameSays: string): { status: number | null; said: string; left: string[]; kept: string[] } {
    const home = tmp("wsp-deploy-chip-");
    try {
      const place = sshDaemonPlace({ home, path: "/usr/bin:/bin" });
      for (const target of GUEST_DAEMON_TARGETS) {
        mkdirSync(dirname(daemonBinaryOn(place.dir, target)), { recursive: true });
        writeFileSync(daemonBinaryOn(place.dir, target), `${target.triple}\n`);
      }
      mkdirSync(dirname(place.unitPath), { recursive: true });
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${unameSays}\n`, { mode: 0o755 });
      // The arm hands the unit it writes to systemd, which is not a unit test's business; the file it writes is.
      writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const lines = deployScript(place, "aabbcc").split("\n");
      const from = lines.indexOf('case "$(uname -m)" in');
      const to = lines.indexOf("esac");
      expect(from).toBeGreaterThan(-1);
      const ran = spawnSync("/bin/bash", ["-ec", [...lines.slice(from, to + 1), "echo WENT_ON"].join("\n")], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
      const left = GUEST_DAEMON_TARGETS.filter(t => existsSync(daemonBinaryOn(place.dir, t))).map(t => t.triple);
      const kept = left.map(triple => readFileSync(daemonBinaryOn(place.dir, GUEST_DAEMON_TARGETS.find(t => t.triple === triple)!), "utf8").trim());
      return { status: ran.status, said: `${ran.stdout}${ran.stderr}`, left, kept };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("on each chip the case leaves one binary, the one built for that chip, where the command beside it reads one", () => {
    for (const target of GUEST_DAEMON_TARGETS) {
      const picked = pickedFor(target.uname);
      expect(picked.status).toBe(0);
      expect(picked.left).toEqual([target.triple]);
      expect(picked.kept).toEqual([target.triple]);
      expect(picked.said).toContain("WENT_ON");
    }
  });

  it("a chip wsp builds no daemon for stops the deploy there, the case's own exit and not the shell's", () => {
    const picked = pickedFor("riscv64");
    expect(picked.status).toBe(1);
    expect(picked.said).toContain("unsupported arch: riscv64");
    expect(picked.said).not.toContain("WENT_ON");
    // Nothing of the machine's was touched: a chip wsp builds no daemon for is left with the bundle as it landed.
    expect(picked.left).toEqual(GUEST_DAEMON_TARGETS.map(t => t.triple));
  });

  it("stops the daemon holding the port before starting the new one, so an update replaces a running daemon instead of reading it as up", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    const stop = script.indexOf(stopDaemonScript());
    // Inside the chip's own arm: the unit beside it names the binary by a path that carries the chip's triple.
    expect(stop).toBeGreaterThan(script.indexOf('case "$(uname -m)" in'));
    expect(stop).toBeLessThan(script.indexOf("esac"));
    expect(stop).toBeGreaterThan(script.indexOf("umask 077"));
    expect(stop).toBeLessThan(script.indexOf("systemctl restart"));
    // The pid is read off the socket table for the daemon's port, never matched by name.
    expect(stopDaemonScript()).toContain("ss -ltnpH 'sport = :7070'");
    expect(stopDaemonScript()).not.toMatch(/pkill|killall|pgrep/);
    expect(stopDaemonScript()).toContain('kill "$old"');
  });

  it("stops the unit before killing the port holder, since Restart=always would put the old daemon straight back", () => {
    const stop = stopDaemonScript();
    expect(stop.indexOf("systemctl stop wsp-daemon.service")).toBeLessThan(stop.indexOf('old="$('));
    // A machine whose daemon predates the unit has no unit to stop, and the deploy must not die on that.
    expect(stop).toContain("systemctl stop wsp-daemon.service 2>/dev/null || true");
  });

  it("leaves the daemon under a supervisor that restarts it, never a bare background process", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc", ".preview.example.com");
    expect(script).not.toContain("setsid");
    expect(script).not.toContain("nohup");
    expect(script).toContain(`cat > ${DAEMON_UNIT_PATH} <<'WSP_UNIT'`);
    expect(script).toContain(daemonUnit(CLOUD_PLACE, GUEST_TARGET, ".preview.example.com"));
    const lines = script.split("\n");
    const reload = lines.indexOf("systemctl daemon-reload");
    expect(lines.indexOf(`cat > ${DAEMON_UNIT_PATH} <<'WSP_UNIT'`)).toBeLessThan(reload);
    expect(reload).toBeLessThan(lines.indexOf(`systemctl enable ${DAEMON_UNIT}`));
    expect(lines.indexOf(`systemctl enable ${DAEMON_UNIT}`)).toBeLessThan(lines.indexOf(`systemctl restart ${DAEMON_UNIT}`));
    // The port check waits for the bind instead of guessing how long the daemon takes to reach it.
    expect(script).toContain(`for _ in $(seq 20); do ss -ltnH 'sport = :7070' | grep -q . && break; sleep 0.25; done`);
    expect(script).toContain(`ss -ltn | grep -q 7070 && echo DAEMON_UP || { ${daemonLogCommand()}; echo DAEMON_DOWN; }`);
  });

  it("asks nothing of a guest it built itself, and refuses no machine inside the deploy", () => {
    // wsp built this image and knows what is on it, so a fork is asked nothing and the deploy refuses nothing:
    // the systemd predicate is for a machine somebody already owns, and it is asked before anything lands there.
    expect(CLOUD_PLACE.preflight).toEqual([]);
    expect(preflightScript(CLOUD_PLACE)).not.toContain("command -v systemctl");
    const lines = deployScript(CLOUD_PLACE, "aabbcc").split("\n");
    expect(lines.some(line => line.includes("command -v systemctl"))).toBe(false);
    expect(lines[0]).toBe("set -e");
  });

  /** The guard as the deploy runs it, plus the guard on its own: a refusal that ends the script only because the
   * shell honours `set -e` for the last command of an `||` list is one bash flag away from installing anyway. */
  const guardRuns = (fragment: string[], path: string): { status: number | null; stdout: string } => {
    const ran = spawnSync("/bin/bash", ["-c", [...fragment, "echo WENT_ON"].join("\n")], { encoding: "utf8", env: { PATH: path } });
    return { status: ran.status, stdout: ran.stdout };
  };

  it("a machine with no systemctl stops the ask there, the guard's own exit and not the shell's", () => {
    const lines = preflightScript(sshDaemonPlace({ home: "/home/maya", path: "/usr/bin" })).split("\n");
    const guard = lines.findIndex(line => line.includes(machineLacksShort(NO_SYSTEMD_LINE)));
    expect(guard).toBeGreaterThan(-1);
    // An empty folder is the whole PATH the fragment is given; what the script itself exports is the guest's own.
    const empty = tmp("wsp-deploy-guard-");
    try {
      for (const fragment of [lines.slice(0, guard + 1), lines.slice(guard, guard + 1)]) {
        const ran = guardRuns(fragment, empty);
        expect(ran.stdout).toContain(NO_SYSTEMD_LINE);
        expect(ran.stdout).not.toContain("WENT_ON");
        expect(ran.status).toBe(1);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  /** The supervisor as the deploy writes it into the guest, out of the heredoc it rides in. */
  const supervisorScriptOf = (script: string): string => script.split("WSP_SUPERVISOR")[1] ?? "";

  it("a guest with no service manager gets a supervisor the machine's own boot runs", () => {
    const script = deployScript(CONTAINER_PLACE, "aabbcc");
    // Nothing refuses the guest here: the supervisor is what a machine without systemd is given instead.
    expect(preflightScript(CONTAINER_PLACE)).not.toContain("command -v systemctl");
    expect(script).not.toContain("systemctl daemon-reload");
    expect(script).not.toContain(DAEMON_UNIT_PATH);
    expect(script).toContain(`cat > ${GUEST_SUPERVISOR_PATH}`);
    expect(script).toContain(`chmod 0755 ${GUEST_SUPERVISOR_PATH}`);
    // A supervisor already watching the daemon restarts it with the new bundle; only a machine without one starts it here.
    expect(script).toContain(`setsid nohup ${GUEST_SUPERVISOR_PATH}`);
    // A container image ships neither ss nor curl, so the deploy asks bash itself whether the port answers.
    expect(script).not.toContain("ss -ltn");
    expect(script).toContain("(exec 3<>/dev/tcp/127.0.0.1/7070)");
    expect(script).toContain("DAEMON_UP");
    // The daemon being replaced is stopped by the pid the supervisor wrote, and the supervisor puts the new one up.
    // set -e ends the deploy on an assignment whose substitution failed, and a fresh machine has neither pid file.
    expect(script).toContain(`old="$(cat ${daemonPidPath(CONTAINER_PLACE)} 2>/dev/null || true)"`);
    expect(script).toContain(`sup="$(cat ${supervisorPidPath(CONTAINER_PLACE)} 2>/dev/null || true)"`);
    expect(supervisorScriptOf(script)).toContain(`echo $! > ${daemonPidPath(CONTAINER_PLACE)}`);
    // Both pids sit in the place's own folder, so a second place on this module keeps them where it keeps the rest.
    expect(daemonPidPath(CONTAINER_PLACE).startsWith(`${CONTAINER_PLACE.dir}/`)).toBe(true);
    expect(supervisorPidPath(CONTAINER_PLACE).startsWith(`${CONTAINER_PLACE.dir}/`)).toBe(true);
    const supervisor = daemonSupervisorScript(CONTAINER_PLACE, GUEST_TARGET);
    expect(supervisor).toContain(`  ${daemonExecLine(CONTAINER_PLACE, GUEST_TARGET)} >> ${DAEMON_LOG_PATH} 2>&1 &`);
    // The loop is the whole point: a daemon the kernel's memory killer took comes back on its own.
    expect(supervisor).toContain("while :; do");
    expect(supervisor).toContain(`export PATH=${TOOLS_PATH}`);
    for (const [name, value] of Object.entries(GUEST_USER_ENV)) expect(supervisor).toContain(`export ${name}=${value}`);
    // The log is bounded here, since a container has no journal to rotate one.
    expect(supervisor).toContain(DAEMON_LOG_PATH);
    expect(daemonLogCommand(CONTAINER_PLACE, 50)).toBe(`tail -n 50 ${DAEMON_LOG_PATH}`);
    // The same module under the other place reads the journal, and under a login's own scope reads that login's.
    expect(daemonLogCommand(CLOUD_PLACE, 50)).toBe(`journalctl -u ${DAEMON_UNIT} -n 50 --no-pager`);
  });

  it("the unit restarts the daemon forever, keeps a killed child from taking it, and caps the cgroup at a share of the machine", () => {
    const unit = daemonUnit(CLOUD_PLACE, GUEST_TARGET);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=1");
    // Without this the unit gives up after five restarts in ten seconds, which is the dead machine again.
    expect(unit).toContain("StartLimitIntervalSec=0");
    // systemd's default (stop) would end the daemon whenever a test run under a terminal was killed.
    expect(unit).toContain("OOMPolicy=continue");
    expect(unit).toContain(`MemoryMax=${DAEMON_MEMORY_MAX_PERCENT}%`);
    expect(DAEMON_MEMORY_MAX_PERCENT).toBe(80);
    // Enabled with an install section, so a machine that reboots or comes back from a snapshot has its daemon.
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("ExecStart=/root/wsp-daemon/wsp/assets/daemon/x86_64-unknown-linux-musl/wsp-daemon --host 0.0.0.0 --port 7070 --token-path /root/.wsp/daemon-token --root /root --roots-path /root/.wsp/roots --kind cloud --inbox /root/.wsp/inbox --manifest /root/.wsp/manifest.json --open-socket /root/.wsp/open.sock");
    // The journal, which rotates itself: nothing else on the guest bounds a log, and restarts here have no limit.
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
    expect(unit).not.toContain("append:");
    expect(daemonLogCommand()).toBe("journalctl -u wsp-daemon.service -n 50 --no-pager");
    // A deploy that never saw the port come up reads the journal, and reads it bounded.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).not.toContain("/root/daemon.log");
  });

  it("every road starts the binary the bundle left in the place's own folder, with one set of flags, and never the word node", () => {
    // The unit and the supervisor read one line: the binary by its path, then the flags the place answers.
    expect(daemonUnit(CLOUD_PLACE, GUEST_TARGET)).toContain(`ExecStart=${daemonExecLine(CLOUD_PLACE, GUEST_TARGET)}`);
    expect(daemonExecLine(CLOUD_PLACE, GUEST_TARGET)).toBe(`${GUEST_DAEMON_DIR}/wsp/assets/daemon/${GUEST_TARGET.triple}/wsp-daemon ${daemonFlags(CLOUD_PLACE).join(" ")}`);
    expect(daemonSupervisorScript(CONTAINER_PLACE, GUEST_TARGET)).toContain(`  ${daemonExecLine(CONTAINER_PLACE, GUEST_TARGET)} >>`);
    for (const text of [daemonUnit(CLOUD_PLACE, GUEST_TARGET), daemonSupervisorScript(CONTAINER_PLACE, GUEST_TARGET), deployScript(CLOUD_PLACE, "aabbcc")]) expect(text).not.toMatch(/\bnode\b/);
    // The flags name every file the daemon reads or writes, so nothing is left to a default the guest may not have.
    // Every one of them under root's own wsp folder, which is the same shape the login's own place below reads
    // under its home: on a computer somebody joined that folder is the workspace's own and not the computer's.
    expect(daemonFlags(CLOUD_PLACE)).toEqual(["--host", "0.0.0.0", "--port", "7070", "--token-path", "/root/.wsp/daemon-token", "--root", "/root", "--roots-path", "/root/.wsp/roots", "--kind", "cloud", "--inbox", "/root/.wsp/inbox", "--manifest", "/root/.wsp/manifest.json", "--open-socket", "/root/.wsp/open.sock"]);
    // A login's own place quotes each path, since a home may carry a space; the flags and the words stay bare.
    const login = sshDaemonPlace({ home: "/home/maya doe", path: "/usr/bin:/bin" });
    expect(daemonUnit(login, GUEST_TARGET)).toContain(
      `ExecStart="${daemonBinaryOn(login.dir, GUEST_TARGET)}" --host 127.0.0.1 --port 0 --token-path "/home/maya doe/.wsp/daemon-token" --root "/home/maya doe" --roots-path "/home/maya doe/.wsp/roots" --kind ssh --inbox "/home/maya doe/.wsp/inbox" --manifest "/home/maya doe/.wsp/manifest.json" --open-socket "/home/maya doe/.wsp/open.sock" --port-file "/home/maya doe/.wsp/daemon.port"`,
    );
  });

  it("every flag the unit writes is one the binary takes, read off the binary's own usage line", () => {
    // The binary built in this checkout, placed where the host reads it: what the unit spells has to be what it parses.
    const usage = execFileSync(daemonBinaryHere(), ["--help"], { encoding: "utf8" });
    const flags = daemonFlags(sshDaemonPlace({ home: "/home/maya", path: "/usr/bin" })).filter(word => word.startsWith("--"));
    expect(flags.length).toBeGreaterThan(5);
    for (const flag of flags) expect(usage, flag).toContain(`${flag} `);
  });

  it("the unit states the environment the daemon hands to every pty, since a restart inherits none of the deploy's", () => {
    const unit = daemonUnit(CLOUD_PLACE, GUEST_TARGET);
    expect(unit).toContain(`Environment=PATH=${TOOLS_PATH}`);
    for (const [name, value] of Object.entries(GUEST_USER_ENV)) expect(unit).toContain(`Environment=${name}=${value}`);
    expect(GUEST_USER_ENV["HOME"]).toBe("/root");
  });

  it("a fork's unit reads the environment a backend could not hand over at create off the engine's file, and may lack it; a login's unit reads no root file", () => {
    expect(daemonUnit(CLOUD_PLACE, GUEST_TARGET)).toContain(`EnvironmentFile=-${DAEMON_ENV_FILE}`);
    expect(DAEMON_ENV_FILE).toBe("/etc/wsp/daemon.env");
    expect(daemonUnit(sshDaemonPlace({ home: "/home/maya", path: "/usr/bin:/bin" }), GUEST_TARGET)).not.toContain("EnvironmentFile");
  });

});

describe("tarPackCommand", () => {
  it("disables AppleDouble copies and xattr headers so the guest tar prints nothing", () => {
    const mac = tarPackCommand("/s", "/b.tgz", "darwin");
    expect(mac.file).toBe("tar");
    expect(mac.env["COPYFILE_DISABLE"]).toBe("1");
    expect(mac.args).toContain("--no-xattrs");
    expect(mac.args).toContain("--no-mac-metadata");
    expect(mac.args.slice(-5)).toEqual(["-czf", "/b.tgz", "-C", "/s", "."]);
  });

  it("skips the bsdtar-only flag on linux (GNU tar rejects it)", () => {
    const linux = tarPackCommand("/s", "/b.tgz", "linux");
    expect(linux.args).toContain("--no-xattrs");
    expect(linux.args).not.toContain("--no-mac-metadata");
    expect(linux.env["COPYFILE_DISABLE"]).toBe("1");
  });
});

describe("packBundle", () => {
  it("produces a tarball with no xattr pax headers even when the source files carry them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-pack-"));
    try {
      const src = join(dir, "src");
      mkdirSync(src);
      writeFileSync(join(src, "a.js"), "export const a = 1;");
      if (process.platform === "darwin") {
        await promisify(execFile)("xattr", ["-w", "com.apple.provenance", "x", join(src, "a.js")]);
      }
      const tgz = join(dir, "b.tgz");
      await packBundle(src, tgz);
      const raw = gunzipSync(readFileSync(tgz)).toString("latin1");
      expect(raw).toContain("a.js");
      expect(raw).not.toContain("xattr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deployDaemon", () => {
  it("uploads the bundle, runs the deploy script, and answers the token the daemon started with", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-deploy-"));
    const uploads: Buffer[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c as Buffer));
      req.on("end", () => {
        uploads.push(Buffer.concat(chunks));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    try {
      const daemonDir = fakeDaemonDir(dir);

      const backend = stubBackend();
      backend.execImpl = () => ({ exitCode: 0, stdout: "DAEMON_UP\n", stderr: "" });
      const machine = await backend.create({ kind: "sandbox" });
      const stub = backend.machines[0]!;
      const port = (server.address() as { port: number }).port;
      stub.uploadUrl = async () => `http://127.0.0.1:${port}/put`;

      const cliDir = fakeCliDir(dir);
      const out = await deployDaemon(machine, { token: "abc123", daemonDir, cliDir });
      expect(out).toEqual({ token: "abc123" });
      // A fork is asked nothing, so nothing stands between the create and the deploy.
      expect(stub.execLog).toEqual([deployScript(CLOUD_PLACE, "abc123")]);
      // The deploy waits for the daemon to bind, past what one exec is allowed, so it is a run.
      expect(stub.runLog).toEqual([deployScript(CLOUD_PLACE, "abc123")]);
      // The same deploy is the daemon update on a person's live workspace: nothing of theirs is removed.
      expect(stub.execLog.join("\n")).not.toMatch(/rm -rf[^\n]*\/root\/\.(npm|cache)/);
      expect(uploads).toHaveLength(1);
      const bundle = gunzipSync(uploads[0]!).toString("latin1");
      for (const target of GUEST_DAEMON_TARGETS) expect(bundle).toContain(target.triple);
      expect(bundle).not.toContain("start.mjs");

      // On a backend with a preview edge the script carries the edge's host suffix, read off this machine's URL.
      const edged = await backend.create({ kind: "sandbox" });
      const edgedStub = backend.machines[1]!;
      edgedStub.uploadUrl = async () => `http://127.0.0.1:${port}/put`;
      edgedStub.previewUrl = async p => ({ url: `https://${edgedStub.id}-${p}.preview.example.com/?pt_token=x`, token: "x", expiresAt: 0 });
      await deployDaemon(edged, { token: "abc123", daemonDir, cliDir });
      expect(edgedStub.execLog).toEqual([deployScript(CLOUD_PLACE, "abc123", ".preview.example.com")]);

      // A backend that mints no signed URL lands the bundle on its own road, and says what supervises the daemon,
      // which is the one thing that picks the place a guest's daemon lands in.
      const boxed = await backend.create({ kind: "sandbox" });
      const boxedStub = backend.machines[2]!;
      const landed: { path: string; bytes: number }[] = [];
      boxedStub.uploadUrl = async () => { throw new Error("a container serves no signed upload URL"); };
      boxedStub.putBytes = async (path: string, bytes: Buffer) => { landed.push({ path, bytes: bytes.length }); };
      boxedStub.daemonSupervisor = "entrypoint";
      await deployDaemon(boxed, { token: "abc123", daemonDir, cliDir });
      expect(landed.map(l => l.path)).toEqual(["/root/wsp-daemon.tgz"]);
      expect(landed[0]!.bytes).toBeGreaterThan(0);
      expect(boxedStub.execLog).toEqual([deployScript(CONTAINER_PLACE, "abc123")]);
      expect(edgedStub.execLog[0]).toContain("export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='.preview.example.com'");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("connectDaemonSocket", () => {
  let daemon: DaemonUnderTest | undefined;
  let socket: DaemonSocket | undefined;
  let inboxDir: string | undefined;
  afterEach(async () => {
    socket?.close();
    socket = undefined;
    await daemon?.close();
    daemon = undefined;
    if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
    inboxDir = undefined;
  });

  async function startLocalDaemon(): Promise<{ url: string; token: string }> {
    inboxDir = tmp("wsp-doctor-inbox-");
    daemon = await daemonUnderTest({
      host: "127.0.0.1",
      port: 0,
      token: "secret-token",
      inbox: inboxDir,
      inboxQuietMs: 50,
      inboxPollMs: 25,
      manifest: join(inboxDir, "manifest.json"),
    });
    return { url: `http://127.0.0.1:${daemon.port}/?pt_token=ignored`, token: "secret-token" };
  }

  it("authenticates, round-trips ops, and heartbeats at the configured interval", async () => {
    const { url, token } = await startLocalDaemon();
    socket = await connectDaemonSocket({ url, token, heartbeatMs: 50 });
    const reply = await socket.op("manifest.get");
    expect(reply["ok"]).toBe(true);
    // Each beat is a completed op round trip, app-level because browsers
    // cannot send protocol pings.
    for (const deadline = Date.now() + 4000; socket.beats < 2 && Date.now() < deadline; ) await new Promise(r => setTimeout(r, 10));
    expect(socket.beats).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("receives inbox events after inbox.watch", async () => {
    const { url, token } = await startLocalDaemon();
    const events: Record<string, unknown>[] = [];
    socket = await connectDaemonSocket({ url, token, onEvent: e => events.push(e) });
    await socket.op("inbox.watch");
    writeFileSync(join(inboxDir!, "ping.txt"), "doctor");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no inbox.file event in 3s")), 3000);
      const poll = setInterval(() => {
        if (events.some(e => e["type"] === "inbox.file")) {
          clearTimeout(t);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
  });

  it("an event handler that throws is reported once and the socket keeps working", async () => {
    const { url, token } = await startLocalDaemon();
    const failures: string[] = [];
    let calls = 0;
    socket = await connectDaemonSocket({
      url,
      token,
      onEvent: () => {
        calls++;
        throw new TypeError("Invalid URL");
      },
      onEventError: e => failures.push(e instanceof Error ? e.message : String(e)),
    });
    await socket.op("inbox.watch");
    writeFileSync(join(inboxDir!, "boom.txt"), "x");
    const deadline = Date.now() + 3000;
    while (calls === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(calls).toBeGreaterThan(0);
    expect(failures).toEqual(Array(calls).fill("Invalid URL"));
    expect((await socket.op("manifest.get"))["ok"]).toBe(true);
    expect(socket.open).toBe(true);
  });

  it("an op sent after the server closed the socket rejects at once instead of hanging forever", async () => {
    // A server that answers ops and then closes the connection under the client: the send has nowhere to go and no callback.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(r => server.once("listening", r));
    server.on("connection", ws => {
      ws.on("message", raw => {
        const m = JSON.parse(String(raw)) as { id: number };
        ws.send(JSON.stringify({ id: m.id, ok: true }));
      });
    });
    const port = (server.address() as { port: number }).port;
    try {
      socket = await connectDaemonSocket({ url: `http://127.0.0.1:${port}/`, token: "any", heartbeatMs: 60_000 });
      expect((await socket.op("manifest.get"))["ok"]).toBe(true);
      for (const client of server.clients) client.close();
      await socket.closed;
      expect(socket.open).toBe(false);
      const t0 = Date.now();
      await expect(socket.op("pty.kill", { ptyId: "pty_1" })).rejects.toThrow(/not open/);
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it("rejects on a bad daemon token (4401 through the socket close)", async () => {
    const { url } = await startLocalDaemon();
    await expect(connectDaemonSocket({ url, token: "wrong" })).rejects.toThrow(/4401.*daemon token refused/);
  });

  it("dials with the edge token alone and sends ours as the first frame", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(r => server.once("listening", r));
    const seen: { url: string; frames: Record<string, unknown>[] }[] = [];
    server.on("connection", (ws, req) => {
      const conn = { url: req.url ?? "", frames: [] as Record<string, unknown>[] };
      seen.push(conn);
      ws.on("message", raw => {
        const m = JSON.parse(String(raw)) as { id: number };
        conn.frames.push(m);
        ws.send(JSON.stringify({ id: m.id, ok: true }));
      });
    });
    const port = (server.address() as { port: number }).port;
    try {
      socket = await connectDaemonSocket({ url: `http://127.0.0.1:${port}/?pt_token=edge`, token: "ours", heartbeatMs: 60_000 });
      expect(seen[0]!.url).toBe("/?pt_token=edge");
      expect(seen[0]!.frames.map(f => f["op"])).toEqual(["auth", "manifest.get"]);
      expect(seen[0]!.frames[0]).toMatchObject({ op: "auth", token: "ours" });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

describe("the doctor's local road", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A scripted harness on this computer: it describes itself the way a binary that answered does, and a turn runs
   * one real command through the local exec stream, so a reply landing proves the local backend drove it. */
  const scripted = (over: { probe?: HarnessCatalogAnswer } = {}): HarnessAdapterFactory => ctx => ({
    steers: false,
    probeCatalog: async () => (over.probe === undefined ? { version: "9.9.9", models: [], efforts: [], permissionModes: [] } : over.probe),
    start: ({ prompt, onEvent }) => {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const asked = prompt.slice(prompt.lastIndexOf(": ") + 2);
      const finished = (async () => {
        const stream = ctx.execStream(`printf %s ${asked}`, { env: { ...ctx.env } });
        let out = "";
        for await (const line of stream.lines) out += line;
        await stream.exited;
        onEvent({ type: "session.start", sessionId });
        const result = { status: "completed", text: out } as const;
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });

  const localRuntime = (adapters: Record<string, HarnessAdapterFactory>): { rt: Runtime; root: string } => {
    const root = tmp("wsp-doctor-local-");
    roots.push(root);
    return {
      root,
      // The provider module of a host with no key: a local road that reaches it would refuse rather than pass.
      rt: createRuntime({
        backend: new NoProviderBackend(),
        store: memoryStore(),
        adapters,
        local: {
          backend: new LocalBackend({ root }),
          execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
          home: () => join(root, ".claude"),
          homeDir: root,
          rootsPath: join(root, "roots"),
          env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
          platform: hostPlatform(),
          copier: copyingFake(),
        },
        hostId: "box:h1",
      }),
    };
  };

  const record = (): CliIO & { lines: string[] } => {
    const lines: string[] = [];
    return { lines, log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
  };

  it("makes this computer a workspace, runs a thread on it, reads the reply back, and leaves the state as it found it", async () => {
    const { rt } = localRuntime({ claude: scripted() });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("doctor: proving a thread on this computer, with no machine and nothing billing");
    expect(out).toContain("Claude Code 9.9.9");
    expect(out).toContain("Claude Code answered with the word it was asked for");
    expect(out).toContain("the workspace, the project and the folder this run made are gone");
    expect(out).toContain("DOCTOR PASS: this computer is a workspace, a thread ran on it and its reply came back.");
    expect(out).not.toContain("latest release");
    // The doctor left nothing behind: the state has no more workspaces than it started with.
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });

  it("the word it asks for is fresh each run, so a reply that carries it was written by this run's turn", () => {
    const first = localPrompt("wsp-aaaaaa");
    expect(first).toBe("Reply with exactly this word and nothing else: wsp-aaaaaa");
    expect(localPrompt("wsp-bbbbbb")).not.toBe(first);
  });

  it("a workspace this host already holds is the one it runs on, and it stays afterwards", async () => {
    const { rt } = localRuntime({ claude: scripted() });
    const held = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(0);
    expect(io.lines.join("\n")).toContain("mac (already here)");
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([held.id]);
    await rt.close();
  });

  it("with no agent describing itself here it fails with what each one said, and takes back the workspace it made", async () => {
    const { rt } = localRuntime({ claude: scripted({ probe: { refused: "not signed in" } }) });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(1);
    expect(io.lines.join("\n")).toContain("DOCTOR FAIL: no agent on this computer described itself (Claude Code: not signed in)");
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });

  it("a reply that does not carry the word fails the run rather than passing on a turn that said anything", async () => {
    const wrong: HarnessAdapterFactory = () => ({
      steers: false,
      probeCatalog: async () => ({ version: "9.9.9", models: [], efforts: [], permissionModes: [] }),
      start: ({ onEvent }) => {
        const sessionId = "22222222-2222-4222-8222-222222222222";
        const result = { status: "completed", text: "sure thing" } as const;
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    });
    const { rt } = localRuntime({ claude: wrong });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(1);
    expect(io.lines.join("\n")).toContain('DOCTOR FAIL: the reply did not carry the word this run asked for: "sure thing"');
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });

  it("a turn the agent refused fails the run with the refusal's own sentence: it is the turn's error, and a refusal carries no reply to read", async () => {
    const refused: HarnessAdapterFactory = () => ({
      steers: false,
      probeCatalog: async () => ({ version: "9.9.9", models: [], efforts: [], permissionModes: [] }),
      start: ({ onEvent }) => {
        const sessionId = "33333333-3333-4333-8333-333333333333";
        const result = { status: "failed", error: `Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`, refusal: "sign-in" } as const;
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 1, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    });
    const { rt } = localRuntime({ claude: refused });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(1);
    expect(io.lines.join("\n")).toContain(`DOCTOR FAIL: the turn ended failed: Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`);
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });
});
