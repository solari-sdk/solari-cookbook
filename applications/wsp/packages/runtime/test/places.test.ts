// SPDX-License-Identifier: AGPL-3.0-only
// The host's side of a place: the handshake a joining computer takes, the
// records and links the door holds, the workspace a join records, and the two
// ops a person's own socket reaches. The signatures here are real ed25519
// ones, so what the door verifies is what a place would send.
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
  NO_PLACE_INSTALLER,
  PLACE_CODE_REFUSAL,
  PLACE_DOOR_REFUSAL,
  PLACE_DOOR_UNSERVED,
  PLACES_TICKET_REFUSAL,
  deviceHeldRefusal,
  noSignInRefusal,
  SIGN_IN_LINE_REFUSAL,
  AGENTS_KEY_REFUSAL,
  PLACE_LOGIN_REFUSED_KIND,
  PLACE_KEY_REFUSAL,
  PLACE_UNKNOWN_REFUSAL,
  placeRefusalTranscript,
  PLACE_LINK_NONCE_BYTES,
  DAEMON_VERSION,
  PLACE_WORKSPACE_PATH,
  placeBehindLine,
  agentsCell,
  placeDaemonBehind,
  placeWatchesItselfLine,
  forkProcsUnreadLine,
  forkOpRefusedLine,
  placeServesDaemonLine,
  noHostCliLine,
  THREAD_OPS,
  placeDaemonPaths,
  absentComputer,
  placeBuildsNoImageLine,
  placeForksNowhereLine,
  placeCannotBootLine,
  placeNotAWorkspaceLine,
  placeNotAWorkspaceFix,
  workspaceState,
  placeLinkTranscript,
  joinToken,
  readJoinToken,
  JoinMint,
  PAIR_CODE_TTL_MS,
  MINT_JOIN_REFUSAL,
  PLACES_WORDS,
  SSH_HOSTS_REFUSAL,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  placeNoHomeLine,
  placeNoRecipeLine,
  MCP_ID_PREFIX,
  placeProvisionPaths,
  placeProvisioningLine,
  placeStillInstalledLine,
  placeDialBackLine,
  placeWentAwayLine,
  workFolderIn,
  copyStoppedLine,
  NO_IMAGES_HERE,
  probePath,
  twoPlacesRefusal,
  HERE_PLACE_ID,
  noSuchPlaceRefusal,
  providerFoldersRefusal,
  providerAgentsRefusal,
  refusal,
  type HostFolderListing,
  type AgentsSignInEvent,
  type GoldenStageEvent,
  type PlaceBack,
  type PlaceProvision,
  type PlaceProvisionRow,
  type PlaceStageEvent,
  type PlaceReport,
  type PlaceView,
  type TurnResult,
} from "@wsp/protocol";
import { CODEX_TOML, MCP_SERVERS_JSON, TOOL_PREFIX, installEnv, installHomes } from "@wsp/catalog";
import { copyKey, createRuntime, GUEST_LOGIN_ENV, wiredPlace, type GoldenRecipe, type HarnessAdapterFactory, type HostFolders, type PlaceBackends, type Runtime } from "../src/runtime.js";
import { removeScript } from "../src/project-landing.js";
import { COPY_RECIPE, dfOk, recipeWith } from "./image-fixtures.js";
import { HANDSHAKE, MCP_READ_MARK, NoProviderBackend, SERVER_MARK, keyFingerprint, type Machine, type MachineBackend, type ProvisionPlan } from "@wsp/engine";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret } from "@wsp/keys";
import { NO_PLACE_UPDATER, PROVISION_HOST_STOPPED, PlaceAddTakenBackError, PlaceLoginRefusedError, PlaceProvisioningError, type PlaceBackHolder, type PlaceRecord, newPlaceKeyPair, signInsOf, placeLoginRoadLine, placeSweptOverLinkLine, placeSweptOverSshLine, type PlaceDialler, type PlaceInstallRequest, type PlaceKeyPair, type PlaceLeaveRequest, type PlaceLeaver, type PlaceLogin, type PlaceProvisioner, type PlaceUpdateRequest, type PlaceUpdater, type PlaceWiring } from "../src/places.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { NO_AGENTS_READER, type AgentsActs, type AgentsOn, type AgentsReader, type ServerIcons, type ServersActs, type SkillsActs } from "../src/agents-read.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

let srv: RuntimeServer | undefined;
let runtime: Runtime | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await srv?.close();
  srv = undefined;
  await runtime?.close();
  runtime = undefined;
});

/** The addresses a joining computer is told to dial, as the host's own door answers them: the install is handed
 * them rather than reading them a second time. */
const DOOR = ["http://192.168.1.20:4400"];

const HERE = { name: "zingzys-mac", os: "macOS 15.0", shape: { cpu: 8, memMb: 16384 }, engine: "docker" as const };

function wiring(hostKey: PlaceKeyPair, provider?: { id: string; rateUsdPerHour: number }, update?: PlaceUpdater): PlaceWiring {
  return { hostKey, provider: () => provider, here: () => HERE, hostName: () => "zingzys-mac", ...(update === undefined ? {} : { update }) };
}

const report = (name = "old-macbook", over: Partial<PlaceReport> = {}): PlaceReport => ({
  name,
  platform: "linux",
  arch: "x64",
  os: "Ubuntu 24.04",
  shape: { cpu: 4, memMb: 4096 },
  diskFreeBytes: 831 * 1024 * 1024 * 1024,
  login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
  runsWorkspaces: true,
  engine: "none",
  daemonVersion: 17,
  agents: [],
  wsp: ["/home/maya/.npm-global/bin/wsp"],
  dialed: "http://192.168.1.20:14621",
  ...over,
});

async function serving(opts: { provider?: { id: string; rateUsdPerHour: number }; store?: Store; relinkWaitMs?: number; update?: PlaceUpdater; updateWaitMs?: number; leave?: PlaceLeaver; vault?: Record<string, string>; folders?: HostFolders; agentsReader?: AgentsReader; agentsActs?: AgentsActs; skillsActs?: SkillsActs; serversActs?: ServersActs; serverIcons?: ServerIcons } = {}, serve: { log?: (line: string) => void } = {}): Promise<{ hostKey: PlaceKeyPair; store: Store }> {
  const store = opts.store ?? memoryStore();
  const hostKey = newPlaceKeyPair();
  runtime = createRuntime({
    backend: stubBackend(),
    store,
    adapters: {},
    ...(opts.vault === undefined ? {} : { vault: () => opts.vault! }),
    ...(opts.agentsReader === undefined ? {} : { agentsReader: opts.agentsReader }),
    ...(opts.agentsActs === undefined ? {} : { agentsActs: opts.agentsActs }),
    ...(opts.skillsActs === undefined ? {} : { skillsActs: opts.skillsActs }),
    ...(opts.serversActs === undefined ? {} : { serversActs: opts.serversActs }),
    ...(opts.serverIcons === undefined ? {} : { serverIcons: opts.serverIcons }),
    placeLinks: { ...wiring(hostKey, opts.provider, opts.update), ...(opts.leave === undefined ? {} : { leave: opts.leave }) },
    ...(opts.relinkWaitMs !== undefined ? { placeRelinkWaitMs: opts.relinkWaitMs } : {}),
    ...(opts.updateWaitMs !== undefined ? { placeUpdateWaitMs: opts.updateWaitMs } : {}),
  });
  srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, ...(opts.folders === undefined ? {} : { folders: opts.folders }), ...(serve.log === undefined ? {} : { log: serve.log }) });
  return { hostKey, store };
}

/** A code minted over the host's own socket, which is the only road to one. */
async function code(): Promise<string> {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const issued = await c.request("pair.issue");
  c.close();
  expect(issued.ok, String(issued["error"])).toBe(true);
  return issued["code"] as string;
}

const nonce = (): string => randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
const signWith = (pem: string, bytes: Uint8Array): string => sign(null, bytes, createPrivateKey(pem)).toString("base64");

/** The computer's half of the key agreement, the one helper both the join and the relink speak it through: the
 * ephemeral that rides frame one, and the seal every frame from the prove on travels inside once the host has
 * answered with its own. */
function agreeing(): { ephemeral: string; sealFrom: (client: WsClient, placeId: string, reply: Record<string, unknown>) => void } {
  const mine = freshEphemeral();
  return {
    ephemeral: mine.publicKey,
    sealFrom: (client, placeId, reply) => {
      client.seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, String(reply["ephemeral"])), placeId), "place");
    },
  };
}

/** One join, as a computer would make it: the frame, the check of the host's own signature, and the prove. */
async function join(
  hostKey: PlaceKeyPair,
  opts: { code: string; name?: string; client?: { name: string }; report?: PlaceReport; proveReport?: PlaceReport; expectProved?: boolean; answers?: (c: WsClient) => void } = { code: "" },
): Promise<{ client: WsClient; placeId: string; reply: Record<string, unknown>; proved: Record<string, unknown>; pair: PlaceKeyPair }> {
  const client = await WsClient.connect(srv!.port);
  // What this computer answers is on the socket before the handshake is: the host may send its first frame the
  // moment the prove lands, and a computer that only starts listening afterwards would miss it.
  opts.answers?.(client);
  const pair = newPlaceKeyPair();
  const mine = nonce();
  const sent = opts.report ?? report(opts.name);
  const agreed = agreeing();
  const reply = await client.request("place.join", { publicKey: pair.publicKey, nonce: mine, ephemeral: agreed.ephemeral });
  if (reply.ok !== true) return { client, placeId: "", reply, proved: {}, pair };
  const placeId = String(reply["placeId"]);
  expect(reply["hostPublicKey"]).toBe(hostKey.publicKey);
  agreed.sealFrom(client, placeId, reply);
  const proved = await client.request("place.prove", {
    signature: signWith(pair.privateKeyPem, placeLinkTranscript("place", placeId, String(reply["nonce"]), mine, { challenger: String(reply["ephemeral"]), answerer: agreed.ephemeral })),
    // The second frame carries a report of its own, which a computer may send with anything in it, and the code
    // this join spends: both ride inside the seal, after the host proved the key the join line named.
    report: opts.proveReport ?? sent,
    code: opts.code,
    ...(opts.client === undefined ? {} : { client: opts.client }),
  });
  if (opts.expectProved !== false) expect(proved.ok, String(proved["error"])).toBe(true);
  return { client, placeId, reply, proved, pair };
}

/** A place that already joined, dialling in again: the handshake it runs on every attempt. */
async function relink(
  hostKey: PlaceKeyPair,
  placeId: string,
  pair: PlaceKeyPair,
  sent: PlaceReport = report(),
  answers?: (c: WsClient) => void,
): Promise<{ client: WsClient; proved: Record<string, unknown> }> {
  const client = await WsClient.connect(srv!.port);
  answers?.(client);
  const mine = nonce();
  const agreed = agreeing();
  const challenged = await client.request("place.auth", { placeId, nonce: mine, ephemeral: agreed.ephemeral });
  expect(challenged.ok, String(challenged["error"])).toBe(true);
  expect(challenged["hostPublicKey"]).toBe(hostKey.publicKey);
  agreed.sealFrom(client, placeId, challenged);
  const proved = await client.request("place.prove", {
    signature: signWith(pair.privateKeyPem, placeLinkTranscript("place", placeId, String(challenged["nonce"]), mine, { challenger: String(challenged["ephemeral"]), answerer: agreed.ephemeral })),
    report: sent,
  });
  return { client, proved };
}

/** The same store with a timer in front of every read and write, as a store on a disk or behind a network has:
 * the loop turns inside each of them, which is where a handover that is not order-safe drops a frame. */
function yielding(inner: Store): Store {
  const soon = (): Promise<void> => new Promise(done => setTimeout(done, 30));
  return {
    get: async (c, id) => (await soon(), inner.get(c, id)),
    put: async (c, id, v) => (await soon(), inner.put(c, id, v)),
    list: async c => (await soon(), inner.list(c)),
    keys: async c => (await soon(), inner.keys(c)),
    delete: async (c, id) => (await soon(), inner.delete(c, id)),
    getBlob: async (c, id) => (await soon(), inner.getBlob(c, id)),
    putBlob: async (c, id, b) => (await soon(), inner.putBlob(c, id, b)),
    deleteBlob: async (c, id) => (await soon(), inner.deleteBlob(c, id)),
    shape: async () => (await soon(), inner.shape()),
  };
}

const placesOf = async (): Promise<PlaceView[]> => {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const answer = await c.request("places.list");
  c.close();
  expect(answer.ok, String(answer["error"])).toBe(true);
  return answer["places"] as PlaceView[];
};

describe("a code spent by a road that proves itself another way", () => {
  it("spends once: the second spend is false, whatever asks", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const issued = await runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await runtime.devices.spend(issued.code, 1)).toBe(true);
    expect(await runtime.devices.spend(issued.code, 2)).toBe(false);
  });

  it("still admits a device on a fresh code and refuses a spent one, which is one code store for both roads", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const first = await runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await runtime.devices.redeem(first.code, "a laptop", 1)).toBeDefined();
    expect(await runtime.devices.redeem(first.code, "a laptop", 2)).toBeUndefined();
    const second = await runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await runtime.devices.spend(second.code, 1)).toBe(true);
    expect(await runtime.devices.redeem(second.code, "a laptop", 2)).toBeUndefined();
  });

  it("refuses a code that ran out, and spends it either way so one guess never gets two tries", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const issued = await runtime.devices.issue({ now: 0, ttlMs: 10 });
    expect(await runtime.devices.spend(issued.code, 100)).toBe(false);
    expect(await runtime.devices.spend(issued.code, 5)).toBe(false);
  });
});

describe("a computer joining", () => {
  it("is recorded on a host nothing has asked a verb of yet, which is every host a place dials as it starts", async () => {
    // The records are read lazily, on the first verb; a place dials on its own and asks for none, so the roads it
    // reaches wait on that one reading rather than finding an empty host.
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const first = await join(hostKey, { code: await code() });
    sockets.push(first.client.ws);
    // A second host over the same store, asked nothing, still sees the name the first one recorded.
    await srv.close();
    await runtime.close();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const second = await join(hostKey, { code: await code() });
    sockets.push(second.client.ws);
    expect(second.placeId).toMatch(/^p_[0-9a-f]{16}$/);
    expect((await placesOf()).filter(p => p.name === "old-macbook")).toHaveLength(2);
  });

  it("spends the code, records the place with its key and report, marks it default, and records no workspace of its own", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    expect(placeId).toMatch(/^p_[0-9a-f]{16}$/);
    const places = await placesOf();
    const row = places.find(p => p.id === placeId)!;
    expect(row).toMatchObject({ kind: "computer", name: "old-macbook", default: true, takesForks: true, os: "Ubuntu 24.04", present: true });
    expect(row.shape).toEqual({ cpu: 4, memMb: 4096 });
    // The computer is a place, not a workspace: nothing is on the sidebar or in wsp workspaces until a fork lands.
    expect(await runtime!.workspaces.list()).toEqual([]);
  });

  it("refuses a computer whose kernel cannot boot the image, in the doctor's own sentence, and writes no record for it", async () => {
    const { hostKey, store } = await serving();
    const blocked = "this computer's kernel has no overlay filesystem, which a workspace here reads this computer's own directories through";
    // The report crosses on the prove, inside the seal, so that is where a computer that cannot boot is turned
    // down: nothing of it was read before this host had proved the key the join line named.
    const { client, proved } = await join(hostKey, { code: await code(), report: report("laptop", { runsWorkspaces: false, workspacesBlocked: blocked }), expectProved: false });
    sockets.push(client.ws);
    expect(String(proved["error"])).toBe(placeCannotBootLine("laptop", blocked));
    expect((await placesOf()).filter(p => p.id !== "here")).toEqual([]);
    expect(await store.list("places")).toEqual([]);
  });

  it("names a word that is a place and not a workspace with the road to a workspace there, rather than calling it missing", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // What wsp run <place> and wsp exec <place> meet: both resolve their target through this one reading.
    await expect(runtime!.workspaces.resolve("old-macbook")).rejects.toThrow(placeNotAWorkspaceLine("old-macbook"));
    await expect(runtime!.workspaces.resolve("old-macbook")).rejects.toThrow(placeNotAWorkspaceFix("old-macbook"));
  });

  it("refuses a code this host is not holding, in the one sentence every reason reads as", async () => {
    const { hostKey } = await serving();
    const { client, proved } = await join(hostKey, { code: "NOTACODE", expectProved: false });
    expect(String(proved["error"])).toContain("wsp add");
    expect(proved).toMatchObject({ ok: false, error: PLACE_CODE_REFUSAL, kind: "auth" });
    expect(await client.closed()).toBe(4401);
  });

  it("refuses a code a second time, so a spent code is worth nothing", async () => {
    const { hostKey } = await serving();
    const spent = await code();
    const first = await join(hostKey, { code: spent });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: spent, expectProved: false });
    expect(second.proved).toMatchObject({ ok: false, error: PLACE_CODE_REFUSAL });
    expect(await placesOf()).toHaveLength(2); // this computer and the one place that did join
  });

  it("refuses a report whose home is not a plain path, before the code is spent", async () => {
    const { hostKey } = await serving();
    const fresh = await code();
    const bad = await join(hostKey, { code: fresh, report: report("old-macbook", { login: { HOME: "/home/maya; rm -rf /" } }), expectProved: false });
    expect(bad.proved.ok).toBe(false);
    expect(String(bad.proved["error"])).toContain("not a plain path");
    // The code was not spent by a join that was never going to stand.
    const good = await join(hostKey, { code: fresh });
    sockets.push(good.client.ws);
    expect(good.placeId).not.toBe("");
  });

  it("writes no record and spends no code for a join whose prove this host refused, so nothing of it is left behind", async () => {
    const { hostKey, store } = await serving();
    const fresh = await code();
    const slipped = await join(hostKey, {
      code: fresh,
      report: report("old-macbook", { login: { HOME: "/home/m; rm -rf /", USER: "maya", PATH: "/usr/bin" } }),
      expectProved: false,
    });
    expect(slipped.proved).toMatchObject({ ok: false });
    expect(String(slipped.proved["error"])).toContain("not a plain path");
    expect(await slipped.client.closed()).toBe(4401);
    // The record is written on the prove and on nothing before it, so a join answered and never proved leaves no
    // place standing and no code spent.
    expect(await store.list("places")).toEqual([]);
    expect((await placesOf()).filter(p => p.id !== "here")).toEqual([]);
    const good = await join(hostKey, { code: fresh });
    sockets.push(good.client.ws);
    expect(good.placeId).not.toBe("");
  });

  it("refuses the same report on a relink, and the workspace keeps the login it had", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    const again = await relink(hostKey, joined.placeId, joined.pair, report("old-macbook", { login: { HOME: "/home/m; rm -rf /", USER: "maya", PATH: "/usr/bin" } }));
    expect(again.proved).toMatchObject({ ok: false });
    expect(String(again.proved["error"])).toContain("not a plain path");
    expect(await again.client.closed()).toBe(4401);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.present).toBe(false);
    expect((await runtime!.places!.reportOf(joined.placeId))!.login["HOME"]).toBe("/home/maya");
  });

  it("keeps the name this computer joined under, whatever a later report calls itself", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), name: "old-macbook" });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    // A box whose own place file a hostile process edited: it relinks under the name of another computer on this
    // host, and everything that names that word would follow it.
    const again = await relink(hostKey, joined.placeId, joined.pair, report("attic-server"));
    expect(again.proved.ok, String(again.proved["error"])).toBe(true);
    sockets.push(again.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.name).toBe("old-macbook");
    // The rest of the report is the newest one all the same: the name is the one field a relink cannot move.
    expect((await runtime!.places!.reportOf(joined.placeId))!.name).toBe("attic-server");
    await expect(runtime!.places!.placeFor("attic-server")).rejects.toThrow(/no place named attic-server/);
    expect(await runtime!.places!.placeFor("old-macbook")).toEqual({ placeId: joined.placeId });
  });

  it("refuses a word two computers on this host answer to, with both ids, and lands nothing on either", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code(), name: "old-macbook" });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: await code(), name: "old-macbook" });
    sockets.push(second.client.ws);
    // Both joined under the word, which is the person's own doing and not a name one of them took; ids tell them
    // apart, so every road that resolves the word says so rather than taking whichever joined first.
    await expect(runtime!.places!.placeFor("old-macbook")).rejects.toThrow(twoPlacesRefusal("old-macbook", [first.placeId, second.placeId]));
    expect(await runtime!.places!.placeFor(second.placeId)).toEqual({ placeId: second.placeId });
  });

  it("keeps a report's PATH and store folders only where they are plain paths, as the ssh read does", async () => {
    const { hostKey } = await serving();
    const sent = report("old-macbook", {
      login: { HOME: "/home/maya", USER: "maya", PATH: "/home/maya/bin:/usr/bin:/opt/a b", CLAUDE_CONFIG_DIR: "/tmp/x; rm -rf /" },
    });
    const joined = await join(hostKey, { code: await code(), report: sent });
    sockets.push(joined.client.ws);
    const kept = await runtime!.places!.reportOf(joined.placeId);
    expect(kept!.login["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(kept!.login["PATH"]).toBe("/home/maya/bin:/usr/bin");
    expect(kept!.login["HOME"]).toBe("/home/maya");
  });

  it("records a second computer under a name another place already holds, since a place is no workspace and ids tell them apart", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: await code() });
    sockets.push(second.client.ws);
    expect(second.reply["notice"]).toBeUndefined();
    expect((await placesOf()).filter(p => p.name === "old-macbook").map(p => p.id).sort()).toEqual([first.placeId, second.placeId].sort());
    expect(await runtime!.workspaces.list()).toEqual([]);
  });
});

describe("a place dialling back in", () => {
  it("answers a signature this computer can check against the host's key over the transcript it challenged with", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    const again = await WsClient.connect(srv!.port);
    sockets.push(again.ws);
    const mine = nonce();
    const agreed = agreeing();
    const answer = await again.request("place.auth", { placeId, nonce: mine, ephemeral: agreed.ephemeral });
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["hostPublicKey"]).toBe(hostKey.publicKey);
    const { verify } = await import("node:crypto");
    const ok = verify(
      null,
      placeLinkTranscript("host", placeId, mine, String(answer["nonce"]), { challenger: agreed.ephemeral, answerer: String(answer["ephemeral"]) }),
      { key: Buffer.from(hostKey.publicKey, "base64"), format: "der", type: "spki" },
      Buffer.from(String(answer["signature"]), "base64"),
    );
    expect(ok).toBe(true);
  });

  it("refuses an id this host holds no place by, with its own key over the sentence it refused with", async () => {
    const { hostKey } = await serving();
    const c = await WsClient.connect(srv!.port);
    const mine = nonce();
    const answer = await c.request("place.auth", { placeId: "p_deadbeefdeadbeef", nonce: mine });
    expect(answer).toMatchObject({ ok: false, error: PLACE_UNKNOWN_REFUSAL, kind: "auth" });
    // The word is this host's own and the computer that dialled can prove it: the key it pinned at join over the
    // place it named, the nonce it challenged with and the sentence. That is what earns it the long wait.
    expect(answer["hostPublicKey"]).toBe(hostKey.publicKey);
    const { verify } = await import("node:crypto");
    const stands = (bytes: Uint8Array): boolean =>
      verify(null, bytes, { key: Buffer.from(hostKey.publicKey, "base64"), format: "der", type: "spki" }, Buffer.from(String(answer["signature"]), "base64"));
    expect(stands(placeRefusalTranscript("p_deadbeefdeadbeef", mine, PLACE_UNKNOWN_REFUSAL))).toBe(true);
    expect(stands(placeRefusalTranscript("p_deadbeefdeadbeef", nonce(), PLACE_UNKNOWN_REFUSAL))).toBe(false);
    expect(await c.closed()).toBe(4401);
  });

  it("refuses a prove signed over the wrong transcript, and attaches nothing", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    first.client.close();
    const other = newPlaceKeyPair();
    const c = await WsClient.connect(srv!.port);
    const mine = nonce();
    const agreed = agreeing();
    const challenged = await c.request("place.auth", { placeId: first.placeId, nonce: mine, ephemeral: agreed.ephemeral });
    agreed.sealFrom(c, first.placeId, challenged);
    const bad = await c.request("place.prove", {
      // Signed with a key this host never learned, which is what a place file copied off a computer would carry.
      signature: signWith(other.privateKeyPem, placeLinkTranscript("place", first.placeId, String(challenged["nonce"]), mine, { challenger: String(challenged["ephemeral"]), answerer: agreed.ephemeral })),
      report: report(),
    });
    expect(bad).toMatchObject({ ok: false, error: PLACE_KEY_REFUSAL });
    expect(await c.closed()).toBe(4401);
  });

  it("refuses a computer whose wsp agrees no key for the link, in the sentence its row already carries, and attaches nothing", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    sockets.push(joined.client.ws);
    const behind = await WsClient.connect(srv!.port);
    // A daemon older than the seal sends no half of the key agreement: every frame after the handshake would
    // travel where whoever carries the bytes reads it.
    const answer = await behind.request("place.auth", { placeId: joined.placeId, nonce: nonce() });
    expect(answer.ok).toBe(false);
    expect(String(answer["error"])).toContain("is behind");
    expect(await behind.closed()).toBe(4401);
    // The link the join opened is the one this host still holds: nothing of the older dial replaced it.
    expect((await placesOf()).find(p => p.id === joined.placeId)!.present).toBe(true);
  });

  it("takes every frame the computer sends the moment its prove is answered, over a store whose reads and writes yield", async () => {
    // A store on a disk or behind a network turns the loop inside every read and write. The daemon sends its
    // hello the moment its prove is answered, so a handover that let the loop turn between the door's listener
    // and the link's own would lose that frame, leave the two counters a frame apart and close the link on the
    // next one. A memory store hides it by answering inside its own async method.
    const { hostKey } = await serving({ store: yielding(memoryStore()) });
    const joined = await join(hostKey, { code: await code() });
    sockets.push(joined.client.ws);
    joined.client.say({ type: "daemon.hello", root: "/root", version: 17 });
    joined.client.say({ type: "daemon.hello", root: "/root", version: 17 });
    // One more once the record writes are done and the link's own listener certainly stands: a frame lost in the
    // gap leaves this one sealed at a counter the host is not at, which is what ends the link.
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    joined.client.say({ type: "daemon.hello", root: "/root", version: 17 });
    // Nothing closed the link: every frame opened under the key, in the order they were sent.
    const ended = await Promise.race([joined.client.closed(), new Promise<number>(done => setTimeout(() => done(-1), 400))]);
    expect(ended).toBe(-1);
  });

  it("seals every frame after the handshake both ways, and ends a socket that sends one in the clear", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    sockets.push(joined.client.ws);
    // The reply to the prove was binary and opened under the key both ends agreed: the client read it, which is
    // what the prove standing means. A frame in the clear after it is a carrier writing into the link.
    const straight = await WsClient.connect(srv!.port);
    const agreed = agreeing();
    const challenged = await straight.request("place.auth", { placeId: joined.placeId, nonce: nonce(), ephemeral: agreed.ephemeral });
    expect(challenged.ok).toBe(true);
    agreed.sealFrom(straight, joined.placeId, challenged);
    // Sent past the seal, as a carrier on the path of the bytes would send it.
    straight.ws.send(JSON.stringify({ id: 9, op: "place.prove", signature: Buffer.alloc(64, 1).toString("base64"), report: report() }));
    expect(await straight.closed()).toBe(4401);
  });

  it("refuses a second frame that is not the prove, and a prove on a socket that challenged nothing", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    const wrongOrder = await WsClient.connect(srv!.port);
    const agreed = agreeing();
    const challenged = await wrongOrder.request("place.auth", { placeId: joined.placeId, nonce: nonce(), ephemeral: agreed.ephemeral });
    // Everything after the host's reply is sealed, the refusal of a frame that is not the prove among it.
    agreed.sealFrom(wrongOrder, joined.placeId, challenged);
    const answer = await wrongOrder.request("status.list");
    expect(answer.ok).toBe(false);
    expect(await wrongOrder.closed()).toBe(4401);

    const bare = await WsClient.connect(srv!.port);
    const straight = await bare.request("place.prove", { signature: Buffer.alloc(64, 1).toString("base64"), report: report() });
    expect(straight.ok).toBe(false);
    expect(await bare.closed()).toBe(4401);
  });
});

describe("the socket a place proved", () => {
  it("stops being a client's: a runtime frame sent after the prove is never answered", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // The place door holds this socket now, and what it reads are daemon frames; the runtime answers nothing. The
    // op asked is one that answers off this process alone, so silence is the door and never a read that hung.
    const raced = await Promise.race([client.request("capabilities.get"), new Promise<"silence">(done => setTimeout(() => done("silence"), 300))]);
    expect(raced).toBe("silence");
    // And a socket nothing handed over answers it at once, so the silence above is this socket's and not the op's.
    const mine = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(mine.ws);
    expect((await mine.request("capabilities.get")).ok).toBe(true);
  });

  it("is replaced by a newer link for the same place, since a laptop that slept dials before the old socket is known to be dead", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    const closed = first.client.closed();
    // A second link proves with the key on record: the same handshake, a fresh socket. The door cuts the first.
    const { client: again } = await relink(hostKey, first.placeId, first.pair);
    sockets.push(again.ws);
    expect(await closed).toBe(1000);
    expect((await placesOf()).find(p => p.id === first.placeId)!.present).toBe(true);
  });

  it("moves the login a turn there runs under onto what the newest link reported", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    // The person installed a tool under their home and restarted the agent: the next link is where wsp learns it.
    const moved = report("old-macbook", { login: { HOME: "/home/maya-moved", USER: "maya", PATH: "/home/maya/.npm-global/bin:/usr/bin" }, shape: { cpu: 8, memMb: 8192 } });
    const again = await WsClient.connect(srv!.port);
    sockets.push(again.ws);
    const mine = nonce();
    const agreed = agreeing();
    const challenged = await again.request("place.auth", { placeId: joined.placeId, nonce: mine, ephemeral: agreed.ephemeral });
    agreed.sealFrom(again, joined.placeId, challenged);
    const proved = await again.request("place.prove", {
      signature: signWith(joined.pair.privateKeyPem, placeLinkTranscript("place", joined.placeId, String(challenged["nonce"]), mine, { challenger: String(challenged["ephemeral"]), answerer: agreed.ephemeral })),
      report: moved,
    });
    expect(proved.ok, String(proved["error"])).toBe(true);
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.shape).toEqual({ cpu: 8, memMb: 8192 });
    // The record reads the newest login, so every path a fork there is built from moved with it.
    await until(async () => (await runtime!.places!.reportOf(joined.placeId))!.login["HOME"] === "/home/maya-moved");
  });

  it("marks the place absent when the socket goes, and moves its last seen", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    expect((await placesOf()).find(p => p.id === placeId)!.present).toBe(true);
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    expect((await placesOf()).find(p => p.id === placeId)!.lastSeenAt).toBeDefined();
  });
});

/** A place answering machine.backend with the facts this test hands it, counting the asks: the facts belong to
 * the daemon that answered, so a test can move the answer between dials the way an update does. Its capacity is
 * answered too, since a computer whose facts are on the record is asked for that at every listing. */
const saysItsFacts = (facts: () => Record<string, unknown>, asks: { count: number }, afterMs = 0) => (c: WsClient): void => {
  c.onFrame(raw => {
    const frame = raw as unknown as { id?: number; op?: string };
    if (frame.op === "machine.capacity") {
      const room = { cores: 4, memMb: 8192, memRoomMb: 4096, machineMemMb: 4096, diskFreeBytes: 10 * 1024 ** 3, images: [], machines: { running: 0, paused: 0 } };
      c.say({ id: frame.id, ok: true, ...room });
      return;
    }
    if (frame.op !== "machine.backend") return;
    asks.count += 1;
    // `afterMs` is a computer that takes a moment to answer, which is what makes a road that reads the row
    // without waiting for it read a row that has not got it yet.
    const answer = (): void => c.say({ id: frame.id, ok: true, ...facts() });
    if (afterMs === 0) answer();
    else setTimeout(answer, afterMs).unref?.();
  });
};

/** Where a computer keeps the logins its workspaces share, as its daemon reports one. */
const LOGINS = "/var/lib/wsp/logins";

describe("what a computer says it forks with", () => {
  it("is asked once per computer, and asked again when it dials back on another daemon, so a field the version before it never carried lands on the row", async () => {
    const { hostKey } = await serving();
    const asks = { count: 0 };
    let logins: string | undefined;
    const answers = saysItsFacts(() => ({ ...PLACE_FACTS, ...(logins === undefined ? {} : { logins }) }), asks);
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), report: behind, answers });
    sockets.push(client.ws);
    // The first attach asks, and what that daemon said is kept: it shares no logins, so the row carries none.
    await until(async () => runtime!.places!.offerOf(placeId) === PLACE_FACTS.offer);
    expect(asks.count).toBe(1);
    expect((await placesOf()).find(p => p.id === placeId)!.logins).toBeUndefined();

    // A dial on the same daemon is the same computer saying the same thing: nothing is asked again.
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const same = await relink(hostKey, placeId, pair, behind, answers);
    sockets.push(same.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    expect(asks.count).toBe(1);

    // It takes the daemon this host deploys and dials back on it, and that one shares its logins.
    logins = LOGINS;
    same.client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const newer = await relink(hostKey, placeId, pair, report("old-macbook", { daemonVersion: DAEMON_VERSION }), answers);
    sockets.push(newer.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.logins === LOGINS);
    expect(asks.count).toBe(2);
    // The backend a fork there stands on reads the same answer, which is what fills a create's shares.
    expect(runtime!.places!.backendOf(placeId)?.logins).toBe(LOGINS);
  });

  it("is read over the link a join has just opened, so the row an install answers with already says where that computer keeps its logins", async () => {
    const hostKey = newPlaceKeyPair();
    const asks = { count: 0 };
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          const { client } = await join(hostKey, {
            code: readJoinToken(req.code).code,
            name: "box",
            answers: saysItsFacts(() => ({ ...PLACE_FACTS, logins: LOGINS }), asks),
          });
          sockets.push(client.ws);
          return { name: "box" };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@10.0.0.9", name: "box", hostUrls: DOOR }, Date.now());
    // Before the add answers, not behind it: the sign-in the join offers next reads this field off the row.
    expect(added.place.logins).toBe(LOGINS);
    expect(asks.count).toBe(1);
  });

});

describe("a channel to the daemon on a computer you own", () => {
  it("rides the link that computer opened: the frame goes up it, the answer comes back under the ask, and what it pushes reaches the socket that asked", async () => {
    const { hostKey } = await serving();
    const asked: Record<string, unknown>[] = [];
    // The computer answers the pty frames the host sends it, as its own daemon would, and pushes one chunk back.
    const answers = (c: WsClient): void => {
      c.onFrame(raw => {
        const frame = raw as unknown as Record<string, unknown>;
        const op = frame["op"];
        if (typeof op !== "string" || !op.startsWith("pty.")) return;
        asked.push(frame);
        c.say({ id: frame["id"], ok: true, ptyId: "pty_7" });
        c.say({ type: "pty.data", ptyId: "pty_7", data: "Open https://auth.openai.com/device" });
      });
    };
    const { client, placeId } = await join(hostKey, { code: await code(), answers });
    sockets.push(client.ws);
    const mine = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(mine.ws);
    const opened = await mine.request("daemon.open", { placeId });
    expect(opened.ok, String(opened["error"])).toBe(true);
    const channel = String(opened["channel"]);
    const sent = await mine.request("daemon.send", { channel, frame: { op: "pty.create", cols: 80, rows: 24, env: { CODEX_HOME: "/var/lib/wsp/logins/codex" } } });
    expect(sent["reply"]).toMatchObject({ ok: true, ptyId: "pty_7" });
    // The frame reached that computer whole, the environment the sign-in runs with included.
    expect(asked.at(-1)).toMatchObject({ op: "pty.create", cols: 80, env: { CODEX_HOME: "/var/lib/wsp/logins/codex" } });
    await until(async () => mine.events.some(e => e.type === "daemon.event" && e["channel"] === channel && String((e["event"] as Record<string, unknown>)["data"]).includes("auth.openai.com")));
    // One daemon per channel: naming both, or neither, is the caller not saying which.
    expect((await mine.request("daemon.open", { placeId, workspaceId: "w_1" })).ok).toBe(false);
    expect((await mine.request("daemon.open", {})).ok).toBe(false);
    // The computer going away ends the channel, since whatever was running behind it is no longer reachable.
    client.close();
    await until(async () => mine.events.some(e => e.type === "daemon.closed" && e["channel"] === channel));
    // And a computer that is not connected has no channel to open at all.
    expect(String((await mine.request("daemon.open", { placeId }))["error"])).toContain("old-macbook");
  });

  it("is the host's own road: a socket let in on a ticket is refused, as it is for every other places op", async () => {
    const { hostKey } = await serving();
    const { placeId } = await join(hostKey, { code: await code() });
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(host.ws);
    const issued = await host.request("ticket.issue", { purpose: "connect" });
    expect(issued.ok, String(issued["error"])).toBe(true);
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    const refused = await ticketed.request("daemon.open", { placeId });
    expect(refused.ok).toBe(false);
    expect(refused["error"]).toBe(PLACES_TICKET_REFUSAL);
  });
});

describe("what stands for each agent on a computer you own", () => {
  const withAgents = (over: Partial<PlaceReport> = {}) => report("spoo", { agents: ["claude", "codex"], ...over });

  it("reads a login off the files that computer listed, else the vault's variable, else nothing", () => {
    const signedIn = signInsOf(withAgents({ logins: ["codex/auth.json"] }), {});
    // Codex signed in on the box itself: that file is what every workspace there shares.
    expect(signedIn).toEqual({ claude: "none", codex: "signed-in" });
    // Claude Code keeps no login on a machine at all, so the vault's token or key is the whole of its sign-in there.
    expect(signInsOf(withAgents({ logins: [] }), { ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({ claude: "vault-key", codex: "none" });
    expect(signInsOf(withAgents({ logins: [] }), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" })).toEqual({ claude: "vault-key", codex: "none" });
    expect(signInsOf(withAgents({ logins: [] }), { OPENAI_API_KEY: "sk-x" })).toEqual({ claude: "none", codex: "vault-key" });
    // A login on the computer wins over a key this host holds, which is the order a turn there is handed.
    expect(signInsOf(withAgents({ logins: ["codex/auth.json"] }), { OPENAI_API_KEY: "sk-x" })?.codex).toBe("signed-in");
    // A folder with no file under it is no login: the name the row shares is what has to be there.
    expect(signInsOf(withAgents({ logins: ["gemini/oauth_creds.json"] }), {})?.codex).toBe("none");
  });

  it("says nothing at all about a computer whose daemon lists no logins, which is unknown and not none", () => {
    expect(signInsOf(withAgents(), {})).toBeUndefined();
  });

  it("puts the versions that computer reported and the word for each agent on its row", async () => {
    const { hostKey } = await serving({ vault: { ANTHROPIC_API_KEY: "sk-ant-x" } });
    const sent = withAgents({ logins: [], agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" } });
    const { client } = await join(hostKey, { code: await code(), report: sent });
    const row = (await placesOf()).find(p => p.name === "spoo")!;
    expect(row.agentVersions).toEqual(sent.agentVersions);
    expect(row.signIns).toEqual({ claude: "vault-key", codex: "none" });
    expect(agentsCell(row)).toBe("claude 2.1.270 your key, codex 0.153.0 not signed in");
    client.close();
  });

  it("leaves both off the row of a computer running a daemon older than they are", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code(), report: withAgents() });
    const row = (await placesOf()).find(p => p.name === "spoo")!;
    expect(row.agentVersions).toBeUndefined();
    expect(row.signIns).toBeUndefined();
    client.close();
  });
});

describe("the list of every place", () => {
  it("puts this computer first, the computers joined after it and the provider last, with exactly one default", async () => {
    const { hostKey } = await serving({ provider: { id: "box", rateUsdPerHour: 0.018 } });
    const first = await join(hostKey, { code: await code(), name: "box" });
    sockets.push(first.client.ws);
    const places = await placesOf();
    expect(places.map(p => p.kind)).toEqual(["computer", "computer", "provider"]);
    expect(places[0]).toMatchObject({ id: "here", name: HERE.name, present: true, takesForks: false });
    expect(places.at(-1)).toMatchObject({ id: "box", kind: "provider", rateUsdPerHour: 0.018, takesForks: true });
    expect(places.filter(p => p.default)).toHaveLength(1);
    expect(places.find(p => p.default)!.id).toBe(first.placeId);
  });

  it("falls back to this computer as the default when the place the mark named is gone", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    const removed = await remove(joined.placeId);
    expect(removed["removed"]).toBe(true);
    const places = await placesOf();
    expect(places.find(p => p.default)!.id).toBe("here");
  });

  it("notes a login a sign-in at a terminal landed on that computer, so the listing says signed in before it dials again", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), report: report("srv", { agents: ["codex"], logins: [] }) });
    sockets.push(joined.client.ws);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.signIns?.["codex"]).toBe("none");
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    expect(await host.request("places.loginLanded", { placeId: joined.placeId, agent: "codex" })).toMatchObject({ ok: true });
    host.close();
    expect((await placesOf()).find(p => p.id === joined.placeId)!.signIns?.["codex"]).toBe("signed-in");
  });

  it("is refused on a socket let in on a ticket, and is no op a thread may send", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv!.port, { ticket });
    expect(await relayed.request("places.list")).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.remove", { placeId: "p_1" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.add", { address: "root@10.0.0.9" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.dial", { placeId: "p_1" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.loginLanded", { placeId: "p_1", agent: "codex" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    relayed.close();
    expect(THREAD_OPS).not.toContain("places.list");
    expect(THREAD_OPS).not.toContain("places.remove");
    expect(THREAD_OPS).not.toContain("places.add");
  });
});

/** A computer that answers the frames a remove sends it: the reads of what wsp merged into the agents' own files
 * there, which on a computer with no list beside its job come back with nothing to take, and the sweep with what
 * its own leave took. */
function answersLeave(client: WsClient, swept: readonly string[], asked?: string[]): void {
  client.onFrame(raw => {
    const frame = raw as unknown as { id?: number; op?: string };
    if (frame.op === "exec") return void client.say({ id: frame.id, ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false });
    if (frame.op !== "place.leave") return;
    asked?.push("place.leave");
    client.say({ id: frame.id, ok: true, swept: [...swept] });
  });
}

async function remove(placeId: string): Promise<Record<string, unknown>> {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const answer = await c.request("places.remove", { placeId });
  c.close();
  return answer;
}

describe("moving a place onto the daemon this host deploys", () => {
  /** What the host's own updater does, in miniature: the binary in parts over the link the place is holding, each
   * under one upload id with the sha256 of the whole, and the path the place answered with. An update that asks
   * for no binary answers no landing, as the host's own does: what it runs there instead is wsp's login files,
   * which is the host's road and not this one's. */
  const overTheLink = (bytes: Uint8Array, asked: { req: PlaceUpdateRequest }[]): PlaceUpdater => async req => {
    asked.push({ req });
    if (!req.daemon) return undefined;
    const half = Math.ceil(bytes.length / 2);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let at = "";
    for (const [seq, part] of [bytes.subarray(0, half), bytes.subarray(half)].entries()) {
      const answer = await req.link!.request("place.update", { uploadId: "u1", seq, last: seq === 1, data: Buffer.from(part).toString("base64"), sha256 });
      at = typeof answer["at"] === "string" ? answer["at"] : at;
    }
    return { road: "link", at };
  };

  /** A place that takes the parts as the daemon does: appended in order, and the last one answered with where the
   * binary landed. What it was sent is kept so the test can read the whole of it back. */
  const takesParts = (landed: Buffer[], sent: { sha256: string[]; uploads: string[] }) => (c: WsClient): void => {
    c.onFrame(raw => {
      const frame = raw as unknown as { id?: number; op?: string; data?: string; sha256?: string; uploadId?: string; last?: boolean };
      if (frame.op !== "place.update") return;
      landed.push(Buffer.from(String(frame.data), "base64"));
      sent.sha256.push(String(frame.sha256));
      sent.uploads.push(String(frame.uploadId));
      c.say({ id: frame.id, ok: true, ...(frame.last === true ? { at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" } : {}) });
    });
  };

  const update = async (placeId: string): Promise<Record<string, unknown>> => {
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const answer = await c.request("places.update", { placeId });
    c.close();
    return answer;
  };

  it("puts the binary over the link as bytes, and the row reads the new version once that computer dials back on it", async () => {
    const binary = Buffer.from("a daemon built for this box's chip, twice as long as one part");
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(binary, asked), updateWaitMs: 5_000 });
    const landed: Buffer[] = [];
    const sent = { sha256: [] as string[], uploads: [] as string[] };
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), report: behind, answers: takesParts(landed, sent) });
    sockets.push(client.ws);

    // The computer restarts its agent on the new binary and dials back saying so, which is what the wait is for.
    const back = setTimeout(() => {
      client.close();
      void relink(hostKey, placeId, pair, report("old-macbook", { daemonVersion: DAEMON_VERSION })).then(({ client: fresh }) => sockets.push(fresh.ws));
    }, 200);
    back.unref?.();
    const answer = await update(placeId);

    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["name"]).toBe("old-macbook");
    // The daemon half of the reply; the recipe half beside it is this host's own and nothing is wired for it here.
    expect(answer["daemon"]).toMatchObject({ from: DAEMON_VERSION - 1, to: DAEMON_VERSION, road: "link", at: "/home/maya/.wsp/daemon/wsp-daemon" });
    // The row a person reads says it too, and says nothing about being behind any more.
    const row = (await placesOf()).find(p => p.id === placeId)!;
    expect(row.daemonVersion).toBe(DAEMON_VERSION);

    // The binary arrived whole, in order, as bytes on the link and never as a command: two parts under one upload
    // id, each carrying the sha256 of the whole, and what landed is byte for byte what was sent.
    expect(landed).toHaveLength(2);
    expect(Buffer.concat(landed)).toEqual(binary);
    expect(new Set(sent.uploads)).toEqual(new Set(["u1"]));
    expect(new Set(sent.sha256)).toEqual(new Set([createHash("sha256").update(binary).digest("hex")]));
    // The updater is told what the place said about itself, which is how the chip is picked, and handed the link.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.req.report.arch).toBe("x64");
    expect(asked[0]!.req.name).toBe("old-macbook");
  });

  it("is asked again by an update, so the row it answers with carries the new daemon's facts rather than none", async () => {
    const asks = { count: 0 };
    let logins: string | undefined;
    // The facts come back a moment after they are asked for, as a real computer's do: a row read without waiting
    // for that answer is a row the update printed before the new daemon had said anything.
    const answers = (landed: Buffer[], sent: { sha256: string[]; uploads: string[] }) => (c: WsClient): void => {
      takesParts(landed, sent)(c);
      saysItsFacts(() => ({ ...PLACE_FACTS, ...(logins === undefined ? {} : { logins }) }), asks, 600)(c);
    };
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon for this box"), asked), updateWaitMs: 5_000 });
    const landed: Buffer[] = [];
    const sent = { sha256: [] as string[], uploads: [] as string[] };
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), report: behind, answers: answers(landed, sent) });
    sockets.push(client.ws);
    await until(async () => runtime!.places!.offerOf(placeId) === PLACE_FACTS.offer);
    expect((await placesOf()).find(p => p.id === placeId)!.logins).toBeUndefined();

    // The computer restarts its agent on the binary the update landed and dials back on the new daemon, which
    // shares its logins where the one before it shared none.
    logins = LOGINS;
    const back = setTimeout(() => {
      client.close();
      void relink(hostKey, placeId, pair, report("old-macbook", { daemonVersion: DAEMON_VERSION }), answers(landed, sent)).then(({ client: fresh }) => sockets.push(fresh.ws));
    }, 200);
    back.unref?.();
    const answer = await update(placeId);
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["daemon"]).toMatchObject({ to: DAEMON_VERSION });
    // The row read straight after the update carries them: the sign-in on that computer is the next thing a
    // person runs, and it reads this field.
    expect((await placesOf()).find(p => p.id === placeId)!.logins).toBe(LOGINS);
  });

  it("answers what the row still reads, with the reason, when the computer has not come back on it inside the wait", async () => {
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon"), asked), updateWaitMs: 300 });
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId } = await join(hostKey, { code: await code(), report: behind, answers: takesParts([], { sha256: [], uploads: [] }) });
    sockets.push(client.ws);
    const answer = await update(placeId);
    expect(answer.ok, String(answer["error"])).toBe(true);
    // Nothing failed: the binary landed and the row moves on the computer's next link, which the note says.
    expect(answer["daemon"]).toMatchObject({ to: DAEMON_VERSION - 1 });
    expect(String((answer["daemon"] as { note?: unknown }).note)).toContain("had not dialled back on it within");
  });

  it("picks up no byte for a place already running this daemon, and refuses one this host does not hold", async () => {
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon"), asked) });
    const level = report("old-macbook", { daemonVersion: DAEMON_VERSION });
    const { client, placeId } = await join(hostKey, { code: await code(), report: level });
    sockets.push(client.ws);
    const answer = await update(placeId);
    // The update is the road the recipe is put on again, so a computer that is current is not refused: it takes
    // the recipe alone, and nothing here is wired to put one on.
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["daemon"]).toBeUndefined();
    expect(answer["provision"]).toBeUndefined();
    // The updater is asked all the same, since wsp's login files there are this host's to spell; it is told no
    // binary goes with this one, and picks up none.
    expect(asked.map(a => a.req.daemon)).toEqual([false]);
    const nowhere = await update("p_nothing");
    expect(nowhere.ok).toBe(false);
    expect(String(nowhere["error"])).toContain("p_nothing");
  });

  it("hands back the updater's own refusal for a computer that is away, on an update that carries no binary", async () => {
    // What the host's own updater does with the road it has not got: a computer joined by a code holds no ssh
    // login, so an ask that arrives with neither a link nor one is refused there rather than run nowhere.
    const asked: { req: PlaceUpdateRequest }[] = [];
    const away = "srv is not connected and this wsp has no login for it";
    const { hostKey } = await serving({
      update: async req => {
        asked.push({ req });
        if (req.link === undefined && req.ssh === undefined) throw new Error(away);
        return undefined;
      },
    });
    const level = report("srv", { daemonVersion: DAEMON_VERSION });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: level });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === false);
    const answer = await update(placeId);
    // The person reads the road's own sentence and the recipe is not started behind it: a computer that is off
    // takes neither wsp's login files nor its recipe until it is back.
    expect(answer.ok).toBe(false);
    expect(answer["error"]).toBe(away);
    expect(asked.map(a => a.req.daemon)).toEqual([false]);
  });

  it("says so plainly on a host wired with no road to put a daemon on a computer", async () => {
    const { hostKey } = await serving();
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId } = await join(hostKey, { code: await code(), report: behind });
    sockets.push(client.ws);
    const answer = await update(placeId);
    expect(answer.ok).toBe(false);
    expect(answer["error"]).toBe(NO_PLACE_UPDATER);
  });
});

describe("taking a place back out", () => {
  it("asks the linked place to sweep itself, drops the workspace standing on it, and answers what came off", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // The place answers place.leave with what its own sweep took; the host never guesses that list.
    answersLeave(client, ["the systemd user unit", "/home/maya/.wsp/place.json"]);
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(answer["swept"]).toEqual(["the systemd user unit", "/home/maya/.wsp/place.json"]);
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });

  it("takes the servers wsp merged into the agents' own files there back out before it asks that computer to leave", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    const home = report().login["HOME"]!;
    const config = `${home}/.codex/config.toml`;
    const theirs = ['[projects."/root/repo"]', 'trust_level = "trusted"', ""];
    const text = [...theirs, "[mcp_servers.context7]", 'command = "npx"', ""].join("\n");
    const digest = createHash("sha256").update(CODEX_TOML.entryOf(text, "context7")!).digest("hex");
    // What that computer answers the two long reads of the unmerge with, in the order it makes them: the key
    // lines of the list beside its job, then the file that key sits in.
    const reads = [`${SERVER_MARK}\t${digest}\t${MCP_ID_PREFIX}codex/context7`, `${MCP_READ_MARK} 0 0 ${Buffer.from(text).toString("base64")}`];
    /** One poll of a detached run, as a guest answers it: the exit code, the output so far, and the run gone. */
    const polled = (out: string): string => ["WSP_POLL", "0", Buffer.from(`${out}\n`).toString("base64"), "", "down", "WSP_POLL_END"].join("\n");
    const order: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { id?: number; op?: string; cmd?: string };
      const say = (body: Record<string, unknown>): void => client.say({ id: frame.id, ok: true, ...body });
      if (frame.op === "exec") {
        const cmd = String(frame.cmd);
        order.push(cmd);
        const stdout = cmd.includes(HANDSHAKE.launched) ? `${HANDSHAKE.launched}\n` : cmd.includes("WSP_POLL") ? polled(reads.shift() ?? "") : "";
        return say({ exitCode: 0, stdout, stderr: "", truncated: false });
      }
      if (frame.op === "place.leave") {
        order.push("place.leave");
        say({ swept: [`${home}/.wsp`] });
      }
    });

    const answer = await remove(placeId);
    // What came out of the agent's own file is said beside what the place's own sweep took.
    expect(answer["swept"]).toEqual([`context7 (out of ${config})`, `${home}/.wsp`]);
    // And the file was written back over the link before the leave took the folder holding the list.
    const wrote = order.findIndex(cmd => cmd.includes(`f='${config}'`) && cmd.includes('mv -f "$n" "$r"'));
    expect(wrote, order.join("\n")).toBeGreaterThanOrEqual(0);
    expect(wrote).toBeLessThan(order.indexOf("place.leave"));
  });

  it("says the agent is still installed when the place was not connected to sweep", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(answer["swept"]).toEqual([]);
    expect(String(answer["note"])).toContain("wsp leave on that computer");
  });

  it("answers that nothing was removed for an id this host holds no place by", async () => {
    await serving();
    expect(await remove("p_deadbeefdeadbeef")).toMatchObject({ removed: false });
  });

  it("never logs in to a computer that joined by typing a code, which this host holds no login for", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const { hostKey } = await serving({
      leave: async req => {
        asked.push(req);
        return [];
      },
    });
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(asked).toEqual([]);
    expect(String(answer["note"])).toBe(placeStillInstalledLine("old-macbook"));
  });
});

describe("taking a place back out over the login the install used", () => {
  /** A computer this host put the agent on over ssh and then stopped hearing from: its record carries that login
   * and no link, which is the box a remove has to reach itself. */
  const installedAndSilent = async (leave?: PlaceLeaver): Promise<{ placeId: string; store: Store }> => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    let joined = "";
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // The shape a box that stops calling home has: its own join opens a socket and closes it while the
          // install is still running, and nothing dials this host afterwards.
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "vps", report: report("vps") });
          joined = placeId;
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          client.close();
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
          return { name: "vps", ssh: "root@65.21.4.12", sshKeyPath: "/Users/lena/.ssh/hetzner" };
        },
        ...(leave === undefined ? {} : { leave }),
      },
      placeJoinWaitMs: 60,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await expect(runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now())).rejects.toThrow(placeNoLinkLine("vps"));
    return { placeId: joined, store };
  };

  it("runs the leave over that login, keeps the record until it answered, and says which road it took", async () => {
    const asked: PlaceLeaveRequest[] = [];
    let answer = (): void => {};
    const answered = new Promise<void>(done => (answer = done));
    const took = ["systemd system unit wsp-place-1234abcd.service (stopped)", "/home/maya/.wsp/place.json"];
    const { placeId, store } = await installedAndSilent(async req => {
      asked.push(req);
      await answered;
      return took;
    });
    const removing = runtime!.places!.remove(placeId);
    await until(() => asked.length === 1);
    // Still this host's while the leave runs: a box that refuses halfway is one a person can still name and try
    // again, and a record dropped first would leave the agent on it with nothing here to reach it by.
    expect(await store.get("places", placeId)).toBeDefined();
    answer();
    const removed = await removing;
    expect(asked[0]!.ssh).toEqual({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    // The line that runs wsp on that computer rides with it, off the last thing it said about itself.
    expect(asked[0]!.report.wsp).toEqual(report("vps").wsp);
    expect(removed.swept).toEqual(took);
    expect(removed.note).toBe(placeSweptOverSshLine("vps", "root@65.21.4.12"));
    expect(await store.get("places", placeId)).toBeUndefined();
  });

  it("keeps the sentence a person has always read where the box will not answer the login, and still lets it go", async () => {
    // The refusal the road throws when the login itself would not stand, which is the one it throws for that
    // alone: nothing ran on that computer, so nothing of it is said to have.
    const { placeId, store } = await installedAndSilent(async () => {
      throw new PlaceLoginRefusedError("ssh: connect to host 65.21.4.12 port 22: Connection refused");
    });
    const removed = await runtime!.places!.remove(placeId);
    expect(removed.removed).toBe(true);
    expect(removed.swept).toEqual([]);
    expect(removed.note).toBe(placeStillInstalledLine("vps"));
    expect(await store.get("places", placeId)).toBeUndefined();
  });

  it("says the leave ran there and stopped in that computer's own words, which is not the same as a login that would not stand", async () => {
    const said = "vps ran the leave and had not finished it within 180s";
    const { placeId } = await installedAndSilent(async () => {
      throw new Error(said);
    });
    const removed = await runtime!.places!.remove(placeId);
    // The login stood and the leave ran: how far it got is that computer's to say, and a line reading that it did
    // not answer would be telling a person something that did not happen.
    expect(removed.note).toBe(`${placeLoginRoadLine("vps", "root@65.21.4.12", said)}; ${placeStillInstalledLine("vps")}`);
    expect(removed.note).not.toContain("did not answer the login");
    expect(removed.note).toContain(said);
  });

  it("says the agent is still installed on a host wired with no road to log in to one", async () => {
    const { placeId } = await installedAndSilent();
    const removed = await runtime!.places!.remove(placeId);
    expect(removed.swept).toEqual([]);
    expect(removed.note).toBe(placeStillInstalledLine("vps"));
  });

  /** The same box, still dialling this host: its record carries the install's login and the link is up, which is
   * the computer a remove used to sweep over the link alone. The box it holds is that computer's own socket, for
   * a test that has to drop the link mid-remove the way the stop on it does. */
  const installedAndLinked = async (
    leave: PlaceLeaver,
    over: { box?: WsClient; dial?: PlaceDialler } = {},
  ): Promise<{ placeId: string; overLink: string[]; askedOverLink: string[]; store: Store }> => {
    const hostKey = newPlaceKeyPair();
    const askedOverLink: string[] = [];
    const overLink = ["/home/maya/.wsp/place.json", "/home/maya/.wsp/daemon-token"];
    const store = memoryStore();
    let joined = "";
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        ...(over.dial === undefined ? {} : { dial: over.dial }),
        install: async req => {
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "vps", report: report("vps") });
          joined = placeId;
          over.box = client;
          sockets.push(client.ws);
          // The agent as it answers a leave on the link: it sweeps the files it owns and says what it took.
          answersLeave(client, overLink, askedOverLink);
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          return { name: "vps", ssh: "root@65.21.4.12", sshKeyPath: "/Users/lena/.ssh/hetzner" };
        },
        leave,
      },
      placeJoinWaitMs: 60,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now());
    return { placeId: joined, overLink, askedOverLink, store };
  };

  it("takes that road on a computer that is holding a link too, since what answers there cannot take its own service", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const took = ["systemd system unit wsp-place-1234abcd.service (stopped)", "/home/maya/.wsp/place.json"];
    const { placeId, askedOverLink } = await installedAndLinked(async req => {
      asked.push(req);
      return took;
    });
    const removed = await runtime!.places!.remove(placeId);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.ssh).toEqual({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    // The agent on the link is never asked: its sweep leaves the unit that restarts it, and a second sweep after
    // the box's own leave would be a second copy of what came off.
    expect(askedOverLink).toEqual([]);
    expect(removed.swept).toEqual(took);
    expect(removed.note).toBe(placeSweptOverSshLine("vps", "root@65.21.4.12", true));
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });

  it("falls back to the sweep on the link where that login will not answer, so the files still come off", async () => {
    const { placeId, overLink, askedOverLink } = await installedAndLinked(async () => {
      throw new PlaceLoginRefusedError("ssh: connect to host 65.21.4.12 port 22: Connection refused");
    });
    const removed = await runtime!.places!.remove(placeId);
    expect(askedOverLink).toEqual(["place.leave"]);
    expect(removed.swept).toEqual(overLink);
    // Which road finished it, since the two take different things off: this one left the unit that restarts the
    // agent on that computer, and a person reading the files that came off would have read the rest into it.
    expect(removed.note).toBe(placeSweptOverLinkLine("vps", "root@65.21.4.12"));
  });

  it("lets go of a computer whose own leave dropped the link under it, which is what the stop on that unit does", async () => {
    const took = ["systemd system unit wsp-place-1234abcd.service (stopped)", "/home/maya/.wsp/place.json"];
    const box: { box?: WsClient } = {};
    const { placeId, store, askedOverLink } = await installedAndLinked(async req => {
      // The shape the road makes on a linked box: the leave stops the unit, so the daemon dies and the link drops
      // while this host is still waiting on the answer that comes back over ssh.
      box.box?.close();
      await until(async () => (await placesOf()).find(p => p.id === req.placeId)?.present === false);
      return took;
    }, box);
    const removed = await runtime!.places!.remove(placeId);
    expect(removed.swept).toEqual(took);
    expect(removed.note).toBe(placeSweptOverSshLine("vps", "root@65.21.4.12", true));
    expect(askedOverLink).toEqual([]);
    // The record goes and stays gone: the link's own close handler writes the row it last saw, and a write that
    // landed after the removal would put a place this host no longer holds back in the list.
    expect(await store.get("places", placeId)).toBeUndefined();
    await new Promise(done => setTimeout(done, 200));
    expect(await store.get("places", placeId)).toBeUndefined();
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });

  it("takes the link road at once where the login does not answer the probe, rather than waiting out the leave", async () => {
    let asked = 0;
    const dialled: PlaceLogin[] = [];
    const { placeId, overLink, askedOverLink } = await installedAndLinked(
      async () => {
        asked += 1;
        // A leave the probe should never reach: this one would hold the remove for as long as ssh is black-holed.
        await new Promise(done => setTimeout(done, 5_000));
        return [];
      },
      {
        dial: async login => {
          dialled.push(login);
          throw new Error("ssh: connect to host 65.21.4.12 port 22: Operation timed out");
        },
      },
    );
    const started = Date.now();
    const removed = await runtime!.places!.remove(placeId);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(dialled).toEqual([{ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" }]);
    expect(asked).toBe(0);
    expect(askedOverLink).toEqual(["place.leave"]);
    expect(removed.swept).toEqual(overLink);
    expect(removed.note).toBe(placeSweptOverLinkLine("vps", "root@65.21.4.12"));
  });

  it("carries that computer's own words into the note where the leave ran there and stopped, and still sweeps over the link", async () => {
    const said = "vps ran the leave and did not finish it: Failed to stop: Unit is masked.";
    const { placeId, overLink, askedOverLink } = await installedAndLinked(async () => {
      throw new Error(said);
    });
    const removed = await runtime!.places!.remove(placeId);
    expect(askedOverLink).toEqual(["place.leave"]);
    expect(removed.swept).toEqual(overLink);
    expect(removed.note).toBe(placeSweptOverLinkLine("vps", "root@65.21.4.12", said));
    expect(removed.note).not.toContain("did not answer the login");
  });
});

describe("dialling a computer that stopped answering", () => {
  /** The one road the app's Try now takes, over the person's own socket. */
  const dialled = async (placeId: string): Promise<Record<string, unknown>> => {
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const answer = await c.request("places.dial", { placeId });
    c.close();
    expect(answer.ok, String(answer["error"])).toBe(true);
    return answer;
  };

  it("sends one frame over the link a computer is holding and answers how long it took", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as { id?: number; op?: string };
          if (frame.op === "ping") c.say({ id: frame.id, ok: true });
        }),
    });
    sockets.push(client.ws);
    const answer = await dialled(placeId);
    expect(answer["dialled"]).toMatchObject({ answered: true });
    expect((answer["dialled"] as { roundTripMs: number }).roundTripMs).toBeGreaterThanOrEqual(0);
    expect(String(answer["line"])).toContain("old-macbook answered");
    // The answer is written on the row, so a window opened after the press reads what the press got.
    expect((answer["place"] as PlaceView).dialled).toMatchObject({ answered: true });
  });

  it("logs in over the road the computer was installed on when it is holding no link, and says the computer is on", async () => {
    const hostKey = newPlaceKeyPair();
    const logins: PlaceLogin[] = [];
    let box: WsClient | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12" };
        },
        dial: async login => {
          logins.push(login);
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
    // The login the install used is kept on the row: the join frame the record was made from says nothing about it.
    expect(added.place.road?.ssh).toBe("root@65.21.4.12");
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    const answer = await dialled(added.place.id);
    expect(logins).toEqual([{ ssh: "root@65.21.4.12" }]);
    expect(answer["dialled"]).toMatchObject({ answered: true });
    expect(String(answer["line"])).toContain("the agent on it is not dialling this host");
    // An ssh login that answered is the box speaking and not the agent, so it does not date the silence.
    expect((answer["place"] as PlaceView).present).toBe(false);
  });

  it("dials with the key file the add was given, since every ssh child runs with BatchMode on", async () => {
    const hostKey = newPlaceKeyPair();
    const logins: PlaceLogin[] = [];
    let box: WsClient | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12", ...(req.keyPath === undefined ? {} : { sshKeyPath: req.keyPath }) };
        },
        dial: async login => {
          logins.push(login);
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now());
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    await dialled(added.place.id);
    expect(logins).toEqual([{ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" }]);
    // A path on this computer is the host's business: the row a client reads carries the login and the address the
    // link came from, and never the key file.
    const road = (await placesOf()).find(p => p.id === added.place.id)!.road!;
    expect(road.ssh).toBe("root@65.21.4.12");
    expect(Object.keys(road).sort()).toEqual(["from", "ssh"]);
  });

  it("marks the step an install stopped in with the installer's one sentence and hands back that sentence alone", async () => {
    const hostKey = newPlaceKeyPair();
    const sentence = "spoo took wsp but could not connect back: the host at http://100.129.166.28:4640 did not answer in 20s";
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (_req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          stage("wsp", "done", "x86_64");
          stage("service", "running");
          throw new Error(sentence);
        },
      },
    });
    const stages: PlaceStageEvent[] = [];
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(runtime.places!.add({ address: "root@178.156.161.168", hostUrls: DOOR }, Date.now())).rejects.toThrow(new Error(sentence));
    expect(stages.filter(s => s.state === "failed").map(s => [s.step, s.note])).toEqual([["service", sentence]]);
  });

  it("hands back ssh's own sentence when the login is refused, and keeps it on the row", async () => {
    const hostKey = newPlaceKeyPair();
    let box: WsClient | undefined;
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12" };
        },
        dial: () => Promise.reject(new Error(said)),
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    const answer = await dialled(added.place.id);
    expect(answer["dialled"]).toMatchObject({ answered: false, said });
    expect(String(answer["line"])).toBe(said);
    // And it stands on the row after the press, which is what the sentence under the pane reads back.
    expect((await placesOf()).find(p => p.id === added.place.id)!.dialled).toMatchObject({ said });
  });

  it("drops what the last dial said when the computer dials in again, since a refusal from before it came back is not news", async () => {
    const { hostKey } = await serving();
    const { client, placeId, pair } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await dialled(placeId);
    expect((await placesOf()).find(p => p.id === placeId)!.dialled).toBeDefined();
    const back = await relink(hostKey, placeId, pair);
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    expect((await placesOf()).find(p => p.id === placeId)!.dialled).toBeUndefined();
  });

  it("bounds the dial itself, so a road that hangs rather than refusing still answers the hand that pressed", async () => {
    const hostKey = newPlaceKeyPair();
    let box: WsClient | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeDialWaitMs: 60,
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12" };
        },
        // A road that neither answers nor refuses: an ssh child on a network that swallows the packets.
        dial: () => new Promise<void>(() => {}),
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    const answer = await dialled(added.place.id);
    expect(answer["dialled"]).toMatchObject({ answered: false });
    expect(String((answer["dialled"] as { said: string }).said)).toContain("root@65.21.4.12");
    expect(String(answer["line"])).toContain("was not answered");
  });

  it("says there is no road at all on a computer that joined by typing a code and is holding no link", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const answer = await dialled(placeId);
    expect(answer["dialled"]).toMatchObject({ answered: false });
    expect(String(answer["line"])).toContain("joined by typing a code");
  });

  it("keeps the address a computer dialled in from on its row, which is the only one a code join gives", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.road?.from !== undefined);
    const row = (await placesOf()).find(p => p.id === placeId)!;
    expect(row.road?.from).toMatch(/\d+\.\d+\.\d+\.\d+|::1|127\.0\.0\.1/);
    // And what it last said about itself, for the slots that would otherwise stand at pending while it is away,
    // with the stamp of the report it said it in: the uptime grows while the computer is up, so a row dating it by
    // the last frame would read an old figure as a fresh one.
    expect(row.home).toBe("/home/maya");
    expect(Date.parse(row.reportedAt!)).toBeGreaterThan(0);
  });
});

describe("putting the agent on a computer over ssh", () => {
  it("refuses on a host that wired no road onto a computer it has never met", async () => {
    const { hostKey } = await serving();
    // The wiring this host was served with names no installer, which is every host but the one with the ssh road.
    expect(hostKey).toBeDefined();
    await expect(runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow(NO_PLACE_INSTALLER);
  });

  it("mints a code the computer spends, says what each step is doing, and answers once that computer's link is up", async () => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    const stages: PlaceStageEvent[] = [];
    let handed: PlaceInstallRequest | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          handed = req;
          stage("connect", "done", "Ubuntu 24.04");
          // The computer's own join, with the code the install was handed: the door spends it and the link follows.
          await join(hostKey, { code: readJoinToken(req.code).code, name: "box", report: report("box", { dialed: DOOR[0]! }) });
          return { name: "box", hostKey: "ssh-ed25519 SHA256:abc" };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    // The caller mints the stream, since the steps come back before the reply that would have named it.
    const added = await runtime.places!.add({ addId: "a_mine", address: "root@10.0.0.9", name: "box", hostUrls: DOOR }, Date.now());
    expect(added.place.name).toBe("box");
    expect(added.place.present).toBe(true);
    expect(added.hostKey).toBe("ssh-ed25519 SHA256:abc");
    // The token and every address this host answers on are the door's to hand the installer, not the installer's to
    // find: one word carrying the code the box spends and the fingerprint of the key this host will prove to it.
    expect(handed?.code).toBe(joinToken(readJoinToken(handed!.code).code, keyFingerprint(hostKey.publicKey)));
    expect(readJoinToken(handed!.code).code).toMatch(/^[A-Z0-9]+$/);
    // The door's reading, handed down: the install reads no addresses of its own.
    expect(handed?.hostUrls).toEqual(DOOR);
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["connect done", "join running", "join done"]);
    expect(added.addId).toBe("a_mine");
    expect(stages.every(s => s.addId === "a_mine")).toBe(true);
    // The road its link came in on and the one fact the box's own row does not already carry: a size here as well
    // cuts the line the app draws.
    expect(stages.at(-1)?.note).toBe("at http://192.168.1.20:4400, engine none");
    // The computer is held by the time its join is done, so that step names the row a reader acts on.
    expect(stages.at(-1)?.placeId).toBe(added.place.id);
  });

  it("never says an address the box claims it dialled that this add did not hand it", async () => {
    const hostKey = newPlaceKeyPair();
    const stages: PlaceStageEvent[] = [];
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          await join(hostKey, { code: readJoinToken(req.code).code, name: "box", report: report("box", { dialed: `https://whatever-it-likes.example/${"a".repeat(4000)}` }) });
          return { name: "box" };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await runtime.places!.add({ address: "root@10.0.0.9", name: "box", hostUrls: DOOR }, Date.now());
    expect(stages.find(s => s.step === "join" && s.state === "done")?.note).toBe("engine none");
  });

  it("waits for the link the agent dials, not the socket the join itself opened and closed", async () => {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // What happens on a real computer: its own join dials once, writes its place file and closes that socket,
          // and the unit its join installed is what opens the link a moment later.
          const { client, placeId, pair } = await join(hostKey, { code: readJoinToken(req.code).code, name: "box" });
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          client.close();
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
          setTimeout(() => void relink(hostKey, placeId, pair).then(({ client: link }) => sockets.push(link.ws)), 20);
          return { name: "box" };
        },
      },
      placeJoinWaitMs: 4_000,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    expect(added.place.present).toBe(true);
  });

  it("names the step an install stopped on, and the code it minted opens nothing afterwards", async () => {
    const hostKey = newPlaceKeyPair();
    const stages: PlaceStageEvent[] = [];
    let minted = "";
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          minted = readJoinToken(req.code).code;
          stage("wsp", "running");
          throw new Error("ssh refused the login (publickey)");
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow("publickey");
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["wsp running", "wsp failed"]);
    expect(stages.at(-1)?.note).toContain("publickey");
    // The code went to the box as a file, so the add that failed has spent it and nobody can join with it after.
    expect(await runtime.devices.spend(minted, Date.now())).toBe(false);
  });

  it("draws a failure on the step that was under way, not on a step that only said what it had done", async () => {
    const stages: PlaceStageEvent[] = [];
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          stage("host-key", "done", "ssh-ed25519 SHA256:abc");
          throw new Error("root@spoo runs zsh as root's shell");
        },
      },
    });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(runtime.places!.add({ address: "root@spoo", hostUrls: DOOR }, Date.now())).rejects.toThrow("zsh");
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["connect running", "host-key done", "connect failed"]);
  });

  it("answers a refused login over the wire with the kind the app reads its login fix off, and any other refusal without it", async () => {
    let refuse: Error = new PlaceLoginRefusedError("maya@box: Permission denied (publickey).");
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => Promise.reject(refuse) },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door: { open: async () => ({ port: 4420, addresses: DOOR }) } });
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    expect(await c.request("places.add", { address: "maya@box" })).toMatchObject({ ok: false, error: "maya@box: Permission denied (publickey).", kind: PLACE_LOGIN_REFUSED_KIND });
    refuse = new Error("root@spoo runs zsh as root's shell");
    expect(await c.request("places.add", { address: "root@spoo" })).not.toHaveProperty("kind");
    c.close();
  });

  it("gives up on a computer that took the agent and never dialled, in the sentence that says what to check", async () => {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(hostKey), install: async () => ({ name: "box" }) },
      placeJoinWaitMs: 50,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await expect(runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow(placeNoLinkLine("box"));
  });

  it("puts the agent's own last lines under that sentence, read over the login the install used", async () => {
    const hostKey = newPlaceKeyPair();
    const asked: PlaceLogin[] = [];
    const said = ["https://h645d7f8a8d48cbd6.example could not be dialled: not an http address", "http://100.129.175.77:4420 did not answer in 10s"];
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async () => ({ name: "box", ssh: "root@10.0.0.9", sshKeyPath: "/Users/lena/.ssh/hetzner" }),
        log: async login => {
          asked.push(login);
          return said;
        },
      },
      placeJoinWaitMs: 50,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const stages: PlaceStageEvent[] = [];
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow([placeNoLinkLine("box"), ...said].join("\n"));
    expect(asked).toEqual([{ ssh: "root@10.0.0.9", keyPath: "/Users/lena/.ssh/hetzner" }]);
    // The step's note is one line by construction: a terminal prints it after the step's marker and the sheet puts
    // it in one span, so the box's own lines ride the throw, which both roads print whole.
    expect(stages.at(-1)?.note).toBe(placeNoLinkLine("box"));
  });

  it("says the wait's own sentence and nothing else when the box will not answer the read either", async () => {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async () => ({ name: "box", ssh: "root@10.0.0.9" }),
        log: async () => {
          throw new Error("ssh: connect to host 10.0.0.9 port 22: Connection refused");
        },
      },
      placeJoinWaitMs: 50,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const failed = await runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now()).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(failed?.message).toBe(placeNoLinkLine("box"));
  });

  it("drops the record a join made when the install it landed in failed, since that install took the join back off the box", async () => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    const removed: string[] = [];
    let joined = "";
    const said = "spoo connected back but its agent did not start: systemctl exited 1; nothing this add put on it is left there";
    let taken = true;
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // The join on the box landed and wrote the record; the unit it installed next did not start.
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "spoo", report: report("spoo") });
          sockets.push(client.ws);
          joined = placeId;
          throw taken ? new PlaceAddTakenBackError(said) : new Error(said);
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.removed", e => removed.push((e as { placeId: string }).placeId));
    await expect(runtime.places!.add({ address: "root@spoo", hostUrls: DOOR }, Date.now())).rejects.toThrow(said);
    expect(joined).not.toBe("");
    expect(await store.get("places", joined)).toBeUndefined();
    expect((await placesOf()).some(p => p.id === joined)).toBe(false);
    expect(removed).toEqual([joined]);
    // An install that could not take its join back keeps the record, which is the road a remove sweeps that box by.
    taken = false;
    await expect(runtime.places!.add({ address: "root@spoo", hostUrls: DOOR }, Date.now())).rejects.toThrow(said);
    expect(await store.get("places", joined)).toBeDefined();
    expect(removed).toHaveLength(1);
  });

  it("keeps the login the install used on the record when the computer never dials back, which is the box that needs it most", async () => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    const asked: PlaceUpdateRequest[] = [];
    let joined = "";
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // The shape a box that never comes back has: its own join opens a socket and closes it while the install's
          // ssh command is still running, and the unit that join wrote never dials this host at all.
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "vps", report: report("vps", { daemonVersion: DAEMON_VERSION - 1 }) });
          joined = placeId;
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          client.close();
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
          return { name: "vps", ssh: "root@65.21.4.12", sshKeyPath: "/Users/lena/.ssh/hetzner" };
        },
        update: async req => {
          asked.push(req);
          return { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" };
        },
      },
      placeJoinWaitMs: 60,
      placeUpdateWaitMs: 60,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await expect(runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now())).rejects.toThrow(placeNoLinkLine("vps"));
    // The wait's outcome says nothing about what road this host was handed, so the record holds the login either way.
    const held = (await store.get("places", joined)) as { road?: { ssh?: string; keyPath?: string } };
    expect(held.road).toMatchObject({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    // And the road that puts a daemon on that computer takes it: the one box that needs the update road is the one
    // whose agent could not dial.
    const updated = await runtime.places!.update(joined);
    expect(updated.daemon?.road).toBe("ssh");
    expect(asked.map(r => r.ssh)).toEqual([{ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" }]);
  });

});

describe("the adds this host keeps", () => {
  const door = { open: async () => ({ port: 4420, addresses: DOOR }) };
  const addsOf = async (c: WsClient): Promise<unknown[]> => ((await c.request("places.list")) as { adds?: unknown[] }).adds ?? [];

  it("keeps an add that failed mid-way, its steps, what it said and the fix, for a second client to read off places.list", async () => {
    let go: () => void = () => {};
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          stage("connect", "done", "Ubuntu 24.04");
          stage("wsp", "running");
          await new Promise<void>(ok => (go = ok));
          throw refusal("spoo has no curl or wget on its PATH", "Install one of them there, then add again.");
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    const mine = await WsClient.connect(srv.port, { token: "host-token" });
    const other = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(mine.ws, other.ws);
    const answer = mine.request("places.add", { addId: "a_spoo", address: "root@spoo", sshPort: 2222 });
    await until(async () => (await addsOf(other)).length === 1);
    expect(await addsOf(other)).toEqual([
      expect.objectContaining({ addId: "a_spoo", address: "root@spoo", sshPort: 2222, state: "running", steps: [{ step: "connect", state: "done", note: "Ubuntu 24.04" }, { step: "wsp", state: "running" }] }),
    ]);
    go();
    expect(await answer).toMatchObject({ ok: false, fix: "Install one of them there, then add again." });
    const [job] = (await addsOf(other)) as Record<string, unknown>[];
    expect(job).toMatchObject({
      addId: "a_spoo",
      state: "failed",
      said: "spoo has no curl or wget on its PATH.",
      fix: "Install one of them there, then add again.",
      steps: [{ step: "connect", state: "done", note: "Ubuntu 24.04" }, { step: "wsp", state: "failed", note: "spoo has no curl or wget on its PATH. Install one of them there, then add again." }],
    });
    expect(job).not.toHaveProperty("kind");
    expect(Date.parse(String(job!["startedAt"]))).not.toBeNaN();
  });

  it("keeps the kind a refused login carries, so the app's login fix reads off the record", async () => {
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => Promise.reject(new PlaceLoginRefusedError("maya@box: Permission denied (publickey).")) },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("places.add", { addId: "a_maya", address: "maya@box" });
    expect(await addsOf(c)).toEqual([expect.objectContaining({ addId: "a_maya", state: "failed", said: "maya@box: Permission denied (publickey).", kind: PLACE_LOGIN_REFUSED_KIND, steps: [expect.objectContaining({ step: "connect", state: "failed" })] })]);
  });

  it("marks an add done with the computer it made once that computer has joined", async () => {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          await join(hostKey, { code: readJoinToken(req.code).code, name: "box" });
          return { name: "box" };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    const added = await runtime.places!.add({ addId: "a_box", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(await addsOf(c)).toEqual([expect.objectContaining({ addId: "a_box", state: "done", placeId: added.place.id })]);
  });

  it("keeps no add whose join code was never issued, since nothing would ever end it", async () => {
    const store = memoryStore();
    const put = store.put.bind(store);
    store.put = async (collection, id, value) => (collection === "pairings" ? Promise.reject(new Error("the state file is read-only")) : put(collection, id, value));
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => ({ name: "box" }) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(await c.request("places.add", { addId: "a_ro", address: "root@10.0.0.9" })).toMatchObject({ ok: false, error: "the state file is read-only" });
    expect(await addsOf(c)).toEqual([]);
  });

  it("keeps the box's own lines under a failed add cut to the length a log line keeps, and says each cut", async () => {
    const long = `agent: ${"x".repeat(5_000)}`;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => ({ name: "box", ssh: "root@10.0.0.9" }), log: async () => [long, "agent: dial refused"] },
      placeJoinWaitMs: 50,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    await runtime.places!.add({ addId: "a_box", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now()).catch(() => undefined);
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(c.ws);
    const [job] = (await addsOf(c)) as { said: string }[];
    expect(job!.said.split("\n")).toEqual([placeNoLinkLine("box"), `${long.slice(0, 400)} (cut ${long.length - 400} characters)`, "agent: dial refused"]);
  });

  it("cuts the failed step's note to the length a log line keeps, and says the cut", async () => {
    const long = `root@10.0.0.9: ${"y".repeat(5_000)}`;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          throw new Error(`${long}\nsecond line`);
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    const stages: PlaceStageEvent[] = [];
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("places.add", { addId: "a_long", address: "root@10.0.0.9" });
    const cut = `${long.slice(0, 400)} (cut ${long.length - 400} characters)`;
    const [job] = (await addsOf(c)) as { steps: { note?: string }[] }[];
    expect(job!.steps.at(-1)).toMatchObject({ step: "connect", state: "failed", note: cut });
    expect(stages.at(-1)).toMatchObject({ step: "connect", state: "failed", note: cut });
  });

  it("refuses an add under the id of one still running, and leaves that one's job as it was", async () => {
    let go: () => void = () => {};
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          await new Promise<void>(ok => (go = ok));
          throw new Error("root@10.0.0.9 did not answer on port 22");
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(c.ws);
    const first = c.request("places.add", { addId: "a_one", address: "root@10.0.0.9" });
    await until(async () => (await addsOf(c)).length === 1);
    expect(await c.request("places.add", { addId: "a_one", address: "maya@elsewhere" })).toMatchObject({ ok: false, kind: "usage" });
    expect(await addsOf(c)).toEqual([expect.objectContaining({ addId: "a_one", address: "root@10.0.0.9", state: "running", steps: [{ step: "connect", state: "running" }] })]);
    go();
    await first;
  });

  it("keeps every add still running and the last twenty that finished", async () => {
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => Promise.reject(new Error("root@10.0.0.9 did not answer on port 22")) },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door });
    for (let n = 0; n < 22; n++) await runtime.places!.add({ addId: `a_${n}`, address: "root@10.0.0.9", hostUrls: DOOR }, Date.now()).catch(() => undefined);
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(((await addsOf(c)) as { addId: string }[]).map(j => j.addId)).toEqual(Array.from({ length: 20 }, (_, n) => `a_${n + 2}`));
  });
});


describe("the road a pane takes to a place", () => {
  it("is refused with the place's name while that computer is not connected", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box" });
    client.close();
    await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
    await expect(runtime!.places!.road(placeId)).rejects.toThrow(absentComputer("box", null).sentence);
  });

  it("is refused with its own sentence while that computer has not said which port its daemon bound", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box" });
    await expect(runtime!.places!.road(placeId)).rejects.toThrow(placeNoDaemonPortLine("box"));
  });
});

describe("the port a place's panes ride", () => {
  it("goes with the link that carried it, so nothing is left answering for a computer that is gone", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box", report: report("box", { daemonPort: 4321 }) });
    const port = await runtime!.places!.road(placeId);
    expect(port).toBeGreaterThan(0);
    client.close();
    await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
    await expect(
      new Promise((done, fail) => {
        const socket = netConnect({ port, host: "127.0.0.1" }, () => done(true));
        socket.once("error", fail);
      }),
    ).rejects.toThrow();
  });
});

describe("the device a join buys beside the place", () => {
  it("mints one with no scope, whose token matches and which is listed and revoked as a redeemed one is", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const admitted = await runtime.devices.admit("old-macbook", 1);
    expect(admitted.device.scope).toBeUndefined();
    expect(await runtime.devices.match(admitted.deviceToken)).toMatchObject({ id: admitted.deviceId, name: "old-macbook" });
    expect((await runtime.devices.list()).map(d => d.id)).toContain(admitted.deviceId);
    expect(await runtime.devices.revoke(admitted.deviceId)).toBe(true);
    expect(await runtime.devices.match(admitted.deviceToken)).toBeUndefined();
  });

  it("answers a join that asked for one, names it after the joining computer, and answers none to a join that did not", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code(), client: { name: "old-macbook" } });
    sockets.push(first.client.ws);
    // The token rides the sealed reply to the prove, since the code that bought it crossed on that frame.
    const device = first.proved["device"] as { deviceId: string; deviceToken: string };
    expect(device.deviceToken).toBeTruthy();
    expect(await runtime!.devices.match(device.deviceToken)).toMatchObject({ id: device.deviceId, name: "old-macbook" });
    expect(first.reply["device"]).toBeUndefined();
    const second = await join(hostKey, { code: await code(), name: "attic" });
    sockets.push(second.client.ws);
    expect(second.proved["device"]).toBeUndefined();
  });

  it("leaves the link bound to no device, so revoking that device closes nothing", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), client: { name: "old-macbook" } });
    sockets.push(client.ws);
    const device = (await runtime!.devices.list())[0]!;
    expect(device.name).toBe("old-macbook");
    expect(await runtime!.devices.revoke(device.id)).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect(client.ws.readyState).toBe(client.ws.OPEN);
    expect((await placesOf()).find(p => p.id === placeId)?.present).toBe(true);
  });
});

describe("what a join is told about the wsp it joined", () => {
  it("answers the primary computer's own name off the wiring, and the signature over the transcript still verifies", async () => {
    const { hostKey } = await serving();
    const { client, reply, proved } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    expect(reply["hostName"]).toBe("zingzys-mac");
    expect(proved.ok).toBe(true);
  });
});

describe("the four events a computer you own rides the runtime's stream on", () => {
  it("carries the join with the address it came from, the link coming and going, and the remove", async () => {
    const { hostKey } = await serving();
    const watcher = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await watcher.request("events.subscribe")).ok).toBe(true);
    const { client, placeId } = await join(hostKey, { code: await code() });
    await until(() => watcher.events.some(e => e.type === "place.present"));
    const joined = watcher.events.find(e => e.type === "place.joined")!;
    expect((joined["place"] as PlaceView).id).toBe(placeId);
    expect(String(joined["from"])).toContain("127.0.0.1");
    expect(typeof joined["seq"]).toBe("number");
    expect(watcher.events.find(e => e.type === "place.present")).toMatchObject({ placeId });
    client.ws.close();
    await until(() => watcher.events.some(e => e.type === "place.absent"));
    const remover = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await remover.request("places.remove", { placeId })).ok).toBe(true);
    await until(() => watcher.events.some(e => e.type === "place.removed"));
    expect(watcher.events.filter(e => e.type === "place.removed")).toMatchObject([{ placeId }]);
    remover.close();
    watcher.close();
  });
});

describe("the door a computer you own dials", () => {
  it("is refused on a host that serves none, and answered on one that does", async () => {
    const { hostKey } = await serving();
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const none = await c.request("places.door");
    expect(none).toMatchObject({ ok: false, error: PLACE_DOOR_UNSERVED });
    c.close();
    await srv!.close();
    const view = { port: 4420, addresses: ["http://192.168.1.20:4420"] };
    srv = await serveRuntime(runtime!, { port: 0, authToken: "host-token", devices: runtime!.devices, door: { open: async () => ({ ...view, backPort: 4420 }) } });
    const opened = await WsClient.connect(srv.port, { token: "host-token" });
    const answer = await opened.request("places.door");
    // Where to dial is the host's answer; the key proved there is the place door's own, off the pair it signs with.
    // The port a forward over ssh lands on is this computer's business and stays off the wire.
    expect(answer["door"]).toEqual({ ...view, hostKey: keyFingerprint(hostKey.publicKey) });
    opened.close();
  });

  it("is refused on a socket let in by a ticket, as every other place op is", async () => {
    await serving();
    await srv!.close();
    srv = await serveRuntime(runtime!, { port: 0, authToken: "host-token", devices: runtime!.devices, door: { open: async () => ({ port: 4420, addresses: ["http://x:4420"] }) } });
    const own = await WsClient.connect(srv.port, { token: "host-token" });
    const { ticket } = (await own.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    own.close();
    const relayed = await WsClient.connect(srv.port, { ticket });
    expect(await relayed.request("places.door")).toMatchObject({ ok: false, error: PLACE_DOOR_REFUSAL });
    relayed.close();
  });
});

describe("the join line and the ssh hosts the app asks for", () => {
  const view = { port: 4420, addresses: ["http://192.168.1.20:4420"], relay: "https://p_ab12cd34.singhi.me" };
  const at = Date.parse("2026-09-24T10:00:00.000Z");

  it("mints one code into every line the door and the relay answer on, and the code is the one a join spends", async () => {
    const { hostKey } = await serving();
    await srv!.close();
    srv = await serveRuntime(runtime!, { port: 0, authToken: "host-token", devices: runtime!.devices, door: { open: async () => view }, now: () => at });
    const own = await WsClient.connect(srv.port, { token: "host-token" });
    const answer = await own.request("places.mint");
    own.close();
    expect(answer.ok, String(answer["error"])).toBe(true);
    const minted = JoinMint.parse(answer);
    const token = minted.joins[0]!.line.split(" --code ")[1]!;
    expect(readJoinToken(token).hostKey).toBe(keyFingerprint(hostKey.publicKey));
    expect(minted).toEqual({
      joins: [
        { url: view.addresses[0], line: PLACES_WORDS.sheet.joinLine(view.addresses[0]!, token) },
        { url: view.relay, line: PLACES_WORDS.sheet.joinLine(view.relay, token), note: PLACES_WORDS.sheet.relayNote },
      ],
      expiresAt: new Date(at + PAIR_CODE_TTL_MS).toISOString(),
    });
    // The same mint wsp add spends: the code redeems once, as a pair.issue code does.
    const spending = await WsClient.connect(srv.port);
    expect((await spending.request("pair.redeem", { code: readJoinToken(token).code, name: "laptop" })).ok).toBe(true);
    spending.close();
  });

  it("hands neither a code nor the ssh hosts to a paired computer or a relayed socket", async () => {
    await serving();
    await srv!.close();
    const read: unknown[] = [];
    srv = await serveRuntime(runtime!, {
      port: 0,
      authToken: "host-token",
      devices: runtime!.devices,
      door: { open: async () => view },
      sshHosts: async rows => {
        read.push(rows);
        return [{ alias: "hetzner", hostName: "65.21.4.12", user: "root", from: "config" }];
      },
    });
    const own = await WsClient.connect(srv.port, { token: "host-token" });
    expect(await own.request("places.sshHosts")).toMatchObject({ ok: true, hosts: [{ alias: "hetzner", hostName: "65.21.4.12", user: "root", from: "config" }] });
    expect(read).toHaveLength(1);
    const code = (await own.request("pair.issue"))["code"] as string;
    const { ticket } = (await own.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    own.close();
    const spending = await WsClient.connect(srv.port);
    const { deviceToken } = (await spending.request("pair.redeem", { code, name: "phone" })) as { deviceToken: string };
    spending.close();
    const paired = await WsClient.connect(srv.port, { token: deviceToken });
    expect(await paired.request("places.mint")).toMatchObject({ ok: false, error: deviceHeldRefusal("places.mint") });
    expect(await paired.request("places.sshHosts")).toMatchObject({ ok: false, error: deviceHeldRefusal("places.sshHosts") });
    paired.close();
    const relayed = await WsClient.connect(srv.port, { ticket });
    expect(await relayed.request("places.mint")).toMatchObject({ ok: false, error: MINT_JOIN_REFUSAL });
    expect(await relayed.request("places.sshHosts")).toMatchObject({ ok: false, error: SSH_HOSTS_REFUSAL });
    relayed.close();
    expect(read).toHaveLength(1);
    expect(THREAD_OPS).not.toContain("places.mint");
    expect(THREAD_OPS).not.toContain("places.sshHosts");
  });

  it("refuses a code on a host that serves no door", async () => {
    await serving();
    const own = await WsClient.connect(srv!.port, { token: "host-token" });
    expect(await own.request("places.mint")).toMatchObject({ ok: false, error: PLACE_DOOR_UNSERVED });
    own.close();
  });
});

/** A joined computer that forks: it answers the machine ops on the socket it opened, as the agent on it does, and
 * records what the host asked it for. Nothing here is the server half itself, which lives with the agent; this is
 * one computer's worth of answers, so the runtime's own roads are what the test is reading. */
interface ForkingPlace {
  created: Record<string, unknown>[];
  killed: string[];
  paused: number;
  resumed: number;
  tunnels: { tunnelId: string; port: number }[];
  /** What the next create answers with instead of a machine; cleared after one use. */
  refuseCreate?: { error: string; kind: string; status: number };
  /** What a pull request frame is refused with, for the note a bring back carries beside a landed push. */
  refuseGitPr?: { error: string; code: string };
  /** Every op the host sent, in order. */
  ops: string[];
  /** Every files or git frame the host sent for a workspace on this computer, whole: the workspace named on it is
   * what a case reads. */
  frames: Record<string, unknown>[];
  /** How many times each op was asked. */
  asked: Record<string, number>;
  /** The ask of the machine's own daemon check that first answers yes; every one before it answers no. */
  daemonAnswersAfter: number;
  /** Ops this computer takes and never answers, so a test can close the socket with a frame in flight on it. */
  swallow: Set<string>;
  /** One event up the link, as this computer's daemon pushes one for a workspace on it. */
  push(event: Record<string, unknown>): void;
  /** Holds every resume frame until it is called, for a wake a test wants in flight. */
  holdResumes(): () => void;
}

const PLACE_FACTS = {
  offer: "docker",
  capabilities: {
    liveCloneForks: false,
    pauseMode: "memory",
    replacesMachine: true,
    previewUrls: false,
    signedUrls: false,
    callbackRelay: true,
    diskSnapshots: true,
    images: true,
    snapshotsAnyLife: false,
    snapshotListing: true,
    templates: true,
    kept: false,
    copies: true,
    ownNetwork: true,
    sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }],
  },
  pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
  lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
  baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
};

const PLACE_ROADS = { previewUrl: true, daemonAnswers: true, putBytes: true, describe: true, facts: true, metrics: true };
/** What a computer somebody joined answers about itself once its workspaces are copies of the computer: it keeps
 * no image, so nothing behind an image is offered either. The shape the daemon of this build reports. */
const KEEPS_NO_IMAGE = {
  ...PLACE_FACTS,
  capabilities: { ...PLACE_FACTS.capabilities, images: false, diskSnapshots: false, snapshotsAnyLife: false, snapshotListing: false, templates: false },
  baseTemplates: undefined,
};

/** One sealed version of this host's own image, promoted to a template: what a fork at a provider that keeps
 * images stands on, and the image a create on a computer that keeps none is handed and must not send. */
const SEALED = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", templateId: "tpl_g", baseTemplate: "base", setupSha: "s1", createdAt: "2026-09-16T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }],
};

/** What a computer says about itself that keeps the project checkouts it holds on a disk of its own, and no image,
 * so the work of an add there runs in a copy of its own directories. */
const HOLDS_PROJECTS = { ...KEEPS_NO_IMAGE, projects: "/wsp/projects" };

function forks(
  client: WsClient,
  capacity: {
    cores: number;
    memMb: number;
    memRoomMb: number;
    machineMemMb: number;
    diskFreeBytes: number;
    images: { id: string; sizeBytes: number }[];
    machines: { running: number; paused: number };
  } = {
    cores: 4,
    memMb: 8192,
    memRoomMb: 9000,
    machineMemMb: 4096,
    diskFreeBytes: 10 * 1024 * 1024 * 1024,
    images: [{ id: "sha256:i", sizeBytes: 4 * 1024 * 1024 * 1024 }],
    machines: { running: 1, paused: 0 },
  },
  /** What a command run on a machine there answers; nothing and exit 0 unless the test says. */
  exec: (cmd: string) => { exitCode: number; stdout: string; stderr: string } = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  /** What this computer says it forks with; the default keeps images, which is the shape the copy road is read on. */
  facts: Record<string, unknown> = PLACE_FACTS,
): ForkingPlace {
  let held: ((...args: never[]) => void)[] | undefined;
  const seen: ForkingPlace = {
    created: [],
    killed: [],
    paused: 0,
    resumed: 0,
    tunnels: [],
    ops: [],
    frames: [],
    asked: {},
    daemonAnswersAfter: 1,
    swallow: new Set<string>(),
    push: event => client.say(event),
    holdResumes: () => {
      held = [];
      return () => {
        for (const release of held ?? []) release();
        held = undefined;
      };
    },
  };
  let made = 0;
  let ptys = 0;
  // The container's own word for itself, as a Docker daemon would answer it: a wake reads it before it resumes.
  let state: "running" | "paused" = "running";
  client.onFrame(raw => {
    const frame = raw as unknown as Record<string, unknown>;
    const op = typeof frame["op"] === "string" ? frame["op"] : undefined;
    if (op === undefined) return;
    const id = frame["id"];
    const say = (payload: Record<string, unknown>): void => client.say({ id, ok: true, ...payload });
    const machine = (machineId: string): Record<string, unknown> => ({ machine: { id: machineId, kind: "sandbox", daemonSupervisor: "entrypoint", roads: PLACE_ROADS } });
    // A machine the host killed is gone from that computer, as the daemon there answers: a get or a state read of
    // it is refused as missing, which is what the kill's own wait for gone reads.
    const gone = (machineId: string): boolean => seen.killed.includes(machineId);
    const missing = (machineId: string): void => void client.say({ id, ok: false, error: `no such machine: ${machineId}`, kind: "missing", status: 404 });
    if (op.startsWith("machine.") || op.startsWith("tunnel.")) seen.ops.push(op);
    seen.asked[op] = (seen.asked[op] ?? 0) + 1;
    if (seen.swallow.has(op)) return;
    switch (op) {
      case "machine.backend":
        return say(facts);
      case "machine.capacity":
        return say(capacity);
      case "machine.create": {
        if (seen.refuseCreate !== undefined) {
          const refusal = seen.refuseCreate;
          delete seen.refuseCreate;
          return void client.say({ id, ok: false, ...refusal });
        }
        seen.created.push(frame["spec"] as Record<string, unknown>);
        return say(machine(`k${++made}`));
      }
      case "machine.get":
        return gone(String(frame["machineId"])) ? missing(String(frame["machineId"])) : say(machine(String(frame["machineId"])));
      case "machine.state":
        return gone(String(frame["machineId"])) ? missing(String(frame["machineId"])) : say({ state });
      case "machine.exec":
        return say({ result: exec(String(frame["cmd"])) });
      case "machine.describe":
        return say({ shape: { cpu: 2, memMb: 4096 } });
      case "machine.facts":
        return say({ facts: { os: "Ubuntu 24.04", uptimeMs: 1000, folder: "/root" } });
      case "machine.metrics":
        return say({});
      case "machine.daemonAnswers":
        return say({ answers: (seen.asked[op] ?? 0) >= seen.daemonAnswersAfter });
      case "machine.previewUrl":
        return say({ reach: { url: "http://127.0.0.1:49155", token: "", expiresAt: 1 } });
      case "machine.pause":
        seen.paused++;
        state = "paused";
        return say({});
      case "machine.resume": {
        seen.resumed++;
        state = "running";
        if (held === undefined) return say({});
        held.push(() => say({}));
        return;
      }
      case "machine.kill":
        seen.killed.push(String(frame["machineId"]));
        return say({});
      case "machine.putBytes":
        return say({});
      // A container mints no signed URL, as the Docker machine's own answer says; a nap that would have exported a
      // vault through one reads the refusal and keeps the vault it had.
      case "machine.downloadUrl":
      case "machine.uploadUrl":
        return void client.say({ id, ok: false, error: "a container serves no signed URL" });
      case "tunnel.open":
        seen.tunnels.push({ tunnelId: String(frame["tunnelId"]), port: Number(frame["port"]) });
        return say({});
      case "tunnel.write":
      case "tunnel.close":
        return say({});
      case "exec":
        return say({ exitCode: 0, stdout: "", stderr: "", truncated: false });
      // The workspace's own git, answered by this computer's daemon for the workspace the frame names, which is
      // what a workspace with no daemon of its own is served by.
      case "git.status":
        seen.frames.push(frame);
        return say({ branch: "work", ahead: 0, files: [] });
      // The pane's road: this computer's daemon opens and drives a shell inside the workspace the frame names.
      case "pty.create":
        seen.frames.push(frame);
        return say({ ptyId: `p${++ptys}`, pid: 4242 });
      case "pty.attach":
      case "pty.detach":
      case "pty.write":
      case "pty.resize":
      case "pty.kill":
        seen.frames.push(frame);
        return say({});
      case "pty.list":
        seen.frames.push(frame);
        return say({ ptys: [] });
      case "proc.watch":
      case "proc.unwatch":
      case "proc.kill":
        return say({});
      case "proc.inspect":
        return say({ pid: frame["pid"] });
      case "ping":
      case "fs.list":
      case "fs.read":
      case "git.diff":
      case "git.prState":
      case "guest.watch":
      case "guest.reply":
      case "guest.close":
        seen.frames.push(frame);
        return say({});
      case "git.push":
        seen.frames.push(frame);
        return say({ branch: "work", base: String(frame["base"] ?? ""), remote: "origin", ahead: 1, uncommitted: 0, stat: [" README.md | 2 +-"] });
      case "git.pr": {
        seen.frames.push(frame);
        if (seen.refuseGitPr !== undefined) return void client.say({ id, ok: false, ...seen.refuseGitPr });
        return say({ pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "open", host: "github.com" }, created: true });
      }
      default:
        return;
    }
  });
  return seen;
}

describe("a fork at a provider this host is not wired to", () => {
  /** Two providers over two backends, as the host's own table hands them down: the wired one and one more whose key
   * this computer holds. */
  const twoProviders = (wired: string, at: Record<string, MachineBackend>): PlaceBackends => ({
    get wired() {
      return wired;
    },
    backend: place => at[place],
    list: () => Object.keys(at),
  });

  it("lists every provider whose key this host holds and forks at the one the line names, through that provider's own backend", async () => {
    const solari = stubBackend();
    const box = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const rows = await placesOf();
    expect(rows.filter(p => p.kind === "provider").map(p => p.id)).toEqual(["solari", "box"]);
    for (const row of rows.filter(p => p.kind === "provider")) expect(row.takesForks, row.id).toBe(true);

    // Named on the line: the machine is minted by that provider and the record says where it stands.
    const there = await createOn(runtime, { golden: "snap_g", name: "x", on: "box" });
    expect(box.machines).toHaveLength(1);
    expect(solari.machines).toHaveLength(0);
    expect(there.place).toBe("box");
    expect(await runtime.workspaces.get(there.id)).toMatchObject({ place: "box" });
    // A second workspace of a project on that computer lands there too: the project says where, not a default.
    const again = await createOn(runtime, { golden: "snap_g", name: "y", on: "box" });
    expect(box.machines).toHaveLength(2);
    expect(again.place).toBe("box");

    // A project on the wired provider is the road a record with no place word already takes.
    const here = await createOn(runtime, { golden: "snap_g", name: "z", on: "solari" });
    expect(solari.machines).toHaveLength(1);
    expect(here.place).toBeUndefined();
  });

  it("a project image taken at that provider records the place and is removed there, never at the wired one", async () => {
    const solari = stubBackend();
    const box = stubBackend();
    runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }),
      killConfirm: { graceMs: 40, pollMs: 1 },
    });
    const there = await createOn(runtime, { golden: "snap_g", name: "x", on: "box" });
    const golden = await runtime.workspaces.snapshot(there.id);
    expect(golden.place).toBe("box");
    expect((await runtime.image.get()).projects).toEqual([{ ...golden, sizeBytes: box.snapshotBytes }]);
    // The wired provider answers a delete of an id it never held as a success, which is how a wrong door would pass.
    const wiredDeletes: string[] = [];
    solari.deleteSnapshot = async id => void wiredDeletes.push(id);
    await runtime.golden.removeProject(golden.snapshotId);
    expect(wiredDeletes).toEqual([]);
    expect(box.snapshots).toEqual([]);
    expect(await runtime.golden.projects()).toEqual([]);
  });

  it("carries each provider's own sizes at its own rates on its row, so a picker reads the row it is under", async () => {
    // One list of sizes for every row is what priced a workspace at another provider's rates to the cent: the
    // dialog quoted the wired provider's three sizes under a row that bills nothing. The list is per row on the
    // wire, off the backend this host holds for that row, or a client has nothing to read it from.
    const solari = stubBackend();
    const free = [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }, { cpu: 4, memMb: 8192, rateUsdPerHour: 0 }];
    const made = stubBackend();
    const box: MachineBackend = { ...made, capabilities: { ...made.capabilities, sizes: free } };
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const rows = await placesOf();
    // The wired row reads off the runtime's own backend, the other off the one the table hands back for it.
    expect(rows.find(p => p.id === "solari")!.sizes).toEqual(solari.capabilities.sizes);
    expect(rows.find(p => p.id === "box")!.sizes).toEqual(free);
    // A computer of the person's own offers no pick of its own, so it carries no list rather than an empty one.
    expect(rows.find(p => p.kind === "computer")!.sizes).toBeUndefined();
  });

  it("names every provider it holds when a word names none of them", async () => {
    const solari = stubBackend();
    const box = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await expect(createOn(runtime, { golden: "snap_g", name: "x", on: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*solari.*box/);
  });
});

describe("a fork on a computer you joined", () => {
  it("names no image where that computer keeps none: no template, no snapshot, and nothing of an image read or built there first", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, KEEPS_NO_IMAGE)) });
    sockets.push(client.ws);
    // This host has sealed no image at all, and a computer that keeps none needs none: the create reads no image
    // head and builds no copy of one there before the fork, where the road behind it stopped for want of one.
    const bare = await createOn(runtime, { name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(place.created[0]).not.toHaveProperty("template");
    expect(place.created[0]).not.toHaveProperty("fromSnapshot");
    expect(bare.golden).toBe("");
    expect(await store.get("workspaces", bare.id)).toMatchObject({ golden: "" });
    // And where this host does hold an image, the word the verb hands every create down is dropped rather than
    // sent on to a computer that would refuse it.
    await store.put("goldens", copyKey("solari", "default"), SEALED);
    const named = await createOn(runtime, { golden: "snap_g", name: "y", on: "srv" });
    expect(place.created).toHaveLength(2);
    expect(place.created[1]).not.toHaveProperty("template");
    expect(place.created[1]).not.toHaveProperty("fromSnapshot");
    expect(named.golden).toBe("");
    // Nothing was forked at this host's own provider for either, which is where a copy would have been built.
    expect(backend.machines).toHaveLength(0);
  });

  it("tells a turn there which agents already hold a login on that computer, so the vault's key goes only where none does", async () => {
    const asked: Record<string, boolean>[] = [];
    const factory: HarnessAdapterFactory = ctx => {
      asked.push({ claude: ctx.loginStands("claude"), codex: ctx.loginStands("codex") });
      return {
        steers: false,
        start: ({ onEvent }) => {
          const sessionId = randomUUID();
          const result: TurnResult = { status: "completed", text: "ok" };
          onEvent({ type: "session.start", sessionId });
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
        },
      };
    };
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const signedIn = report("srv", { agents: ["claude", "codex"], logins: ["codex/auth.json"] });
    const { client } = await join(hostKey, { code: await code(), report: signedIn, answers: c => forks(c, undefined, undefined, KEEPS_NO_IMAGE) });
    sockets.push(client.ws);
    const ws = await createOn(runtime, { name: "x", on: "srv" });
    await (await runtime.sessions.start(ws.id, { prompt: "one", harness: "claude" })).finished;
    // Codex signed in there wins over any key this host holds; Claude Code keeps no login on a machine, so the
    // vault is the whole of its sign-in and nothing stands against it.
    expect(asked.at(-1)).toEqual({ claude: false, codex: true });
  });

  it("carries the workspace order and the recipe's knobs into a workspace on that computer, its turns and its commands", async () => {
    const envs: Readonly<Record<string, string>>[] = [];
    const factory: HarnessAdapterFactory = ctx => {
      envs.push(ctx.env);
      return {
        steers: false,
        start: ({ onEvent }) => {
          const sessionId = randomUUID();
          const result: TurnResult = { status: "completed", text: "ok" };
          onEvent({ type: "session.start", sessionId });
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
        },
      };
    };
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: factory },
      places: wiredPlace("solari", backend),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, KEEPS_NO_IMAGE)) });
    sockets.push(client.ws);
    const ws = await createOn(runtime, { name: "x", on: "srv" });

    // The boot: the order that reads the folders no process inside can write before the home every workspace on
    // that computer shares, and every knob the recipe's job installs under, off the catalog's one table.
    const created = place.created[0]!["envs"] as Record<string, string>;
    expect(created["PATH"]).toBe(PLACE_WORKSPACE_PATH);
    expect(created).toMatchObject(installEnv(installHomes(TOOL_PREFIX)));
    expect(created).toMatchObject({ UV_TOOL_DIR: "/opt/wsp/uv/tools", CARGO_HOME: "/opt/wsp/cargo", RUSTUP_HOME: "/opt/wsp/rustup", GOBIN: "/usr/local/bin" });

    // And a turn on it: the adapter exports the same, so a thread there runs the copy under the prefix and the
    // rustup proxy finds its own home.
    await (await runtime.sessions.start(ws.id, { prompt: "one", harness: "claude" })).finished;
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) expect(env).toMatchObject({ PATH: PLACE_WORKSPACE_PATH, ...installEnv(installHomes(TOOL_PREFIX)) });

    // A fork at this host's own provider is a copy of an image sealed on the other order, with each manager's
    // own folders under a home that is root's alone: it takes neither the order nor a knob.
    await createOn(runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.spec.envs).toEqual(GUEST_LOGIN_ENV);
  });

  it("still names the image where the computer keeps them: a fork at this host's own provider carries the template its version was promoted to", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    backend.capabilities.templates = true;
    backend.templates.set("tpl_g", { id: "tpl_g", name: "wsp-default-v1", status: "ready", snapshotId: "snap_g" });
    runtime = createRuntime({ backend, store, adapters: {}, places: wiredPlace("solari", backend), placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await store.put("goldens", copyKey("solari", "default"), SEALED);
    const made = await createOn(runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.spec).toMatchObject({ template: "tpl_g" });
    expect(made.golden).toBe("snap_g");
  });

  it("lands on that computer's backend and not on this host's, and the record and the view say where", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    expect(made.place).toBe(placeId);
    expect((await runtime.workspaces.get(made.id)).place).toBe(placeId);
    expect(await store.get("workspaces", made.id)).toMatchObject({ place: placeId });
    // The place a fork landed on is where the next one lands when nobody says.
    expect((await placesOf()).find(p => p.default)!.id).toBe(placeId);
  });

  it("sends no memory read to a fork there, whose container would count the whole computer, and keeps the size that computer applied", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const sent: string[] = [];
    const exec = (cmd: string) => {
      sent.push(cmd);
      return { exitCode: 0, stdout: cmd.includes("/proc/meminfo") ? "memkb 16384000\n" : "", stderr: "" };
    };
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c, undefined, exec) });
    sockets.push(client.ws);
    const made = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(sent.filter(c => c.includes("/proc/meminfo"))).toEqual([]);
    expect(made).not.toHaveProperty("notice");
    expect(await store.get("workspaces", made.id)).toMatchObject({ size: { cpu: 2, memMb: 4096 } });
  });

  it("is served by that computer's daemon: the create says nothing of a daemon inside, the bring back's frames go up its link with the workspace named, and nothing is dialled", async () => {
    // Found on spoo, 2026-09-18: a workspace on a computer somebody owns runs no daemon of its own, so the create
    // printed "Daemon did not answer.", the row read Unreachable while exec answered from inside, and every bring
    // back died at "has no daemon answering yet" before a byte left the box.
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ project: (await projectOn(runtime, "srv")).id, golden: "snap_g", name: "work" });
    // Nothing was asked about a route or a daemon inside: a workspace here has neither.
    expect(place.asked["machine.previewUrl"]).toBeUndefined();
    // The two frames a bring back is made of go up this computer's link, each naming the workspace it is for, and
    // the checkout path is the one the workspace sees.
    const back = await runtime.workspaces.bringBack({ workspaceId: made.id, title: "bring back proof" });
    expect(place.frames.map(f => f["op"])).toEqual(["git.push", "git.pr"]);
    for (const frame of place.frames) expect(frame["machineId"]).toBe(made.machineId);
    // The checkout as the workspace sees it, which is the project's own path on that computer, and absolute: the
    // daemon answering for a workspace has no working directory inside it and refuses a relative path.
    const cwd = (await runtime.workspaces.get(made.id)).project.path;
    expect(cwd.startsWith("/")).toBe(true);
    expect(place.frames[0]).toMatchObject({ op: "git.push", cwd });
    expect(place.frames[1]).toMatchObject({ op: "git.pr", cwd });
    expect(back).toMatchObject({ branch: "work", ahead: 1, pr: { number: 7, url: "https://github.com/o/r/pull/7" } });
    // The road to a daemon inside is refused in one sentence rather than minting a route to a port nothing listens
    // on, and so is the update that would deploy one.
    const said = placeServesDaemonLine("work", "srv");
    await expect(runtime.workspaces.daemonReach(made.id)).rejects.toThrow(said);
    await expect(runtime.workspaces.updateDaemon(made.id)).rejects.toThrow(said);
    // And the row reads reachable while the workspace runs, off the computer's own answer for it, which is what
    // read Unreachable before.
    const status = (await runtime.status.list()).find(w => w.id === made.id)!;
    expect(status.reach.state).toBe("reachable");
    // And nothing was written or deployed inside it: no roots file, and no daemon put there by any road of this
    // host's, since the daemon answering for it is that computer's own.
    expect(place.asked["machine.putBytes"]).toBeUndefined();
    const wrote = place.asked["machine.exec"] ?? 0;
    await runtime.status.list();
    expect(place.asked["machine.exec"] ?? 0).toBe(wrote);
  });

  it("hands a road into it one channel: its own hello, every frame up the link with the workspace named, and this workspace's sessions alone", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ project: (await projectOn(runtime, "srv")).id, golden: "snap_g", name: "work" });
    const cwd = (await runtime.workspaces.get(made.id)).project.path;
    const heard: Record<string, unknown>[] = [];
    const channel = await runtime.workspaces.daemonChannel(made.id, e => heard.push(e));
    // The workspace's own hello, not the computer's: a client builds this workspace's paths off the root it reads
    // here, and the link's own named the computer's home.
    expect(heard).toEqual([{ type: "daemon.hello", root: cwd, version: DAEMON_VERSION }]);
    // Every frame goes up that computer's link with the workspace named on it, and nothing is dialled.
    expect(await channel.send({ op: "git.status", cwd })).toMatchObject({ ok: true });
    expect(place.frames.at(-1)).toMatchObject({ op: "git.status", cwd, machineId: made.machineId });
    expect(place.asked["machine.previewUrl"]).toBeUndefined();
    // A computer answers for every workspace on it, so the one it stamps on a session's frames is what says whose
    // that session is; another workspace's never reaches this channel.
    const session = { type: "guest.opened", session: "g0", life: "l1", kind: "cli", token: "dev-1.tok", argv: ["threads"], cwd };
    place.push({ ...session, machineId: "another-workspace" });
    place.push({ ...session, machineId: made.machineId });
    await until(() => heard.length > 1);
    expect(heard.slice(1)).toEqual([{ ...session, machineId: made.machineId }]);
    channel.close();
  });

  it("opens a pane's shell in the workspace's own folder, keeps that computer's readings off it, and lets its ptys go when it closes", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ project: (await projectOn(runtime, "srv")).id, golden: "snap_g", name: "work" });
    const cwd = (await runtime.workspaces.get(made.id)).project.path;
    const heard: Record<string, unknown>[] = [];
    const channel = await runtime.workspaces.daemonChannel(made.id, e => heard.push(e));

    // The pane's first tab names no folder, and the daemon answering for a workspace has no working directory
    // inside one; a tab that names its own keeps it.
    const created = await channel.send({ op: "pty.create", cols: 80, rows: 24 });
    expect(place.frames.at(-1)).toMatchObject({ op: "pty.create", cwd, cols: 80, machineId: made.machineId });
    const own = await channel.send({ op: "pty.create", cols: 80, rows: 24, cwd: `${cwd}/docs` });
    expect(place.frames.at(-1)).toMatchObject({ op: "pty.create", cwd: `${cwd}/docs` });
    const killed = await channel.send({ op: "pty.create", cols: 80, rows: 24 });

    // The two a pane opens every link with: the ports and the load that computer's daemon reads are the whole
    // computer's, so they are answered here and nothing goes up the link.
    for (const op of ["ports.watch", "sys.watch"]) {
      const before = place.asked[op] ?? 0;
      expect(await channel.send({ op })).toMatchObject({ ok: false, code: "unsupported", error: placeWatchesItselfLine("srv") });
      expect(place.asked[op] ?? 0).toBe(before);
    }

    // A pty of another pane on that computer is not this channel's to read.
    const ptyId = String((created as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId });
    place.push({ type: "pty.data", ptyId: "p99", data: "another pane's" });
    place.push({ type: "pty.data", ptyId, data: "hello" });
    await until(() => heard.length > 1);
    expect(heard.slice(1)).toEqual([{ type: "pty.data", ptyId, data: "hello" }]);

    // A shell that ended and one this pane killed hold no listener worth taking off; the shell that stands does.
    const exited = String((own as Record<string, unknown>)["ptyId"]);
    const gone = String((killed as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId: exited });
    await channel.send({ op: "pty.attach", ptyId: gone });
    await channel.send({ op: "pty.kill", ptyId: gone });
    place.push({ type: "pty.exit", ptyId: exited, exitCode: 0 });
    await until(() => heard.some(e => e["type"] === "pty.exit"));

    // Every pane on that computer rides the one link, so a pane that closes takes its own listeners off rather
    // than leaving its bytes riding it.
    channel.close();
    await until(() => place.frames.some(f => f["op"] === "pty.detach"));
    expect(place.frames.filter(f => f["op"] === "pty.detach")).toEqual([expect.objectContaining({ ptyId, machineId: made.machineId })]);
  });

  /** A workspace forked on a computer this host holds a link to, whose daemon answers that workspace's frames. */
  const servedFork = async (): Promise<{ place: ForkingPlace; placeId: string; machineId: string; id: string }> => {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ project: (await projectOn(runtime, "srv")).id, golden: "snap_g", name: "work" });
    return { place, placeId, machineId: made.machineId, id: made.id };
  };

  it("refuses a command on a fork's channel before anything reaches its computer, and that computer's own channel still runs it", async () => {
    const { place, placeId, id } = await servedFork();
    const channel = await runtime!.workspaces.daemonChannel(id, () => {});
    // The daemon runs exec on the computer itself, as its own user, whatever workspace the frame names.
    expect(await channel.send({ op: "exec", cmd: "kill -9 1" })).toMatchObject({ ok: false, code: "unsupported", error: forkOpRefusedLine("exec", "work", "srv") });
    expect(place.asked["exec"] ?? 0).toBe(0);
    channel.close();
    const own = runtime!.places!.channel(placeId, () => {})!;
    expect(await own.send({ op: "exec", cmd: "uptime" })).toMatchObject({ ok: true });
    expect(place.asked["exec"]).toBe(1);
    own.close();
  });

  it("refuses a fork's process watch, reads and kills before anything reaches its computer, and that computer's own channel still carries them", async () => {
    const { place, placeId, id } = await servedFork();
    const channel = await runtime!.workspaces.daemonChannel(id, () => {});
    // The daemon there acts on any pid it is handed, so a pid of the computer's own or of another workspace's is
    // refused here with nothing sent up the link.
    const frames = [
      { op: "proc.kill", pid: 1, signal: "KILL" },
      { op: "proc.inspect", pid: 1 },
      { op: "proc.watch" },
      { op: "proc.unwatch" },
    ];
    for (const frame of frames) {
      expect(await channel.send(frame)).toMatchObject({ ok: false, code: "unsupported", error: forkProcsUnreadLine("work", "srv") });
      expect(place.asked[frame.op] ?? 0).toBe(0);
    }
    channel.close();

    // The computer's own page reads and signals its own processes over the same link, as it did.
    const own = runtime!.places!.channel(placeId, () => {})!;
    for (const frame of frames) expect(await own.send(frame)).toMatchObject({ ok: true });
    expect(frames.map(f => place.asked[f.op])).toEqual([1, 1, 1, 1]);
    own.close();
  });

  it("keeps the readings the computer's own page watches over the shared link off a fork's channel", async () => {
    const { place, id } = await servedFork();
    const heard: Record<string, unknown>[] = [];
    const channel = await runtime!.workspaces.daemonChannel(id, e => heard.push(e));
    const ptyId = String(((await channel.send({ op: "pty.create", cols: 80, rows: 24 })) as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId });
    place.push({ type: "proc.snapshot", at: 1, procs: [{ pid: 1, ppid: 0, comm: "init" }] });
    place.push({ type: "sys.sample", at: 1 });
    place.push({ type: "ports.changed", ports: [22] });
    place.push({ type: "pty.data", ptyId, data: "after" });
    await until(() => heard.some(e => e["type"] === "pty.data"));
    expect(heard.map(e => e["type"])).toEqual(["daemon.hello", "pty.data"]);
    channel.close();
  });

  /** Every op the computer's daemon serves, off the frames crate itself, with whether its request names the
   * workspace it is for: a new op there fails this table until it is placed on one side. */
  const daemonOps = (): { op: string; scoped: boolean }[] => {
    const crate = (file: string): string => readFileSync(new URL(`../../../daemon/crates/wsp-frames/src/${file}`, import.meta.url), "utf8");
    const listed = (text: string, name: string): string[] => [...text.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`))![1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
    const request = crate("request.rs");
    const body = request.slice(request.indexOf("pub enum DaemonOp"), request.indexOf("pub const DAEMON_OPS"));
    const variants = new Map(body.split(/#\[serde\(rename = "/).slice(1).map(part => [part.slice(0, part.indexOf('"')), part.includes("machine_id")] as const));
    return [...listed(request, "DAEMON_OPS"), ...listed(crate("machine.rs"), "MACHINE_OPS")].map(op => ({ op, scoped: variants.get(op) ?? false }));
  };
  const PTY = ["pty.create", "pty.attach", "pty.detach", "pty.write", "pty.resize", "pty.kill", "pty.list"];
  const FILES_AND_GIT = ["fs.list", "fs.read", "git.status", "git.diff", "git.push", "git.pr", "git.prState"];
  const HOST_GUESTS = ["guest.watch", "guest.reply", "guest.close"];
  const REFUSED = [
    "ports.watch",
    "sys.watch",
    "proc.watch",
    "proc.unwatch",
    "proc.inspect",
    "proc.kill",
    "manifest.get",
    "manifest.record",
    "manifest.restartScript",
    "inbox.watch",
    "inbox.rescan",
    "fs.folders",
    "tunnel.open",
    "tunnel.write",
    "tunnel.close",
    "exec",
    "place.leave",
    "place.update",
    "guest.open",
    "guest.send",
  ];

  it.each([
    { road: "a client's", open: (id: string) => runtime!.workspaces.daemonChannel(id, () => {}), carried: [...PTY, ...FILES_AND_GIT, "ping"] },
    { road: "the host's guest road's", open: (id: string) => runtime!.workspaces.guestChannel(id, () => {}), carried: [...PTY, ...FILES_AND_GIT, "ping", ...HOST_GUESTS] },
  ])("places every op the computer's daemon serves on $road channel into a fork: carried naming that fork, or refused before it leaves", async ({ open, carried }) => {
    const ops = daemonOps();
    const machineOps = ops.filter(o => o.op.startsWith("machine.")).map(o => o.op);
    expect(ops.map(o => o.op).sort()).toEqual([...PTY, ...FILES_AND_GIT, "ping", ...HOST_GUESTS, ...REFUSED, ...machineOps].sort());
    const { place, machineId, id } = await servedFork();
    const channel = await open(id);
    for (const { op, scoped } of ops) {
      const before = place.asked[op] ?? 0;
      const reply = await channel.send({ op, ptyId: "p1", path: "/root/work", cwd: "/root/work", session: "g1", message: {} });
      if (carried.includes(op)) {
        // ping reads nothing of any workspace's; the guest road's three answer a session by the id the computer gave it.
        expect(scoped || op === "ping" || HOST_GUESTS.includes(op), op).toBe(true);
        expect(reply, op).toMatchObject({ ok: true });
        expect(place.frames.filter(f => f["op"] === op).at(-1), op).toMatchObject({ machineId });
      } else {
        expect(reply, op).toMatchObject({ ok: false, code: "unsupported" });
        expect(place.asked[op] ?? 0, op).toBe(before);
      }
    }
    channel.close();
  });

  it("opens no channel at all on a computer whose daemon is older than the one this wsp deploys", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION - 1 }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ project: (await projectOn(runtime, "srv")).id, golden: "snap_g", name: "work" });
    // A daemon that reads no workspace name on a pane's frame would open a shell on the computer itself, so the
    // road is refused in the word the computers table already shows rather than opened and used.
    const behind = placeBehindLine("srv", placeDaemonBehind({ daemonVersion: DAEMON_VERSION - 1 })!);
    await expect(runtime.workspaces.daemonChannel(made.id, () => {})).rejects.toThrow(behind);
    expect(place.frames).toEqual([]);
  });

  it("refuses the bring back on a computer whose daemon is older than the one this wsp deploys, and carries a pull request refusal as the note beside the landed push", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId, pair } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION - 1 }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ project: (await projectOn(runtime, "srv")).id, golden: "snap_g", name: "work" });
    // A daemon that reads no workspace name on a files or git frame would resolve the checkout's path against its
    // own home, so the frames are not sent at all: the row's own word for a computer that is behind, and the line
    // that moves it on.
    const behind = placeBehindLine("srv", placeDaemonBehind({ daemonVersion: DAEMON_VERSION - 1 })!);
    await expect(runtime.workspaces.bringBack({ workspaceId: made.id })).rejects.toThrow(behind);
    expect(place.frames).toEqual([]);

    // The same computer on this wsp's daemon takes the frames; a pull request it cannot open is the note beside a
    // push that landed, never a failed bring back.
    const { client: fresh } = await relink(hostKey, placeId, pair, report("srv", { daemonVersion: DAEMON_VERSION }), c => (place = forks(c)));
    sockets.push(fresh.ws);
    place.refuseGitPr = { error: noHostCliLine("github.com"), code: "no-host-cli" };
    const back = await runtime.workspaces.bringBack({ workspaceId: made.id });
    expect(back.note).toBe(noHostCliLine("github.com"));
    expect(back.pr).toBeUndefined();
    expect(back).toMatchObject({ branch: "work", ahead: 1 });
    expect(place.frames.map(f => f["op"])).toEqual(["git.push", "git.pr"]);
  });

  it("says the computer it was forked on where a record names one, and this host's own provider otherwise", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, places: wiredPlace("solari", backend), placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    const there = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    // The fork stands on a computer that offers Docker, and this host forks at Solari: the row says Docker, which
    // is what made it, and place says which computer it is on.
    expect(there.provider).toBe("docker");
    expect(there.place).toBeDefined();
    const here = await createOn(runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(here.provider).toBe("solari");
    expect(here.place).toBeUndefined();
  });

  it("lands where the project's computer is, whatever the default mark says: a workspace is that computer's copy", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    // A project on the provider this host forks at: the host's own backend takes it and the record carries no place,
    // and the mark on the places table says nothing about either.
    await runtime.places!.markUsed(undefined);
    const second = await createOn(runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(backend.machines).toHaveLength(1);
    expect(second.place).toBeUndefined();
    expect(place.created).toHaveLength(1);
  });

  it("says every computer on the row forks and the computer the app runs on does not, off the list the verbs read", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const withDocker = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(withDocker.client.ws);
    const rows = await placesOf();
    // The computer the app runs on is its own local mode, never something the host forks into; a computer that
    // joined boots the image, since the join turns down every one whose kernel cannot.
    expect(rows.find(p => p.id === "here")!.takesForks).toBe(false);
    expect(rows.find(p => p.id === withDocker.placeId)!.takesForks).toBe(true);
    expect(rows.find(p => p.id === "solari")!.takesForks).toBe(true);
    // What the row promises is what the create does: the fork lands on that computer's own backend.
    const made = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    expect(made.place).toBe(withDocker.placeId);
    // What the sidebar and wsp workspaces list for that computer: its forks, and no row for the computer itself.
    expect((await runtime.workspaces.list()).map(w => [w.name, w.place])).toEqual([["x", withDocker.placeId]]);
  });

  it("refuses a word that names no place, and names what this host holds", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    await expect(createOn(runtime!, { golden: "snap_g", name: "x", on: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*srv.*solari/);
  });

  it("never holds a computer that forks nowhere: the join turned it down, so no word names one", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { runsWorkspaces: false }), answers: c => forks(c), expectProved: false });
    sockets.push(client.ws);
    await expect(projectOn(runtime!, "srv")).rejects.toThrow(/no place named srv/);
    expect((await runtime!.workspaces.list()).filter(w => w.name === "x")).toEqual([]);
  });

  it("names the wall when that computer holds no copy of the image, and records nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    place.refuseCreate = { error: "no such image: snap_g", kind: "missing", status: 404 };
    await expect(createOn(runtime!, { golden: "snap_g", name: "x", on: "srv" })).rejects.toThrow(/srv holds no copy of snap_g/);
    expect((await runtime!.workspaces.list()).filter(w => w.name === "x")).toEqual([]);
  });

  it("gives the daemon on a machine that was stopped the whole budget to answer, rather than one ask at the start", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    await runtime.workspaces.nap(made.id);
    // The daemon says no to the wake's first ask and yes to its second, which is a container still coming up off
    // its own layers; the machine that comes back is the one that napped and not a fresh fork of the image.
    const asked = place.asked["machine.daemonAnswers"] ?? 0;
    place.daemonAnswersAfter = asked + 2;
    expect((await runtime.workspaces.wake(made.id)).machineId).toBe(made.machineId);
    expect(place.asked["machine.daemonAnswers"]).toBeGreaterThan(asked + 1);
  });

  it("naps and wakes on that computer and never on this host's provider", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    await runtime.workspaces.nap(made.id);
    expect(place.paused).toBe(1);
    await runtime.workspaces.wake(made.id);
    expect(place.resumed).toBe(1);
    expect(backend.machines).toHaveLength(0);
  });

  it("refuses a snapshot of a fork on that computer in one sentence, and asks that computer and this host's provider for none", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    // A fork of a project golden carries that project from birth, so the verb gets past its own project wall and
    // what it meets is the computer's.
    await store.put("project-goldens", "snap_p", {
      snapshotId: "snap_p",
      golden: "snap_g",
      projects: [{ name: "proj", dest: "/root/proj", importedAt: "2026-09-12T00:00:00.000Z", size: 20 }],
      workspaceId: "ws_older",
      workspaceName: "older",
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    const made = await createOn(runtime, { golden: "snap_p", name: "x", on: "srv" });
    // A computer somebody joined keeps no image, so there is nothing for a copy of this fork's disk to become:
    // the sentence is the far side's own and no frame is sent for it.
    await expect(runtime.workspaces.snapshot(made.id)).rejects.toThrow(NO_IMAGES_HERE);
    expect(place.ops.filter(op => op.startsWith("machine.snapshot"))).toEqual([]);
    expect(backend.snapshots).toEqual([]);
  });

  it("says the computer is not connected rather than asking the provider anything, and reads it again when it is back", async () => {
    const { hostKey } = await serving();
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    const made = await createOn(runtime!, { golden: "snap_g", name: "x", on: "srv" });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const away = (await runtime!.status.list()).find(r => r.id === made.id)!;
    expect(away.reach.state).toBe("unreachable");
    expect(away.reason).toBe(absentComputer("srv", null).sentence);
    expect(away.machineState).toBe("running");
    const back = await relink(hostKey, placeId, key, report("srv"), c => forks(c));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    await until(async () => (await runtime!.status.list()).find(r => r.id === made.id)!.reach.state !== "unreachable");
  });

  it("refuses a keyed frame at a computer that is simply off at once, and waits only for one whose socket closed inside the wait", async () => {
    const store = memoryStore();
    const { hostKey } = await serving({ store, relinkWaitMs: 400 });
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    // One fork made while the computer is here, so the road is warm and what follows is the wait and nothing else.
    await createOn(runtime!, { golden: "snap_g", name: "warm", on: "srv" });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);

    // A gap this host holds a closed socket for: a keyed frame waits, and the computer dialling back finishes it.
    const waiting = createOn(runtime!, { golden: "snap_g", name: "held", on: "srv" });
    let back!: ForkingPlace;
    const linked = await relink(hostKey, placeId, key, report("srv"), c => (back = forks(c)));
    sockets.push(linked.client.ws);
    expect((await waiting).name).toBe("held");
    expect(back.created).toHaveLength(1);
    linked.client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    // Past the wait, the same frame is refused with the one sentence every road on an absent computer reads.
    await new Promise(r => setTimeout(r, 450));
    let asked = Date.now();
    await expect(createOn(runtime!, { golden: "snap_g", name: "late", on: "srv" })).rejects.toThrow(absentComputer("srv", null).sentence);
    expect(Date.now() - asked).toBeLessThan(50);

    // And a host that has held no socket for that computer at all, which is every host at start, refuses at once
    // rather than waiting out a computer that is off.
    await srv!.close();
    await runtime!.close();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey), placeRelinkWaitMs: 50_000 });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    asked = Date.now();
    await expect(createOn(runtime, { golden: "snap_g", name: "cold", on: "srv" })).rejects.toThrow(absentComputer("srv", null).sentence);
    expect(Date.now() - asked).toBeLessThan(50);
  });

  it("never asks a frame with no key of its own a second time: the gap fails it, and the socket that computer opens next is not sent it", async () => {
    const { hostKey } = await serving();
    let first!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (first = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(runtime!, { golden: "snap_g", name: "x", on: "srv" });
    // A pause is the machine moving, not a reading: the far side has taken it by the time the answer is lost, and
    // a second one would be a second move. So the frame names no key and the gap is its end.
    first.swallow.add("machine.pause");
    const napping = runtime!.workspaces.nap(made.id);
    await until(() => first.asked["machine.pause"] === 1);
    client.close();
    await expect(napping).rejects.toThrow("connection lost");
    let second!: ForkingPlace;
    const back = await relink(hostKey, placeId, key, report("srv"), c => (second = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    await new Promise(r => setTimeout(r, 60));
    expect(second.asked["machine.pause"]).toBeUndefined();
    expect(first.paused + second.paused).toBe(0);
  });

  it("leaves a fork that was live through the blip alone, wake and all, when its computer dials again", async () => {
    const { hostKey } = await serving();
    let first!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (first = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(runtime!, { golden: "snap_g", name: "x", on: "srv" });
    await runtime!.workspaces.nap(made.id);
    // A wake in flight across the relink: the machine resumes and its daemon says no, so the wake is still asking
    // when the computer's new socket lands.
    first.daemonAnswersAfter = Number.MAX_SAFE_INTEGER;
    const waking = runtime!.workspaces.wake(made.id);
    await until(async () => first.resumed === 1);
    let second!: ForkingPlace;
    const back = await relink(hostKey, placeId, key, report("srv"), c => (second = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    // The second caller joins the wake in flight rather than finding a record the presence beat replaced.
    const joined = runtime!.workspaces.wake(made.id);
    expect((await waking).id).toBe(made.id);
    expect((await joined).id).toBe(made.id);
    // One resume and one create between the two sockets: the wake was joined, not started again, and nothing
    // forked the image afresh behind it.
    expect(first.resumed + second.resumed).toBe(1);
    expect(first.created.length + second.created.length).toBe(1);
    // And the record was never read again off the store: a fork this host was holding live is left exactly as it
    // is, which is what keeps the wake, the nap and the delete in flight from being thrown away by a beat.
    expect(second.ops).not.toContain("machine.get");
  });

  it("holds a fork on a computer that is away at host start, and reads its machine once it dials in", async () => {
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const first = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(first.client.ws);
    const made = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    await runtime.workspaces.nap(made.id);
    first.client.close();
    await srv.close();
    await runtime.close();
    // A second host over the same store, with that computer away: the record keeps the word it was left with.
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    expect((await runtime.workspaces.get(made.id)).phase).toBe("napping");
    let place!: ForkingPlace;
    const back = await relink(hostKey, first.placeId, first.pair, report("srv"), c => (place = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => place.ops.includes("machine.get"));
  });

  it("reads a running fork's machine again when its computer dials back in, and its daemon sync runs off that reading", async () => {
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const first = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(first.client.ws);
    const made = await createOn(runtime, { golden: "snap_g", name: "x", on: "srv" });
    first.client.close();
    await srv.close();
    await runtime.close();
    // A second host over the same store with that computer away: the fork is held by a stand-in, so nothing about
    // its machine is read and no sync is started for it.
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    try {
      runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
      srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
      expect((await runtime.workspaces.get(made.id)).phase).toBe("running");
      let place!: ForkingPlace;
      const back = await relink(hostKey, first.placeId, first.pair, report("srv"), c => (place = forks(c)));
      sockets.push(back.client.ws);
      await until(async () => place.ops.includes("machine.get") && place.ops.includes("machine.state"));
      await new Promise(r => setTimeout(r, 100));
      // The record was read again and the sync the reading handed back ran on it: a workspace this computer serves
      // the daemon for is asked for no version and given no deploy, and nothing is left saying otherwise.
      expect((await runtime.workspaces.get(made.id)).phase).toBe("running");
      expect(warned.filter(l => l.includes("were not read again") || l.startsWith("daemon on"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("carries one port on this computer to one port on that one, for as long as the host runs", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const first = await runtime!.places!.forward(placeId, 32768);
    const again = await runtime!.places!.forward(placeId, 32768);
    expect(again.localPort).toBe(first.localPort);
    await dialLocal(first.localPort);
    await until(async () => place.tunnels.some(t => t.port === 32768));
    // The listener stays bound while that computer is away: the route this host handed out keeps its port.
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await expect(dialLocal(first.localPort, true)).resolves.toBe("cut");
    let second!: ForkingPlace;
    const back = await relink(hostKey, placeId, key, report("srv"), c => (second = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    expect((await runtime!.places!.forward(placeId, 32768)).localPort).toBe(first.localPort);
    await dialLocal(first.localPort);
    await until(async () => second.tunnels.some(t => t.port === 32768));
  });

  it("hands a channel on that computer's link the tunnel frames of a road it opened, and keeps its own forward's to itself", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const { localPort } = await runtime!.places!.forward(placeId, 32768);
    const pane = netConnect({ host: "127.0.0.1", port: localPort });
    await until(async () => place.tunnels.length === 1);
    const own = place.tunnels[0]!.tunnelId;
    const heard: Record<string, unknown>[] = [];
    const channel = runtime!.places!.channel(placeId, e => void heard.push(e))!;
    place.push({ type: "tunnel.data", tunnelId: own, data: "aGk=" });
    place.push({ type: "tunnel.data", tunnelId: "t9", data: "aGk=" });
    place.push({ type: "tunnel.end", tunnelId: "t9" });
    await until(async () => heard.length === 2);
    expect(heard).toEqual([
      { type: "tunnel.data", tunnelId: "t9", data: "aGk=" },
      { type: "tunnel.end", tunnelId: "t9" },
    ]);
    channel.close();
    pane.destroy();
  });

  it("a napping fork is not counted as one that runs, and the room is what a create can take now", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      // One running and one napping machine on that computer, as its own backend counts them under a stopping nap:
      // the napping one holds the disk its copy takes and no cpu or memory, so it takes no slot from a create.
      answers: c =>
        forks(c, {
          cores: 4,
          memMb: 8192,
          memRoomMb: 9000,
          machineMemMb: 4096,
          diskFreeBytes: 10 * 1024 * 1024 * 1024,
          images: [{ id: "sha256:i", sizeBytes: 4 * 1024 * 1024 * 1024 }],
          machines: { running: 1, paused: 1 },
        }),
    });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.forks !== undefined);
    expect((await placesOf()).find(p => p.id === placeId)!.forks).toEqual({ running: 1, room: 2 });
  });

  it("shows how many forks a place holds of how many it takes", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.forks !== undefined);
    // Nine thousand megabytes of room at four thousand a fork is two; ten gigabytes of disk at four an image is two.
    expect((await placesOf()).find(p => p.id === placeId)!.forks).toEqual({ running: 1, room: 2 });
  });

  it("refuses to take a computer out from under the forks standing on it, and sweeps nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const swept: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { op?: string };
      if (frame.op === "place.leave") swept.push("asked");
    });
    await createOn(runtime!, { golden: "snap_g", name: "x", on: "srv" });
    await expect(runtime!.places!.remove(placeId)).rejects.toThrow(/srv still holds a fork \(x\); delete them first/);
    expect(swept).toEqual([]);
    expect(place.killed).toEqual([]);
  });

  it("refuses to take a computer out from under the projects recorded on it, naming them, and sweeps nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const swept: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { op?: string };
      if (frame.op === "place.leave") swept.push("asked");
    });
    // A project with no workspace of it: the forks refusal cannot be what answers here, so the projects one is.
    await projectOn(runtime!, "srv", "https://github.com/wsp/spoo-landing.git", { name: "spoo-landing" });
    await expect(runtime!.places!.remove(placeId)).rejects.toThrow(/srv still holds a project \(spoo-landing\); wsp projects remove each of them first/);
    expect(swept).toEqual([]);
    expect(place.killed).toEqual([]);
  });
});

/** One connection to a port this host is forwarding; answers what it read, or "cut" when the far side refused it. */
function dialLocal(port: number, expectCut = false): Promise<string> {
  return new Promise((done, fail) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.on("error", e => (expectCut ? done("cut") : fail(e)));
    socket.on("close", () => done(expectCut ? "cut" : "closed"));
    socket.on("connect", () => {
      socket.write("hello");
      if (!expectCut) setTimeout(() => socket.destroy(), 60);
    });
  });
}

describe("the image built through a computer you joined", () => {
  it("a copy build names the computer by its name or id, learns its backend from the computer itself, and is refused at the record rather than at the name", async () => {
    const { hostKey } = await serving();
    let place: ForkingPlace | undefined;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await expect(runtime!.image.build({ place: "srv" })).rejects.toThrow(/owns no image named default/);
    await expect(runtime!.image.build({ place: placeId })).rejects.toThrow(/owns no image named default/);
    // One frame taught this host what srv forks with; nothing was made there.
    expect(place!.asked["machine.backend"]).toBe(1);
    expect(place!.created).toEqual([]);
    await expect(runtime!.image.build({ place: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*srv/);
  });

  it("the image is built on the joined computer when it is the default place, and when the provider this host forks on forks nothing", async () => {
    const { hostKey } = await serving();
    const marked = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(marked.client.ws);
    await runtime!.places!.markUsed(marked.placeId);
    const picked = await runtime!.golden.buildPlace();
    expect([picked.place, picked.name]).toEqual([marked.placeId, "srv"]);
    expect(picked.backend.capabilities.sizes.length).toBeGreaterThan(0);
    // The provider a keyless host wires forks nothing and is the default: the one joined computer that runs
    // workspaces is where the image goes, with nothing named.
    await srv?.close();
    await runtime?.close();
    const none = new NoProviderBackend();
    const keyless = newPlaceKeyPair();
    runtime = createRuntime({ backend: none, store: memoryStore(), adapters: {}, places: wiredPlace("none", none), placeLinks: wiring(keyless) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const joined = await join(keyless, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(joined.client.ws);
    const only = await runtime.golden.buildPlace();
    expect([only.place, only.name]).toEqual([joined.placeId, "srv"]);
  });
});

describe("the image build and the computer whose doctor said no, or that does not answer", () => {
  const BLOCKED = "this computer mounts cgroup v1 at /sys/fs/cgroup";
  const copyRecipe = (): GoldenRecipe => ({ setup: "true", smoke: "true" });

  it("a computer whose doctor said no never becomes a place: the join is refused in the doctor's own sentence and nothing is written", async () => {
    const { hostKey, store } = await serving();
    const { client, proved } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { runsWorkspaces: false, workspacesBlocked: BLOCKED }), answers: c => forks(c), expectProved: false });
    sockets.push(client.ws);
    expect(String(proved["error"])).toBe(placeCannotBootLine("srv", BLOCKED));
    expect(String(proved["error"])).toBe("srv cannot run wsp workspaces: it mounts cgroup v1 at /sys/fs/cgroup");
    // Nothing on the store, nothing on the list, and no road names it: the refusal is the whole of what happened.
    expect(await store.list("places")).toEqual([]);
    await expect(runtime!.golden.buildPlace("srv")).rejects.toThrow(/no place named srv/);
    await expect(runtime!.image.build({ place: "srv" })).rejects.toThrow(/no place named srv/);
    await expect(runtime!.golden.prepare({ place: "srv", recipe: copyRecipe() })).rejects.toThrow(/no place named srv/);
    await expect(projectOn(runtime!, "srv")).rejects.toThrow(/no place named srv/);
  });

  it("a default place that is not answering is the refusal the person reads, with its name in it, never a build sent to another place", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv" });
    await runtime!.places!.markUsed(placeId);
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await expect(runtime!.golden.buildPlace()).rejects.toThrow(absentComputer("srv", null).sentence);
  });

  it("this computer is never built into: naming it for a copy build or a build place is refused rather than read as the provider this host forks on", async () => {
    await serving();
    await expect(runtime!.image.build({ place: HERE.name })).rejects.toThrow(placeBuildsNoImageLine(HERE.name));
    await expect(runtime!.golden.buildPlace(HERE.name)).rejects.toThrow(placeBuildsNoImageLine(HERE.name));
  });
});

describe("a computer joining a host that holds a sealed image", () => {
  /** A host that forks at a provider stub and composes the recipe a copy builds from; with `sealed`, its image is
   * sealed at that provider before anything joins. The key and the store are handed in for a host that comes back. */
  async function imageHost(o: { sealed: boolean; store?: Store; hostKey?: PlaceKeyPair; relinkWaitMs?: number }): Promise<{ hostKey: PlaceKeyPair; store: Store }> {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const hostKey = o.hostKey ?? newPlaceKeyPair();
    const store = o.store ?? memoryStore();
    runtime = createRuntime({
      backend,
      store,
      adapters: {},
      goldenRecipe: recipeWith(),
      copyRecipe: () => COPY_RECIPE,
      hostId: "h1",
      places: wiredPlace("solari", backend),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
      ...(o.relinkWaitMs !== undefined ? { placeRelinkWaitMs: o.relinkWaitMs } : {}),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    if (o.sealed) {
      const b = await runtime.golden.prepare();
      await runtime.golden.seal(b.id);
    }
    return { hostKey, store };
  }

  const settled = (): Promise<void> => new Promise(r => setTimeout(r, 60));
  const rowOf = async (placeId: string): Promise<PlaceView> => (await placesOf()).find(p => p.id === placeId)!;
  /** A computer answering what a builder asks of it, as far as a fake goes: its exec answers the checks, and the
   * builder's own setup is where a build there stops. */
  const answering =
    (hold: (p: ForkingPlace) => void) =>
    (c: WsClient): void =>
      hold(forks(c, undefined, cmd => dfOk(undefined, cmd)));
  const framesOf = (): GoldenStageEvent[] => {
    const frames: GoldenStageEvent[] = [];
    runtime!.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push(e);
    });
    return frames;
  };

  it("builds that computer's copy only when asked, never on a link: the join socket and the agent's link start nothing, a press starts the build, and where the build stops the row says so, the builder is killed by its id and no copy is filed", async () => {
    const { hostKey } = await imageHost({ sealed: true });
    const frames = framesOf();
    // The join command's road: join and prove on one socket that answers no machine frame and closes once the
    // prove is answered; the agent's link dials in after it.
    const joined = await join(hostKey, { code: await code(), name: "srv" });
    const { placeId, pair } = joined;
    await until(async () => (await rowOf(placeId)).present === true);
    joined.client.close();
    await until(async () => (await rowOf(placeId)).present === false);
    await settled();
    expect(frames.filter(f => f.place === placeId)).toEqual([]);
    expect((await rowOf(placeId)).build).toBeUndefined();
    let place!: ForkingPlace;
    const linked = await relink(hostKey, placeId, pair, report("srv"), answering(p => (place = p)));
    sockets.push(linked.client.ws);
    expect(linked.proved.ok, String(linked.proved["error"])).toBe(true);
    await settled();
    expect(place.asked["machine.create"]).toBeUndefined();
    void runtime!.image.build({ place: placeId }).catch(() => undefined);
    await until(() => place.asked["machine.create"] === 1, 5000);
    expect(frames.some(f => f.place === placeId && f.stage === "creating")).toBe(true);
    // The fake computer runs no builder's setup, so the build stops there: the row says so in the seal's own
    // words, and the stopped build starts no second one on its own.
    await until(async () => (await rowOf(placeId)).build?.startsWith(copyStoppedLine()) === true, 5000);
    expect((await rowOf(placeId)).buildStopped).toBe(true);
    expect((await rowOf(placeId)).buildsImages).toBe(true);
    expect(frames.filter(f => f.place === placeId).map(f => f.stage)).toContain("failed");
    expect(place.killed).toHaveLength(1);
    expect((await runtime!.image.get()).copies.map(c => c.place)).toEqual(["solari"]);
    expect(place.asked["machine.create"]).toBe(1);
  });

  it("a fork there builds that computer's copy first, saying so with no rate since the computer charges nothing, and never forks the image it holds no copy of", async () => {
    const { hostKey } = await imageHost({ sealed: true });
    let place!: ForkingPlace;
    const { placeId } = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(async () => (await rowOf(placeId)).present === true);
    const lines: string[] = [];
    runtime!.events.on("workspace.creating", e => {
      if (e.type === "workspace.creating" && e.name === "x") lines.push(e.message);
    });
    const head = (await runtime!.image.get()).copies.find(c => c.place === "solari")!.snapshotId;
    // The fake computer runs no builder's tool install, so the copy's build stops there and the fork with it; a
    // fork that forked the image anyway would have asked this computer for a second machine.
    await expect(createOn(runtime!, { golden: head, name: "x", on: "srv" })).rejects.toThrow(/launch failed/);
    expect(lines[0]).toBe("building your image on srv first, about ten minutes, then x forks from it");
    expect(place.created).toHaveLength(1);
    expect((place.created[0]!["labels"] as Record<string, string>)["wsp-builder"]).toBe("1");
    expect(place.killed).toHaveLength(1);
  });

  it("a link that drops under a stage and dials back finishes the stage: the create is asked again on the socket that computer opens next, the build goes on to the stage after it, and the stage reads the wait while the gap lasts", async () => {
    const { hostKey } = await imageHost({ sealed: false });
    const frames = framesOf();
    let first!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (first = p)) });
    await until(() => first.asked["machine.backend"] === 1);
    // The computer takes the builder's create and says nothing back; then its socket goes.
    first.swallow.add("machine.create");
    // The fake computer runs no builder's setup, so the prepare stops there in the end; what this reads is how far
    // it got, and its answer is taken here so nothing of it is loose while the test waits.
    const preparing = runtime!.golden.prepare({ place: joined.placeId, recipe: { setup: "true", smoke: "true" } }).catch(() => undefined);
    await until(() => first.asked["machine.create"] === 1, 5000);
    joined.client.close();
    await until(async () => (await rowOf(joined.placeId)).present === false);
    expect(frames.some(f => f.stage === "creating" && f.detail === placeDialBackLine("srv"))).toBe(true);

    let back!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (back = p)));
    sockets.push(linked.client.ws);
    // The same prepare goes on over the new socket: its create is asked again there and the stage after creating
    // is reached, where with no wait at all the prepare was already over.
    await until(() => back.asked["machine.create"] === 1, 5000);
    await until(() => frames.some(f => f.stage === "deploying-daemon"), 5000);
    expect(back.created).toHaveLength(1);
    // And the wait's line is gone once the computer is back: the frame put back is the stage's own last frame,
    // field for field, so a step a reader clocks and the machines a stage left behind ride the gap with its line.
    const own = frames
      .filter(f => f.stage === "creating" && f.detail !== placeDialBackLine("srv"))
      .map(({ name, stage, detail, step, left, place }) => ({ name, stage, detail, step, left, place }));
    expect(own).toHaveLength(2);
    expect(own[1]).toEqual(own[0]);
    await preparing;
  });

  it("a computer that never dials back fails the stage after the wait, with the sentence the stage fails with when nothing waits at all", async () => {
    const { hostKey } = await imageHost({ sealed: false, relinkWaitMs: 300 });
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(() => place.asked["machine.backend"] === 1);
    place.swallow.add("machine.create");
    const preparing = runtime!.golden.prepare({ place: joined.placeId, recipe: { setup: "true", smoke: "true" } });
    await until(() => place.asked["machine.create"] === 1, 5000);
    const at = Date.now();
    joined.client.close();
    // The wait is a wait, not a second answer: past its bound the stage fails with the frame's own words, which is
    // what a person read on this stage before anything waited at all.
    await expect(preparing).rejects.toThrow("connection lost");
    // Node wakes a timer against its own clock, which can read short of the wall clock the elapsed here is
    // measured on (a runner read 299 ms of this 300 ms wait). Ten milliseconds of slack, rather than one, because
    // the gap is the two clocks drifting and not a fixed cost, and a wait that never happened is off by 300.
    expect(Date.now() - at).toBeGreaterThanOrEqual(300 - 10);
  });

  it("a copy build whose computer went and never dialled back ends stopped, saying it went away, and its next link puts no building frame back", async () => {
    const { hostKey } = await imageHost({ sealed: true, relinkWaitMs: 300 });
    const frames = framesOf();
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(() => place.asked["machine.backend"] === 1);
    place.swallow.add("machine.create");
    const building = runtime!.image.build({ place: joined.placeId });
    await until(() => place.asked["machine.create"] === 1, 5000);
    joined.client.close();
    await expect(building).rejects.toThrow();
    const ours = (): GoldenStageEvent[] => frames.filter(f => f.place === joined.placeId);
    expect(ours().at(-1)).toMatchObject({ stage: "failed", detail: placeWentAwayLine("srv") });
    expect((await rowOf(joined.placeId)).build).toBe(copyStoppedLine(placeWentAwayLine("srv")));
    expect((await rowOf(joined.placeId)).buildStopped).toBe(true);
    const said = ours().length;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(() => undefined));
    sockets.push(linked.client.ws);
    await until(async () => (await rowOf(joined.placeId)).present === true);
    await settled();
    expect(ours().slice(said)).toEqual([]);
    expect((await rowOf(joined.placeId)).buildStopped).toBe(true);
  });

  it("builds nothing for a computer whose doctor said no, since its join never stood, and nothing at all on a host that holds no image", async () => {
    const { hostKey } = await imageHost({ sealed: true });
    let blocked!: ForkingPlace;
    const laptop = await join(hostKey, { code: await code(), name: "laptop", report: report("laptop", { runsWorkspaces: false }), answers: c => (blocked = forks(c)), expectProved: false });
    sockets.push(laptop.client.ws);
    await settled();
    expect(blocked.asked["machine.create"]).toBeUndefined();
    expect((await placesOf()).some(p => p.name === "laptop")).toBe(false);

    await srv?.close();
    await runtime?.close();
    const { hostKey: bare } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(bare, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await until(async () => (await rowOf(placeId)).present === true);
    await settled();
    expect(place.asked["machine.create"]).toBeUndefined();
    expect((await rowOf(placeId)).build).toBeUndefined();
  });

  it("a computer not connected at the cut builds nothing then and its row says nothing, and its next link builds nothing either", async () => {
    const { hostKey } = await imageHost({ sealed: false });
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    // The computer said what it forks with, then went away.
    await until(() => place.asked["machine.backend"] === 1);
    joined.client.close();
    await until(async () => (await rowOf(joined.placeId)).present === false);
    const frames = framesOf();
    const b = await runtime!.golden.prepare();
    await runtime!.golden.seal(b.id);
    await settled();
    expect(frames.filter(f => f.place === joined.placeId)).toEqual([]);
    expect((await rowOf(joined.placeId)).build).toBeUndefined();
    let back!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (back = p)));
    sockets.push(linked.client.ws);
    await until(async () => (await rowOf(joined.placeId)).present === true);
    await settled();
    expect(back.asked["machine.create"]).toBeUndefined();
    expect(frames.filter(f => f.place === joined.placeId)).toEqual([]);
  });

  it("a host restarted while a copy was building on a computer you joined reads the builder back through that computer once it dials in and the sweep stops it there; the wired provider is never asked about it and no copy is half filed", async () => {
    const { hostKey, store } = await imageHost({ sealed: false });
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(() => place.asked["machine.backend"] === 1);
    // What a host that died mid build leaves behind: the builder's record, marked building, naming the computer it
    // was made on.
    await store.put("builders", "k7", { id: "k7", name: "default", kind: "sandbox", baseTemplate: "ubuntu:24.04", setupSha: "x", createdAt: new Date().toISOString(), size: { cpu: 2, memMb: 4096 }, firstLife: true, building: true, place: joined.placeId });
    joined.client.close();
    await srv!.close();
    await runtime!.close();
    // The host comes back on the same state and the computer dials in again.
    await imageHost({ sealed: false, store, hostKey });
    let again!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (again = p)));
    sockets.push(linked.client.ws);
    const swept = await runtime!.reap();
    expect(again.asked["machine.get"]).toBeGreaterThanOrEqual(1);
    expect(again.killed).toEqual(["k7"]);
    expect(swept.reaped.map(r => r.id)).toContain("k7");
    expect(await store.get("builders", "k7")).toBeUndefined();
    expect(await store.keys("goldens")).toEqual([]);
  });
});

describe("the recipe this host holds, put on a computer you own", () => {
  const RECIPE_AT = "2026-09-17T10:00:00.000Z";
  const PLAN: ProvisionPlan = {
    recipeAt: RECIPE_AT,
    path: probePath("/root"),
    steps: [
      { id: "agents/node", label: "Node 22.23.2", manager: "script", cmd: "node-step" },
      { id: "agents/codex", label: "Codex", manager: "npm", cmd: "codex-step", after: "agents/node" },
    ],
    skipped: [],
  };
  const ROWS: PlaceProvisionRow[] = [
    { id: "agents/node", label: "Node 22.23.2", outcome: "present" },
    { id: "agents/codex", label: "Codex", outcome: "installed" },
  ];

  /** An image this host has sealed, so the road that keeps a computer's copy of it current gets past its first
   * read and reaches the computer. The hashes are plainly fake, as every key in these fixtures is. */
  const IMAGE_RECORD = {
    name: "default",
    version: 1,
    hash: "a".repeat(64),
    recipeHash: "rh",
    recipe: { version: 1, at: RECIPE_AT, histories: [], rows: [] },
    logins: [],
    sealedAt: RECIPE_AT,
    sealedFrom: "h1",
    vault: { sha256: "b".repeat(64), bytes: 10, paths: 1, takenAt: RECIPE_AT },
  };

  /** A provisioner as the host wires one, with what it plans and what its run comes to under this test's hand. */
  function provisioner(o: { rows?: PlaceProvisionRow[]; plan?: ProvisionPlan; throws?: string; noRecipe?: string; hold?: boolean; planThrows?: string; planMs?: number } = {}) {
    let release = (): void => {};
    const held = new Promise<void>(resolve => (release = resolve));
    const calls = { plan: 0, run: 0 };
    const machines: Machine[] = [];
    const homes: string[] = [];
    const rows = o.rows ?? ROWS;
    return {
      calls,
      machines,
      homes,
      release,
      wired: {
        plan: async () => {
          calls.plan++;
          if (o.planMs !== undefined) await new Promise(resolve => setTimeout(resolve, o.planMs));
          if (o.planThrows !== undefined) throw new Error(o.planThrows);
          return o.noRecipe === undefined ? (o.plan ?? PLAN) : { noRecipe: o.noRecipe };
        },
        run: async (machine, plan, stage, on) => {
          calls.run++;
          machines.push(machine);
          homes.push(on.home);
          expect(plan.recipeAt).toBe(RECIPE_AT);
          // The row it is on before the first outcome, as a run that is on a step says it.
          stage(`${rows[0]!.label} (1/${rows.length})`, { label: rows[0]!.label, index: 1, of: rows.length });
          if (o.hold === true) await held;
          if (o.throws !== undefined) throw new Error(o.throws);
          for (const [i, row] of rows.entries()) stage(`${row.label}: ${row.outcome}`, { label: row.label, index: i + 1, of: rows.length }, row);
          return rows;
        },
      } satisfies PlaceProvisioner,
    };
  }

  /** What the computer answers on its link: what it forks with, and every command as its daemon's exec would. */
  function answersFor(cmds: string[]) {
    return (c: WsClient): void => {
      c.onFrame(raw => {
        const frame = raw as unknown as Record<string, unknown>;
        const op = frame["op"];
        if (op === "machine.backend") return void c.say({ id: frame["id"], ok: true, ...KEEPS_NO_IMAGE });
        // What room it has left, which every read of the row asks for: a computer that does not answer holds every
        // listing for the wait the table gives it.
        if (op === "machine.capacity") {
          return void c.ws.send(
            JSON.stringify({
              id: frame["id"],
              ok: true,
              cores: 2,
              memMb: 7600,
              memRoomMb: 6000,
              machineMemMb: 4096,
              diskFreeBytes: 19 * 1024 ** 3,
              images: [],
              machines: { running: 0, paused: 0 },
            }),
          );
        }
        if (op !== "exec") return;
        cmds.push(String(frame["cmd"] ?? ""));
        c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false });
      });
    };
  }

  /** A host with the recipe wired, and a computer joined to it through the install road, as a join does it. */
  async function joined(o: { provision: PlaceProvisioner; store?: Store; cmds?: string[]; report?: PlaceReport; update?: PlaceUpdater }): Promise<{ placeId: string; addId: string; store: Store; hostKey: PlaceKeyPair; added: Awaited<ReturnType<NonNullable<Runtime["places"]>["add"]>> }> {
    const hostKey = newPlaceKeyPair();
    const store = o.store ?? memoryStore();
    const answers = answersFor(o.cmds ?? []);
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey, undefined, o.update),
        provision: o.provision,
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          const { client } = await join(hostKey, { code: readJoinToken(req.code).code, name: "spoo", ...(o.report === undefined ? {} : { report: o.report, proveReport: o.report }), answers });
          sockets.push(client.ws);
          return { name: "spoo" };
        },
      },
      placeUpdateWaitMs: 50,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ addId: "a_mine", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    return { placeId: added.place.id, addId: added.addId, store, hostKey, added };
  }

  const provisionOf = async (placeId: string): Promise<PlaceView["provision"]> => (await placesOf()).find(p => p.id === placeId)?.provision;

  /** What one exec that lands a file wrote into it: the text goes up as base64 and the shell decodes it there. */
  const written = (cmd: string): string => Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(cmd)![1]!, "base64").toString("utf8");

  it("starts inside the join, on the add's own stream, and leaves the rows the computer answered on the row", async () => {
    const p = provisioner();
    const stages: PlaceStageEvent[] = [];
    const { placeId, added } = await joined({ provision: p.wired });
    runtime!.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    // The reply already says a job is under way, so whoever asked knows there is one to follow.
    expect(added.place.provision).toMatchObject({ state: "running", addId: "a_mine", recipeAt: RECIPE_AT, rows: [] });
    expect(added.said).toBeUndefined();
    await until(async () => (await provisionOf(placeId))?.state === "done");
    const provision = (await provisionOf(placeId))!;
    expect(provision.rows).toEqual(ROWS);
    expect(provision.addId).toBe("a_mine");
    expect(provision.finishedAt).toBeDefined();
    expect(provision.at).toBeUndefined();
    expect(p.calls).toEqual({ plan: 1, run: 1 });
    // The run is handed the home the computer's own agent reported: the agents' folders there hang off it, and
    // this host has no other way of knowing where they are.
    expect(p.homes).toEqual([(await runtime!.places!.reportOf(placeId))!.login["HOME"]]);
  });

  it("says what the recipe puts there by kind, in the line the job opens with and in the header of its log there", async () => {
    const stages: PlaceStageEvent[] = [];
    const cmds: string[] = [];
    const hostKey = newPlaceKeyPair();
    const p = provisioner({
      plan: {
        ...PLAN,
        files: { lands: [{ id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/skills" }], pack: () => Promise.reject(new Error("no pack under this test")) },
        mcp: { agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: ["/root/.claude-cfg/.claude.json"], format: MCP_SERVERS_JSON, keep: ["github"], drop: [] }], aside: [] }], guestHome: "/root", rewrites: [], binDirs: [], tools: [] },
      },
    });
    const store = memoryStore();
    const answers = answersFor(cmds);
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        provision: p.wired,
        install: async req => {
          const { client } = await join(hostKey, { code: readJoinToken(req.code).code, name: "spoo", answers });
          sockets.push(client.ws);
          return { name: "spoo" };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    const added = await runtime.places!.add({ addId: "a_mine", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await provisionOf(added.place.id))?.state === "done");
    expect(stages.filter(e => e.step === "provision")[0]?.note).toBe(`2 tools, 1 file, 1 MCP server from the recipe of ${RECIPE_AT}`);
    // The log on that computer opens with the same count, so its own reader is told what this run was for.
    expect(cmds.some(c => c.includes(Buffer.from("2 tools, 1 file, 1 MCP server").toString("base64").slice(0, 20)))).toBe(true);
  });

  it("says each row as it lands on the add's own stream, and says the tally once at the end", async () => {
    const stages: PlaceStageEvent[] = [];
    const hostKey = newPlaceKeyPair();
    const p = provisioner();
    // The events are watched from before the add, the way a terminal watches them: the first rows land inside it.
    const store = memoryStore();
    const answers = answersFor([]);
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        provision: p.wired,
        install: async req => {
          const { client } = await join(hostKey, { code: readJoinToken(req.code).code, name: "spoo", answers });
          sockets.push(client.ws);
          return { name: "spoo" };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    const added = await runtime.places!.add({ addId: "a_mine", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await provisionOf(added.place.id))?.state === "done");
    const provision = stages.filter(s => s.step === "provision");
    expect(provision.every(s => s.addId === "a_mine")).toBe(true);
    expect(provision[0]?.note).toContain(`2 tools from the recipe of ${RECIPE_AT}`);
    expect(provision.map(s => s.note)).toContain("Codex: installed");
    expect(provision.filter(s => s.state === "done")).toHaveLength(1);
    expect(provision.at(-1)?.note).toContain("1 installed: Codex");
  });

  it("refuses a workspace there in one sentence while it runs, naming the row it is on, and takes one once it is done", async () => {
    const p = provisioner({ hold: true });
    const { placeId } = await joined({ provision: p.wired });
    await until(async () => (await provisionOf(placeId))?.at !== undefined);
    const at = (await provisionOf(placeId))!.at;
    await expect(runtime!.places!.forkingBackend(placeId)).rejects.toThrow(placeProvisioningLine("spoo", at));
    // The workspaces already standing there are untouched: they read the backend, not the road a fork takes.
    expect(runtime!.places!.backendOf(placeId)).toBeDefined();
    p.release();
    await until(async () => (await provisionOf(placeId))?.state === "done");
    expect(await runtime!.places!.forkingBackend(placeId)).toBeDefined();
  });

  it("refuses a fork during the job in a class of its own, keeping the conflict a create there has always answered in", async () => {
    const p = provisioner({ hold: true });
    const { placeId } = await joined({ provision: p.wired });
    await until(async () => (await provisionOf(placeId))?.at !== undefined);
    const refused = await runtime!.places!.forkingBackend(placeId).then(
      () => undefined,
      (e: unknown) => e,
    );
    // The class says which refusal this is to a road that waits for the job; the kind is what the create's own
    // answer is classed by, and it is the one it always was.
    expect(refused).toBeInstanceOf(PlaceProvisioningError);
    expect(refused).toMatchObject({ kind: "conflict", message: placeProvisioningLine("spoo", (await provisionOf(placeId))!.at) });
    p.release();
    await until(async () => (await provisionOf(placeId))?.state === "done");
  });

  it("says which computer every step of the job is on, so a road that acts at its end reads the row off the step", async () => {
    const p = provisioner({ hold: true });
    const stages: PlaceStageEvent[] = [];
    const { placeId } = await joined({ provision: p.wired });
    runtime!.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await until(async () => (await provisionOf(placeId))?.at !== undefined);
    p.release();
    await until(async () => (await provisionOf(placeId))?.state === "done");
    const provision = stages.filter(s => s.step === "provision");
    expect(provision.length).toBeGreaterThan(0);
    expect(provision.every(s => s.placeId === placeId)).toBe(true);
    expect(provision.filter(s => s.state === "done").map(s => s.placeId)).toEqual([placeId]);
  });

  it("counts the rows that failed on the job's last step and on no other", async () => {
    const failing = provisioner({ rows: [...ROWS, { id: "agents/uv", label: "uv", outcome: "failed", note: "exit 2" }, { id: "agents/go", label: "Go", outcome: "failed" }], hold: true });
    const stages: PlaceStageEvent[] = [];
    const { placeId } = await joined({ provision: failing.wired });
    runtime!.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    failing.release();
    await until(async () => stages.some(s => s.step === "provision" && s.state === "done"));
    const done = stages.find(s => s.step === "provision" && s.state === "done")!;
    expect(done.failed).toBe(2);
    expect(stages.filter(s => s.state !== "done").every(s => s.failed === undefined)).toBe(true);
  });

  it("says nothing about the image while the job runs, and reads the image again once the job ends", async () => {
    const p = provisioner({ hold: true });
    const store = memoryStore();
    await store.put("images", "default", IMAGE_RECORD);
    const { placeId } = await joined({ provision: p.wired, store });
    await until(async () => (await provisionOf(placeId))?.at !== undefined);
    // Asked by hand before the job ends: the refusal the road meets is the job's, and no row is written for it.
    await runtime!.image.keepCurrent(placeId);
    expect((await placesOf()).find(r => r.id === placeId)?.build).toBeUndefined();
    const asks: string[] = [];
    runtime!.image.keepCurrent = async place => {
      asks.push(place);
    };
    p.release();
    await until(() => asks.length > 0);
    // Once, at the end of the job, which is the moment the tally beside it is written.
    expect(asks).toEqual([placeId]);
    expect((await placesOf()).find(r => r.id === placeId)?.build).toBeUndefined();
  });

  it("is refused a second time while the first is still going on, as the op's own refusal so nothing waits on it", async () => {
    const p = provisioner({ hold: true });
    const { placeId } = await joined({ provision: p.wired, report: report("spoo", { daemonVersion: DAEMON_VERSION }) });
    await until(async () => (await provisionOf(placeId))?.at !== undefined);
    const at = (await provisionOf(placeId))!.at;
    // A refusal of the op, not a reply carrying somebody else's job: whoever asked reads one sentence and returns.
    await expect(runtime!.places!.update(placeId)).rejects.toThrow(placeProvisioningLine("spoo", at));
    expect(p.calls.plan).toBe(1);
    expect(p.calls.run).toBe(1);
    p.release();
    await until(async () => (await provisionOf(placeId))?.state === "done");
    // And once it is done the same ask starts a job of its own.
    const again = await runtime!.places!.update(placeId);
    expect(again.provision?.state).toBe("running");
    await until(async () => p.calls.run === 2);
  });

  it("starts one job per computer even when two asks land inside the recipe read, which reads this whole computer", async () => {
    // The read takes a while, as reading this Mac does: the slot is taken before it, or both asks pass the check
    // and two runs install over each other on that box.
    const p = provisioner({ planMs: 40 });
    const { placeId } = await joined({ provision: p.wired, report: report("spoo", { daemonVersion: DAEMON_VERSION }) });
    await until(async () => (await provisionOf(placeId))?.state === "done");
    const both = await Promise.allSettled([runtime!.places!.update(placeId), new Promise(r => setTimeout(r, 5)).then(() => runtime!.places!.update(placeId))]);
    const said = both.map(o => (o.status === "fulfilled" ? "ok" : String((o.reason as Error).message)));
    expect(said.filter(w => w === "ok")).toHaveLength(1);
    expect(said.filter(w => w.includes("is still being set up"))).toHaveLength(1);
    // The recipe was read once more and run once more, not twice.
    expect(p.calls.plan).toBe(2);
    expect(p.calls.run).toBe(2);
  });

  it("says a computer that reported no home folder got no recipe, as the one with no recipe says it", async () => {
    const p = provisioner();
    const store = memoryStore();
    const { placeId } = await joined({ provision: p.wired, store, report: report("spoo", { daemonVersion: DAEMON_VERSION }) });
    await until(async () => (await provisionOf(placeId))?.state === "done");
    // A report with no home is refused at the join, so this is a record from a wsp that took one: the paths every
    // step is built from come off that home and there are none.
    const held = (await store.get("places", placeId)) as PlaceRecord;
    await store.put("places", placeId, { ...held, provision: undefined, report: { ...held.report, login: { USER: "root", PATH: "/usr/bin" } } });
    const answer = await runtime!.places!.update(placeId);
    expect(answer.said).toBe(placeNoHomeLine("spoo"));
    expect(answer.provision).toBeUndefined();
    expect(p.calls.run).toBe(1);
  });

  it("stops with the computer's own sentence when the link goes under it, and the gate opens again", async () => {
    const p = provisioner({ throws: "spoo is not connected" });
    const { placeId } = await joined({ provision: p.wired });
    await until(async () => (await provisionOf(placeId))?.state === "stopped");
    expect((await provisionOf(placeId))!.said).toBe("spoo is not connected");
    expect(await runtime!.places!.forkingBackend(placeId)).toBeDefined();
  });

  it("writes nothing on the row when this computer holds no recipe, and says where one would be written", async () => {
    const p = provisioner({ noRecipe: "/Users/lena/.wsp/recipe.json" });
    const { placeId, added } = await joined({ provision: p.wired });
    expect(added.said).toBe(placeNoRecipeLine("spoo", "/Users/lena/.wsp/recipe.json"));
    expect(added.place.provision).toBeUndefined();
    expect(await provisionOf(placeId)).toBeUndefined();
    expect(p.calls.run).toBe(0);
  });

  it("answers a recipe this host cannot read as a computer that got no agents, not as a join that failed", async () => {
    const p = provisioner({ planThrows: "/Users/lena/.wsp/recipe.json: invalid recipe: rows: required" });
    const { added, placeId } = await joined({ provision: p.wired });
    expect(added.said).toContain("invalid recipe");
    expect(await provisionOf(placeId)).toBeUndefined();
  });

  it("asks the updater on every update, with a binary only where the computer is behind", async () => {
    const current = provisioner();
    const asked: PlaceUpdateRequest[] = [];
    const { placeId } = await joined({
      provision: current.wired,
      report: report("spoo", { daemonVersion: DAEMON_VERSION }),
      // A computer already on this daemon takes no binary, so the updater answers no landing; what it does run
      // there is wsp's own login files, whose text moves with this host and not with the daemon.
      update: async req => {
        asked.push(req);
        return undefined;
      },
    });
    await until(async () => (await provisionOf(placeId))?.state === "done");
    const answer = await runtime!.places!.update(placeId);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ name: "spoo", daemon: false });
    // Nothing landed, so no dial-back was waited for and the row carries no daemon: the recipe is what the
    // person asked for and it is all this answers.
    expect(answer.daemon).toBeUndefined();
    expect(answer.name).toBe("spoo");
    expect(answer.provision).toMatchObject({ state: "running", recipeAt: RECIPE_AT });
    await until(async () => current.calls.run === 2);

    // And a runtime that wired no updater at all, which is every runtime outside the app: the recipe alone, and
    // nothing refused.
    const bare = provisioner();
    const alone = await joined({ provision: bare.wired, report: report("mini", { daemonVersion: DAEMON_VERSION }) });
    await until(async () => (await provisionOf(alone.placeId))?.state === "done");
    const said = await runtime!.places!.update(alone.placeId);
    expect(said.daemon).toBeUndefined();
    expect(said.provision).toMatchObject({ state: "running" });
    await until(async () => bare.calls.run === 2);

    const behind = provisioner();
    const behindAsked: PlaceUpdateRequest[] = [];
    const later = await joined({
      provision: behind.wired,
      report: report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 }),
      update: async req => {
        behindAsked.push(req);
        return { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" };
      },
    });
    await until(async () => (await provisionOf(later.placeId))?.state === "done");
    const moved = await runtime!.places!.update(later.placeId);
    expect(behindAsked).toHaveLength(1);
    expect(behindAsked[0]).toMatchObject({ name: "old-macbook", daemon: true });
    expect(moved.daemon).toMatchObject({ from: DAEMON_VERSION - 1, road: "ssh" });
    expect(moved.provision?.state).toBe("running");
    await until(async () => behind.calls.run === 2);
  });

  it("keeps its own log and its outcome on that computer, under the folder wsp already owns there", async () => {
    const cmds: string[] = [];
    const p = provisioner();
    const { placeId } = await joined({ provision: p.wired, cmds });
    await until(async () => (await provisionOf(placeId))?.state === "done");
    const at = placeProvisionPaths("/home/maya");
    await until(async () => cmds.some(c => c.includes(at.result)));
    const log = cmds.filter(c => c.includes(at.log));
    // Appended, so a second batch does not replace the first, and behind its own marker so a retried exec lands once.
    expect(log.length).toBeGreaterThan(0);
    expect(log.some(c => c.includes("base64 -d >>"))).toBe(true);
    expect(log.map(written).join("\n")).toContain("Codex: installed");
    // The header names this host, the recipe it read and how many rows it planned, for a person reading the log.
    expect(log.map(written).join("\n")).toContain(`wsp zingzys-mac put the recipe of ${RECIPE_AT}`);
    // The outcome itself, written whole at the end, for a person at that computer's own shell.
    const result = cmds.filter(c => c.includes(`base64 -d > '${at.result}'`));
    expect(result).toHaveLength(1);
    expect(JSON.parse(written(result[0]!))).toMatchObject({ state: "done", rows: ROWS });
  });

  it("puts the time it was written in front of every line of that log, in UTC", async () => {
    const cmds: string[] = [];
    const p = provisioner();
    const { placeId } = await joined({ provision: p.wired, cmds });
    await until(async () => (await provisionOf(placeId))?.state === "done");
    const at = placeProvisionPaths("/home/maya");
    await until(async () => cmds.some(c => c.includes(at.result)));
    const lines = cmds.filter(c => c.includes(at.log)).flatMap(c => written(c).split("\n")).filter(l => l !== "");
    expect(lines.length).toBeGreaterThan(1);
    // The header too: every line reads the same way, so what a stage of the job took is one subtraction.
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /);
    expect(lines.some(l => l.endsWith("Codex: installed"))).toBe(true);
  });

  it("turns a job the host that drove it did not outlive into one that stopped, at the next host's first read", async () => {
    const store = memoryStore();
    const p = provisioner();
    const { placeId } = await joined({ provision: p.wired, store });
    await until(async () => (await provisionOf(placeId))?.state === "done");
    const held = (await store.get("places", placeId)) as { provision: PlaceProvision };
    await store.put("places", placeId, { ...held, provision: { ...held.provision, state: "running", at: { label: "Codex", index: 2, of: 2 } } });
    await srv!.close();
    await runtime!.close();
    // The next host over the same state file: its first read is what ends the job nothing is running.
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { ...wiring(newPlaceKeyPair()), provision: p.wired } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    // The one hydration every road waits on, which is what a host does before it serves anything.
    expect(await runtime.workspaces.list()).toEqual([]);
    expect(await provisionOf(placeId)).toMatchObject({ state: "stopped", said: PROVISION_HOST_STOPPED });
    // And the gate is open again: a workspace there is nobody's to wait for.
    expect((await provisionOf(placeId))!.at).toBeUndefined();
  });

  it("puts nothing on a computer at all on a host that wired no recipe road, and says nothing about one", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), report: report("old-macbook", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    expect(await provisionOf(placeId)).toBeUndefined();
    await expect(runtime!.places!.update(placeId)).resolves.toMatchObject({ name: "old-macbook" });
    expect(await provisionOf(placeId)).toBeUndefined();
  });
});

describe("a project on a computer you joined", () => {
  /** Every command that computer was asked to run on itself rather than in a workspace on it. */
  const onItself = (client: WsClient): string[] => {
    const ran: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { op?: string; cmd?: string };
      if (frame.op === "exec") ran.push(String(frame.cmd));
    });
    return ran;
  };

  it("is cloned by the add into the folder that computer keeps checkouts in, and that folder goes when the record does", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, HOLDS_PROJECTS)) });
    sockets.push(client.ws);
    const ran = onItself(client);
    const project = await runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing-906" });
    // The checkout is wsp's own folder on that computer, and what a workspace of it reads is outside the
    // computer's own home.
    expect(project.checkout).toBe(`/wsp/projects/${project.id}/checkout`);
    expect(project.path).toBe("/srv/landing-906");
    // One workspace of that computer did the work and was stopped; the clone ran inside it.
    expect(place.created).toHaveLength(1);
    expect(place.killed).toHaveLength(1);
    // And it read what a workspace there reads: a computer that keeps no image is worked in a copy of its own
    // directories with the shared home bound in, so the install runs on the prefix's order and its knobs rather
    // than finding whatever stands under that home.
    const envs = place.created[0]!["envs"] as Record<string, string>;
    expect(envs["PATH"]).toBe(PLACE_WORKSPACE_PATH);
    expect(envs).toMatchObject(installEnv(installHomes(TOOL_PREFIX)));
    // The remove runs one command on the computer itself, over the same link, and says what went.
    const { said } = await runtime!.projects.remove(project.id);
    // That one command reads whether the agent there kept memory for this project and then takes wsp's own
    // folder; this computer answered nothing, so the sentence ends at the checkout rather than naming a folder
    // that is not there.
    expect(ran.filter(cmd => cmd.includes("rm -rf"))).toEqual([removeScript({ dir: `/wsp/projects/${project.id}`, memoryDir: project.memoryDir })]);
    expect(said).toBe(`landing-906 is no longer a project on srv; the folder wsp kept for it there, /wsp/projects/${project.id}, is gone with its checkout`);
    expect(await runtime!.projects.list()).toEqual([]);
  });

  it("is refused in that computer's own absent sentence while it is not connected, with nothing made anywhere", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, HOLDS_PROJECTS)) });
    sockets.push(client.ws);
    // The computer says what it forks with once, then goes.
    await until(async () => runtime!.places!.offerOf(placeId) === HOLDS_PROJECTS.offer);
    client.close();
    await until(async () => (await runtime!.places!.list(0)).find(p => p.id === placeId)?.present === false);
    await expect(runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing-906" })).rejects.toThrow(absentComputer("srv", null).sentence);
    // Nothing was forked there and nothing was recorded here: the refusal comes before either.
    expect(place.created).toEqual([]);
    expect(await runtime!.projects.list()).toEqual([]);
  });
});

describe("the folders of a computer you own", () => {
  const LISTING: HostFolderListing = { dir: "/home/maya", roots: ["/home/maya", "/wsp/projects/p_1/checkout"], folders: [{ path: "/home/maya/code", repo: true }], hidden: 2 };

  /** That computer's daemon answering the folders frame, keeping every one it was asked. */
  const listsFolders = (asked: Record<string, unknown>[], answer: Record<string, unknown> = { ok: true, ...LISTING }) => (c: WsClient) =>
    c.onFrame(raw => {
      const frame = raw as unknown as Record<string, unknown>;
      if (frame["op"] !== "fs.folders") return;
      asked.push(frame);
      c.say({ id: frame["id"], ...answer });
    });

  async function mine(): Promise<WsClient> {
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    return c;
  }

  it("are read by that computer's daemon over its link, told the folder of every project recorded there, and answered as it listed them", async () => {
    const { hostKey } = await serving();
    const asked: Record<string, unknown>[] = [];
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => {
        forks(c, undefined, undefined, HOLDS_PROJECTS);
        listsFolders(asked)(c);
      },
    });
    sockets.push(client.ws);
    const project = await runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing" });
    const c = await mine();
    const listed = await c.request("host.folders", { on: placeId, dir: "/home/maya", hidden: true });
    expect(listed.ok, String(listed["error"])).toBe(true);
    expect(listed["listing"]).toEqual(LISTING);
    // The repos listing is that computer's too, over the same frame.
    expect((await c.request("host.folders", { on: placeId, repos: true })).ok).toBe(true);
    expect(asked).toEqual([
      { id: expect.anything(), op: "fs.folders", dir: "/home/maya", hidden: true, projects: [project.checkout] },
      { id: expect.anything(), op: "fs.folders", repos: true, projects: [project.checkout] },
    ]);
  });

  it("carry that daemon's own refusal, and a daemon too old to list folders is named behind rather than asked", async () => {
    const { hostKey } = await serving();
    const refusal = "/etc is outside the folders wsp browses on that computer: /home/maya";
    const asked: Record<string, unknown>[] = [];
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: listsFolders(asked, { ok: false, code: "outside-root", error: refusal }) });
    sockets.push(client.ws);
    const c = await mine();
    expect(await c.request("host.folders", { on: placeId, dir: "/etc" })).toMatchObject({ ok: false, error: refusal });
    const old = report("old-box", { daemonVersion: DAEMON_VERSION - 1 });
    const behind = await join(hostKey, { code: await code(), name: "old-box", report: old, answers: listsFolders(asked) });
    sockets.push(behind.client.ws);
    expect(await c.request("host.folders", { on: behind.placeId })).toMatchObject({ ok: false, error: placeBehindLine("old-box", placeDaemonBehind(old)!) });
    expect(asked.map(f => f["dir"])).toEqual(["/etc"]);
  });

  it("are refused on a provider in one sentence saying what to do instead, on a place nobody holds by the places there are, and on a computer that is not connected by its absent sentence", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await mine();
    const rows = await runtime!.places!.list(Date.now());
    const provider = rows.find(p => p.kind !== "computer")!;
    expect(await c.request("host.folders", { on: provider.id })).toMatchObject({ ok: false, error: providerFoldersRefusal(provider.name), kind: "usage" });
    expect(await c.request("host.folders", { on: "pl_nobody" })).toMatchObject({ ok: false, error: noSuchPlaceRefusal("pl_nobody", rows.map(p => p.name)), kind: "usage" });
    client.close();
    await until(async () => (await runtime!.places!.list(0)).find(p => p.id === placeId)?.present === false);
    expect(await c.request("host.folders", { on: placeId })).toMatchObject({ ok: false, error: absentComputer("srv", null).sentence });
  });

  it("are this computer's own when the ask names this computer or none, and a computer of yours is the host's own road alone", async () => {
    const seen: { dir?: string; hidden?: boolean; wide?: boolean }[] = [];
    const here: HostFolderListing = { dir: "/Users/dev", roots: ["/Users/dev"], folders: [], hidden: 0 };
    const { hostKey } = await serving({ folders: { list: async req => (seen.push(req), here) } });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: listsFolders([]) });
    sockets.push(client.ws);
    const c = await mine();
    expect((await c.request("host.folders", { on: HERE_PLACE_ID, hidden: true }))["listing"]).toEqual(here);
    expect((await c.request("host.folders", {}))["listing"]).toEqual(here);
    expect(seen).toEqual([{ hidden: true, wide: false }, { wide: false }]);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("host.folders", { on: placeId })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
  });
});

describe("the agents on a computer you own", () => {
  const READ = { home: "/home/maya", user: "maya", agents: [], skills: [], servers: [], refused: [] };

  /** A reader that keeps where it was asked to read and runs one line there, as the host's readers do. */
  const reading = (asked: AgentsOn[], said: string[]): AgentsReader => ({
    read: async on => {
      asked.push(on);
      if (on.kind !== "here") said.push((await on.machine.exec("id -un")).stdout);
      return READ;
    },
    tools: async (on, ask) => {
      asked.push(on);
      // The bytes a run hands its command ride the frame's stdin to the computer, which is the road a server's
      // variables take there.
      const out = on.kind === "here" ? "" : (await on.machine.exec("cat", { stdin: Buffer.from("A=1") })).stdout;
      return { auth: "open", tools: [{ name: `${ask.key} ${ask.agent} ${ask.name} ${ask.refresh === true} ${out}` }], readAt: "2026-09-24T12:00:00.000Z" };
    },
  });

  it("cover every project recorded on that computer, each at its checkout there, and an act names one of them", async () => {
    const asked: AgentsOn[] = [];
    const { hostKey } = await serving({ agentsReader: { read: async on => (asked.push(on), READ), tools: async on => (asked.push(on), { auth: "open", readAt: "2026-09-25T12:00:00.000Z" }) }, vault: {} });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: c => forks(c, undefined, undefined, HOLDS_PROJECTS) });
    sockets.push(client.ws);
    const project = await runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing" });
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    expect((await c.request("agents.read", { target: { placeId } })).ok).toBe(true);
    const tools = await c.request("servers.tools", { target: { placeId, project: project.id }, agent: "claude", name: "db" });
    expect(tools.ok, String(tools["error"])).toBe(true);
    const at = { id: project.id, name: "landing", path: project.checkout };
    expect(asked.map(on => on.projects)).toEqual([[at], [at]]);
    expect(project.checkout).toBeDefined();
  });

  it("are read over that computer's link with the login, sign-ins and versions its report carries, and answered stamped", async () => {
    const asked: AgentsOn[] = [];
    const said: string[] = [];
    const { hostKey } = await serving({ agentsReader: reading(asked, said), vault: {} });
    const lines: string[] = [];
    const sent = report("srv", { daemonVersion: DAEMON_VERSION, agents: ["claude"], agentVersions: { claude: "2.1.281 (Claude Code)" }, logins: [] });
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: sent,
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (frame["op"] !== "exec") return;
          lines.push(String(frame["cmd"]));
          c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "maya", stderr: "", truncated: false });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const answered = await c.request("agents.read", { target: { placeId } });
    expect(answered.ok, String(answered["error"])).toBe(true);
    expect(answered["report"]).toMatchObject({ ...READ, target: { placeId } });
    expect(typeof (answered["report"] as { readAt: unknown }).readAt).toBe("string");
    expect(asked).toEqual([{ kind: "box", machine: expect.anything(), login: { HOME: "/home/maya", PATH: "/usr/bin" }, signIns: { claude: "none" }, versions: { claude: "2.1.281 (Claude Code)" }, projects: [] }]);
    expect(lines).toEqual(["id -un"]);
    expect(said).toEqual(["maya"]);
    expect((await c.request("agents.read", { target: { placeId: HERE_PLACE_ID } })).ok).toBe(true);
    expect(asked.at(-1)).toEqual({ kind: "here", projects: [] });
  });

  it("hand one server's tools ask to the reader over that computer's link, its stdin riding the frame, and refuse it on a ticket", async () => {
    const asked: AgentsOn[] = [];
    const { hostKey } = await serving({ agentsReader: reading(asked, []), vault: {} });
    const frames: Record<string, unknown>[] = [];
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (frame["op"] !== "exec") return;
          frames.push(frame);
          c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: Buffer.from(String(frame["stdin"] ?? ""), "base64").toString(), stderr: "", truncated: false });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const answered = await c.request("servers.tools", { target: { placeId }, agent: "claude", name: "airtable", refresh: true });
    expect(answered.ok, String(answered["error"])).toBe(true);
    expect(answered["answer"]).toEqual({ auth: "open", tools: [{ name: `${JSON.stringify({ placeId })} claude airtable true A=1` }], readAt: "2026-09-24T12:00:00.000Z" });
    expect(asked).toEqual([expect.objectContaining({ kind: "box" })]);
    expect(frames.map(f => f["cmd"])).toEqual(["cat"]);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("servers.tools", { target: { placeId }, agent: "claude", name: "airtable" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(asked).toHaveLength(1);
  });

  it("are refused on a cloud account, on a place nobody holds, on a socket let in on a ticket, and on a runtime with no reader", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 }, agentsReader: reading([], []) });
    const { client } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const rows = await runtime!.places!.list(Date.now());
    const provider = rows.find(p => p.kind !== "computer")!;
    expect(await c.request("agents.read", { target: { placeId: provider.id } })).toMatchObject({ ok: false, error: providerAgentsRefusal(provider.name), kind: "usage" });
    expect(await c.request("agents.read", { target: { placeId: "pl_nobody" } })).toMatchObject({ ok: false, error: noSuchPlaceRefusal("pl_nobody", rows.map(p => p.name)), kind: "usage" });
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("agents.read", { target: { placeId: HERE_PLACE_ID } })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    for (const ws of sockets.splice(0)) ws.close();
    await srv!.close();
    srv = undefined;
    await runtime!.close();
    runtime = undefined;
    await serving();
    const bare = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(bare.ws);
    expect(await bare.request("agents.read", { target: { placeId: HERE_PLACE_ID } })).toMatchObject({ ok: false, error: NO_AGENTS_READER });
  });
  it("search, read, preview, add, turn off and remove skills from the host's own socket alone, each on the computer named", async () => {
    const asked: string[] = [];
    const acts: SkillsActs = {
      search: async (q, limit) => (asked.push(`search ${q} ${limit}`), [{ id: "a/b/pdf", source: "a/b", skillId: "pdf", name: "pdf", installs: 3 }]),
      get: async skill => (asked.push(`get ${skill}`), { text: "# pdf", size: 5 }),
      preview: async (on, ask) => (asked.push(`preview ${on.kind} ${ask.name}`), { text: "# pdf", size: 5 }),
      add: async (on, ask) => (asked.push(`add ${on.kind} ${ask.skill} ${(ask.agents ?? []).join(",")} ${ask.project === true}`), { path: "~/.agents/skills/pdf", agents: [{ agent: "claude", path: "~/.claude/skills/pdf" }] }),
      remove: async (on, ask) => (asked.push(`remove ${on.kind} ${ask.name}`), { removed: ["~/.agents/skills/pdf"] }),
      toggle: async (on, ask) => (asked.push(`toggle ${on.kind} ${ask.name} ${ask.on}`), { paths: ["~/.agents/skills/pdf"] }),
    };
    const { hostKey } = await serving({ agentsReader: reading([], []), skillsActs: acts });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("events.subscribe");
    const box = { placeId };
    expect(await c.request("skills.search", { q: "pdf" })).toMatchObject({ ok: true, skills: [{ id: "a/b/pdf" }] });
    expect(await c.request("skills.get", { skill: "a/b/pdf" })).toMatchObject({ ok: true, preview: { text: "# pdf", size: 5 } });
    expect(await c.request("skills.preview", { target: box, name: "pdf" })).toMatchObject({ ok: true, preview: { size: 5 } });
    expect(await c.request("skills.add", { target: { placeId: HERE_PLACE_ID }, skill: "a/b/pdf", agents: ["claude"] })).toMatchObject({ ok: true, added: { path: "~/.agents/skills/pdf" } });
    expect(await c.request("skills.toggle", { target: box, name: "pdf", on: false })).toMatchObject({ ok: true, paths: ["~/.agents/skills/pdf"] });
    expect(await c.request("skills.remove", { target: box, name: "pdf" })).toMatchObject({ ok: true, removed: ["~/.agents/skills/pdf"] });
    expect(asked).toEqual(["search pdf 20", "get a/b/pdf", "preview box pdf", "add here a/b/pdf claude false", "toggle box pdf false", "remove box pdf"]);
    await until(() => c.events.filter(e => e.type === "agents.changed").length === 3);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    const redeemer = await WsClient.connect(srv!.port);
    sockets.push(redeemer.ws);
    const device = await WsClient.connect(srv!.port, { token: String((await redeemer.request("pair.redeem", { code: await code(), name: "the phone" }))["deviceToken"]) });
    sockets.push(device.ws);
    for (const [op, extra] of [
      ["skills.search", { q: "pdf" }],
      ["skills.get", { skill: "a/b/pdf" }],
      ["skills.preview", { target: box, name: "pdf" }],
      ["skills.add", { target: box, skill: "a/b/pdf" }],
      ["skills.toggle", { target: box, name: "pdf", on: true }],
      ["skills.remove", { target: box, name: "pdf" }],
    ] as const) {
      expect(await ticketed.request(op, extra), op).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
      expect(await device.request(op, extra), op).toMatchObject({ ok: false, error: deviceHeldRefusal(op) });
    }
    expect(asked).toHaveLength(6);
  });

  it("asks for a server's icon from the host's own socket alone, and asks nothing and forgets every icon once the person turns server icons off", async () => {
    const asked: string[] = [];
    let forgot = 0;
    let on: (() => Promise<boolean>) | undefined;
    const icons: ServerIcons = { folder: "/nowhere/icons", icon: async (host, refresh, stillOn) => (asked.push(`${host} ${refresh === true}`), (on = stillOn), "data:image/png;base64,AA=="), forget: () => void (forgot += 1) };
    await serving({ serverIcons: icons });
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(await c.request("servers.icon", { host: "mcp.notion.com" })).toMatchObject({ ok: true, icon: "data:image/png;base64,AA==" });
    expect(await c.request("servers.icon", { host: "mcp.notion.com", refresh: true })).toMatchObject({ ok: true, icon: "data:image/png;base64,AA==" });
    expect(asked).toEqual(["mcp.notion.com false", "mcp.notion.com true"]);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("servers.icon", { host: "mcp.notion.com" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
    const redeemer = await WsClient.connect(srv!.port);
    sockets.push(redeemer.ws);
    const device = await WsClient.connect(srv!.port, { token: String((await redeemer.request("pair.redeem", { code: await code(), name: "the phone" }))["deviceToken"]) });
    sockets.push(device.ws);
    expect(await device.request("servers.icon", { host: "mcp.notion.com" })).toMatchObject({ ok: false, error: deviceHeldRefusal("servers.icon") });
    expect(await c.request("preferences.set", { patch: { theme: "dark" } })).toMatchObject({ ok: true });
    expect(forgot).toBe(0);
    expect(await c.request("preferences.set", { patch: { serverIcons: false } })).toMatchObject({ ok: true, preferences: { serverIcons: false } });
    expect(forgot).toBe(1);
    // An ask started before the switch went off reads it again before it keeps anything.
    expect(await on?.()).toBe(false);
    expect(await c.request("servers.icon", { host: "mcp.sentry.dev", refresh: true })).toMatchObject({ ok: true, icon: null });
    expect(asked).toHaveLength(2);
  });

  it("add, turn off and remove a server from the host's own socket alone, each on the computer named, and never log the values an add carried", async () => {
    const asked: string[] = [];
    const acts: ServersActs = {
      add: async (on, ask) => {
        asked.push(`add ${on.kind} ${ask.agent} ${ask.name} ${ask.url ?? ask.command} ${ask.project === true}`);
        if (ask.name === "echo") throw Object.assign(new Error(`refused ${JSON.stringify(ask.headers)} ${JSON.stringify(ask.env)}`), { kind: "usage" });
        return { file: "~/.claude.json" };
      },
      remove: async (on, ask) => (asked.push(`remove ${on.kind} ${ask.agent} ${ask.name} ${ask.scope}`), { file: "~/.claude.json" }),
      toggle: async (on, ask) => (asked.push(`toggle ${on.kind} ${ask.agent} ${ask.name} ${ask.on}`), { file: "~/.codex/config.toml" }),
    };
    const lines: string[] = [];
    const { hostKey } = await serving({ agentsReader: reading([], []), serversActs: acts }, { log: line => void lines.push(line) });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("events.subscribe");
    const box = { placeId };
    expect(await c.request("servers.add", { target: { placeId: HERE_PLACE_ID }, agent: "claude", name: "acme", url: "https://mcp.acme.example/mcp", headers: { Authorization: "Bearer tok-acme-x" } })).toMatchObject({ ok: true, file: "~/.claude.json" });
    expect(await c.request("servers.toggle", { target: box, agent: "codex", name: "acme", on: false })).toMatchObject({ ok: true, file: "~/.codex/config.toml" });
    expect(await c.request("servers.remove", { target: box, agent: "claude", name: "acme", scope: "home" })).toMatchObject({ ok: true, file: "~/.claude.json" });
    expect(asked).toEqual(["add here claude acme https://mcp.acme.example/mcp false", "toggle box codex acme false", "remove box claude acme home"]);
    await until(() => c.events.filter(e => e.type === "agents.changed").length === 3);
    expect(await c.request("servers.add", { target: box, agent: "claude", name: "echo", command: "npx", env: { ACME_KEY: "sk-acme-env-x" }, headers: { Authorization: "Bearer tok-acme-hdr-x" } })).toMatchObject({ ok: false });
    const refused = lines.filter(l => l.startsWith("refused servers.add"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).not.toContain("sk-acme-env-x");
    expect(refused[0]).not.toContain("tok-acme-hdr-x");
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    const redeemer = await WsClient.connect(srv!.port);
    sockets.push(redeemer.ws);
    const device = await WsClient.connect(srv!.port, { token: String((await redeemer.request("pair.redeem", { code: await code(), name: "the phone" }))["deviceToken"]) });
    sockets.push(device.ws);
    for (const [op, extra] of [
      ["servers.add", { target: box, agent: "claude", name: "acme", command: "npx" }],
      ["servers.toggle", { target: box, agent: "codex", name: "acme", on: true }],
      ["servers.remove", { target: box, agent: "claude", name: "acme" }],
    ] as const) {
      expect(await ticketed.request(op, extra), op).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
      expect(await device.request(op, extra), op).toMatchObject({ ok: false, error: deviceHeldRefusal(op) });
    }
    expect(asked).toHaveLength(4);
  });

  it("run a sign-in over that computer's link, push its steps to the asking socket alone, type its code, stop it when that socket goes, and keep keys to the host's own socket", async () => {
    const typed: string[] = [];
    const keys: string[] = [];
    let ended = 0;
    const acts: AgentsActs = {
      signInLine: async () => ({ command: "codex login --device-auth" }),
      signIn: async on => async run => {
        expect(on).toMatchObject({ kind: "box" });
        const made = await run.link.op("pty.create", { cols: 200, rows: 50 });
        run.typing(async code => void typed.push(code));
        run.emit({ state: "waiting", url: "https://auth.openai.com/codex/device", code: String(made["ptyId"]), paste: false });
        await run.stop;
        ended += 1;
      },
      key: async (agent, key) => void keys.push(`${agent} ${key}`),
      addTools: async () => ({ file: "~/.codex/config.toml" }),
    };
    const { hostKey } = await serving({ agentsReader: reading([], []), agentsActs: acts, vault: {} });
    const frames: string[] = [];
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION, logins: [] }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (typeof frame["op"] !== "string") return;
          frames.push(String(frame["op"]));
          c.say({ id: frame["id"], ok: true, ptyId: "pty_7" });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const other = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws, other.ws);
    expect((await other.request("events.subscribe")).ok).toBe(true);
    const started = await c.request("agents.signIn", { target: { placeId }, agent: "codex" });
    expect(started.ok, String(started["error"])).toBe(true);
    const signInId = String(started["signInId"]);
    await until(() => c.events.some(e => e.type === "agents.signIn"));
    expect(c.events.find(e => e.type === "agents.signIn")).toEqual({ type: "agents.signIn", signInId, state: "waiting", url: "https://auth.openai.com/codex/device", code: "pty_7", paste: false });
    expect(frames).toContain("pty.create");
    expect((await c.request("agents.signInCode", { signInId, code: "ABCD-1234" })).ok).toBe(true);
    expect(typed).toEqual(["ABCD-1234"]);
    // Asking again from the same socket joins the one it already follows, and its steps still come once.
    expect(await c.request("agents.signIn", { target: { placeId }, agent: "codex" })).toMatchObject({ ok: true, signInId });
    await new Promise(r => setTimeout(r, 20));
    expect(c.events.filter(e => e.type === "agents.signIn")).toHaveLength(1);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    for (const [op, extra] of [
      ["agents.signIn", { target: { placeId }, agent: "codex" }],
      ["agents.signInCode", { signInId, code: "x" }],
      ["agents.signInStop", { signInId }],
      ["agents.signInLine", { target: { placeId }, agent: "codex" }],
      ["agents.addTools", { target: { placeId: HERE_PLACE_ID }, agent: "codex" }],
    ] as const) {
      expect(await ticketed.request(op, extra), op).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
    }
    expect(await ticketed.request("agents.key", { agent: "claude", key: "sk-ant-oat01-x" })).toMatchObject({ ok: false, error: AGENTS_KEY_REFUSAL });
    expect((await c.request("agents.key", { agent: "claude", key: "sk-ant-oat01-x" })).ok).toBe(true);
    expect(keys).toEqual(["claude sk-ant-oat01-x"]);
    // The change goes on the one stream every socket follows; the page and the code went to the asker alone.
    await until(() => other.events.some(e => e.type === "agents.changed"));
    expect(other.events.some(e => e.type === "agents.signIn")).toBe(false);
    // Only a socket following the sign-in types into it or stops it; its stop ends it at once.
    expect(await other.request("agents.signInCode", { signInId, code: "x" })).toMatchObject({ ok: false, error: noSignInRefusal });
    expect(await other.request("agents.signInStop", { signInId })).toMatchObject({ ok: false, error: noSignInRefusal });
    expect(ended).toBe(0);
    expect((await c.request("agents.signInStop", { signInId })).ok).toBe(true);
    await until(() => ended === 1);
    // A paired computer asks for neither a key nor a sign-in's line; the host's own socket asks for the line.
    const redeemer = await WsClient.connect(srv!.port);
    sockets.push(redeemer.ws);
    const redeemed = await redeemer.request("pair.redeem", { code: await code(), name: "the phone" });
    const device = await WsClient.connect(srv!.port, { token: String(redeemed["deviceToken"]) });
    sockets.push(device.ws);
    expect(await device.request("agents.key", { agent: "claude", key: "sk-ant-oat01-y" })).toMatchObject({ ok: false, error: deviceHeldRefusal("agents.key") });
    expect(await device.request("agents.signInLine", { target: { placeId }, agent: "codex" })).toMatchObject({ ok: false, error: deviceHeldRefusal("agents.signInLine") });
    // The owner's own browser on this computer is a device too: the line and the key are the host's alone.
    const hereCode = String((await c.request("pair.issue", { here: true }))["code"]);
    const browserRedeem = await WsClient.connect(srv!.port);
    sockets.push(browserRedeem.ws);
    const browser = await WsClient.connect(srv!.port, { token: String((await browserRedeem.request("pair.redeem", { code: hereCode, name: "this Mac's browser" }))["deviceToken"]) });
    sockets.push(browser.ws);
    expect(await browser.request("agents.signInLine", { target: { placeId }, agent: "codex" })).toMatchObject({ ok: false, error: SIGN_IN_LINE_REFUSAL });
    expect(await browser.request("agents.key", { agent: "claude", key: "sk-ant-oat01-z" })).toMatchObject({ ok: false, error: AGENTS_KEY_REFUSAL });
    expect(keys).toEqual(["claude sk-ant-oat01-x"]);
    expect((await c.request("agents.signInLine", { target: { placeId }, agent: "codex" }))["line"]).toEqual({ command: "codex login --device-auth" });
    // A window that goes stops what it alone followed.
    expect((await c.request("agents.signIn", { target: { placeId }, agent: "codex" })).ok).toBe(true);
    c.close();
    await until(() => ended === 2);
  });

  it("read an agent whose login lives on that computer as signed in once its sign-in there lands, on the row and the next read, without waiting for a redial", async () => {
    const asked: AgentsOn[] = [];
    const ends: Record<string, AgentsSignInEvent["state"]> = { codex: "signed-in", claude: "signed-in" };
    const acts: AgentsActs = {
      signInLine: async () => ({ command: "codex login --device-auth" }),
      signIn: async (_on, ask) => async run => void run.emit({ state: ends[ask.agent]! }),
      key: async () => {},
      addTools: async () => ({ file: "~/.codex/config.toml" }),
    };
    const { hostKey } = await serving({ agentsReader: reading(asked, []), agentsActs: acts, vault: {} });
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [] }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (typeof frame["op"] === "string") c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "maya", stderr: "", truncated: false });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const landed = async (agent: string): Promise<void> => {
      const before = c.events.filter(e => e.type === "agents.changed").length;
      expect((await c.request("agents.signIn", { target: { placeId }, agent })).ok).toBe(true);
      await until(() => c.events.filter(e => e.type === "agents.changed").length > before);
    };
    expect((await c.request("events.subscribe")).ok).toBe(true);
    // A failed sign-in and a login kept in the home of that computer's login, which no workspace shares, change no word.
    ends["codex"] = "failed";
    await landed("codex");
    await landed("claude");
    expect((await placesOf()).find(p => p.id === placeId)!.signIns).toEqual({ claude: "none", codex: "none" });
    ends["codex"] = "signed-in";
    await landed("codex");
    expect((await placesOf()).find(p => p.id === placeId)!.signIns).toEqual({ claude: "none", codex: "signed-in" });
    expect((await c.request("agents.read", { target: { placeId } })).ok).toBe(true);
    expect(asked.at(-1)).toMatchObject({ kind: "box", signIns: { claude: "none", codex: "signed-in" } });
  });
});

describe("the forward a computer dials back through", () => {
  /** A holder that records every ask, standing each forward where it was asked. */
  function backHolder(): { holder: PlaceBackHolder; holds: { login: PlaceLogin; back: PlaceBack; home: string; moved?: (back: PlaceBack) => void }[]; calls: string[] } {
    const holds: { login: PlaceLogin; back: PlaceBack; home: string; moved?: (back: PlaceBack) => void }[] = [];
    const calls: string[] = [];
    return {
      holds,
      calls,
      holder: {
        hold: async (login, back, on, moved) => {
          holds.push({ login, back, home: on.home, ...(moved !== undefined ? { moved } : {}) });
          calls.push(`hold ${login.ssh} ${back.boxPort}`);
          return back;
        },
        release: login => void calls.push(`release ${login.ssh}`),
        door: () => {},
        close: () => void calls.push("close"),
      },
    };
  }

  const AT_DOOR: PlaceBack = { boxPort: 4640 };

  /** One add of a box that reached this host only through the forward the install stood. */
  async function addedOverTheForward(store: Store, back: PlaceBackHolder, stages: PlaceStageEvent[] = []): Promise<{ hostKey: PlaceKeyPair; placeId: string }> {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        back,
        install: async req => {
          const { client } = await join(hostKey, { code: readJoinToken(req.code).code, name: "spoo", report: report("spoo", { dialed: "http://127.0.0.1:4640" }) });
          sockets.push(client.ws);
          answersLeave(client, [], []);
          return { name: "spoo", ssh: "root@spoo", back: AT_DOOR };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    const added = await runtime.places!.add({ address: "spoo", hostUrls: DOOR, doorPort: 4640 }, Date.now());
    return { hostKey, placeId: added.place.id };
  }

  it("says the link came in over ssh where the box dialled the forward on its own loopback", async () => {
    const stages: PlaceStageEvent[] = [];
    await addedOverTheForward(memoryStore(), backHolder().holder, stages);
    const joined = stages.find(s => s.step === "join" && s.state === "done");
    expect(joined?.note).toBe("over ssh, engine none");
    expect(joined?.note).not.toContain("127.0.0.1");
  });

  it("keeps the forward an install stood held for the record it made, and writes a port it moved to onto that record", async () => {
    const store = memoryStore();
    const back = backHolder();
    const { placeId } = await addedOverTheForward(store, back.holder);
    expect(back.holds).toHaveLength(1);
    expect(back.holds[0]).toMatchObject({ login: { ssh: "root@spoo" }, back: AT_DOOR, home: "/home/maya" });
    expect((await placesOf()).find(p => p.id === placeId)?.road).toEqual({ ssh: "root@spoo", from: "127.0.0.1", back: AT_DOOR });
    back.holds[0]!.moved!({ boxPort: 23456 });
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.road?.back?.boxPort === 23456);
    expect(((await store.get("places", placeId)) as PlaceRecord).road?.back).toEqual({ boxPort: 23456 });
  });

  it("holds it again for every record that dials back through one when the host starts, and lets every one go when it stops", async () => {
    const store = memoryStore();
    const first = backHolder();
    const { hostKey } = await addedOverTheForward(store, first.holder);
    await srv!.close();
    srv = undefined;
    await runtime!.close();
    expect(first.calls.at(-1)).toBe("close");
    const again = backHolder();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { ...wiring(hostKey), back: again.holder } });
    await runtime.places!.load();
    expect(again.holds).toHaveLength(1);
    expect(again.holds[0]).toMatchObject({ login: { ssh: "root@spoo" }, back: AT_DOOR, home: "/home/maya" });
    expect(again.holds[0]!.moved).toBeDefined();
  });

  it("lets the forward go when the computer is removed, after the sweep that may ride it", async () => {
    const back = backHolder();
    const { placeId } = await addedOverTheForward(memoryStore(), back.holder);
    await runtime!.places!.remove(placeId);
    expect(back.calls.at(-1)).toBe("release root@spoo");
  });

  it("a move heard while the computer is being removed never writes the removed record back", async () => {
    const inner = memoryStore();
    let gate: Promise<void> | undefined;
    const store: Store = {
      ...inner,
      get: async (collection, id) => {
        const found = await inner.get(collection, id);
        if (collection === "places" && gate !== undefined) await gate;
        return found;
      },
    };
    const back = backHolder();
    const { placeId } = await addedOverTheForward(store, back.holder);
    let open!: () => void;
    gate = new Promise<void>(r => (open = r));
    back.holds[0]!.moved!({ boxPort: 23456 });
    await new Promise(r => setTimeout(r, 10));
    gate = undefined;
    await runtime!.places!.remove(placeId);
    open();
    await new Promise(r => setTimeout(r, 30));
    expect(await inner.get("places", placeId)).toBeUndefined();
  });

  it("lets the forward go when the add that stood it left no record", async () => {
    const back = backHolder();
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), back: back.holder, install: async () => ({ name: "spoo", ssh: "root@spoo", back: AT_DOOR }) },
      placeJoinWaitMs: 30,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await expect(runtime.places!.add({ address: "spoo", hostUrls: DOOR, doorPort: 4640 }, Date.now())).rejects.toThrow(placeNoLinkLine("spoo"));
    expect(back.calls).toEqual(["release root@spoo"]);
  });

  it("hands the install the door's own port and the relay's address off the host's door", async () => {
    let handed: PlaceInstallRequest | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async req => {
          handed = req;
          throw new Error("stop here");
        },
      },
    });
    const relay = "https://h645d7f8a8d48cbd6.example";
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, door: { open: async () => ({ port: 4640, addresses: DOOR, relay, backPort: 4640 }) } });
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    await c.request("places.add", { address: "root@spoo" });
    c.close();
    expect(handed).toMatchObject({ hostUrls: [...DOOR, relay], doorPort: 4640, relay });
  });
});

describe("a computer that turns unable to run workspaces keeps its link, and refuses only what runs inside a copy", () => {
  const BLOCKED = "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1";
  const blocked = (): PlaceReport => report("srv", { daemonVersion: DAEMON_VERSION, runsWorkspaces: false, workspacesBlocked: BLOCKED });
  const SAID = placeCannotBootLine("srv", BLOCKED);

  /** A workspace forked on srv while it ran workspaces, then srv dialling back with its doctor saying it no longer
   * can, as it does after a reboot into a kernel line without cgroup v2. */
  const blockedFork = async (
    opts: { update?: PlaceUpdater; before?: (id: string) => Promise<void>; adapter?: HarnessAdapterFactory } = {},
  ): Promise<{ place: () => ForkingPlace; placeId: string; made: { id: string; machineId: string }; turns: string[]; renamed: string[] }> => {
    const turns: string[] = [];
    const renamed: string[] = [];
    const factory: HarnessAdapterFactory = opts.adapter ?? (() => ({
      steers: false,
      renameSession: async (_id, title) => (renamed.push(title), { kind: "written" }),
      start: ({ onEvent }) => {
        turns.push("started");
        const sessionId = randomUUID();
        const result: TurnResult = { status: "completed", text: "ok" };
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    }));
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }, opts.update), placeRelinkWaitMs: 50, killConfirm: { graceMs: 40, pollMs: 1 } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId, pair } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ project: (await projectOn(runtime, "srv")).id, golden: "snap_g", name: "work" });
    await opts.before?.(made.id);
    const again = await relink(hostKey, placeId, pair, blocked(), c => (place = forks(c)));
    sockets.push(again.client.ws);
    expect(again.proved, String(again.proved["error"])).toMatchObject({ ok: true });
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === true);
    return { place: () => place, placeId, made: { id: made.id, machineId: made.machineId }, turns, renamed };
  };

  it("holds the link, moves the last seen stamp, and carries the doctor's sentence on the row rather than as a refused dial", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), name: "srv" });
    sockets.push(joined.client.ws);
    const before = (await placesOf()).find(p => p.id === joined.placeId)!.lastSeenAt!;
    const absences: Record<string, unknown>[] = [];
    runtime!.events.on("place.absent", e => absences.push(e as Record<string, unknown>));
    await new Promise(r => setTimeout(r, 5));
    const again = await relink(hostKey, joined.placeId, joined.pair, report("srv", { runsWorkspaces: false, workspacesBlocked: BLOCKED }));
    sockets.push(again.client.ws);
    expect(again.proved, String(again.proved["error"])).toMatchObject({ ok: true });
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    const row = (await placesOf()).find(p => p.id === joined.placeId)!;
    expect(row.blocked).toBe(SAID);
    expect(row.dialled).toBeUndefined();
    expect(Date.parse(row.lastSeenAt!)).toBeGreaterThan(Date.parse(before));
    expect(absences.filter(e => e["said"] !== undefined)).toEqual([]);
  });

  it("refuses a send into a thread there in the doctor's sentence, and starts no turn", async () => {
    const { made, turns, place } = await blockedFork();
    const execs = place().asked["machine.exec"] ?? 0;
    await expect(runtime!.sessions.start(made.id, { prompt: "one", harness: "claude" })).rejects.toThrow(SAID);
    expect(turns).toEqual([]);
    expect(place().asked["machine.exec"] ?? 0).toBe(execs);
  });

  /** A turn opened while srv ran workspaces, still running once it cannot, as the daemon keeps containers across a restart. */
  const runningThrough = (steers: boolean) => {
    const steered: string[] = [];
    const opened: ((r: TurnResult) => void)[] = [];
    let thread = "";
    const adapter: HarnessAdapterFactory = () => ({
      steers,
      start: ({ onEvent, resume }) => {
        const sessionId = resume ?? randomUUID();
        queueMicrotask(() => onEvent({ type: "session.start", sessionId }));
        let end!: (r: TurnResult) => void;
        const finished = new Promise<TurnResult>(r => {
          end = result => {
            onEvent({ type: "turn.done", sessionId, result });
            onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
            r(result);
          };
        });
        opened.push(end);
        return { localId: sessionId, finished, interrupt: async () => end({ status: "interrupted" }), steer: async (prompt: string) => (steered.push(prompt), "accepted" as const) };
      },
    });
    const before = async (id: string): Promise<void> => {
      const started = await runtime!.sessions.start(id, { prompt: "one", harness: "claude" });
      thread = started.view().threadId!;
      await until(async () => (await runtime!.sessions.list(id))[0]?.claudeSessionId !== undefined);
    };
    return { adapter, before, steered, opened, thread: () => thread };
  };

  it("lets a send into a turn still running there join it, as a steer does, so the person can still steer or stop it", async () => {
    const through = runningThrough(true);
    const { made } = await blockedFork({ adapter: through.adapter, before: through.before });
    const joined = await runtime!.sessions.start(made.id, { prompt: "two", thread: through.thread() });
    expect(joined.outcome).toBe("steered");
    expect(through.steered).toEqual(["two"]);
    expect(through.opened).toHaveLength(1);
  });

  it("refuses a send queued behind a turn running there once that turn ends, in the doctor's sentence, and starts no turn", async () => {
    const through = runningThrough(false);
    const { made } = await blockedFork({ adapter: through.adapter, before: through.before });
    const queued = runtime!.sessions.start(made.id, { prompt: "two", thread: through.thread() });
    const settled = queued.then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    await new Promise(r => setTimeout(r, 20));
    through.opened[0]!({ status: "completed", text: "ok" });
    expect(await settled).toBe(SAID);
    expect(through.opened).toHaveLength(1);
  });

  it("refuses the panes' road, Terminal, Files and Diff, in the doctor's sentence, before a frame reaches that computer", async () => {
    const { made, place } = await blockedFork();
    await expect(runtime!.workspaces.daemonChannel(made.id, () => {})).rejects.toThrow(SAID);
    expect(place().frames).toEqual([]);
  });

  it("refuses the Browser's road to a port inside the copy in the doctor's sentence", async () => {
    const { made, place } = await blockedFork();
    await expect(runtime!.workspaces.portReach(made.id, 3000)).rejects.toThrow(SAID);
    await expect(runtime!.workspaces.portProbe(made.id, 3000)).rejects.toThrow(SAID);
    expect(place().asked["machine.previewUrl"] ?? 0).toBe(0);
  });

  it("refuses a new workspace there, the road New thread and run --on take, in the doctor's sentence, and forks nothing", async () => {
    const { place } = await blockedFork();
    const made = place().created.length;
    await expect(runtime!.workspaces.create({ project: (await projectOn(runtime!, "srv")).id, golden: "snap_g", name: "more" })).rejects.toThrow(SAID);
    expect(place().created).toHaveLength(made);
  });

  it("refuses a command inside the copy, on both of exec's roads, in the doctor's sentence", async () => {
    const { made, place } = await blockedFork();
    const execs = place().asked["machine.exec"] ?? 0;
    await expect(runtime!.workspaces.exec(made.id, "true")).rejects.toThrow(SAID);
    await expect(runtime!.workspaces.execStream(made.id, ["true"])).rejects.toThrow(SAID);
    expect(place().asked["machine.exec"] ?? 0).toBe(execs);
  });

  it("refuses the bring back in the doctor's sentence, before a git frame leaves", async () => {
    const { made, place } = await blockedFork();
    await expect(runtime!.workspaces.bringBack({ workspaceId: made.id })).rejects.toThrow(SAID);
    expect(place().frames).toEqual([]);
  });

  it("refuses a wake of a stopped copy there in the row's sentence, not the boot's words, and resumes nothing", async () => {
    const { made, place } = await blockedFork({ before: id => runtime!.workspaces.nap(id).then(() => undefined) });
    await expect(runtime!.workspaces.wake(made.id)).rejects.toThrow(SAID);
    expect(place().resumed).toBe(0);
    expect(place().asked["machine.resume"] ?? 0).toBe(0);
  });

  it("refuses naming a thread there, which writes inside the copy, in the doctor's sentence", async () => {
    let session = "";
    const { renamed } = await blockedFork({
      before: async id => {
        const started = await runtime!.sessions.start(id, { prompt: "one", harness: "claude" });
        await started.finished;
        session = started.id;
      },
    });
    await expect(runtime!.sessions.rename(session, "a name")).rejects.toThrow(SAID);
    expect(renamed).toEqual([]);
  });

  it("refuses carrying a folder into the copy or out of it in the doctor's sentence, before the bundler or the lander is asked", async () => {
    const { made } = await blockedFork();
    await expect(runtime!.projects.import({ workspaceId: made.id, source: "/s", dest: "/d", bundler: {} as never })).rejects.toThrow(SAID);
    await expect(runtime!.projects.export({ workspaceId: made.id, source: "/s", dest: "/d", lander: {} as never })).rejects.toThrow(SAID);
  });

  it("deletes a workspace there over the link", async () => {
    const { made, place } = await blockedFork();
    await runtime!.workspaces.delete(made.id);
    expect(place().killed).toContain(made.machineId);
    expect(await runtime!.workspaces.list()).toEqual([]);
  });

  it("takes the computer out over the link, asking it to sweep itself", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), name: "srv" });
    sockets.push(joined.client.ws);
    const asked: string[] = [];
    const again = await relink(hostKey, joined.placeId, joined.pair, blocked(), c => answersLeave(c, ["/root/.wsp/place.json"], asked));
    sockets.push(again.client.ws);
    expect(again.proved, String(again.proved["error"])).toMatchObject({ ok: true });
    const answer = await remove(joined.placeId);
    expect(answer["removed"]).toBe(true);
    expect(asked).toEqual(["place.leave"]);
  });

  it("hands the update pass the link", async () => {
    const asked: PlaceUpdateRequest[] = [];
    const { placeId } = await blockedFork({ update: async req => void asked.push(req) });
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const answer = await c.request("places.update", { placeId });
    c.close();
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.link).toBeDefined();
  });
});
