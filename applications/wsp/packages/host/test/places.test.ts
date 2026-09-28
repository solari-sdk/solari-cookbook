// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { execFile, execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { promisify } from "node:util";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A seam between a join's key and its place file, where another process's leave or a crash would land. */
const fsHooks = vi.hoisted(() => ({ beforeLink: undefined as (() => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    linkSync: (existing: import("node:fs").PathLike, path: import("node:fs").PathLike) => {
      fsHooks.beforeLink?.();
      return fs.linkSync(existing, path);
    },
  };
});
afterEach(() => {
  fsHooks.beforeLink = undefined;
});
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { ALREADY_JOINED_LINE, DAEMON_VERSION, configHardLinkRefusal, backUrl, PLACE_LOGIN_REFUSED_KIND, hostKeyAsk, hostKeyMismatchRefusal, hostKeyUnconfirmedRefusal, hostKeyUnscannableRefusal, PLACE_ROOT_SHELLS, placeRootShellRefusal, addedProjectLine, addedProjectOn, agentsCell, placeCurrentLine, placeNoRecipeLine, placeProvisioningLine, provisionWord, type PlaceProvision, JOIN_NO_KEY_REFUSAL, PLACE_LEAVE_LINE, PLACE_LEAVE_VERB, PLACE_ADD_WORDS, PLACE_CODE_REFUSAL, PLACE_DOOR_UNSERVED, PLACE_NEEDS_ROOT_LINE, PlaceReport, doorPortHeldLine, joinKeyRefusal, joinToken, placeFileText, MCP_ID_PREFIX, placeDaemonBehind, placeDaemonPaths, placeKeptForLinkLine, placeLinkTranscript, placeNoChipLine, placeOwnedPaths, placeProvisionPaths, placeUpdateLine, shellQuote, sshDaemonPaths, workFolderIn, wsUrlOf, type PlaceBack, type PlaceDoorView, type PlaceView, type SignInLine } from "@wsp/protocol";
import { CATALOG_AGENTS, CODEX_TOML } from "@wsp/catalog";
import { PlaceAddTakenBackError, PlaceLoginRefusedError, freshEphemeral, makeSeal, sealKeys, sharedSecret, type PlaceBackHolder, type PlaceLogin, type PlaceStaging, type PlaceUpdateRequest, type Seal } from "@wsp/runtime";
import { MissingKnownHostsError, missingKnownHostsLine, OWN_MARK, SshBackend, SSH_LINE_CAP, SSH_READ_SCRIPT, SSH_WORD_REFUSAL, keyFingerprint, sshWordReach, type SshLocalRun, type SshReach, type SshTransport } from "@wsp/engine";
import { daemonBinaryHere } from "../src/assets.js";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS, noGuestDaemonLine, noPlaceSystemLine } from "../src/daemon-binary.js";
import { ADD_FOUND_END, ADD_TAKEN_LINE, DAEMON_GONE_LINE, addFound, addFoundScript, addUndoScript, daemonFlags, joinedAddWrites, joinedLine, joinedPlace, loginFilesStep, PLACE_JOINED_LINE, profileSourceLine, sshDaemonPlace, WSP_READY_LINE } from "../src/doctor.js";
import { BoxBackend, type KeyCheck, type MachineBackend } from "@wsp/engine";
import { computerLines, hostPlatform, placeLines } from "../src/verbs.js";
import {
  ADD_FLAGS_REFUSAL,
  NOTHING_TO_LEAVE_LINE,
  brokenJoinLine,
  brokenPlaceLeftLine,
  joinCutByLeaveLine,
  addCommand,
  addFlags,
  addLines,
  addRefusal,
  deviceLeftLine,
  hostPlaceKey,
  hostPlaceKeyPath,
  joinCommand,
  placeDaemonFlags,
  placeInstaller,
  backRefusedLine,
  dialsBackOverSshNote,
  placeHeldRefusal,
  reachScript,
  reachedUrls,
  unreachedLine,
  placeDialler,
  placeLogReader,
  PLACE_LOG_TAIL,
  preparePlaceHome,
  joinPlace,
  addableProviders,
  leaveCommand,
  leavePlace,
  placeNameHere,
  placeStanding,
  removeCommand,
  removeLines,
  twoPlacesLine,
  stageLines,
  UNSAID_CHIP_REFUSAL,
  ADD_LOOPBACK_REFUSAL,
  advertisedLoopbackRefusal,
  hostKeyHere,
  UPDATE_FLAGS_REFUSAL,
  placeNoUpdateRoadLine,
  placeUnit,
  PLACE_NO_KEEP_LINE,
  PLACE_UPDATED_LINE,
  placeLoginFilesFailedLine,
  placeUpdateFailedLine,
  placeUpdateScript,
  placeUpdater,
  placeLeaver,
  placeLeaveFailedLine,
  updatedLines,
  SIGN_IN_FLAGS_REFUSAL,
  placeNoLoginsLine,
  boxSignInLaterLine,
  boxSignedInLine,
  joinUnansweredLine,
  addUndoneLine,
  addTakenLine,
  placeRootHomeRefusal,
} from "../src/places.js";
import { BackCutError, backBindLine, heldPlaceScript } from "../src/place-back.js";
import { placeFilePath, placeKeyPath, placeLogPath, placeReport, placeService, readPlaceFile, sweepPlace, sweptLine, sweptSaid, writePlaceFile } from "../src/place-report.js";
import { captured } from "./verbs-fixture.js";
import { SERVICE_MANAGERS, type RunResult, type ServiceAddress, type ServiceManager, type ServiceRunner, type ServiceUnit } from "../src/service.js";
import { addedBy, addedProviders } from "../src/providers.js";
import { sha256sumBin } from "../../engine/test/sha256sum-bin.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

const dirs: string[] = [];
const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${name}-`));
  dirs.push(dir);
  return dir;
};

/** The list the recipe's job leaves beside itself, as the contract fixture holds it: one line per path wsp landed
 * in an agent's home on that computer, the bytes that travelled and the bytes standing after the round. The
 * daemon's own case builds its fake home from the same file. */
const LEDGER_FIXTURE = fileURLToPath(new URL("../../../daemon/fixtures/contract/landed.tsv", import.meta.url));

/** The bytes of the three files that ledger names, in its order: what the run that landed them put there, so the
 * read that hashes a file against the ledger's third column answers for the ones nothing has rewritten. */
const LANDED_BYTES = ["the skill wsp landed\n", '{"wsp":true}\n', "wsp = true\n"];

/** That ledger as rows of a path and the bytes wsp left at it, with each hash it holds read against the bytes
 * written here, so a fixture and a case cannot drift apart quietly. */
function ledgerRows(): { rel: string; bytes: string }[] {
  const lines = readFileSync(LEDGER_FIXTURE, "utf8").split("\n").filter(line => line.trim() !== "");
  expect(lines.length, "landed.tsv holds a line per set of bytes here").toBe(LANDED_BYTES.length);
  return lines.map((line, index) => {
    const fields = line.split("\t");
    const bytes = LANDED_BYTES[index]!;
    expect(fields[2], `landed.tsv names bytes for ${fields[0]} that this file does not write`).toBe(createHash("sha256").update(bytes).digest("hex"));
    return { rel: fields[0]!, bytes };
  });
}

/** A home with that ledger and what it names: every file but the last as wsp left it, the last one rewritten by
 * the person since, and one file of theirs beside them that no line names. */
function homeWithLandedFiles(name: string): { home: string; rows: { rel: string; bytes: string }[] } {
  const home = tmp(name);
  const rows = ledgerRows();
  const at = placeProvisionPaths(home);
  mkdirSync(at.dir, { recursive: true });
  writeFileSync(at.landed, readFileSync(LEDGER_FIXTURE));
  for (const [index, row] of rows.entries()) {
    const path = join(home, row.rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, index + 1 === rows.length ? "the person wrote this\n" : row.bytes);
  }
  writeFileSync(join(home, ".claude", "theirs.md"), "mine\n");
  // A line the servers step wrote: a key in an agent's own file, no path under the home, and the digest of the
  // entry wsp left under that name. Nothing on the disk stands at it and nothing is taken for it.
  appendFileSync(at.landed, `${MCP_ID_PREFIX}claude/context7\tdeadbeef\tdeadbeef\n`);
  return { home, rows };
}

/** sh with a sha256sum to find: the script the leave runs is the engine's own and hashes the bytes with it, and a
 * Mac carries no coreutils one on every release. */
function shWithSha256sum(): (script: string) => string {
  const bin = sha256sumBin();
  dirs.push(bin);
  return script => execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
}

/** Every manager command answered as if it worked, with what was asked kept. */
function fakeRunner(): { run: ServiceRunner; ran: string[][]; holds: boolean } {
  const state = { run: (() => Promise.resolve({ code: 0, output: "" })) as ServiceRunner, ran: [] as string[][], holds: true };
  state.run = (argv): Promise<RunResult> => {
    state.ran.push([...argv]);
    // `holds` is the one answer a stop turns on: a manager that says it has the unit is asked to unload it.
    if (argv.includes("print") || argv.includes("is-enabled")) return Promise.resolve({ code: state.holds ? 0 : 113, output: state.holds ? "" : "could not find service" });
    return Promise.resolve({ code: 0, output: "" });
  };
  return state;
}

interface FakeHost {
  url: string;
  publicKey: string;
  /** The join frames it saw, so a test can read the report and the key a computer sent. */
  frames: Record<string, unknown>[];
}

async function fakeHost(opts: { wrongKey?: boolean; strangerKey?: boolean; refuse?: string; hostUrls?: string[]; unreadable?: boolean } = {}): Promise<FakeHost> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const other = generateKeyPairSync("ed25519");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const frames: Record<string, unknown>[] = [];
  wss.on("connection", ws => {
    ws.on("error", () => {});
    /** Set once this host has answered the join: from the prove on the link is sealed both ways. */
    let seal: Seal | undefined;
    ws.on("message", raw => {
      const frame = JSON.parse(seal === undefined ? String(raw) : seal.unseal(raw as Uint8Array)) as Record<string, unknown>;
      frames.push(frame);
      if (frame["op"] === "place.join") {
        if (opts.refuse !== undefined) {
          ws.send(JSON.stringify({ id: frame["id"], ok: false, error: opts.refuse, kind: "auth" }));
          ws.close(4401, "unauthorized");
          return;
        }
        if (opts.unreadable === true) {
          ws.send(JSON.stringify({ id: frame["id"], ok: true }));
          return;
        }
        const placeId = "p_ab12cd34ab12cd34";
        const nonce = Buffer.alloc(32, 5).toString("base64");
        const mine = freshEphemeral();
        const bytes = placeLinkTranscript("host", placeId, String(frame["nonce"]), nonce, { challenger: String(frame["ephemeral"]), answerer: mine.publicKey });
        // A host whose signature is made by a key other than the one it sent is the one thing a join must refuse.
        // A stranger answering at the host's address holds a key of its own and signs the transcript with it
        // perfectly well: what tells it from the host is which key it is, not whether it can sign.
        const answering = opts.strangerKey === true ? other.publicKey.export({ type: "spki", format: "der" }).toString("base64") : key.publicKey;
        const signature = sign(null, bytes, opts.wrongKey === true || opts.strangerKey === true ? other.privateKey : createPrivateKey(key.pem)).toString("base64");
        ws.send(
          JSON.stringify({
            id: frame["id"],
            ok: true,
            placeId,
            hostPublicKey: answering,
            nonce,
            signature,
            ephemeral: mine.publicKey,
            hostName: "zingzy-mbp",
          }),
        );
        seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, String(frame["ephemeral"])), placeId), "host");
        return;
      }
      if (frame["op"] === "place.prove") {
        // The token the window asked for rides the sealed reply to the prove, since the code that bought it
        // crossed on this frame and no earlier.
        ws.send(seal!.seal(JSON.stringify({ id: frame["id"], ok: true, ...(frame["client"] === undefined ? {} : { device: { deviceId: "d_1", deviceToken: "dev-token" } }) })));
      }
    });
  });
  const port = await new Promise<number>((done, fail) => {
    wss.once("listening", () => done((wss.address() as { port: number }).port));
    wss.once("error", fail);
  });
  return { url: `http://127.0.0.1:${port}`, publicKey: key.publicKey, frames };
}

/** A port this computer held a moment ago and holds no longer, so a dial at it is refused rather than left hanging. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port));
  });
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

/** The systemd this computer's real one stands in for in these tests: the module as it is, with the machine's unit
 * folder under the test's own home. Where a place's unit actually lands is pinned on the module itself, in
 * service.test.ts; nothing here writes into the real /etc. */
const unitsUnder = (home: string): ServiceManager => {
  // The machine's own folder moved under this test's home; a login's folder already sits under the home it is handed.
  const here = (unit: ServiceUnit): ServiceUnit => (unit.path.startsWith("/etc/") ? { name: unit.name, path: join(home, "etc-systemd-system", unit.name) } : unit);
  return {
    ...SERVICE_MANAGERS.systemd,
    unit: at => here(SERVICE_MANAGERS.systemd.unit(at)),
    held: at => SERVICE_MANAGERS.systemd.held(at).map(held => ({ ...held, unit: here(held.unit) })),
  };
};

/** The one token a join line carries, for the host a test started: the code that host will spend and the
 * fingerprint of the key it will prove. */
const codeFor = (host: FakeHost, code: string): string => joinToken(code, keyFingerprint(host.publicKey));

/** A token naming a key no host in these tests holds, for the dials that reach nothing at all. */
const NOWHERE_CODE = joinToken("X", `SHA256:${"a".repeat(43)}`);

const joinDepsFor = (home: string, runner: ServiceRunner): Parameters<typeof joinCommand>[3] => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: runner,
  platform: "linux",
  home,
  now: () => 0,
  manager: unitsUnder(home),
  uid: 0,
});

describe("a join the host never answered", () => {
  it("names the address and the wait, then what to do, and reads whole behind the app's install sentence", () => {
    const line = joinUnansweredLine("http://100.129.166.28:4640");
    expect(line).toBe("the host at http://100.129.166.28:4640 did not answer in 20 s; put both computers on one network, or link that host to your relay, and try again");
    // The app reads it as the box's last stderr line behind "<name> took wsp but could not connect back: ", cut at 300.
    expect(`spoo took wsp but could not connect back: ${line}`.length).toBeLessThanOrEqual(300);
  });
});

describe("what wsp add prints with no argument", () => {
  it("names the line to type on that computer at every address this host answers on, and the other two roads", () => {
    const token = joinToken("7QK3M2VD", `SHA256:${"b".repeat(43)}`);
    const lines = addLines(token, 600_000, 0, ["http://192.168.1.20:4400"], "p_ab12cd34.singhi.me").join("\n");
    // One word beside --code on every address: the code the host will spend and the key it will prove.
    expect(lines).toContain(`wsp join http://192.168.1.20:4400 --code ${token}`);
    expect(lines).toContain(`wsp join https://p_ab12cd34.singhi.me --code ${token}`);
    expect(lines).toContain("spent by the first join");
    expect(lines).toContain("wsp add user@host");
    for (const id of addableProviders()) expect(lines).toContain(`wsp add ${id}`);
  });

  it("leaves the relay line out when the host is on no relay", () => {
    expect(addLines(joinToken("X", `SHA256:${"b".repeat(43)}`), 1, 0, ["http://10.0.0.2:4400"], undefined).join("\n")).not.toContain("relay");
  });

  it("takes every provider the table says how to add, and nothing it names no way of adding", () => {
    // Read off the table, never off an id: the row that holds no machine is no place to add at all.
    expect(addableProviders()).toEqual(["box", "solari"]);
    // How a row is added is read off the row's own facts: a row that declares the variable it reads a key from is
    // opened by that key, and is not asked to say so twice.
    expect(addedProviders().map(m => addedBy(m))).toEqual(["key", "key"]);
    expect(addedProviders().map(m => [m.id, m.keyEnv !== undefined])).toEqual([["box", true], ["solari", true]]);
    expect(addableProviders()).not.toContain("none");
    expect(addRefusal("nonsense")).toContain("box, solari");
    expect(addRefusal("nonsense")).toContain("user@host");
    expect(addRefusal("nonsense")).toContain("wsp add with no argument");
    expect(addRefusal("nonsense")).toContain("an alias your ssh config gives a HostName");
    expect(addRefusal("nonsense")).not.toMatch(/\.\s+\S/);
  });
});

/** Every dependency the two host-side words take, with the provider check answered here: a unit test calls no
 * provider. The dial is the one road that reaches a host, and the tests that take it hand their own. */
/** The sign-in on a computer you own, answered here: a unit test opens no pty on a box. A test that means to
 * exercise it hands its own signIn and reads what it was given. */
/** An ssh client config holding one block, spoo renamed to its address with root as its user and the port given,
 * and nothing else: every other word comes back as its own hostname, which is what `ssh -G` prints for a name no
 * block renames. Nothing here runs the real client. */
const spooConfig =
  (port = 22): SshLocalRun =>
  async (_file, args) => {
    const word = args.at(-1)!;
    const stdout = word === "spoo" ? `user root\nhostname 178.156.161.168\nport ${port}\n` : `user dev\nhostname ${word}\nport 22\n`;
    return { exitCode: 0, stdout, stderr: "" };
  };

const noBoxSignIn = {
  sshWord: (word: string, o: { port?: number; keyPath?: string }) => sshWordReach(word, o, spooConfig()),
  // Every road that is not the first dial of a stranger reads a computer this Mac's client has already met, and
  // none of them reaches the real client: a scan leaves this computer.
  heldHostKey: async (): Promise<string | undefined> => "ssh-ed25519 SHA256:held",
  offeredHostKey: async (): Promise<{ key?: string; stoppedBy?: string }> => ({ key: "ssh-ed25519 SHA256:offered" }),
  terminal: { input: new PassThrough() as never, output: new PassThrough() as never },
  open: async () => false,
  placeLink: async () => ({ link: { op: async () => ({ ok: true }), onEvent: () => () => {} }, close: async () => undefined }),
  signIn: async () => ({ signedIn: false, said: "nothing signs in on this road" }),
};

const systemPlaceDeps: Parameters<typeof addCommand>[4] = {
  dial: () => Promise.reject(new Error("no host is dialled on this road")),
  now: () => 0,
  run: fakeRunner().run,
  platform: "linux",
  checkKey: async () => ({ state: "taken" }),
  ...noBoxSignIn,
};

const opts = (home: string, env: Record<string, string | undefined> = {}): Parameters<typeof addCommand>[1] => ({
  statePath: join(home, "state.json"),
  home,
  env: { HOME: home, WSP_HOME: home },
  providerEnv: env,
});

describe("a provider as a place", () => {
  it("puts the key to a provider that is opened by one, and writes nothing when it is refused", async () => {
    const home = tmp("add-provider-key");
    const put: MachineBackend[] = [];
    const refusing = { ...systemPlaceDeps, checkKey: async (b: MachineBackend): Promise<KeyCheck> => (put.push(b), { state: "refused", said: "box said 401 invalid token" }) };
    const io = captured();
    expect(await addCommand(io, opts(home, { BOX_API_KEY: "sk-ant-x" }), ["box"], {}, refusing)).toBe(1);
    expect(io.errors.join("\n")).toContain("401");
    expect(existsSync(join(home, ".env"))).toBe(false);
    // The key is put to the provider being added, built out of the environment that carries every row's key under
    // the variable that row declares.
    expect(put).toHaveLength(1);
    expect(put[0]).toBeInstanceOf(BoxBackend);
    // A key the provider took sets this computer up for it and nothing of the key is written or printed.
    const taking = { ...systemPlaceDeps, checkKey: async () => ({ state: "taken" }) as const };
    const good = captured();
    expect(await addCommand(good, opts(home, { BOX_API_KEY: "sk-ant-x" }), ["box"], {}, taking)).toBe(0);
    expect(good.lines.join("\n")).toContain("place box");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("WSP_PROVIDER=box\n");
    expect(good.lines.join("\n") + good.errors.join("\n")).not.toContain("sk-ant-x");
  });

  it("writes the pick beside the state file it was run against, which is what the host serving it reads", async () => {
    const home = tmp("add-provider-beside");
    const folder = join(home, "elsewhere");
    mkdirSync(folder, { recursive: true });
    const beside = { ...opts(home, { BOX_API_KEY: "sk-ant-x" }), statePath: join(folder, "state.json") };
    const io = captured();
    expect(await addCommand(io, beside, ["box"], {}, systemPlaceDeps)).toBe(0);
    expect(readFileSync(join(folder, ".env"), "utf8")).toBe("WSP_PROVIDER=box\n");
    // The wsp home's own file is another host's, and this add never touched it.
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("refuses the ssh road's own flags when no computer was named beside them", async () => {
    const home = tmp("add-name");
    const io = captured();
    expect(await addCommand(io, opts(home, {}), [], { name: "box" }, systemPlaceDeps)).toBe(1);
    expect(io.errors).toEqual([ADD_FLAGS_REFUSAL]);
    expect(io.errors[0]).toContain("wsp join");
  });
});

describe("the table wsp places prints", () => {
  const rows: PlaceView[] = [
    { id: "here", kind: "computer", name: "zingzys-mac", default: false, shape: { cpu: 8, memMb: 16384 }, engine: "docker", present: true, takesForks: false },
    { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 831 * 1024 ** 3, engine: "none", present: true, lastSeenAt: "2026-09-12T00:00:00.000Z", takesForks: true },
    { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.018, takesForks: true },
  ];

  it("carries the cores, the memory, the free disk, its engine and the presence, with the default marked once, and no column for whether it runs workspaces", () => {
    const printed = placeLines(rows);
    expect(printed[0]).toContain("PLACE");
    expect(printed[0]).toContain("DISK FREE");
    // Every place on this list forks, so the column that said yes or no said one word forever.
    expect(printed[0]).not.toContain("WORKSPACES");
    expect(printed[0]).toContain("ENGINE");
    expect(printed[1]).toContain("zingzys-mac");
    expect(printed[2]).toContain("box");
    expect(printed[2]).toContain("default");
    expect(printed[3]).toContain("$0.018/hr");
    expect(printed.filter(l => l.includes("default"))).toHaveLength(1);
  });

  it("says beside the engine how a workspace's copy of a project is made there, and nothing for a place that has not said", () => {
    const printed = placeLines([{ ...rows[1]!, copies: "reflink" }, rows[0]!, rows[2]!]);
    // Beside the engine: both are what that computer brings to a workspace rather than what one asked for.
    const header = printed[0]!;
    expect(header).toContain("COPIES");
    expect(header.indexOf("COPIES")).toBeGreaterThan(header.indexOf("ENGINE"));
    expect(printed[1]).toContain("reflink");
    // The columns line up: the word sits under its own heading rather than in the one beside it.
    const column = (line: string): string => line.slice(header.indexOf("COPIES"), header.indexOf("PRESENT")).trim();
    expect(column(printed[1]!)).toBe("reflink");
    expect(column(printed[2]!)).toBe("");
    expect(column(printed[3]!)).toBe("");
  });

  it("says how to get one when the host holds none", () => {
    expect(placeLines([]).join("")).toContain("wsp add prints the join line");
  });

  it("says on the row what a copy of the image there is doing, and nothing where the copy stands", () => {
    const printed = placeLines([{ ...rows[1]!, build: "building your image · creating the machine" }, rows[2]!]);
    expect(printed[0]).toContain("IMAGE");
    expect(printed[1]).toContain("building your image · creating the machine");
    expect(printed[2]).not.toContain("building");
  });

  it("says on the row that a computer runs an older daemon than this wsp deploys, in one word naming both versions", () => {
    const printed = placeLines([
      { ...rows[1]!, daemonVersion: DAEMON_VERSION - 5 },
      { ...rows[0]!, id: "p_2", name: "laptop", daemonVersion: DAEMON_VERSION },
    ]);
    expect(printed[0]).toContain("BEHIND");
    expect(printed[1]).toContain(`daemon ${DAEMON_VERSION - 5}, host ${DAEMON_VERSION}`);
    // The word is the protocol's own, so this row and the app's table cannot say it two ways.
    expect(printed[1]).toContain(placeDaemonBehind({ daemonVersion: DAEMON_VERSION - 5 })!);
    // A computer on this wsp's own daemon says nothing in that column, and neither does one that never reported.
    expect(printed[2]).not.toContain("daemon");
    expect(placeLines([rows[2]!])[1]).not.toContain("daemon");
  });

  it("says on the computers table what the recipe on that computer is doing, and nothing for a cloud or this Mac", () => {
    const job: PlaceProvision = { state: "running", addId: "a_1", recipeAt: "2026-09-17T10:00:00.000Z", startedAt: "2026-09-17T10:01:00.000Z", rows: [], at: { label: "Codex", index: 3, of: 7 } };
    const printed = computerLines([{ ...rows[1]!, provision: job }, rows[0]!, rows[2]!], "darwin");
    const header = printed[0]!;
    expect(header).toContain("TOOLS");
    const column = (line: string): string => line.slice(header.indexOf("TOOLS")).trim();
    // The word is the protocol's own, so this table and the app's row cannot say it two ways.
    expect(column(printed[1]!)).toBe(provisionWord(job));
    expect(column(printed[1]!)).toBe("setting up 3/7: Codex");
    expect(column(printed[2]!)).toBe("");
    expect(column(printed[3]!)).toBe("");
    // Once it is over the same column says what stands.
    const over = computerLines([{ ...rows[1]!, provision: { ...job, state: "done", at: undefined, rows: [{ id: "agents/codex", label: "Codex", outcome: "installed" }] } }], "darwin");
    expect(over[1]!.slice(over[0]!.indexOf("TOOLS")).trim()).toBe("1 tool ready");
  });

  it("says on the computers table which agents stand on a computer, at which version and signed in how", () => {
    const spoo = { ...rows[1]!, agents: ["claude", "codex"], agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" }, signIns: { claude: "vault-key" as const, codex: "none" as const } };
    const printed = computerLines([spoo, rows[0]!, rows[2]!], "darwin");
    const header = printed[0]!;
    expect(header).toContain("AGENTS");
    const column = (line: string): string => line.slice(header.indexOf("AGENTS")).trim();
    // The cell is the protocol's own, so this table and the app's row cannot say it two ways.
    expect(column(printed[1]!)).toBe(agentsCell(spoo));
    expect(column(printed[1]!)).toBe("claude 2.1.270 your key, codex 0.153.0 not signed in");
    // This computer reports no agent of its own on this row, and neither does a cloud account.
    expect(column(printed[2]!)).toBe("");
    expect(column(printed[3]!)).toBe("");
  });

  it("says nothing in the image column across the three states of the recipe, while the tools column beside it says what is happening", () => {
    const job: PlaceProvision = { state: "running", addId: "a_1", recipeAt: "2026-09-17T10:00:00.000Z", startedAt: "2026-09-17T10:01:00.000Z", rows: [], at: { label: "your agents' files", index: 36, of: 37 } };
    const done: PlaceProvision = { ...job, state: "done", at: undefined, rows: [{ id: "agents/codex", label: "Codex", outcome: "installed" }] };
    const of = (place: PlaceView): { image: string; tools: string } => {
      const printed = computerLines([place], "darwin");
      const header = printed[0]!;
      const line = printed[1]!;
      return { image: line.slice(header.indexOf("IMAGE"), header.indexOf("TOOLS")).trim(), tools: line.slice(header.indexOf("TOOLS"), header.indexOf("AGENTS")).trim() };
    };
    // A computer that keeps no image says nothing in that column in any state of the job, and the refusal a fork
    // there meets while the job runs is never one of them.
    expect(of(rows[1]!)).toEqual({ image: "", tools: "" });
    expect(of({ ...rows[1]!, provision: job })).toEqual({ image: "", tools: "setting up 36/37: your agents' files" });
    expect(of({ ...rows[1]!, provision: done })).toEqual({ image: "", tools: "1 tool ready" });
  });

  it("says how many forks a place holds of how many it takes, and nothing there for one that has not said yet", () => {
    const printed = placeLines([
      { ...rows[1]!, forks: { running: 1, room: 2 } },
      { ...rows[0]!, id: "p_2", name: "laptop", engine: "none" },
    ]);
    expect(printed[0]).toContain("FORKS");
    expect(printed[1]).toContain("1 of 3");
    expect(printed[2]).not.toContain("of");
  });
});

describe("what a remove prints", () => {
  it("names what came off the computer and the note for a place that was off, and says nothing about workspaces, since a remove is refused while forks stand", () => {
    const lines = removeLines("box", { swept: ["the systemd user unit", "/home/maya/.wsp/place.json"], note: "box is off this host" }).join("\n");
    expect(lines).toContain("removed from box:");
    expect(lines).toContain("  the systemd user unit");
    expect(lines).toContain("box is off this host");
    expect(lines).toContain("box is no longer a place in this wsp.");
  });

  it("names the ids when two places share a name, since ids tell them apart and names are the person's", () => {
    expect(twoPlacesLine("box", ["p_1", "p_2"])).toContain("p_1, p_2");
  });
});

describe("the host's own key", () => {
  it("is made once beside the state file, at the person's own mode, and read back after", () => {
    const dir = tmp("host-key");
    const statePath = join(dir, "state.json");
    const first = hostPlaceKey(statePath);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(hostPlaceKey(statePath)).toEqual(first);
    expect(statSync(hostPlaceKeyPath(statePath)).mode & 0o777).toBe(0o600);
  });

  it("writes a fresh pair over a file that is not one, since a place that pinned the old key says so on its next dial", () => {
    const dir = tmp("host-key-bad");
    const statePath = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(hostPlaceKeyPath(statePath), "not a key");
    expect(hostPlaceKey(statePath).privateKeyPem).toContain("PRIVATE KEY");
  });
});

describe("what this computer says about itself", () => {
  it("names itself by its own name lowercased, reads its own shape, and says which line runs wsp here", () => {
    const home = tmp("report-home");
    const report = placeReport({ name: placeNameHere(), home, env: { PATH: "/usr/bin", HOME: home } });
    expect(report.name).toBe(report.name.toLowerCase());
    expect(report.shape.cpu).toBeGreaterThan(0);
    expect(report.login["HOME"]).toBe(home);
    expect(report.wsp.length).toBeGreaterThan(0);
    expect(["darwin", "linux"]).toContain(report.platform);
    // How long it has been up rides the report, so a row for a computer that stopped answering says what it last
    // was rather than standing at pending for a fact nothing is coming back with.
    expect(report.uptimeMs).toBeGreaterThan(0);
  });

  it("reads the PATH a login shell here gives, not the one the shell that typed the join happened to hold", () => {
    const home = tmp("report-path");
    // A login file of the person's own, which a service's bare environment would never have read: without HOME a
    // login shell reads none of their files and answers the service's own PATH.
    writeFileSync(join(home, ".profile"), `export PATH=${home}/bin:$PATH\n`);
    // A service starts with almost no environment: what the agent reports has to be the person's own login PATH,
    // or every tool they installed under their home is unfindable to a turn.
    const report = placeReport({ name: "x", home, env: { PATH: "/only/this", HOME: home } });
    expect(report.login["PATH"]).not.toBe("/only/this");
    expect(report.login["PATH"]).toContain(`${home}/bin`);
  });

  it("leaves a store folder that is not a plain path out of the login, since what is there lands in a command", () => {
    const home = tmp("report-store");
    const report = placeReport({ name: "x", home, env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/tmp/a; rm -rf /" } });
    expect(report.login["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });
});

describe("a computer joining a wsp", () => {
  it("writes the place file and the key at the person's own mode, installs the agent as a service, and says so", async () => {
    const home = tmp("join-home");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "7QK3M2VD"), name: "old-macbook" }, joinDepsFor(home, runner.run))).toBe(0);
    const file = readPlaceFile(placeFilePath(home))!;
    expect(file).toMatchObject({ placeId: "p_ab12cd34ab12cd34", name: "old-macbook", hostUrls: [host.url], hostPublicKey: host.publicKey });
    expect(statSync(placeFilePath(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(placeKeyPath(home), "utf8")).toContain("PRIVATE KEY");
    expect(statSync(placeKeyPath(home)).mode & 0o777).toBe(0o600);
    // The service runs the daemon itself, under the place's own name rather than the host's.
    expect(runner.ran.some(argv => argv.includes("enable") && argv.some(w => w.startsWith("wsp-place-")))).toBe(true);
    const unit = join(home, "etc-systemd-system");
    const written = readFileSync(join(unit, readdirSync(unit)[0]!), "utf8");
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain("'--kind' 'place'");
    expect(written).toContain(`'--place-file' ${shellQuote(placeFilePath(home))}`);
    // The home is stated in the unit: the daemon keeps its files under the home its place file sits in, and a
    // manager handing it the login's own default would put them somewhere else.
    expect(written).toContain(`HOME=${home}`);
    expect(io.lines.join("\n")).toContain("old-macbook joined the wsp at");
    expect(io.lines.join("\n")).toContain("wsp leave takes this computer back out.");
    // Frame one carries public values only; the report names this computer and the address it dialled, and it
    // rides the prove, inside the seal, after the host proved the key the join line named.
    const first = host.frames.find(f => f["op"] === "place.join")!;
    expect(Object.keys(first).sort()).toEqual(["ephemeral", "id", "nonce", "op", "publicKey"]);
    const sent = host.frames.find(f => f["op"] === "place.prove")!;
    expect((sent["report"] as { name: string; dialed: string }).name).toBe("old-macbook");
    expect((sent["report"] as { dialed: string }).dialed).toBe(host.url);
  });

  it("refuses a login that is not root with one sentence and writes nothing, since the agent is the machine's service", async () => {
    const home = tmp("join-plain");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    const deps = { ...joinDepsFor(home, runner.run), uid: 1000 };
    // The sentence itself, not just that something threw: every other reason a join can stop here throws too.
    const said = await joinCommand(io, [host.url], { code: codeFor(host, "7QK3M2VD"), name: "old-macbook" }, deps).then(() => "", (e: unknown) => String(e));
    expect(said).toContain(PLACE_NEEDS_ROOT_LINE);
    // Before the handshake: no place file, no key, no unit, and the host was never dialled at all.
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
    expect(existsSync(join(home, "etc-systemd-system"))).toBe(false);
    expect(runner.ran).toEqual([]);
    expect(host.frames).toEqual([]);
  });

  it("writes nothing when the host could not prove the key it sent", async () => {
    const home = tmp("join-bad-key");
    const host = await fakeHost({ wrongKey: true });
    const io = captured();
    await expect(joinCommand(io, [host.url], { code: codeFor(host, "X") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/did not prove the key/);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
  });

  it("carries the host's own refusal back and writes nothing when the code was spent", async () => {
    const home = tmp("join-spent");
    const host = await fakeHost({ refuse: "that pairing code is not one this host is waiting for" });
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "X") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/not one this host is waiting for/);
    expect(existsSync(placeFilePath(home))).toBe(false);
  });

  it("says which of the two things a person typed a refusal is about, where it is about one of them", async () => {
    // The code: the one refusal a host has for a code it is not holding, spent, expired or never minted.
    const spent = await fakeHost({ refuse: PLACE_CODE_REFUSAL });
    await expect(joinCommand(captured(), [spent.url], { code: codeFor(spent, "X") }, joinDepsFor(tmp("join-code"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "code" });
    // The address: nothing is listening there. The port was this computer's a moment ago and is free again.
    const closed = await freePort();
    await expect(joinCommand(captured(), [`http://127.0.0.1:${closed}`], { code: NOWHERE_CODE }, joinDepsFor(tmp("join-gone"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "address" });
    // A refusal about neither field carries neither: a host that would not prove its key, and any other word of its own.
    const wrong = await fakeHost({ wrongKey: true });
    await expect(joinCommand(captured(), [wrong.url], { code: codeFor(wrong, "X") }, joinDepsFor(tmp("join-key"), fakeRunner().run))).rejects.toMatchObject({ name: "Error" });
    const other = await fakeHost({ refuse: "this host takes no places while it is building your image" });
    await expect(joinCommand(captured(), [other.url], { code: codeFor(other, "X") }, joinDepsFor(tmp("join-other"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "host" });
  });

  it("restarts the unit it just wrote rather than starting it, so an agent that survived runs the binary that landed", async () => {
    const home = tmp("join-restart");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, runner.run))).toBe(0);
    const unit = SERVICE_MANAGERS.systemd.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 }).name;
    // enable without --now and then restart: a start leaves a process from an earlier unit of this name running
    // the binary it was started with, which is what an install over the old one landed on, and a restart on a unit
    // that is stopped starts it.
    expect(runner.ran).toEqual([
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", unit],
      ["systemctl", "restart", unit],
    ]);
  });

  it("refuses a second join on a computer that already belongs to a wsp", async () => {
    const home = tmp("join-again");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, runner.run))).toBe(0);
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "B") }, joinDepsFor(home, runner.run))).toBe(1);
    expect(io.errors).toEqual([ALREADY_JOINED_LINE]);
  });

  it("lets one of two joins racing on one computer write its place file, and refuses the other before it writes anything", async () => {
    const home = tmp("join-race");
    const host = await fakeHost();
    const runner = fakeRunner();
    const ios = [captured(), captured()];
    const sent: string[] = [];
    // Each join's own public key, off its first frame, so the key left on disk can be traced to the join that won.
    const dialFor = (i: number) => (url: string): WebSocket => {
      const ws = new WebSocket(wsUrlOf(url));
      const send = ws.send.bind(ws) as (data: unknown) => void;
      ws.send = ((data: unknown) => {
        if (typeof data === "string" && sent[i] === undefined) sent[i] = String((JSON.parse(data) as Record<string, unknown>)["publicKey"]);
        send(data);
      }) as typeof ws.send;
      return ws;
    };
    const both = await Promise.allSettled(ios.map((io, i) => joinCommand(io, [host.url], { code: codeFor(host, `R${i}`) }, { ...joinDepsFor(home, runner.run), dial: dialFor(i) })));
    expect(both.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const lost = both.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(String(lost?.reason)).toContain(ALREADY_JOINED_LINE);
    const won = ios[both.findIndex(r => r.status === "fulfilled")]!;
    expect(won.lines.join("\n")).toContain("joined the wsp at");
    expect(ios.filter(io => io.lines.join("\n").includes("joined the wsp at"))).toHaveLength(1);
    const onDisk = createPublicKey(createPrivateKey(readFileSync(placeKeyPath(home), "utf8"))).export({ type: "spki", format: "der" }).toString("base64");
    expect(onDisk).toBe(sent[both.findIndex(r => r.status === "fulfilled")]);
  });

  it("refuses a join over a place file it cannot read, naming the file and wsp leave, and leaves the file for leave to take", async () => {
    const home = tmp("join-broken");
    const file = placeFilePath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{\"placeId\": \"p_1\", \"na");
    const host = await fakeHost();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(1);
    expect(io.errors).toEqual([brokenJoinLine(file)]);
    expect(io.errors[0]).toContain(file);
    expect(io.errors[0]).toContain(PLACE_LEAVE_LINE);
    expect(host.frames).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{\"placeId\": \"p_1\", \"na");
  });

  it("reads a key with no place file beside it, which a join cut off between its two writes leaves, as broken: join names it, leave takes it", async () => {
    const home = tmp("join-cut");
    const key = placeKeyPath(home);
    mkdirSync(dirname(key), { recursive: true });
    writeFileSync(key, "-----BEGIN PRIVATE KEY-----\n");
    const host = await fakeHost();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(1);
    expect(io.errors).toEqual([brokenJoinLine(key)]);
    expect(host.frames).toEqual([]);
    const left = captured();
    expect(await leaveCommand(left, [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    expect(existsSync(key)).toBe(false);
    expect(left.lines[0]).toBe(brokenPlaceLeftLine(key));
  });

  it("reads a dangling link at the place file as broken rather than as no file: join names it before any handshake, leave takes the link", async () => {
    const home = tmp("join-dangling");
    const file = placeFilePath(home);
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(join(home, "nowhere.json"), file);
    const host = await fakeHost();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(1);
    expect(io.errors).toEqual([brokenJoinLine(file)]);
    expect(host.frames).toEqual([]);
    expect(await leaveCommand(captured(), [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    expect(() => lstatSync(file)).toThrow();
  });

  it("claims the key before the place file and never writes it through a link planted during the handshake", async () => {
    const home = tmp("join-key-link");
    const key = placeKeyPath(home);
    const theirs = join(home, "their-file");
    writeFileSync(theirs, "mine");
    const host = await fakeHost();
    const dial = (url: string): WebSocket => {
      const ws = new WebSocket(wsUrlOf(url));
      ws.once("open", () => {
        mkdirSync(dirname(key), { recursive: true });
        symlinkSync(theirs, key);
      });
      return ws;
    };
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, { ...joinDepsFor(home, fakeRunner().run), dial })).rejects.toThrow(ALREADY_JOINED_LINE);
    expect(readFileSync(theirs, "utf8")).toBe("mine");
    expect(existsSync(placeFilePath(home))).toBe(false);
  });

  it("writes the place file whole, after the key: at the moment it lands the key is there and no place file stands", async () => {
    const home = tmp("join-order");
    const host = await fakeHost();
    const seen: boolean[] = [];
    fsHooks.beforeLink = () => seen.push(existsSync(placeKeyPath(home)), existsSync(placeFilePath(home)));
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(seen).toEqual([true, false]);
    expect(readdirSync(dirname(placeFilePath(home))).filter(f => f.startsWith(`${basename(placeFilePath(home))}.`))).toEqual([]);
  });

  it("gives way to a leave that lands between its two writes, leaving neither file behind", async () => {
    const home = tmp("join-leave-race");
    const host = await fakeHost();
    // A leave in another process finds the key with no place file beside it, reads it as broken and takes it.
    fsHooks.beforeLink = () => rmSync(placeKeyPath(home), { force: true });
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(joinCutByLeaveLine);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
  });

  it("leaves a second join's key alone when that join landed both its files between this join's two writes", async () => {
    const home = tmp("join-lost-link");
    const host = await fakeHost();
    const theirs = { placeId: "p_2", name: "other", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() };
    // A leave takes this join's key, then another join writes its own key and place file, all before this link.
    fsHooks.beforeLink = () => {
      fsHooks.beforeLink = undefined;
      rmSync(placeKeyPath(home), { force: true });
      writeFileSync(placeKeyPath(home), "their key");
      writeFileSync(placeFilePath(home), placeFileText(theirs));
    };
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(ALREADY_JOINED_LINE);
    expect(readFileSync(placeKeyPath(home), "utf8")).toBe("their key");
    expect(readPlaceFile(placeFilePath(home))?.placeId).toBe("p_2");
  });

  it("takes the code as the other screen shows it, since a person copies the code they can read", async () => {
    const home = tmp("join-dashed");
    const host = await fakeHost();
    expect(await joinCommand(captured(), [host.url], { code: `qw4k-7pzx.${keyFingerprint(host.publicKey)}` }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(String((host.frames.find(f => f["op"] === "place.prove")!)["code"])).toBe("QW4K7PZX");
  });

  it("reads the code off a file and deletes it before dialing, so a code never sits on a disk", async () => {
    const home = tmp("join-code-file");
    const host = await fakeHost();
    const codeFile = join(home, "join-code");
    writeFileSync(codeFile, `${codeFor(host, "7QK3M2VD")}\n`);
    expect(await joinCommand(captured(), [host.url], { codeFile }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(existsSync(codeFile)).toBe(false);
    expect(String((host.frames.find(f => f["op"] === "place.prove")!)["code"])).toBe("7QK3M2VD");
  });

  it("refuses a host that proves a key the join line did not name, before it sends anything of its own", async () => {
    const home = tmp("join-stranger");
    // A peer that answered where the host was expected: its own key, its own valid signature over this computer's
    // nonce. Every signature checks out; the key is not the one the line named.
    const stranger = await fakeHost({ strangerKey: true });
    const io = captured();
    await expect(joinCommand(io, [stranger.url], { code: codeFor(stranger, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(joinKeyRefusal(stranger.url));
    // Nothing of this computer's went over: no report, no signature of its own, nothing past the first frame.
    expect(stranger.frames.map(f => f["op"])).toEqual(["place.join"]);
    // And nothing was written here: no place record, no pinned key, no unit for a daemon to hold a socket open on.
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user"))).toBe(false);
  });

  it("says a join answer it cannot read on one line, since the add reads the box's last line as its sentence", async () => {
    const home = tmp("join-unreadable");
    const host = await fakeHost({ unreadable: true });
    const said = await joinCommand(captured(), [host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run)).catch((e: unknown) => (e as Error).message);
    expect(String(said)).toContain(`${host.url} answered the join with something this computer cannot read: `);
    expect(String(said)).not.toContain("\n");
    expect(String(said)).toContain("placeId");
  });

  it("joins the host whose key the line named, as it did before", async () => {
    const home = tmp("join-named-key");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, runner.run))).toBe(0);
    expect(readPlaceFile(placeFilePath(home))!.hostPublicKey).toBe(host.publicKey);
    // The code that went over is the code alone: the fingerprint is this computer's to check and no part of the frame.
    expect(host.frames.find(f => f["op"] === "place.prove")!["code"]).toBe("7QK3M2VD");
    expect(runner.ran.length).toBeGreaterThan(0);
  });

  it("refuses a line that names no key and says to run wsp add again, on the flag and on the file alike", async () => {
    const home = tmp("join-keyless");
    const host = await fakeHost();
    await expect(joinCommand(captured(), [host.url], { code: "7QK3M2VD" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(JOIN_NO_KEY_REFUSAL);
    const codeFile = join(home, "join-code");
    writeFileSync(codeFile, "7QK3M2VD\n");
    await expect(joinCommand(captured(), [host.url], { codeFile }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(JOIN_NO_KEY_REFUSAL);
    // Refused before anything is dialled: the host saw no frame and this computer wrote nothing.
    expect(host.frames).toEqual([]);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(JOIN_NO_KEY_REFUSAL).toContain("wsp add");
  });

  it("refuses both roads to a code at once", async () => {
    const home = tmp("join-usage");
    await expect(joinCommand(captured(), ["http://x"], { code: "A", codeFile: "/tmp/c" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/--code or --code-file/);
  });
});

describe("taking wsp off the computer it is typed on", () => {
  it("unloads the unit, takes every path wsp put there and keeps the work folder, and says so", async () => {
    const home = tmp("leave-home");
    const at = placeDaemonPaths(home);
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "old-macbook", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    writeFileSync(placeKeyPath(home), "key");
    writeFileSync(at.tokenPath, "token");
    writeFileSync(at.portFile, "7071");
    mkdirSync(at.inbox, { recursive: true });
    mkdirSync(at.runDir, { recursive: true });
    writeFileSync(placeLogPath(home), "linked\n");
    const work = join(home, "wsp-work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "a-thread-wrote-this"), "mine");
    const runner = fakeRunner();
    const io = captured();
    expect(await leaveCommand(io, [], { home, run: runner.run, platform: "linux" })).toBe(0);
    for (const path of [placeFilePath(home), placeKeyPath(home), placeLogPath(home), at.tokenPath, at.portFile, at.inbox, at.runDir]) expect(existsSync(path)).toBe(false);
    // The work folder is the person's own: a place that left a wsp keeps what its threads wrote.
    expect(readFileSync(join(work, "a-thread-wrote-this"), "utf8")).toBe("mine");
    const said = io.lines.join("\n");
    expect(said).toContain("old-macbook left the wsp at");
    expect(said).toContain("stays: the work your threads did there is yours");
    expect(said).toContain("wsp remove");
    // The manager was asked to stop the agent and to forget it, which is what a person running this wants to see.
    expect(runner.ran.some(argv => argv.includes("stop"))).toBe(true);
    expect(runner.ran.some(argv => argv.includes("disable"))).toBe(true);
  });

  it("takes every file wsp landed in an agent's home here whose bytes are still wsp's, and keeps the one the person wrote", async () => {
    const { home, rows } = homeWithLandedFiles("leave-landed");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: shWithSha256sum() });
    for (const row of rows.slice(0, -1)) {
      expect(existsSync(join(home, row.rel)), row.rel).toBe(false);
      expect(swept.removed).toContain(join(home, row.rel));
    }
    // The person's own copy of a file wsp once landed hashes differently, so the read never named it.
    const kept = rows.at(-1)!;
    expect(readFileSync(join(home, kept.rel), "utf8")).toBe("the person wrote this\n");
    expect(swept.removed).not.toContain(join(home, kept.rel));
    // A folder wsp's own files left empty goes with them, up to but never into the folder the agent itself owns.
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(true);
    expect(existsSync(join(home, ".codex"))).toBe(true);
    expect(readFileSync(join(home, ".claude", "theirs.md"), "utf8")).toBe("mine\n");
    // The list's server line named no path, so the leave took nothing for it and made nothing at its name.
    expect(existsSync(join(home, "agents"))).toBe(false);
    expect(swept.removed.filter(took => took.includes("agents/mcp"))).toEqual([]);
    // And wsp's own folder is gone whole, the provision folder and the ledger inside it with it.
    expect(existsSync(placeDaemonPaths(home).wsp)).toBe(false);
    expect(swept.removed.at(-1)).toBe(placeDaemonPaths(home).wsp);
  });

  it("reads what wsp owns before the folder that holds the list goes", async () => {
    const { home, rows } = homeWithLandedFiles("leave-landed-order");
    const ledger = placeProvisionPaths(home).landed;
    const sh = shWithSha256sum();
    let read = 0;
    const watched = (script: string): string => {
      read += 1;
      // The one thing the order buys: at the moment the read runs, the list it reads is still there to read.
      expect(existsSync(ledger), "the ownership read ran after the folder holding the ledger had gone").toBe(true);
      return sh(script);
    };
    await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: watched });
    // Two reads of that list, both before the folder holding it goes: which files here are wsp's own copies, and
    // which servers in the agents' own files are its own keys.
    expect(read).toBe(2);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(join(home, rows[0]!.rel))).toBe(false);
  });

  it("takes wsp's own folder whole, so nothing under it is left on a computer the person joined", async () => {
    const home = tmp("leave-whole");
    const at = placeDaemonPaths(home);
    mkdirSync(at.putDir, { recursive: true });
    writeFileSync(join(at.putDir, "797"), "half an update");
    writeFileSync(join(at.wsp, "place.json.bak-747"), "old");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: () => "" });
    expect(existsSync(at.wsp)).toBe(false);
    expect(swept.removed).toEqual([at.wsp]);
  });

  it("keeps every file of the person's on a computer the recipe never ran on", async () => {
    const home = tmp("leave-no-ledger");
    mkdirSync(join(home, ".claude", "skills", "wsp"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "theirs\n");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: shWithSha256sum() });
    expect(swept.removed.filter(line => line.startsWith("/"))).toEqual([]);
    expect(existsSync(join(home, ".claude", "skills", "wsp", "SKILL.md"))).toBe(true);
  });

  it("removes nothing through a folder a workspace replaced with a link, and says which paths stayed", async () => {
    const home = tmp("leave-linked-parent");
    const at = placeDaemonPaths(home);
    mkdirSync(at.wsp, { recursive: true });
    // The computer's own bin, holding the two names the fixed list ends on, and the shared bin a workspace
    // replaced with a link to it.
    const theirs = tmp("leave-linked-theirs");
    for (const name of ["wsp-open", "xdg-open"]) writeFileSync(join(theirs, name), "the computer's own\n");
    mkdirSync(join(home, ".local"), { recursive: true });
    symlinkSync(theirs, at.binDir);
    // And a row of the ledger whose folder is a link the same way, pointing at a file of the computer's own.
    const planted = tmp("leave-linked-planted");
    writeFileSync(join(planted, "settings.json"), "the computer's own\n");
    symlinkSync(planted, join(home, ".claude"));

    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: () => `${OWN_MARK}\t.claude/settings.json\n` });

    for (const name of ["wsp-open", "xdg-open"]) expect(readFileSync(join(theirs, name), "utf8"), name).toBe("the computer's own\n");
    expect(readFileSync(join(planted, "settings.json"), "utf8")).toBe("the computer's own\n");
    // The links are the workspace's own doing and stay; what the leave says is that it took nothing at those
    // three paths and why.
    for (const path of [join(at.binDir, "wsp-open"), join(at.binDir, "xdg-open"), join(home, ".claude", "settings.json")]) {
      expect(swept.removed, path).toContain(placeKeptForLinkLine(path));
      expect(swept.removed, path).not.toContain(path);
    }
    // Wsp's own folder is under no link and goes as it always did.
    expect(existsSync(at.wsp)).toBe(false);
    expect(swept.removed).toContain(at.wsp);
  });

  it("says this computer is no place when there is nothing to leave", async () => {
    const io = captured();
    expect(await leaveCommand(io, [], { home: tmp("leave-none"), run: fakeRunner().run, platform: "linux" })).toBe(1);
    expect(io.errors).toEqual([NOTHING_TO_LEAVE_LINE]);
  });

  it("takes a place file it cannot read off this computer, and says it was broken", async () => {
    const home = tmp("leave-broken");
    const file = placeFilePath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "not json");
    const io = captured();
    expect(await leaveCommand(io, [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(io.lines[0]).toBe(brokenPlaceLeftLine(file));
    expect(io.lines.join("\n")).toContain(file);
  });

  it("stops the agent in both scopes before its unit file goes, reloads the manager after, and says it stopped it", async () => {
    const home = tmp("leave-order");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const unit = manager.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    const swept = await sweepPlace({ home, manager, run: runner.run, uid: 0 });
    // The stop and the disable come while the file is still there: a manager asked to stop a unit whose file has
    // gone stops nothing, and the agent kept running with the place file it serves removed under it. The reload
    // follows the removal, so systemd is left holding no unit at all. The agent is the machine's service, so its
    // own systemctl carries no --user; the login's is asked too, since a computer joined before the unit became
    // the machine's has its file there and nothing else would take it.
    expect(runner.ran).toEqual([
      ["systemctl", "stop", unit.name],
      ["systemctl", "disable", unit.name],
      ["systemctl", "daemon-reload"],
      ["systemctl", "--user", "stop", unit.name],
      ["systemctl", "--user", "disable", unit.name],
    ]);
    // The file is gone and the link systemd keeps beside it was taken with it, so no start brings the agent back,
    // and the line a person reads says what a leave that left the process running never could.
    expect(existsSync(unit.path)).toBe(false);
    expect(swept.removed[0]).toBe(`systemd system unit ${unit.name} (stopped)`);
  });

  it("unloads the workspace profile and takes its file where the leave runs as root, and leaves it for any other login", async () => {
    const home = tmp("leave-apparmor");
    // A space in the folder: the path is one word to the shell or the removal takes two files that are not it.
    const profile = join(tmp("leave-apparmor-etc"), "apparmor d", "wsp-workspace");
    mkdirSync(dirname(profile));
    writeFileSync(profile, "profile wsp-workspace {}\n");
    const ran: string[] = [];
    const sh = (script: string): string => {
      ran.push(script);
      return execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    };
    const other = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 1000, apparmorProfile: profile });
    expect(existsSync(profile)).toBe(true);
    expect(other.removed).not.toContain(profile);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 0, apparmorProfile: profile });
    expect(ran.some(script => script.includes(`apparmor_parser -R ${shellQuote(profile)}`))).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(swept.removed).toContain(profile);
  });

  it("says what the manager answered when the stop refused, and still takes the file", async () => {
    const home = tmp("leave-stop-refused");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    // Every command answered as it would be, except the stop: this is a unit systemd will not let go of, which is
    // the one case where a line reading (stopped) would be telling a person something they cannot check.
    const refusing: ServiceRunner = argv => (argv[1] === "stop" || argv[2] === "stop" ? Promise.resolve({ code: 5, output: "Failed to stop: Unit is masked." }) : runner.run(argv));
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const unit = manager.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    const swept = await sweepPlace({ home, manager, run: refusing, uid: 0 });
    expect(swept.removed[0]).toBe(`systemd system unit ${unit.name} (systemctl stop ${unit.name} exited 5 and said: Failed to stop: Unit is masked.)`);
    // A manager answers in as many lines as it likes, and this line is one thing among what a leave took: a host
    // reading that leave back over ssh reads the lines by the mark in front of them, which only the first of a
    // wrapped line would carry.
    const wordy: ServiceRunner = argv =>
      argv[1] === "stop" || argv[2] === "stop" ? Promise.resolve({ code: 5, output: "Failed to stop:\n  Unit is masked.\n  See systemctl status." }) : runner.run(argv);
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    const wrapped = await sweepPlace({ home, manager, run: wordy, uid: 0 });
    expect(wrapped.removed[0]).toBe(`systemd system unit ${unit.name} (systemctl stop ${unit.name} exited 5 and said: Failed to stop: Unit is masked. See systemctl status.)`);
    expect(sweptSaid(wrapped.removed.map(line => sweptLine(line)).join("\n"))).toEqual(wrapped.removed);
    // The file goes all the same: a person running a leave has decided this computer is out of that wsp, and a
    // unit file left behind is what brings the agent back at the next boot.
    expect(existsSync(unit.path)).toBe(false);
    // And the rest of the teardown was still told: the refusal is this scope's line, not the end of the sweep.
    expect(runner.ran).toContainEqual(["systemctl", "disable", unit.name]);
    expect(runner.ran).toContainEqual(["systemctl", "daemon-reload"]);
  });

  it("takes the unit a computer joined on the older road left in that login's own systemd, and names the scope", async () => {
    const home = tmp("leave-user-scope");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const at: ServiceAddress = { role: "place", statePath: placeFilePath(home), home, uid: 0 };
    const name = SERVICE_MANAGERS.systemd.unit(at).name;
    // Only the login's own systemd holds one: a join before the place's unit became the machine's wrote it there,
    // and the machine's folder is empty, which is the whole of what the sweep used to look at.
    const login = join(home, ".config", "systemd", "user", name);
    mkdirSync(dirname(login), { recursive: true });
    writeFileSync(login, "[Unit]\n");
    expect(existsSync(manager.unit(at).path)).toBe(false);
    const swept = await sweepPlace({ home, manager, run: runner.run, uid: 0 });
    expect(existsSync(login)).toBe(false);
    expect(swept.removed).toContain(`systemd user unit ${name} (stopped)`);
    // That login's own systemd is the one told to forget it: a machine-scoped disable never reaches this unit.
    expect(runner.ran).toContainEqual(["systemctl", "--user", "disable", name]);
  });

  it("takes the servers wsp merged into an agent's own file here back out of it, and leaves that file's every other line", async () => {
    const home = tmp("leave-servers");
    const at = placeProvisionPaths(home);
    mkdirSync(at.dir, { recursive: true });
    const config = join(home, ".codex", "config.toml");
    mkdirSync(dirname(config), { recursive: true });
    const theirs = ['model = "gpt-5"', "", '[projects."/root/repo"]', 'trust_level = "trusted"', "", "[mcp_servers.mine]", 'command = "/usr/local/bin/mine"', ""];
    const text = [...theirs, "[mcp_servers.context7]", 'command = "npx"', 'args = ["-y", "context7"]', ""].join("\n");
    writeFileSync(config, text);
    const digest = createHash("sha256").update(CODEX_TOML.entryOf(text, "context7")!).digest("hex");
    // What the servers round wrote down: the key it merged in, and one whose entry the agent has rewritten since.
    writeFileSync(at.landed, `${MCP_ID_PREFIX}codex/context7\t${digest}\t${digest}\n${MCP_ID_PREFIX}codex/mine\tdeadbeef\tdeadbeef\n`);

    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: shWithSha256sum() });
    // The file is the agent's own and stays; wsp's table is out of it and every other line is where it was.
    expect(readFileSync(config, "utf8")).toBe(theirs.join("\n"));
    expect(swept.removed).toContain(`context7 (out of ${config})`);
    expect(swept.removed.some(took => took.includes("mine"))).toBe(false);
    // Nothing of wsp's own is left beside the file it wrote back.
    expect(existsSync(`${config}.wsp-new`)).toBe(false);
    expect(existsSync(placeDaemonPaths(home).wsp)).toBe(false);
  });

  it("takes nothing off a computer that took nothing: the sweep is every path named and no more", async () => {
    const home = tmp("leave-bare");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(swept.removed.filter(line => line.startsWith("/"))).toEqual([]);
    expect(swept.kept[0]).toContain(join(home, "wsp-work"));
  });
});

describe("a join with more than one address to try", () => {
  it("keeps every address it was given, the one that answered first", async () => {
    const home = tmp("join-urls");
    const host = await fakeHost();
    const io = captured();
    const args = ["http://127.0.0.1:1", host.url, "http://10.0.0.2:4400"];
    expect(await joinCommand(io, args, { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    // The one that answered, then the rest: that is the order the link dials them in from now on.
    expect(readPlaceFile(placeFilePath(home))!.hostUrls).toEqual([host.url, "http://127.0.0.1:1", "http://10.0.0.2:4400"]);
  });

  it("tries the next address when the first answers nothing, and says which one went nowhere", async () => {
    const home = tmp("join-next");
    const host = await fakeHost();
    const io = captured();
    // Port 1 on loopback answers nothing at all, which is the address an installer picked that this computer cannot route to.
    expect(await joinCommand(io, ["http://127.0.0.1:1", host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(io.errors.join("\n")).toContain("http://127.0.0.1:1");
    expect(readPlaceFile(placeFilePath(home))!.hostUrls[0]).toBe(host.url);
  });

  it("stops at a host's own refusal rather than asking its other addresses the same question", async () => {
    const home = tmp("join-refused");
    const host = await fakeHost({ refuse: "that join code is not one this host is waiting for" });
    const io = captured();
    await expect(joinCommand(io, [host.url, "http://127.0.0.1:1"], { code: codeFor(host, "SPENT") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow("not one this host is waiting for");
    expect(io.errors.join("\n")).not.toContain("http://127.0.0.1:1");
    expect(existsSync(placeFilePath(home))).toBe(false);
  });
});

describe("wsp add on a computer reached over ssh", () => {
  it("asks the host to do it, prints each step as it lands and says what joined", async () => {
    const io = captured();
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const place: PlaceView = { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, engine: "none", present: true, takesForks: true };
    const client = {
      request: async (op: string, params?: Record<string, unknown>) => {
        expect(op).toBe("places.add");
        expect(params).toMatchObject({ address: "root@10.0.0.9", name: "box", sshPort: 2222 });
        // The line minted the stream it asks under, since the steps reach the terminal before the reply does.
        const addId = String(params!["addId"]);
        expect(addId).toMatch(/^a_/);
        for (const fn of frames) {
          fn({ type: "place.stage", addId, step: "connect", state: "done", note: "Linux 6.8.0" });
          // Another client's install on the same host is another stream, and this line prints none of it.
          fn({ type: "place.stage", addId: "a_other", step: "connect", state: "done", note: "somebody else" });
        }
        return { addId, place, hostKey: "ssh-ed25519 SHA256:abc" } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: (fn: (frame: Record<string, unknown>) => void) => {
        frames.push(fn);
        return () => frames.splice(frames.indexOf(fn), 1);
      },
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never };
    expect(await addCommand(io, opts(tmp("add-ssh")), ["root@10.0.0.9"], addFlags("box", "2222", undefined), deps)).toBe(0);
    const said = io.lines.join("\n");
    expect(said).toContain(`${PLACE_ADD_WORDS.connect}: Linux 6.8.0`);
    expect(said).toContain("box joined this wsp");
    expect(said).toContain("ssh-ed25519 SHA256:abc");
    // A computer that joined runs your workspaces by definition, so the only doctor sentence left on the line is
    // the engine a project's own containers would run on there.
    expect(said).not.toContain("box runs your workspaces");
    expect(said).toContain("box has no container engine");
    expect(said).toContain("wsp remove box");
    expect(said).not.toContain("somebody else");
  });

  it("says a failed step's sentence once: the step is marked on its line and the sentence is the failure's own", async () => {
    const io = captured();
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const sentence = "root@10.0.0.9 cannot reach this computer at http://192.168.1.20:4640, so nothing of wsp's went onto it";
    const client = {
      request: async (_op: string, params?: Record<string, unknown>) => {
        const addId = String(params!["addId"]);
        for (const fn of frames) {
          fn({ type: "place.stage", addId, step: "connect", state: "done", note: "Linux 6.8.0" });
          fn({ type: "place.stage", addId, step: "reach", state: "failed", note: sentence });
        }
        throw new Error(sentence);
      },
      events: async () => {},
      onFrame: (fn: (frame: Record<string, unknown>) => void) => {
        frames.push(fn);
        return () => frames.splice(frames.indexOf(fn), 1);
      },
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never };
    await expect(addCommand(io, opts(tmp("add-ssh-failed")), ["root@10.0.0.9"], addFlags("box", "2222", undefined), deps)).rejects.toThrow(sentence);
    expect(io.lines).toContain(`  x ${PLACE_ADD_WORDS.reach}`);
    expect([...io.lines, ...io.errors].filter(line => line.includes(sentence))).toEqual([]);
  });

  it("prints the recipe's own rows as they land, after the join lines and before the sign-in it needs them for", async () => {
    const io = { ...captured(), isTTY: true, ask: async () => "no" };
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const job: PlaceProvision = {
      state: "running",
      addId: "a_mine",
      recipeAt: "2026-09-17T10:00:00.000Z",
      startedAt: "2026-09-17T10:01:00.000Z",
      rows: [],
      at: { label: "Codex", index: 1, of: 2 },
    };
    const done: PlaceProvision = {
      ...job,
      state: "done",
      at: undefined,
      rows: [
        { id: "agents/codex", label: "Codex", outcome: "installed" },
        { id: "tools/brew/gh", label: "gh", outcome: "present" },
      ],
    };
    const place: PlaceView = { id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true, agents: ["codex"], logins: "/var/lib/wsp/logins" };
    const client = {
      request: async (op: string, params?: Record<string, unknown>) => {
        if (op === "places.list") return { places: [{ ...place, provision: done }] } as Record<string, unknown>;
        expect(op).toBe("places.add");
        const addId = String(params!["addId"]);
        for (const fn of frames) {
          // The join's own steps and the recipe's rows ride the one stream: the step's words are said once and
          // each row stands on its own line under it.
          fn({ type: "place.stage", addId, step: "join", state: "done", note: "engine none" });
          fn({ type: "place.stage", addId, step: "provision", state: "running", note: "2 tools from the recipe of 2026-09-17T10:00:00.000Z" });
          fn({ type: "place.stage", addId, step: "provision", state: "running", note: "Codex: installed" });
          fn({ type: "place.stage", addId, step: "provision", state: "done", note: "the rows are in" });
        }
        return { addId, place: { ...place, provision: job } } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: (fn: (frame: Record<string, unknown>) => void) => {
        frames.push(fn);
        return () => frames.splice(frames.indexOf(fn), 1);
      },
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never };
    expect(await addCommand(io, opts(tmp("add-recipe")), ["root@10.0.0.9"], {}, deps)).toBe(0);
    const said = io.lines;
    const at = (needle: string): number => said.findIndex(l => l.includes(needle));
    expect(at("spoo joined this wsp")).toBeGreaterThanOrEqual(0);
    // Each row on its own line as it lands, and the tally once the job is over, after the join's own lines.
    expect(at("Codex: installed")).toBeGreaterThanOrEqual(0);
    expect(at("spoo: 1 installed: Codex, 1 already there")).toBeGreaterThan(at("spoo joined this wsp"));
    // The step's words are the protocol's and are said once, not once per row.
    expect(said.filter(l => l.includes(PLACE_ADD_WORDS.provision))).toHaveLength(0);
    // The sign-in on that computer comes after the rows: Codex cannot be signed in there before it is there.
    expect(at("Sign Codex in on spoo now?")).toBe(-1);
    expect(at(boxSignInLaterLine("spoo", "codex"))).toBeGreaterThan(at("spoo: 1 installed: Codex, 1 already there"));
  });

  it("offers the sign-in on that computer while the person is at this terminal, and says what threads read there when they are not", async () => {
    const place: PlaceView = {
      id: "p_1",
      kind: "computer",
      name: "box",
      default: true,
      present: true,
      takesForks: true,
      agents: ["claude", "codex"],
      logins: "/var/lib/wsp/logins",
    };
    const client = {
      request: async (op: string) => (op === "agents.signInLine" ? { line: { command: "codex login --device-auth", prepare: "mkdir -p x" } } : ({ place, hostKey: "ssh-ed25519 SHA256:abc" } as Record<string, unknown>)),
      events: async () => {},
      onFrame: () => () => {},
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const asked: string[] = [];
    const signedIn: { agent?: string; line: SignInLine }[] = [];
    const deps = {
      ...systemPlaceDeps,
      dial: async () => client as never,
      signIn: async (o: { agent?: string; line: SignInLine }) => {
        signedIn.push({ agent: o.agent, line: o.line });
        return { signedIn: true };
      },
    } as Parameters<typeof addCommand>[4];
    const io = { ...captured(), isTTY: true, ask: async (q: string) => (asked.push(q), "yes") };
    expect(await addCommand(io, opts(tmp("add-offer")), ["root@10.0.0.9"], {}, deps)).toBe(0);
    // Only the agent whose login lives on that computer is offered; Claude Code's token is this computer's.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Sign Codex in on box now?");
    expect(signedIn).toEqual([{ agent: "codex", line: { command: "codex login --device-auth", prepare: "mkdir -p x" } }]);
    expect(io.lines.join("\n")).toContain(boxSignedInLine("box", "codex"));
    // Nobody at the keyboard: nothing is asked and nothing runs, and the line says what threads there read
    // until it is signed in and how to sign it in later.
    const quiet = captured();
    expect(await addCommand(quiet, opts(tmp("add-quiet")), ["root@10.0.0.9"], {}, deps)).toBe(0);
    expect(signedIn).toHaveLength(1);
    expect(quiet.lines.join("\n")).toContain(boxSignInLaterLine("box", "codex"));
    expect(quiet.lines.join("\n")).toContain("OPENAI_API_KEY");
  });

  it("asks about the key of a computer this one has never dialled, sends the one it was answered with, and sends nothing off a terminal", async () => {
    const OFFERED = "ssh-ed25519 SHA256:offered";
    const sent: (Record<string, unknown> | undefined)[] = [];
    const client = {
      request: async (_op: string, params?: Record<string, unknown>) => {
        sent.push(params);
        return { place: { id: "p_1", kind: "computer", name: "box", default: true, engine: "none", present: true, takesForks: true } as PlaceView } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: () => () => {},
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = {
      ...systemPlaceDeps,
      dial: async () => client as never,
      heldHostKey: async () => undefined,
      offeredHostKey: async () => ({ key: OFFERED }),
    };

    // Nobody at the keyboard: the line refuses with the key the computer answers with and the line that pins it,
    // and the host is never asked, so nothing was dialled from here either.
    const quiet = captured();
    expect(await addCommand(quiet, opts(tmp("add-quiet")), ["root@10.0.0.9"], {}, deps)).toBe(1);
    expect(quiet.errors).toEqual([hostKeyUnconfirmedRefusal("root@10.0.0.9", OFFERED)]);
    expect(sent).toEqual([]);

    // A person at the keyboard who says no: the same refusal and nothing sent.
    const asked: string[] = [];
    const no = { ...captured(), isTTY: true, ask: async (q: string) => (asked.push(q), "no") };
    expect(await addCommand(no, opts(tmp("add-no")), ["root@10.0.0.9"], {}, deps)).toBe(1);
    expect(asked).toEqual([hostKeyAsk("root@10.0.0.9", OFFERED)]);
    expect(sent).toEqual([]);

    // A yes sends the key the person just read, and the host is the one that holds the computer to it.
    const yes = { ...captured(), isTTY: true, ask: async () => "yes" };
    expect(await addCommand(yes, opts(tmp("add-yes")), ["root@10.0.0.9"], {}, deps)).toBe(0);
    expect(sent.at(-1)).toMatchObject({ address: "root@10.0.0.9", hostKey: OFFERED });

    // The flag pins it with nothing asked and nothing scanned, whether or not the scan could have answered.
    const pinned = captured();
    const blind = { ...deps, offeredHostKey: async () => ({ stoppedBy: "ProxyJump" }) };
    expect(await addCommand(pinned, opts(tmp("add-pin")), ["root@10.0.0.9"], { hostKey: "SHA256:typed" }, blind)).toBe(0);
    expect(sent.at(-1)).toMatchObject({ hostKey: "SHA256:typed" });

    // No flag and no scan to ask: the refusal names the flag and the config line that stopped the scan.
    const stopped = captured();
    expect(await addCommand(stopped, opts(tmp("add-blind")), ["root@10.0.0.9"], {}, blind)).toBe(1);
    expect(stopped.errors).toEqual([hostKeyUnscannableRefusal("root@10.0.0.9", "ProxyJump")]);

    // A computer this computer's client already holds a key for is dialled as it always was, with none sent.
    const known = captured();
    expect(await addCommand(known, opts(tmp("add-known")), ["root@10.0.0.9"], {}, { ...deps, heldHostKey: async () => "ssh-ed25519 SHA256:held" })).toBe(0);
    expect(sent.at(-1)!["hostKey"]).toBeUndefined();
  });

  it("takes an alias out of the person's ssh config as the login its block names, and still refuses a word no block renames", async () => {
    const sent: (Record<string, unknown> | undefined)[] = [];
    const read: SshReach[] = [];
    const client = {
      request: async (_op: string, params?: Record<string, unknown>) => {
        sent.push(params);
        return { place: { id: "p_1", kind: "computer", name: "spoo", default: true, engine: "none", present: true, takesForks: true } as PlaceView } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: () => () => {},
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never, heldHostKey: async (reach: SshReach) => (read.push(reach), "ssh-ed25519 SHA256:held") };

    // The alias stays the host so the block keeps applying, and the record reads the login that block names.
    const io = captured();
    expect(await addCommand(io, opts(tmp("add-alias")), ["spoo"], {}, deps), io.errors.join("\n")).toBe(0);
    expect(sent.at(-1)).toMatchObject({ address: "root@spoo" });
    expect(read.at(-1)).toEqual({ user: "root", host: "spoo", port: 22 });

    // A block with a Port of its own keeps it: a 22 on the dial would override the config.
    const ported = captured();
    const portDeps = { ...deps, sshWord: (word: string, o: { port?: number; keyPath?: string }) => sshWordReach(word, o, spooConfig(2222)) };
    expect(await addCommand(ported, opts(tmp("add-alias-port")), ["spoo"], {}, portDeps), ported.errors.join("\n")).toBe(0);
    expect(sent.at(-1)).toMatchObject({ address: "root@spoo:2222" });
    expect(read.at(-1)).toEqual({ user: "root", host: "spoo", port: 2222 });

    // A word ssh does not rename is refused as it always was, and nothing was asked of the host.
    const before = sent.length;
    const refused = captured();
    expect(await addCommand(refused, opts(tmp("add-no-alias")), ["nonsense"], {}, deps)).toBe(1);
    expect(refused.errors).toEqual([addRefusal("nonsense")]);
    expect(sent.length).toBe(before);
  });

  it("reads the port and the key by the rule every ssh road on this command line reads them by", () => {
    expect(addFlags("box", "2222", "/tmp/id_ed25519")).toEqual({ name: "box", sshPort: 2222, keyPath: "/tmp/id_ed25519" });
    expect(addFlags(undefined, undefined, undefined)).toEqual({});
    // The pinned key rides the same reading, with the spaces a person leaves around a pasted word taken off.
    expect(addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, "  ssh-ed25519 SHA256:abc  ")).toEqual({ hostKey: "ssh-ed25519 SHA256:abc" });
    expect(addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, "   ")).toEqual({});
    expect(() => addFlags(undefined, "no", undefined)).toThrow("--ssh-port");
  });

  it("refuses the ssh road's flags when no computer was named beside them, naming the word that does name one", async () => {
    const io = captured();
    expect(await addCommand(io, opts(tmp("add-flags")), [], { sshPort: 2222 }, systemPlaceDeps)).toBe(1);
    expect(io.errors).toEqual([ADD_FLAGS_REFUSAL]);
    // A pinned key is one of the ssh road's flags too: it names nothing on its own and belongs beside none of the
    // other two words this verb takes.
    const pinned = captured();
    expect(await addCommand(pinned, opts(tmp("add-pin-alone")), [], { hostKey: "SHA256:x" }, systemPlaceDeps)).toBe(1);
    expect(pinned.errors).toEqual([ADD_FLAGS_REFUSAL]);
    const updating = captured();
    expect(await addCommand(updating, opts(tmp("add-pin-update")), ["box"], { update: true, hostKey: "SHA256:x" }, systemPlaceDeps)).toBe(1);
    expect(updating.errors).toEqual([UPDATE_FLAGS_REFUSAL]);
  });
});

describe("dialling a box whose agent stopped calling home", () => {
  /** One ssh child, as the transport sees it: the dial it was given and the script it was asked to run. */
  const dialler = (answer: { exitCode: number; stdout?: string; stderr?: string }) => {
    const asked: { reach: SshReach; script: string }[] = [];
    const transport: SshTransport = async (reach, script) => {
      asked.push({ reach, script });
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    };
    return { asked, dial: placeDialler({ transport }) };
  };

  it("opens one connection over the login on the record, runs a command every unix has, and installs nothing", async () => {
    const { asked, dial } = dialler({ exitCode: 0 });
    await dial({ ssh: "root@65.21.4.12" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reach).toEqual({ user: "root", host: "65.21.4.12", port: 22 });
    expect(asked[0]!.script).toBe("exit 0");
  });

  it("hands back ssh's own line and nothing of the reader that asked, which is the sentence the person came for", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const { dial } = dialler({ exitCode: 255, stderr: `${said}\n` });
    // Not "root@... did not say what it is over ssh (exit 255): ...": the half before the colon is the reader
    // talking about itself, which is the class of leak the absent computer's own sentence was cut of.
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow(said);
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow(/^ssh: connect to host/);
  });

  it("drops ssh's debug chatter, keeping the line a person would have read in their own terminal", async () => {
    const said = "root@65.21.4.12: Permission denied (publickey).";
    const { dial } = dialler({ exitCode: 255, stderr: `debug1: Reading configuration data\ndebug2: resolving\n${said}\n` });
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow(said);
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.not.toThrow(/debug/);
  });

  it("says who refused where ssh itself said nothing, rather than throwing an empty sentence", async () => {
    const { dial } = dialler({ exitCode: 255 });
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow("root@65.21.4.12 refused the login over ssh (exit 255)");
  });

  it("dials with the key file the add was given, since ssh here runs with BatchMode and would refuse for the publickey", async () => {
    const { asked, dial } = dialler({ exitCode: 0 });
    await dial({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    expect(asked[0]!.reach.keyPath).toBe("/Users/lena/.ssh/hetzner");
  });

  it("dials the port the login names, so a box on a port of its own is reached at it", async () => {
    const { asked, dial } = dialler({ exitCode: 0 });
    await dial({ ssh: "root@65.21.4.12:2222" });
    expect(asked[0]!.reach.port).toBe(2222);
  });
});

describe("what a box that took the agent and did not dial back says for itself", () => {
  /** One ssh child, as the transport sees it: the dial it was given and the script it was asked to run. */
  const reader = (answer: { exitCode: number; stdout?: string }) => {
    const asked: { reach: SshReach; script: string }[] = [];
    const transport: SshTransport = async (reach, script) => {
      asked.push({ reach, script });
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: "" };
    };
    return { asked, read: placeLogReader({ transport }) };
  };

  const SAID = [
    "https://h645d7f8a8d48cbd6.example could not be dialled: not an http address",
    "http://100.129.175.77:4420 did not answer in 10s",
  ];

  it("reads the end of the agent's own log over the login the install used, at the path the box's own HOME names", async () => {
    const { asked, read } = reader({ exitCode: 0, stdout: `${SAID.join("\n")}\n` });
    expect(await read({ ssh: "root@spoo" })).toEqual(SAID);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reach).toEqual({ user: "root", host: "spoo", port: 22 });
    // $HOME rather than a home read here: the login's own home is the box's reading of it, and one ssh child is
    // what a person waiting on a wait that already ran out can afford.
    expect(asked[0]!.script).toBe(`tail -n ${PLACE_LOG_TAIL} "${placeDaemonPaths("$HOME").placeLog}" 2>/dev/null`);
  });

  it("hands back nothing where the box has no log yet, leaving the wait's own sentence as it stands", async () => {
    const { read } = reader({ exitCode: 1 });
    expect(await read({ ssh: "root@spoo" })).toEqual([]);
  });

  it("keeps the last ten lines and no more, which is what reads under one sentence", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const { read } = reader({ exitCode: 0, stdout: `${lines.join("\n")}\n` });
    expect(await read({ ssh: "root@spoo" })).toEqual(lines.slice(-PLACE_LOG_TAIL));
  });

  it("carries the key file the add was given, since every ssh child here runs with BatchMode on", async () => {
    const { asked, read } = reader({ exitCode: 0, stdout: "linked\n" });
    await read({ ssh: "root@spoo:2222", keyPath: "/Users/lena/.ssh/hetzner" });
    expect(asked[0]!.reach).toEqual({ user: "root", host: "spoo", port: 2222, keyPath: "/Users/lena/.ssh/hetzner" });
  });
});

describe("the install over ssh marks its steps off the lines the deploy prints", () => {
  /** A daemon asset folder with a stand-in binary per guest target named, and a wsp command as npm lays it out.
   * Named none and it holds every target, which is a release; named one, it is a checkout that built that one. */
  function assets(root: string, targets: readonly { triple: string }[] = GUEST_DAEMON_TARGETS): { daemonDir: string; cliDir: string } {
    const daemonDir = join(root, "daemon");
    for (const target of targets) {
      mkdirSync(join(daemonDir, target.triple), { recursive: true });
      writeFileSync(daemonBinaryIn(daemonDir, target.triple), `#!/bin/sh\necho ${target.triple}\n`, { mode: 0o755 });
    }
    const cliDir = join(root, "cli");
    mkdirSync(join(cliDir, "dist"), { recursive: true });
    writeFileSync(join(cliDir, "dist", "bin.js"), "");
    writeFileSync(join(cliDir, "package.json"), JSON.stringify({ name: "@zingzy/wsp", version: "0.0.0" }));
    return { daemonDir, cliDir };
  }

  /** A box that takes the deploy and answers the word it is told to say about its own chip, recording every script
   * run on it and every file landed there. `arch` is what its `uname -m` answered on the read that adopted it. */
  function fakeBox(arch: string | undefined, shell = "bash", box: { reaches?: (url: string) => boolean; holds?: string; dials?: string; proxied?: boolean; home?: string } = {}): { backend: unknown; ran: string[]; landed: string[]; stages: string[]; stage: PlaceStaging } {
    const ran: string[] = [];
    const landed: string[] = [];
    const stages: string[] = [];
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async (path: string) => {
        landed.push(path);
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Ubuntu 24.04.4 LTS" }),
      run: async (script: string, opts?: { onLine?: (line: string) => void }) => {
        ran.push(script);
        if (script.includes("PREFLIGHT_OK")) return { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" };
        if (script === heldPlaceScript("/home/maya")) return { exitCode: 0, stdout: box.holds ?? "", stderr: "" };
        const reached = reachAnswer(script, box.reaches);
        if (reached !== undefined) return reached;
        for (const line of [WSP_READY_LINE, PLACE_JOINED_LINE]) opts?.onLine?.(line);
        return { exitCode: 0, stdout: `${WSP_READY_LINE}\n${PLACE_JOINED_LINE}\nDAEMON_UP\n`, stderr: "" };
      },
    };
    const backend = {
      hostNameFor: async (reach: SshReach) => (box.proxied === true ? undefined : (box.dials ?? reach.host)),
      adopt: async () => ({ machine, login: { HOME: box.home ?? "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, shell, ...(arch === undefined ? {} : { arch }) }),
      // A computer this computer's ssh client has already met: every case below is about what the install does
      // after that, so none of them stands on the first dial of a stranger.
      keyFor: async () => BOX_KEY,
      offeredKeyFor: async () => ({ key: BOX_KEY }),
      knownHostsEntry: async () => ({ file: "/home/maya/.ssh/known_hosts", target: "box" }),
    };
    return { backend, ran, landed, stages, stage: (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`) };
  }

  /** The key the box's ssh answers with, and the key this computer's client already holds for it. */
  const BOX_KEY = "ssh-ed25519 SHA256:abc";

  /** What a box answers the reach check with: every address it was handed, reached unless `reaches` says not. */
  function reachAnswer(script: string, reaches: (url: string) => boolean = () => true): { exitCode: number; stdout: string; stderr: string } | undefined {
    if (!script.startsWith("reach() {")) return undefined;
    const urls = [...script.matchAll(/^reach '([^']+)'/gm)].map(m => m[1]!);
    return { exitCode: 0, stdout: urls.map(url => `WSP_REACH ${reaches(url) ? "ok" : "no"} ${url}\n`).join(""), stderr: "" };
  }

  const X86 = GUEST_DAEMON_TARGETS.find(t => t.uname === "x86_64")!;
  const ARM = GUEST_DAEMON_TARGETS.find(t => t.uname === "aarch64")!;

  it("sends the binary for the chip the box says it runs, on a host that holds that one alone", async () => {
    // An x86 box joined from a checkout that built the x86 Linux daemon and nothing else. The arm binary is not
    // there and is not wanted: what the box is sent is picked off the box's own word, not off this computer's chip.
    const x86 = fakeBox("x86_64");
    const install = placeInstaller({ backend: x86.backend as never, ...assets(tmp("chip-x86"), [X86]) });
    expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, x86.stage)).toMatchObject({ name: "box" });
    const deploy = x86.ran.find(script => script.includes("uname -m"))!;
    expect(deploy).toContain(`  ${X86.uname})`);
    expect(deploy).not.toContain(ARM.uname);
    // And the reverse, from a host holding the arm one alone: nothing here is this computer's chip either way.
    const arm = fakeBox("aarch64");
    const armInstall = placeInstaller({ backend: arm.backend as never, ...assets(tmp("chip-arm"), [ARM]) });
    expect(await armInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, arm.stage)).toMatchObject({ name: "box" });
    const armDeploy = arm.ran.find(script => script.includes("uname -m"))!;
    expect(armDeploy).toContain(`  ${ARM.uname})`);
    expect(armDeploy).not.toContain(X86.uname);
  });

  it("names the chip it picked on the install line, so a wrong one is read rather than worked out later", async () => {
    const box = fakeBox("x86_64");
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("chip-line"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] },
      box.stage,
    );
    expect(box.stages).toContain("wsp running (x86_64)");
    expect(stageLines({ type: "place.stage", addId: "a_1", step: "wsp", state: "running", note: "x86_64" })).toEqual(["    installing wsp: x86_64"]);
  });

  it("says where the box will dial back as its join starts, not after the twenty seconds it would wait", async () => {
    const box = fakeBox("x86_64");
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("dial-line"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://65.21.4.12:4720", "http://192.168.1.20:4720"] },
      box.stage,
    );
    // The step the join runs under, said while it is running: the addresses in the order the box will try them.
    expect(box.stages).toContain("service running (it dials this computer at http://65.21.4.12:4720, http://192.168.1.20:4720)");
  });

  it("hands the join only the addresses the box proved it reaches, before anything of wsp's lands", async () => {
    // The sighting: a box off the tailnet handed this computer's tailnet address first, which it waited twenty
    // seconds on after the whole install had landed.
    const box = fakeBox("x86_64", "bash", { reaches: url => url.includes("192.168.1.20") });
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("reach-lan"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://100.129.166.28:4720", "http://192.168.1.20:4720"] },
      box.stage,
    );
    const probe = box.ran.findIndex(script => script === reachScript(["http://100.129.166.28:4720", "http://192.168.1.20:4720"]));
    const deploy = box.ran.findIndex(script => script.includes(`case "$(uname -m)" in`));
    expect(probe).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(probe);
    expect(box.ran[deploy]).toContain("join 'http://192.168.1.20:4720' --code-file");
    expect(box.ran[deploy]).not.toContain("100.129.166.28");
    expect(box.stages).toContain("reach done (http://192.168.1.20:4720)");
    expect(box.stages).toContain("service running (it dials this computer at http://192.168.1.20:4720)");
    expect(box.stages.indexOf("reach done (http://192.168.1.20:4720)")).toBeLessThan(box.stages.indexOf("wsp running (x86_64)"));
  });

  it("refuses a box that reaches none of this host's addresses in one sentence, with nothing of wsp's sent", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const urls = ["http://100.129.166.28:4720", "http://192.168.1.20:4720"];
    await expect(placeInstaller({ backend: box.backend as never, ...assets(tmp("reach-none"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls }, box.stage)).rejects.toThrow(
      unreachedLine("root@spoo", urls),
    );
    expect(unreachedLine("root@spoo", urls)).toBe(
      "root@spoo cannot reach this computer at http://100.129.166.28:4720, http://192.168.1.20:4720, so nothing of wsp's went onto it; link this host to your relay, or start it with --advertise naming an address root@spoo can reach",
    );
    expect(box.landed).toEqual([]);
    expect(box.ran.some(script => script.includes(`case "$(uname -m)" in`))).toBe(false);
    expect(box.stages).toContain("reach running");
    expect(box.stages.some(line => line.startsWith("wsp "))).toBe(false);
  });

  /** A holder that records what the installer asked of it into the box's own list of what ran, so the order of the
   * hold and the deploy reads off one list; `refuse` is the sentence its first standing fails with. */
  function backHolder(ran: string[], refuse?: string | Error): { holder: PlaceBackHolder; asked: { login: PlaceLogin; back: PlaceBack; home: string }[]; released: string[] } {
    const asked: { login: PlaceLogin; back: PlaceBack; home: string }[] = [];
    const released: string[] = [];
    return {
      asked,
      released,
      holder: {
        hold: async (login, back, on) => {
          asked.push({ login, back, home: on.home });
          ran.push(`HOLD ${login.ssh} ${back.boxPort}`);
          if (refuse !== undefined) throw typeof refuse === "string" ? new Error(refuse) : refuse;
          return back;
        },
        release: login => void released.push(login.ssh),
        door: () => {},
        close: () => {},
      },
    };
  }

  it("dials back over ssh where the box reaches none of the door's addresses, with the forward standing before anything lands", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const back = backHolder(box.ran);
    const urls = ["http://100.129.166.28:4720", "http://192.168.1.20:4720"];
    const installed = await placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-ssh"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720 }, box.stage);
    expect(back.asked).toEqual([{ login: { ssh: "root@spoo" }, back: { boxPort: 4720 }, home: "/home/maya" }]);
    const hold = box.ran.indexOf("HOLD root@spoo 4720");
    const deploy = box.ran.findIndex(script => script.includes(`case "$(uname -m)" in`));
    expect(hold).toBeGreaterThan(box.ran.indexOf(reachScript(urls)));
    expect(deploy).toBeGreaterThan(hold);
    expect(box.ran[deploy]).toContain(`join '${backUrl(4720)}' --code-file`);
    expect(box.ran[deploy]).not.toContain("192.168.1.20");
    expect(box.stages).toContain(`reach done (${dialsBackOverSshNote(urls, undefined)})`);
    expect(dialsBackOverSshNote(urls, undefined)).toBe("cannot reach this computer at http://100.129.166.28:4720, http://192.168.1.20:4720, so it dials back over ssh");
    expect(box.stages).toContain("service running (it dials back over ssh (127.0.0.1:4720 on spoo))");
    expect(box.stages.join("\n")).not.toContain("dials this computer at http://127.0.0.1");
    expect(installed.back).toEqual({ boxPort: 4720 });
    expect(back.released).toEqual([]);
  });

  it("dials the relay first where the box reaches only that, and back over ssh after it", async () => {
    const relay = "https://h645d7f8a8d48cbd6.example";
    const box = fakeBox("x86_64", "bash", { reaches: url => url === relay });
    const back = backHolder(box.ran);
    const urls = ["http://100.129.166.28:4720", relay];
    await placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-relay"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720, relay }, box.stage);
    const deploy = box.ran.find(script => script.includes(`case "$(uname -m)" in`))!;
    expect(deploy).toContain(`join '${relay}' '${backUrl(4720)}' --code-file`);
    expect(box.stages).toContain(`reach done (${relay}, and back over ssh)`);
    expect(box.stages).toContain(`service running (it dials this computer at ${relay}, then dials back over ssh (127.0.0.1:4720 on spoo))`);
  });

  it("holds no forward where the box reaches an address of the door, or on a host that names no door port of its own", async () => {
    const lan = fakeBox("x86_64", "bash", { reaches: url => url.includes("192.168.1.20") });
    const heldLan = backHolder(lan.ran);
    await placeInstaller({ backend: lan.backend as never, back: heldLan.holder, ...assets(tmp("back-none"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: ["http://100.129.166.28:4720", "http://192.168.1.20:4720"], doorPort: 4720 }, lan.stage);
    expect(heldLan.asked).toEqual([]);
    // A host started with --listen answers on its main port, where a peer on its loopback is the owner's own road:
    // a forward there would hand the box that road, so the add is refused as it was before any forward existed.
    const listening = fakeBox("x86_64", "bash", { reaches: () => false });
    const heldListening = backHolder(listening.ran);
    const urls = ["http://100.129.166.28:4700"];
    await expect(placeInstaller({ backend: listening.backend as never, back: heldListening.holder, ...assets(tmp("back-listen"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls }, listening.stage)).rejects.toThrow(unreachedLine("root@spoo", urls));
    expect(heldListening.asked).toEqual([]);
    expect(listening.landed).toEqual([]);
  });

  it("refuses in one sentence where the forward will not stand either, lets it go, and sends nothing", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const why = "Error: remote port forwarding failed for listen port 23456";
    const back = backHolder(box.ran, why);
    const urls = ["http://100.129.166.28:4720", "http://192.168.1.20:4720"];
    await expect(placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-refused"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720 }, box.stage)).rejects.toThrow(
      backRefusedLine("root@spoo", urls, why),
    );
    expect(backRefusedLine("root@spoo", urls, why)).toBe(
      "root@spoo cannot reach this computer at http://100.129.166.28:4720, http://192.168.1.20:4720 and the forward back over ssh did not stand (Error: remote port forwarding failed for listen port 23456); link this host to your relay, or start it with --advertise naming an address it can reach",
    );
    const long = backRefusedLine("root@spoo", urls, "x".repeat(2000));
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).toMatch(/naming an address it can reach$/);
    // ssh copies the box's stderr raw, and the box's startup files write before the forward's up line.
    const boxWritten = backRefusedLine(`${"u".repeat(255)}@spoo`, urls, "\x1b]0;pwned\x07Connection closed");
    expect(boxWritten).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(boxWritten.length).toBeLessThanOrEqual(300);
    expect(boxWritten).toMatch(/naming an address it can reach$/);
    expect(back.released).toEqual(["root@spoo"]);
    expect(box.landed).toEqual([]);
    expect(box.ran.some(script => script.includes(`case "$(uname -m)" in`))).toBe(false);
  });

  it("says a refusal that names its own fix whole: sshd binding beyond loopback, a known hosts file that is not here", async () => {
    const urls = ["http://100.129.166.28:4720"];
    for (const refusal of [new BackCutError(backBindLine("root@spoo", "0.0.0.0")), new MissingKnownHostsError(missingKnownHostsLine("root@spoo", "/Users/lena/my"))]) {
      const box = fakeBox("x86_64", "bash", { reaches: () => false });
      const back = backHolder(box.ran, refusal);
      const refused = await placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-whole"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720 }, box.stage).catch((e: unknown) => e);
      expect((refused as Error).message).toBe(refusal.message);
      expect(box.landed).toEqual([]);
    }
  });

  it("lets the forward go when the deploy it was held for fails", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const back = backHolder(box.ran);
    const failing = {
      ...(box.backend as { adopt: () => Promise<{ machine: { run: (script: string, opts?: unknown) => Promise<unknown> } }> }),
    };
    const adopt = failing.adopt;
    failing.adopt = async () => {
      const adopted = await adopt();
      const run = adopted.machine.run;
      adopted.machine.run = async (script, opts) => (script.includes(`case "$(uname -m)" in`) ? { exitCode: 1, stdout: "", stderr: "tar: ./daemon: Cannot open: No such file or directory\n" } : run(script, opts));
      return adopted;
    };
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(placeInstaller({ backend: failing as never, back: back.holder, ...assets(tmp("back-deploy"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: ["http://100.129.166.28:4720"], doorPort: 4720 }, box.stage)).rejects.toThrow();
    warned.mockRestore();
    expect(back.released).toEqual(["root@spoo"]);
  });

  /** A box whose deploy fails after its join connected back, answering the read of what it already holds with the
   * writes `had` names, and the undo with `undo`. Every script it was handed is on `ran`, in order. */
  function failingBox(had: (write: { path: string; as: string }) => boolean, opts: { found?: "unsaid"; undo?: { exitCode: number; stdout: string; stderr: string }; preflight?: string; deploy?: { stdout: string; stderr: string } } = {}) {
    const box = fakeBox("x86_64");
    const writes = joinedAddWrites(joinedPlace({ home: "/home/maya", path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: "/home/maya/.wsp/join-code", name: "box" }), placeUnit("/home/maya").path);
    const backend = { ...(box.backend as { adopt: () => Promise<{ machine: { run: (script: string, o?: unknown) => Promise<unknown> } }> }) };
    const adopt = backend.adopt;
    backend.adopt = async () => {
      const adopted = await adopt();
      const run = adopted.machine.run;
      adopted.machine.run = async (script, o) => {
        if (script.includes(ADD_FOUND_END)) {
          box.ran.push(script);
          if (opts.found === "unsaid") return { exitCode: 255, stdout: "", stderr: "Connection reset by peer\n" };
          return { exitCode: 0, stdout: `${writes.flatMap((w, i) => (had(w) ? [`WSP_HAD ${i}\n`] : [])).join("")}${ADD_FOUND_END}\n`, stderr: "" };
        }
        if (opts.preflight !== undefined && script.includes("PREFLIGHT_OK")) {
          box.ran.push(script);
          return { exitCode: 1, stdout: `${opts.preflight}\n`, stderr: "" };
        }
        if (script.includes(`case "$(uname -m)" in`)) {
          box.ran.push(script);
          return { exitCode: 1, ...(opts.deploy ?? { stdout: `WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nWSP_READY\n${joinedLine("box", "http://192.168.1.20:4720")}\n`, stderr: "systemctl enable --now wsp-place-abc exited 1 and said: Failed to enable unit\n" }) };
        }
        if (script.endsWith(`echo ${DAEMON_GONE_LINE}`)) {
          box.ran.push(script);
          return opts.undo ?? { exitCode: 0, stdout: `${DAEMON_GONE_LINE}\n`, stderr: "" };
        }
        return run(script, o);
      };
      return adopted;
    };
    return { ...box, backend, writes };
  }

  const SERVICE_SAID = "box connected back but its agent did not start: systemctl enable --now wsp-place-abc exited 1 and said: Failed to enable unit";

  it("takes back what a failed add put on the box once the deploy fails, and nothing the box held before the add", async () => {
    const at = placeDaemonPaths("/home/maya");
    const unit = placeUnit("/home/maya");
    // The person's own ~/.local/bin and login file were there before the add; nothing else of the list was.
    const box = failingBox(w => w.path === at.binDir || w.as === "login");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const thrown = await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-add"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    warned.mockRestore();
    // Marked as taken back, which is what lets the runtime drop the record the join made.
    expect(thrown).toBeInstanceOf(PlaceAddTakenBackError);
    const said = thrown.message;
    expect(said).toBe(addUndoneLine(SERVICE_SAID, true));
    expect(said).toBe(`${SERVICE_SAID}; nothing this add put on it is left there`);
    const found = box.ran.findIndex(script => script.includes(ADD_FOUND_END));
    const deploy = box.ran.findIndex(script => script.includes(`case "$(uname -m)" in`));
    const undo = box.ran.findIndex(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`));
    expect(box.ran.findIndex(script => script.startsWith("reach() {"))).toBeLessThan(found);
    expect(found).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(undo);
    const lines = box.ran[undo]!.split("\n");
    // The unit the join wrote, stopped before its file goes; the profile the deploy loaded; wsp's line in their file.
    expect(lines).toContain(`systemctl disable --now ${shellQuote(unit.name)} 2>/dev/null || true`);
    expect(lines).toContain(`rm -f ${shellQuote(unit.path)}`);
    expect(box.ran[undo]).toContain("apparmor_parser -R '/etc/apparmor.d/wsp-workspace'");
    expect(box.ran[undo]).toContain(`grep -vF ${shellQuote(at.profileFile)} '/home/maya/.profile'`);
    const removed = [...box.ran[undo]!.matchAll(/rm -rf ('[^']*')/g)].map(m => m[1]);
    for (const path of [at.placeFile, at.placeKey, at.placeLog, at.dir, at.bundle, at.tokenPath, at.profileFile, "/home/maya/.wsp/join-code", `${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`]) expect(removed).toContain(shellQuote(path));
    // The folders it only made go when nothing else is in them, and wsp's own folder is never taken whole.
    expect(lines).toContain(`rmdir ${shellQuote(at.wsp)} 2>/dev/null || true`);
    expect(lines).toContain(`rmdir ${shellQuote(workFolderIn("/home/maya"))} 2>/dev/null || true`);
    expect(removed).not.toContain(shellQuote(at.wsp));
    expect(removed).not.toContain(shellQuote(workFolderIn("/home/maya")));
    // What the box held before the add stays: their ~/.local/bin, their login file, and a unit this add never writes.
    expect(box.ran[undo]).not.toContain(`rmdir ${shellQuote(at.binDir)}`);
    expect(box.ran[undo]).not.toContain("|| rm -f '/home/maya/.profile'");
    expect(box.ran[undo]).not.toContain("wsp-daemon.service");
  });

  it("leaves the workspace profile and the files a box held before the add where they were", async () => {
    const at = placeDaemonPaths("/home/maya");
    const box = failingBox(w => w.as === "apparmor" || w.path === at.dir);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-kept"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).catch(() => undefined);
    warned.mockRestore();
    const undo = box.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))!;
    expect(undo).not.toContain("apparmor_parser");
    expect(undo).not.toContain(shellQuote(at.dir));
    expect(undo).toContain(shellQuote(at.bundle));
  });

  it("takes nothing back where nothing landed, or where the box never said what it held before", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The box refused at the preflight: the deploy stopped before a byte of wsp's landed, and the refusal is said alone.
    const refused = failingBox(() => false, { preflight: PLACE_NEEDS_ROOT_LINE });
    expect(await placeInstaller({ backend: refused.backend as never, ...assets(tmp("undo-preflight"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, refused.stage).catch((e: unknown) => (e as Error).message)).toBe(PLACE_NEEDS_ROOT_LINE);
    expect(refused.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
    // The read of what it held did not answer, so nothing on it can be told from what this add wrote.
    const unsaid = failingBox(() => false, { found: "unsaid" });
    expect(await placeInstaller({ backend: unsaid.backend as never, ...assets(tmp("undo-unsaid"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, unsaid.stage).catch((e: unknown) => (e as Error).message)).toBe(
      `${SERVICE_SAID}; what this add put on it may still be there`,
    );
    expect(unsaid.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
    // The undo ran and did not finish.
    const dropped = failingBox(() => false, { undo: { exitCode: 255, stdout: "", stderr: "Connection closed\n" } });
    const kept = await placeInstaller({ backend: dropped.backend as never, ...assets(tmp("undo-dropped"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, dropped.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    expect(kept.message).toBe(addUndoneLine(SERVICE_SAID, false));
    expect(kept).not.toBeInstanceOf(PlaceAddTakenBackError);
    warned.mockRestore();
    // A box's line at the cap still leaves room for what the undo did.
    const long = addUndoneLine(`box took wsp but could not connect back: ${"x".repeat(400)}`, true);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).toMatch(/…; nothing this add put on it is left there$/);
  });

  it("sends no undo when the join refused the box as already joined, since what stands there is the add that won", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const box = failingBox(() => false, { deploy: { stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nWSP_READY\n", stderr: `${ALREADY_JOINED_LINE}\n` } });
    const thrown = await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-raced"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    warned.mockRestore();
    expect(thrown.message).toBe(`box took wsp but could not connect back: ${ALREADY_JOINED_LINE}`);
    expect(thrown).not.toBeInstanceOf(PlaceAddTakenBackError);
    expect(box.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
    // A name long enough that the sentence's cap cuts the join's line off still reads as refused, off the box's own line.
    const long = failingBox(() => false, { deploy: { stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nWSP_READY\n", stderr: `${ALREADY_JOINED_LINE}\n` } });
    const cut = await placeInstaller({ backend: long.backend as never, ...assets(tmp("undo-raced-long"), [X86]) })({ address: "maya@box", name: "b".repeat(250), code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, long.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    expect(cut.message).not.toContain(ALREADY_JOINED_LINE);
    expect(cut).not.toBeInstanceOf(PlaceAddTakenBackError);
    expect(long.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
  });

  it("takes nothing back, keeps the record and says so where another add took the box before this one's join ran", async () => {
    const at = placeDaemonPaths("/home/maya");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The deploy failed at the files step, so this add's join never wrote a place file; one standing now is another add's.
    const box = failingBox(() => false, { deploy: { stdout: "WSP_STEP files\n", stderr: "tar: place.tgz: unexpected end of file\n" }, undo: { exitCode: 0, stdout: `${ADD_TAKEN_LINE}\n`, stderr: "" } });
    const thrown = await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-taken"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    warned.mockRestore();
    expect(thrown).not.toBeInstanceOf(PlaceAddTakenBackError);
    expect(thrown.message).toBe(addTakenLine("box did not take wsp's files: tar: place.tgz: unexpected end of file"));
    expect(thrown.message).toMatch(/; another add took the box meanwhile, so nothing was taken back off it$/);
    const undo = box.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))!;
    expect(undo).toContain(`then echo ${ADD_TAKEN_LINE}; exit 0; fi`);
    expect(undo.indexOf(ADD_TAKEN_LINE)).toBeLessThan(undo.indexOf(`rm -rf ${shellQuote(at.placeFile)}`));
    // Past its own join the place file is this add's, and the undo takes it.
    const own = failingBox(() => false);
    await placeInstaller({ backend: own.backend as never, ...assets(tmp("undo-own"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, own.stage).catch(() => undefined);
    expect(own.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).not.toContain(ADD_TAKEN_LINE);
  });

  it("stops a place unit this add started and leaves one the box was already running as it was", async () => {
    const unit = placeUnit("/home/maya");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The unit file was there, stopped and disabled: the join rewrote it, enabled it and started it.
    const idle = failingBox(w => w.as === "unit");
    await placeInstaller({ backend: idle.backend as never, ...assets(tmp("undo-idle-unit"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, idle.stage).catch(() => undefined);
    const stopped = idle.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))!.split("\n");
    expect(stopped).toContain(`systemctl stop ${shellQuote(unit.name)} 2>/dev/null || true`);
    expect(stopped).toContain(`systemctl disable ${shellQuote(unit.name)} 2>/dev/null || true`);
    expect(stopped.join("\n")).not.toContain(`rm -f ${shellQuote(unit.path)}`);
    // Running and enabled before the add: nothing of the undo reaches for it.
    const running = failingBox(w => w.as === "unit" || w.as === "running" || w.as === "enabled");
    const said = await placeInstaller({ backend: running.backend as never, ...assets(tmp("undo-running-unit"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, running.stage).then(() => "the add stood", (e: unknown) => (e as Error).message);
    warned.mockRestore();
    expect(running.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).not.toContain(shellQuote(unit.name));
    // The join restarted that agent with this add's flags; the sentence says it stands because it was there before.
    expect(said).toBe(`${SERVICE_SAID}; wsp's agent was running there before this add and is left running, and nothing else this add put on it is left there`);
    expect(addUndoneLine(SERVICE_SAID, false, true)).toBe(`${SERVICE_SAID}; wsp's agent was running there before this add and is left running, and what else this add put on it may still be there`);
  });

  it("refuses a box whose login has / for its home before it reads what the box holds", async () => {
    const box = fakeBox("x86_64", "bash", { home: "/" });
    const said = await placeInstaller({ backend: box.backend as never, ...assets(tmp("root-home"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).catch((e: unknown) => (e as Error).message);
    expect(said).toBe(placeRootHomeRefusal("maya@box"));
    expect(box.ran.some(script => script.includes(ADD_FOUND_END) || script.startsWith("head -c ") || script.startsWith("reach() {"))).toBe(false);
    expect(box.landed).toEqual([]);
  });

  it("refuses a box that already belongs to a wsp at the connect, naming that wsp, with nothing sent", async () => {
    const studio = placeFileText({ placeId: "p_studio", name: "spoo", hostName: "studio", hostUrls: ["http://192.168.1.5:4640"], hostPublicKey: "c3R1ZGlv", keyPath: "/root/.wsp/place.key", joinedAt: "2026-09-20T10:00:00Z" });
    const elsewhere = fakeBox("x86_64", "bash", { holds: studio });
    const own = joinToken("7QK3M2VD", keyFingerprint("dGhpcyBob3N0"));
    await expect(placeInstaller({ backend: elsewhere.backend as never, ...assets(tmp("held-elsewhere"), [X86]) })({ address: "root@spoo", code: own, hostUrls: ["http://192.168.1.20:4720"] }, elsewhere.stage)).rejects.toThrow(
      "root@spoo already belongs to the wsp on studio at http://192.168.1.5:4640; wsp leave on it frees it, or wsp add spoo --update from that wsp updates it there",
    );
    expect(elsewhere.landed).toEqual([]);
    expect(elsewhere.ran).toEqual([heldPlaceScript("/home/maya")]);
    expect(elsewhere.stages).toEqual(["connect running", "host-key done (ssh-ed25519 SHA256:abc)"]);
    // The same file pinned to this host's own key is this wsp's own place, said as that.
    const mine = fakeBox("x86_64", "bash", { holds: studio.replace("c3R1ZGlv", "dGhpcyBob3N0") });
    await expect(placeInstaller({ backend: mine.backend as never, ...assets(tmp("held-here"), [X86]) })({ address: "root@spoo", code: own, hostUrls: ["http://192.168.1.20:4720"] }, mine.stage)).rejects.toThrow(
      "root@spoo is already a place in this wsp as spoo",
    );
    expect(mine.landed).toEqual([]);
    // A file the join itself would not read as a place is none, by the join's own rule.
    const junk = fakeBox("x86_64", "bash", { holds: "{}\n" });
    expect(await placeInstaller({ backend: junk.backend as never, ...assets(tmp("held-junk"), [X86]) })({ address: "maya@box", code: own, hostUrls: ["http://192.168.1.20:4720"] }, junk.stage)).toMatchObject({ name: "box" });
    expect(placeHeldRefusal("root@spoo", { ...JSON.parse(studio), hostUrls: [] }, undefined)).toBe("root@spoo already belongs to the wsp on studio; wsp leave on it frees it, or wsp add spoo --update from that wsp updates it there");
    // A long address that is still a valid one is cut like the names, so the way out survives the cap.
    const long = `http://${"a".repeat(240)}.example:4640`;
    const said = placeHeldRefusal("root@spoo", { ...JSON.parse(studio), name: "s".repeat(200), hostName: "h".repeat(200), hostUrls: [long] }, undefined);
    expect(said.length).toBeLessThanOrEqual(300);
    expect(said).toMatch(/updates it there$/);
    expect(said).toContain(` at ${long.slice(0, 48)};`);
  });

  it("reads whether an alias is this computer off the address ssh dials, not off the alias", async () => {
    const urls = ["http://127.0.0.1:4720", "http://192.168.1.20:4720"];
    // Host me / HostName 127.0.0.1: the box is this computer, where its own loopback is the address that works.
    const me = fakeBox("x86_64", "bash", { dials: "127.0.0.1" });
    await placeInstaller({ backend: me.backend as never, ...assets(tmp("alias-here"), [X86]) })({ address: "maya@me", code: "7QK3M2VD", hostUrls: urls }, me.stage);
    expect(me.stages).toContain("reach done (http://127.0.0.1:4720, http://192.168.1.20:4720)");
    // The same word landing on a box elsewhere drops the loopback before the box is asked.
    const away = fakeBox("x86_64", "bash", { dials: "178.156.161.168" });
    await placeInstaller({ backend: away.backend as never, ...assets(tmp("alias-away"), [X86]) })({ address: "maya@me", code: "7QK3M2VD", hostUrls: urls }, away.stage);
    expect(away.ran).toContain(reachScript(["http://192.168.1.20:4720"]));
    // Host inner / HostName 127.0.0.1 / ProxyJump bastion: the HostName is resolved past the jump, so it is not here.
    const jumped = fakeBox("x86_64", "bash", { proxied: true });
    await placeInstaller({ backend: jumped.backend as never, ...assets(tmp("alias-jumped"), [X86]) })({ address: "root@inner", code: "7QK3M2VD", hostUrls: urls }, jumped.stage);
    expect(jumped.ran).toContain(reachScript(["http://192.168.1.20:4720"]));
  });

  it("refuses the advertised address by name where it is this computer's own loopback, rather than dropping it behind a card", async () => {
    // The sighting's shape: a host started with a word naming its own loopback, on a computer that also answers on
    // a card. The word cannot be dialled from that box, and the card may be one the box cannot route to either, so
    // going on with the card is going on with an address the person did not choose.
    const box = fakeBox("x86_64");
    const install = placeInstaller({ backend: box.backend as never, advertise: "http://127.0.0.1:4720", ...assets(tmp("named-loopback"), [X86]) });
    await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720", "http://100.129.175.77:4720"] }, box.stage)).rejects.toThrow(
      advertisedLoopbackRefusal("http://127.0.0.1:4720"),
    );
    // Refused before the dial: nothing was landed and no step was even started.
    expect(box.landed).toEqual([]);
    expect(box.stages).toEqual([]);
    // The box that is this computer under another name dials its own loopback and reaches this host, so the word
    // holds there and nothing is refused.
    const here = fakeBox("x86_64");
    const hereInstall = placeInstaller({ backend: here.backend as never, advertise: "http://127.0.0.1:4720", ...assets(tmp("named-loopback-here"), [X86]) });
    expect(await hereInstall({ address: `maya@localhost`, code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720"] }, here.stage)).toMatchObject({ name: "localhost" });
    // A host bound to this computer alone behind a relay carries a loopback address in that list too, and nobody
    // typed that one: the install takes the relay and says nothing, which is what it always did.
    const relayed = fakeBox("x86_64");
    const relayedInstall = placeInstaller({ backend: relayed.backend as never, ...assets(tmp("relayed-loopback"), [X86]) });
    expect(await relayedInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720", "https://wsp-box.example.com"] }, relayed.stage)).toMatchObject({ name: "box" });
    // A host that answers on its own loopback alone with no word is still the other refusal, which names the flags
    // that fix it rather than a word the person never typed.
    const alone = fakeBox("x86_64");
    const aloneInstall = placeInstaller({ backend: alone.backend as never, ...assets(tmp("loopback-alone"), [X86]) });
    await expect(aloneInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720"] }, alone.stage)).rejects.toThrow(ADD_LOOPBACK_REFUSAL);
  });

  it("carries a box's own uname word from the ssh read through to the binary it is sent, with nothing faked between", async () => {
    // Every other case here hands the installer an arch. This one answers the real read script over a transport,
    // so the road from what the box printed to the chip arm in its deploy script is proved end to end.
    const cases = [
      { said: "x86_64", arm: "  x86_64)", gone: "aarch64" },
      { said: "aarch64", arm: "  aarch64)", gone: "x86_64" },
    ] as const;
    for (const { said, arm, gone } of cases) {
      const ran: string[] = [];
      const transport: SshTransport = async (_reach, script, opts) => {
        ran.push(script);
        if (script === SSH_READ_SCRIPT) return { exitCode: 0, stdout: `home /home/maya\narch ${said}\nuser maya\npath /usr/bin:/bin\ncpu 2\nmemkb 4194304\n`, stderr: "" };
        if (script.includes("PREFLIGHT_OK")) return { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" };
        if (script.includes("WSP_BYTES_OK")) return { exitCode: 0, stdout: "WSP_BYTES_OK\n", stderr: "" };
        const reached = reachAnswer(script);
        if (reached !== undefined) return reached;
        for (const line of [WSP_READY_LINE, PLACE_JOINED_LINE]) opts.onLine?.(line);
        return { exitCode: 0, stdout: `${WSP_READY_LINE}\n${PLACE_JOINED_LINE}\nDAEMON_UP\n`, stderr: "" };
      };
      const backend = new SshBackend({ transport, hostKey: async () => BOX_KEY, knownHosts: async () => ({}), hostName: async reach => reach.host });
      const target = GUEST_DAEMON_TARGETS.find(t => t.uname === said)!;
      const install = placeInstaller({ backend, ...assets(tmp(`road-${said}`), [target]) });
      expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).toMatchObject({ name: "box" });
      const deploy = ran.find(script => script.includes(`case "$(uname -m)" in`))!;
      expect(deploy).toContain(arm);
      expect(deploy).not.toContain(gone);
    }
  });

  it("reads the system before the chip, so a Mac of either chip is told it is a Mac and any other system its own name", async () => {
    // An Apple silicon Mac says arm64, which reads as a chip wsp builds nothing for, and an Intel Mac says x86_64,
    // which matches the Linux row and meets the systemd sentence halfway through its deploy. Neither says Mac.
    const cases: Array<[string, string, string]> = [
      ["Darwin", "arm64", noPlaceSystemLine("Darwin")],
      ["Darwin", "x86_64", noPlaceSystemLine("Darwin")],
      ["FreeBSD", "amd64", noPlaceSystemLine("FreeBSD")],
      ["Linux", "riscv64", noGuestDaemonLine("riscv64")],
    ];
    for (const [system, arch, line] of cases) {
      const ran: string[] = [];
      const transport: SshTransport = async (_reach, script) => {
        ran.push(script);
        return script === SSH_READ_SCRIPT
          ? { exitCode: 0, stdout: `home /home/maya\nsystem ${system}\narch ${arch}\nuser maya\npath /usr/bin:/bin\ncpu 2\nmemkb 4194304\n`, stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      };
      const backend = new SshBackend({ transport, hostKey: async () => BOX_KEY, knownHosts: async () => ({}), hostName: async reach => reach.host });
      const install = placeInstaller({ backend, ...assets(tmp(`road-${system}-${arch}`)) });
      await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).rejects.toThrow(line);
      expect(ran).toEqual([SSH_READ_SCRIPT]);
    }
    expect(noPlaceSystemLine("Darwin")).toBe("that computer is a Mac, and wsp joins only a Linux computer as a place; a Mac cannot join yet");
    expect(noPlaceSystemLine("FreeBSD")).toBe("that computer runs FreeBSD, and wsp joins only a Linux computer as a place");
    expect(noPlaceSystemLine("Darwin", "that computer", true)).toBe("that computer is a Mac, and wsp keeps only a Linux computer as a place; a Mac cannot be updated as one");
  });

  it("refuses a chip wsp builds no daemon for, and a box that would not say, before a byte of wsp's lands", async () => {
    const odd = fakeBox("riscv64");
    const install = placeInstaller({ backend: odd.backend as never, ...assets(tmp("chip-odd")) });
    await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, odd.stage)).rejects.toThrow(noGuestDaemonLine("riscv64"));
    expect(odd.landed).toEqual([]);
    const quiet = fakeBox(undefined);
    const quietInstall = placeInstaller({ backend: quiet.backend as never, ...assets(tmp("chip-quiet")) });
    await expect(quietInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, quiet.stage)).rejects.toThrow(UNSAID_CHIP_REFUSAL);
    expect(quiet.landed).toEqual([]);
  });

  it("leaves the box-side join as the only thing that reads a place report, and carries no field the join dropped", async () => {
    const box = fakeBox("x86_64");
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("one-reader"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] },
      box.stage,
    );
    // One command on the box builds or reads a report about it, and it is the join the person would run by hand.
    const readers = box.ran.flatMap(script => script.split("\n").filter(line => / join '?https?:/.test(line)));
    expect(readers).toHaveLength(1);
    expect(readers[0]).toContain("--code-file '/home/maya/.wsp/join-code'");
    // Nothing the deploy runs asks that box about docker: the field a report was once refused for is gone from the
    // shape both sides read, so a deploy and a hand-run join cannot disagree about whether a report is valid.
    expect(box.ran.join("\n")).not.toContain("docker");
    expect(Object.keys(PlaceReport.shape)).not.toContain("docker");
    expect(PlaceReport.safeParse({ ...placeReport({ name: "box", home: tmp("one-reader-home") }), dialed: "http://192.168.1.20:4400" }).success).toBe(true);
  });

  it("throws one sentence when a deploy will not come up and leaves the commands it was running to the host's log", async () => {
    const root = tmp("deploy-said");
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Ubuntu 24.04.4 LTS" }),
      run: async (script: string) =>
        script.includes("PREFLIGHT_OK")
          ? { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" }
          : script.includes(ADD_FOUND_END)
            ? { exitCode: 0, stdout: `${ADD_FOUND_END}\n`, stderr: "" }
            : script.endsWith(`echo ${DAEMON_GONE_LINE}`)
              ? { exitCode: 0, stdout: `${DAEMON_GONE_LINE}\n`, stderr: "" }
              : (reachAnswer(script) ?? { exitCode: 1, stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nthe wsp-workspace apparmor profile is loaded, so workspaces isolate here\nWSP_READY\n", stderr: `${joinUnansweredLine("http://192.168.1.20:4400")}\n` }),
    };
    const backend = { adopt: async () => ({ machine, login: { HOME: "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, arch: "x86_64" }), keyFor: async () => BOX_KEY, hostNameFor: async (reach: SshReach) => reach.host };
    const install = placeInstaller({ backend: backend as never, ...assets(root, [X86]) });
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...said: unknown[]) => void warned.push(said.map(String).join(" ")));
    try {
      const said = await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {}).catch((e: unknown) => (e as Error).message);
      expect(said).toBe(`box took wsp but could not connect back: ${joinUnansweredLine("http://192.168.1.20:4400")}; nothing this add put on it is left there`);
      // The join it was running, spelled as it ran there, is for whoever reads the host's log.
      expect(warned.join("\n")).toContain("join 'http://192.168.1.20:4400' --code-file '/home/maya/.wsp/join-code' --name 'box'");
    } finally {
      warn.mockRestore();
    }
  });

  it("answers the login it used and the key file it was given, so a later dial of that box takes the same road", async () => {
    const root = tmp("install-road");
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Linux 6.8.0" }),
      run: async (script: string) => (script.includes("PREFLIGHT_OK") ? { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" } : (reachAnswer(script) ?? { exitCode: 0, stdout: "DAEMON_UP\n", stderr: "" })),
    };
    const backend = { adopt: async () => ({ machine, login: { HOME: "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, arch: "x86_64" }), keyFor: async () => BOX_KEY, hostNameFor: async (reach: SshReach) => reach.host };
    const install = placeInstaller({ backend: backend as never, ...assets(root) });
    // Without a key: the login alone, in the spelling a person would type back.
    expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).toEqual({ name: "box", ssh: "maya@box" });
    // With one: the path rides back, since every ssh child here runs with BatchMode and a dial without it would be
    // refused for the publickey on a box that is switched on.
    expect(await install({ address: "maya@box", sshPort: 2222, keyPath: "/Users/lena/.ssh/box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).toEqual({
      name: "box",
      ssh: "maya@box:2222",
      sshKeyPath: "/Users/lena/.ssh/box",
    });
  });

  it("reads WSP_READY and PLACE_JOINED off the script's own echo lines, and never waits on a node version", async () => {
    const root = tmp("install-steps");
    const printed: string[] = [];
    const ran: string[] = [];
    // A machine that prints what the script it is given would print: each `echo <word>` line, in order, as the
    // deploy's own output reaches the host line by line; the join on it wrote the place file, so the deploy's last
    // word is DAEMON_UP.
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Linux 6.8.0" }),
      run: async (script: string, opts?: { onLine?: (line: string) => void }) => {
        ran.push(script);
        if (script.includes("PREFLIGHT_OK")) return { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" };
        const reached = reachAnswer(script);
        if (reached !== undefined) return reached;
        if (script.includes(ADD_FOUND_END)) return { exitCode: 0, stdout: `${ADD_FOUND_END}\n`, stderr: "" };
        const lines = script.split("\n").flatMap(line => (/^echo (\S+)$/.exec(line)?.[1] === undefined ? [] : [line.slice("echo ".length)]));
        for (const line of lines) {
          printed.push(line);
          opts?.onLine?.(line);
        }
        return { exitCode: 0, stdout: `${[...lines, "DAEMON_UP"].join("\n")}\n`, stderr: "" };
      },
    };
    const backend = {
      adopt: async () => ({ machine, login: { HOME: "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, arch: "x86_64", hostKey: BOX_KEY }),
      keyFor: async () => BOX_KEY,
      hostNameFor: async (reach: SshReach) => reach.host,
      knownHostsEntry: async () => ({ file: "/home/maya/.ssh/known_hosts", target: "box" }),
    };
    const stages: string[] = [];
    const installed = await placeInstaller({ backend: backend as never, ...assets(root) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] },
      (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`),
    );
    // The login it logged in as rides back with the name: it is the road to the box when its agent stops dialling
    // in, and the join frame the record is made from says nothing about how the box was reached.
    expect(installed).toEqual({ name: "box", ssh: "maya@box", hostKey: "ssh-ed25519 SHA256:abc" });
    // The deploy printed the two words the parser reads, and nothing of a node version.
    expect(printed).toEqual([WSP_READY_LINE, PLACE_JOINED_LINE]);
    expect(ran.join("\n")).not.toContain("NODE_VERSION");
    // Every step reaches done in order, off those two lines: the bundle landing is running from the connect until
    // WSP_READY, the join from then until PLACE_JOINED. The dial's own write to this computer's known_hosts is a
    // step of its own, right after the connect, carrying the key it kept.
    expect(stages).toEqual([
      "connect running",
      "connect done (Linux 6.8.0)",
      "host-key done (ssh-ed25519 SHA256:abc)",
      // What the box reached of this host's addresses, before anything of wsp's went onto it.
      "reach running",
      "reach done (http://192.168.1.20:4400)",
      // The chip the box said it runs, which is what picked the binary that landed, and the addresses it is about
      // to dial: both read while the step they belong to is still running, so a wrong one is not a wait first.
      "wsp running (x86_64)",
      "wsp done (x86_64)",
      "service running (it dials this computer at http://192.168.1.20:4400)",
      "service done",
    ]);
    expect(stages.some(line => line.startsWith("node"))).toBe(false);
  });

  it("ticks the known_hosts step on a login ssh would not take, since the dial wrote the key before it was refused", async () => {
    const root = tmp("install-refused");
    const backend = {
      adopt: async () => Promise.reject(new Error("maya@box: Permission denied (publickey).")),
      hostNameFor: async (reach: SshReach) => reach.host,
      keyFor: async () => "ssh-ed25519 SHA256:abc",
      // This computer's config points the file somewhere other than the default the plan line names, so the step
      // says which file was written rather than leaving a person to read the default as the truth.
      knownHostsEntry: async () => ({ file: "/Users/lena/.ssh/known_hosts_work", target: "box" }),
    };
    const stages: string[] = [];
    const install = placeInstaller({ backend: backend as never, ...assets(root) });
    await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`))).rejects.toThrow(
      "Permission denied (publickey).",
    );
    // The plan said the add would write this computer's known_hosts, and it did: the step says so with the key it
    // kept, which is the whole of what a person can check. Nothing else on a failed screen would say it now that
    // the refusal no longer carries ssh's own note.
    expect(stages).toEqual(["connect running", "host-key done (ssh-ed25519 SHA256:abc in /Users/lena/.ssh/known_hosts_work)"]);
  });

  it("refuses a computer this computer has never met before a byte of wsp's leaves, naming the key it answers with", async () => {
    const box = fakeBox("x86_64");
    const never = {
      ...(box.backend as Record<string, unknown>),
      // This computer's ssh client holds no key for it, and the computer itself answers a scan with one.
      keyFor: async () => undefined,
      offeredKeyFor: async () => ({ key: BOX_KEY }),
    };
    const install = placeInstaller({ backend: never as never, ...assets(tmp("first-dial"), [X86]) });
    await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow(hostKeyUnconfirmedRefusal("maya@box", BOX_KEY));
    // Nothing was dialled, so nothing was read off the box and nothing of wsp's landed on it.
    expect(box.ran).toEqual([]);
    expect(box.landed).toEqual([]);

    // A computer no scan can reach either: the refusal names the flag and the config line that stopped the scan.
    const blind = { ...never, offeredKeyFor: async () => ({ stoppedBy: "ProxyJump" }) };
    await expect(placeInstaller({ backend: blind as never, ...assets(tmp("first-dial-blind"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow(
      hostKeyUnscannableRefusal("maya@box", "ProxyJump"),
    );
    expect(box.landed).toEqual([]);
  });

  it("refuses a computer that answered with a key other than the one pinned, before the bundle and the code leave", async () => {
    const box = fakeBox("x86_64");
    // The client dials a name behind the word that was typed and writes the entry under the address: the line that
    // removes it is the client's own reading, never one built here from maya@box, which would remove nothing.
    const other = {
      ...(box.backend as Record<string, unknown>),
      adopt: async () => ({ ...(await (box.backend as { adopt: () => Promise<object> }).adopt()), hostKey: "ssh-ed25519 SHA256:somebody-else" }),
      knownHostsEntry: async () => ({ file: "/Users/lena/.ssh/known_hosts_work", target: "[10.0.0.5]:2222" }),
    };
    const install = placeInstaller({ backend: other as never, ...assets(tmp("wrong-key"), [X86]) });
    await expect(install({ address: "maya@box", hostKey: BOX_KEY, code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow(
      hostKeyMismatchRefusal({ address: "maya@box", pinned: BOX_KEY, wrote: "ssh-ed25519 SHA256:somebody-else", target: "[10.0.0.5]:2222", file: "/Users/lena/.ssh/known_hosts_work" }),
    );
    expect(box.landed).toEqual([]);
    // The read that adopted it ran, since the key ssh writes is read after the dial; nothing of wsp's followed it.
    expect(box.ran).toEqual([]);

    // The same key, given as the bare fingerprint a person reads off ssh-keygen, is the key that answered.
    const pinned = fakeBox("x86_64");
    const matching = { ...(pinned.backend as Record<string, unknown>), adopt: async () => ({ ...(await (pinned.backend as { adopt: () => Promise<object> }).adopt()), hostKey: BOX_KEY }) };
    expect(await placeInstaller({ backend: matching as never, ...assets(tmp("right-key"), [X86]) })({ address: "maya@box", hostKey: BOX_KEY.split(" ")[1]!, code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, pinned.stage)).toMatchObject({ name: "box" });
  });

  it("refuses a computer whose root shell reads a file of the shared home, before anything of wsp's lands", async () => {
    // sshd hands every command the host sends to root's own shell with -c, and on a box that home is the one every
    // workspace on it writes: zsh would read ~/.zshenv there and fish config.fish, as that computer's root.
    for (const shell of ["zsh", "fish"]) {
      const box = fakeBox("x86_64", shell);
      const install = placeInstaller({ backend: box.backend as never, ...assets(tmp(`shell-${shell}`), [X86]) });
      await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow(placeRootShellRefusal("maya@box", shell));
      // The read that adopted it has run, since sshd chose the shell before wsp could ask; nothing of wsp's did.
      expect(box.landed).toEqual([]);
      expect(box.ran).toEqual([]);
    }
    // A shell wsp has read no file for is refused for that, not for a file it has never seen: ash on an Alpine
    // root reads nothing under -c, and the sentence must not say it does.
    const ash = fakeBox("x86_64", "ash");
    await expect(placeInstaller({ backend: ash.backend as never, ...assets(tmp("shell-ash"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, ash.stage)).rejects.toThrow(
      placeRootShellRefusal("maya@box", "ash"),
    );
    expect(placeRootShellRefusal("maya@box", "ash")).not.toContain("reads ");
    expect(placeRootShellRefusal("maya@box", "zsh")).toContain("reads ~/.zshenv");
    expect(placeRootShellRefusal("maya@box", "fish")).toContain("reads config.fish");
    expect(ash.landed).toEqual([]);

    // The two that read nothing there install as they always did, and so does a box that named no shell at all.
    for (const shell of [...PLACE_ROOT_SHELLS, undefined]) {
      const box = fakeBox("x86_64", shell as string);
      const install = placeInstaller({ backend: box.backend as never, ...assets(tmp(`shell-ok-${shell ?? "unsaid"}`), [X86]) });
      expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage), shell).toMatchObject({ name: "box" });
    }
  });

  it("takes an alias out of the person's ssh config from the sheet, and refuses a word no block renames before any dial", async () => {
    const box = fakeBox("x86_64");
    const dialled: SshReach[] = [];
    const backend = { ...(box.backend as Record<string, unknown>), adopt: async (reach: SshReach) => (dialled.push(reach), (box.backend as { adopt: () => Promise<unknown> }).adopt()) };
    const sshWord = (word: string, o: { port?: number; keyPath?: string }) => sshWordReach(word, o, spooConfig(2222));
    const install = placeInstaller({ backend: backend as never, sshWord, ...assets(tmp("alias-sheet"), [X86]) });
    expect(await install({ address: "spoo", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).toMatchObject({ name: "spoo", ssh: "root@spoo:2222" });
    expect(dialled).toEqual([{ user: "root", host: "spoo", port: 2222 }]);

    const stranger = fakeBox("x86_64");
    await expect(placeInstaller({ backend: stranger.backend as never, sshWord, ...assets(tmp("alias-none"), [X86]) })({ address: "nonsense", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, stranger.stage)).rejects.toThrow(
      SSH_WORD_REFUSAL("nonsense"),
    );
    expect(stranger.ran).toEqual([]);
    expect(stranger.landed).toEqual([]);
  });

  it("leaves the known_hosts step alone where the dial never got far enough to exchange a key", async () => {
    const root = tmp("install-nokey");
    const backend = {
      adopt: async () => Promise.reject(new Error("ssh: connect to host box port 22: Connection refused")),
      hostNameFor: async (reach: SshReach) => reach.host,
      keyFor: async () => undefined,
      knownHostsEntry: async () => ({ file: "/home/maya/.ssh/known_hosts", target: "box" }),
    };
    const stages: string[] = [];
    const install = placeInstaller({ backend: backend as never, ...assets(root) });
    // The key rides the request, so the dial is made; it never got far enough to exchange one.
    await expect(install({ address: "maya@box", hostKey: BOX_KEY, code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`))).rejects.toThrow("Connection refused");
    // Nothing was written, so nothing says it was: the line stands waiting, which is what happened.
    expect(stages).toEqual(["connect running"]);
  });

  it("marks a refused login and a word naming no login as the login's own refusal, and no other refusal", async () => {
    const urls = ["http://192.168.1.20:4400"];
    const kept = "host-key done (ssh-ed25519 SHA256:abc)";
    const kindOf = async (install: Promise<unknown>): Promise<unknown> => (await install.then(() => expect.unreachable(), (e: unknown) => e as { kind?: unknown }))!.kind;

    const refused = fakeBox("x86_64");
    const denied = { ...(refused.backend as Record<string, unknown>), adopt: async () => Promise.reject(new Error("maya@box: Permission denied (publickey).")) };
    const login = placeInstaller({ backend: denied as never, ...assets(tmp("kind-login"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: urls }, refused.stage);
    await expect(login).rejects.toBeInstanceOf(PlaceLoginRefusedError);
    expect(await kindOf(login)).toBe(PLACE_LOGIN_REFUSED_KIND);
    expect(refused.stages).toEqual(["connect running", kept]);

    const word = fakeBox("x86_64");
    const sshWord = (w: string, o: { port?: number; keyPath?: string }) => sshWordReach(w, o, spooConfig(2222));
    expect(await kindOf(placeInstaller({ backend: word.backend as never, sshWord, ...assets(tmp("kind-word"), [X86]) })({ address: "nonsense", code: "7QK3M2VD", hostUrls: urls }, word.stage))).toBe(PLACE_LOGIN_REFUSED_KIND);

    // Refused after the login stood: each says the key the dial wrote here, and none carries the login's kind.
    const studio = placeFileText({ placeId: "p_studio", name: "spoo", hostName: "studio", hostUrls: ["http://192.168.1.5:4640"], hostPublicKey: "c3R1ZGlv", keyPath: "/root/.wsp/place.key", joinedAt: "2026-09-20T10:00:00Z" });
    const pinnedOther = fakeBox("x86_64");
    const after: [string, ReturnType<typeof fakeBox>, Record<string, unknown>, string?][] = [
      ["held", fakeBox("x86_64", "bash", { holds: studio }), {}],
      ["shell", fakeBox("x86_64", "zsh"), {}],
      ["chip", fakeBox("riscv64"), {}],
      ["unsaid chip", fakeBox(undefined), {}],
      ["mismatch", pinnedOther, { adopt: async () => ({ ...(await (pinnedOther.backend as { adopt: () => Promise<object> }).adopt()), hostKey: "ssh-ed25519 SHA256:somebody-else" }) }, BOX_KEY],
    ];
    for (const [what, box, over, hostKey] of after) {
      const install = placeInstaller({ backend: { ...(box.backend as Record<string, unknown>), ...over } as never, ...assets(tmp(`kind-${what.replace(" ", "-")}`), [X86]) });
      expect(await kindOf(install({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, ...(hostKey === undefined ? {} : { hostKey }) }, box.stage)), what).toBeUndefined();
      expect(box.stages, what).toEqual(["connect running", kept]);
      expect(box.landed, what).toEqual([]);
    }

    // Refused before any dial: not a login problem either.
    const loop = fakeBox("x86_64");
    expect(await kindOf(placeInstaller({ backend: loop.backend as never, ...assets(tmp("kind-loop"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4400"] }, loop.stage))).toBeUndefined();
    const stranger = fakeBox("x86_64");
    const unmet = { ...(stranger.backend as Record<string, unknown>), keyFor: async () => undefined };
    expect(await kindOf(placeInstaller({ backend: unmet as never, ...assets(tmp("kind-unmet"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls }, stranger.stage))).toBeUndefined();
  });
});

describe("what a failed add takes back off a box, run by a real shell", () => {
  const bash = (script: string): string => execFileSync("/bin/bash", ["-c", script], { encoding: "utf8" });

  /** Everything a joined add lays down under the home, as the deploy and the join on that box write it. */
  function wroteTheAdd(home: string): void {
    const at = placeDaemonPaths(home);
    mkdirSync(join(at.dir, "x86_64"), { recursive: true });
    writeFileSync(join(at.dir, "x86_64", "wsp-daemon"), "");
    writeFileSync(at.bundle, "");
    mkdirSync(at.inbox, { recursive: true });
    writeFileSync(at.tokenPath, "t");
    writeFileSync(at.profileFile, "");
    mkdirSync(at.binDir, { recursive: true });
    writeFileSync(join(at.binDir, "wsp-open"), "");
    symlinkSync(join(at.binDir, "wsp-open"), join(at.binDir, "xdg-open"));
    mkdirSync(at.unitDir, { recursive: true });
    appendFileSync(join(home, ".profile"), `${profileSourceLine(at.profileFile)}\n`);
    writeFileSync(at.placeFile, "{}");
    writeFileSync(at.placeKey, "k");
    writeFileSync(at.placeLog, "");
    mkdirSync(workFolderIn(home), { recursive: true });
  }

  /** The add's writes under this home alone: the unit and the workspace profile are the box's, and no test writes /etc. */
  function underHome(home: string): { place: ReturnType<typeof joinedPlace>; writes: ReturnType<typeof joinedAddWrites> } {
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    return { place, writes: joinedAddWrites(place, "/nonexistent/wsp-place.service").filter(w => w.path.startsWith(`${home}/`)) };
  }

  it("takes what the add wrote and leaves every file and folder the home held before it", () => {
    const home = tmp("undo-held");
    const at = placeDaemonPaths(home);
    // Their own bin folder with a tool in it, their login file, and a wsp folder a host on this login keeps its state in.
    mkdirSync(at.binDir, { recursive: true });
    writeFileSync(join(at.binDir, "mytool"), "#!/bin/sh\n");
    writeFileSync(join(home, ".profile"), "export EDITOR=vi\n");
    mkdirSync(at.wsp, { recursive: true });
    writeFileSync(join(at.wsp, "state.json"), "{}\n");
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    wroteTheAdd(home);
    expect(bash(addUndoScript(place, writes, found, "true", true))).toContain(DAEMON_GONE_LINE);
    expect(readdirSync(at.wsp)).toEqual(["state.json"]);
    expect(readdirSync(at.binDir)).toEqual(["mytool"]);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("export EDITOR=vi\n");
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(workFolderIn(home))).toBe(false);
  });

  it("leaves a home that held nothing of the add's as bare as it found it", () => {
    const home = tmp("undo-bare");
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    expect(found.size).toBe(0);
    wroteTheAdd(home);
    bash(addUndoScript(place, writes, found, "true", true));
    expect(readdirSync(home)).toEqual([]);
  });

  it("says the undo did not finish, and keeps the record's road, where a removal failed", () => {
    const home = tmp("undo-stuck");
    const at = placeDaemonPaths(home);
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    wroteTheAdd(home);
    chmodSync(at.wsp, 0o555);
    try {
      expect(bash(`${addUndoScript(place, writes, found, "true", true)} || true`)).not.toContain(DAEMON_GONE_LINE);
      expect(existsSync(at.placeFile)).toBe(true);
    } finally {
      chmodSync(at.wsp, 0o755);
    }
  });

  it("never follows a folder of the add's that was swapped for a link after the read", () => {
    const home = tmp("undo-swapped");
    const at = placeDaemonPaths(home);
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    wroteTheAdd(home);
    const elsewhere = tmp("undo-swapped-elsewhere");
    mkdirSync(join(elsewhere, posix.basename(at.dir)), { recursive: true });
    writeFileSync(join(elsewhere, posix.basename(at.dir), "precious"), "");
    writeFileSync(join(elsewhere, posix.basename(at.placeFile)), "{}");
    writeFileSync(join(elsewhere, "keep"), "");
    rmSync(at.wsp, { recursive: true });
    symlinkSync(elsewhere, at.wsp);
    expect(bash(`${addUndoScript(place, writes, found, "true", true)} || true`)).not.toContain(DAEMON_GONE_LINE);
    expect(readdirSync(elsewhere).sort()).toEqual([posix.basename(at.dir), posix.basename(at.placeFile), "keep"].sort());
    expect(readdirSync(join(elsewhere, posix.basename(at.dir)))).toEqual(["precious"]);
  });

  it("takes nothing where another add completed on the box after this add read it bare and failed before its join", () => {
    const home = tmp("undo-raced-b");
    const { place, writes } = underHome(home);
    // B reads a bare box, then A's add completes, then B's deploy fails at the files step.
    const found = addFound(bash(addFoundScript(place, writes, "false")), writes.length)!;
    expect(found.size).toBe(0);
    wroteTheAdd(home);
    const before = execFileSync("/usr/bin/find", [home], { encoding: "utf8" });
    const said = bash(addUndoScript(place, writes, found, "false", false));
    expect(said).toContain(ADD_TAKEN_LINE);
    expect(said).not.toContain(DAEMON_GONE_LINE);
    expect(execFileSync("/usr/bin/find", [home], { encoding: "utf8" })).toBe(before);
  });

  it("says the undo did not finish while a unit this add wrote fresh still runs", () => {
    const home = tmp("undo-fresh-unit");
    const state = tmp("undo-fresh-unit-state");
    // A systemctl that keeps active and enabled as files, and refuses disable --now.
    const systemctl = join(tmp("undo-fresh-unit-bin"), "systemctl");
    writeFileSync(
      systemctl,
      `#!/bin/sh\nS=${shellQuote(state)}\ncase "$1" in\n  is-active) [ -f "$S/active-$3" ];;\n  is-enabled) [ -f "$S/enabled-$3" ];;\n  stop) rm -f "$S/active-$2";;\n  disable) [ "$2" = --now ] && exit 1; rm -f "$S/enabled-$2";;\n  *) exit 0;;\nesac\n`,
      { mode: 0o755 },
    );
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    const unitPath = join(home, ".config/systemd/user/wsp-place.service");
    const writes = joinedAddWrites(place, unitPath).filter(w => w.path.startsWith(`${home}/`));
    const found = addFound(bash(addFoundScript(place, writes, systemctl)), writes.length)!;
    expect(found.size).toBe(0);
    wroteTheAdd(home);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "[Service]\n");
    writeFileSync(join(state, "active-wsp-place.service"), "");
    writeFileSync(join(state, "enabled-wsp-place.service"), "");
    expect(bash(`${addUndoScript(place, writes, found, systemctl, true)} || true`)).not.toContain(DAEMON_GONE_LINE);
    expect(existsSync(unitPath)).toBe(false);
    expect(existsSync(join(state, "active-wsp-place.service"))).toBe(true);
    // The same box where disable --now works: the unit stops and the undo says it finished.
    writeFileSync(systemctl, readFileSync(systemctl, "utf8").replace('[ "$2" = --now ] && exit 1;', '[ "$2" = --now ] && rm -f "$S/active-$3";'));
    wroteTheAdd(home);
    writeFileSync(unitPath, "[Service]\n");
    expect(bash(addUndoScript(place, writes, found, systemctl, true))).toContain(DAEMON_GONE_LINE);
    expect(existsSync(join(state, "active-wsp-place.service"))).toBe(false);
  });

  it("names every path a leave takes as the add's own, and never a folder above a home of /", () => {
    const home = "/home/maya";
    const at = placeDaemonPaths(home);
    const writes = joinedAddWrites(joinedPlace({ home, path: "/usr/bin" }, { hostUrls: [], codeFile: `${at.wsp}/join-code`, name: "box" }), placeUnit(home).path);
    const own = writes.filter(w => w.as === "own").map(w => w.path);
    for (const path of placeOwnedPaths(home).filter(path => path !== at.wsp)) expect(own).toContain(path);
    expect(own).not.toContain(at.wsp);
    const root = joinedAddWrites(joinedPlace({ home: "/", path: "/usr/bin" }, { hostUrls: [], codeFile: "/.wsp/join-code", name: "box" }), placeUnit("/").path);
    expect(root.filter(w => w.as === "folder").map(w => w.path)).not.toContain("/");
  });

  it("reads nothing as held where the box never finished saying, and only the writes it was asked about", () => {
    expect(addFound("WSP_HAD 0\n", 3)).toBeUndefined();
    expect([...addFound(`WSP_HAD 0\nWSP_HAD 2\nWSP_HAD 9\nWSP_HAD x\n${ADD_FOUND_END}\n`, 3)!]).toEqual([0, 2]);
  });
});

describe("the place file an add reads off a box before anything lands", () => {
  it("reads at most 64 KiB of it, whatever the box holds there", async () => {
    const home = tmp("held-home");
    const file = placeDaemonPaths(home).placeFile;
    mkdirSync(dirname(file), { recursive: true });
    const run = async (): Promise<string> => (await promisify(execFile)("/bin/bash", ["-c", heldPlaceScript(home)], { timeout: 10_000, maxBuffer: 1 << 24 })).stdout;
    writeFileSync(file, "x".repeat(200_000));
    expect((await run()).length).toBe(65_536);
    rmSync(file);
    symlinkSync("/dev/zero", file);
    expect((await run()).length).toBe(65_536);
    rmSync(file);
    expect(await run()).toBe("");
  });

  it("names another wsp's host in one bounded line with nothing the box wrote to move the terminal, and a url only where it is one", () => {
    const held = { placeId: "p_x", name: "spoo\x1b]0;owned\x07", hostName: `studio\x1b[2J\n${"h".repeat(5000)}`, hostUrls: ["/etc/passwd"], hostPublicKey: "c3R1ZGlv", keyPath: "/root/.wsp/place.key", joinedAt: "2026-09-20T10:00:00Z" };
    const line = placeHeldRefusal("root@spoo", held, undefined);
    expect(line.length).toBeLessThanOrEqual(SSH_LINE_CAP);
    expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(line).not.toContain("/etc/passwd");
    expect(line.startsWith("root@spoo already belongs to the wsp on studio[2J")).toBe(true);
    expect(placeHeldRefusal("root@spoo", { ...held, hostName: "studio", hostUrls: ["http://192.168.1.5:4640"] }, undefined)).toContain("studio at http://192.168.1.5:4640;");
    expect(placeHeldRefusal("root@spoo", { ...held, hostUrls: [`http://h/${"a".repeat(9000)}`] }, undefined)).not.toContain("http://h/");
    expect(placeHeldRefusal("root@spoo", { ...held, hostPublicKey: "dGhpcyBob3N0" }, keyFingerprint("dGhpcyBob3N0"))).toBe("root@spoo is already a place in this wsp as spoo]0;owned");
  });
});

describe("the check a box runs for whether it can reach this host", () => {
  /** A folder standing in for a box's PATH: bash always, and `timeout` or curl only where a case gives them. */
  function boxPath(name: string, tools: { timeout?: boolean; curl?: boolean }): string {
    const dir = tmp(name);
    symlinkSync("/bin/bash", join(dir, "bash"));
    if (tools.curl === true) symlinkSync("/usr/bin/curl", join(dir, "curl"));
    if (tools.timeout === true) writeFileSync(join(dir, "timeout"), '#!/bin/bash\nshift\nexec "$@"\n', { mode: 0o755 });
    return dir;
  }

  it("reaches an address that answers and not one nobody listens on, by curl, by bash under timeout, and by neither", async () => {
    const listening = createHttpServer((_req, res) => res.end("ok"));
    await new Promise<void>(done => listening.listen(0, "127.0.0.1", done));
    const quiet = createHttpServer();
    await new Promise<void>(done => quiet.listen(0, "127.0.0.1", done));
    const closedPort = (quiet.address() as { port: number }).port;
    await new Promise<void>(done => quiet.close(() => done()));
    const urls = [`http://127.0.0.1:${closedPort}`, `http://127.0.0.1:${(listening.address() as { port: number }).port}`];
    const run = async (PATH: string): Promise<string> => (await promisify(execFile)("/bin/bash", ["-c", reachScript(urls)], { env: { PATH }, timeout: 20_000 })).stdout;
    try {
      expect(reachedUrls(await run(boxPath("reach-curl", { curl: true })), urls)).toEqual([urls[1]]);
      expect(reachedUrls(await run(boxPath("reach-tcp", { timeout: true })), urls)).toEqual([urls[1]]);
      const neither = await run(boxPath("reach-neither", {}));
      expect(reachedUrls(neither, urls)).toEqual([]);
      expect(neither).toContain(`WSP_REACH no ${urls[1]}`);
    } finally {
      await new Promise<void>(done => listening.close(() => done()));
    }
  });

  it("reaches an address directly under a proxy in the box's environment, as the join and the daemon dial it", async () => {
    const listening = createHttpServer((_req, res) => res.end("ok"));
    await new Promise<void>(done => listening.listen(0, "127.0.0.1", done));
    const urls = [`http://127.0.0.1:${(listening.address() as { port: number }).port}`];
    const dead = "http://127.0.0.1:9";
    try {
      const said = (await promisify(execFile)("/bin/bash", ["-c", reachScript(urls)], { env: { PATH: boxPath("reach-proxy", { curl: true }), http_proxy: dead, HTTP_PROXY: dead, all_proxy: dead }, timeout: 20_000 })).stdout;
      expect(reachedUrls(said, urls)).toEqual(urls);
    } finally {
      await new Promise<void>(done => listening.close(() => done()));
    }
  });

  it("says every address it cannot reach while they fit the line, and how many more past that, keeping the fix", () => {
    const urls = Array.from({ length: 12 }, (_, i) => `http://100.64.${i}.${i + 10}:4640`);
    const line = unreachedLine("root@spoo", urls);
    expect(line.length).toBeLessThanOrEqual(SSH_LINE_CAP);
    expect(line).toContain(urls[0]);
    expect(line).toMatch(/ and \d+ more, so nothing of wsp's went onto it; link this host to your relay/);
    expect(unreachedLine("root@spoo", urls.slice(0, 2))).toBe(
      `root@spoo cannot reach this computer at ${urls[0]}, ${urls[1]}, so nothing of wsp's went onto it; link this host to your relay, or start it with --advertise naming an address root@spoo can reach`,
    );
  });

  it("keeps the order the addresses were handed in and ignores a line naming one it was not handed", () => {
    const urls = ["http://100.129.166.28:4640", "https://wsp-box.example.com", "http://192.168.1.20:4640"];
    expect(reachedUrls("WSP_REACH ok http://192.168.1.20:4640\nWSP_REACH ok https://wsp-box.example.com\nWSP_REACH ok http://10.9.9.9:1\nWSP_REACH no http://100.129.166.28:4640\n", urls)).toEqual([urls[1], urls[2]]);
    // A tunnel's address names no port, and the fallback try dials the one its scheme implies.
    expect(reachScript(["https://wsp-box.example.com", "http://[fd00::1]:4640"])).toContain("reach 'https://wsp-box.example.com' 'wsp-box.example.com' 443 &");
    expect(reachScript(["http://[fd00::1]:4640"])).toContain("reach 'http://[fd00::1]:4640' 'fd00::1' 4640 &");
  });
});

describe("the sweep a computer runs on itself", () => {
  it("takes the browser name it left even once the shim it pointed at has gone, and its own line out of the login file", async () => {
    const home = tmp("sweep-leftovers");
    const at = placeDaemonPaths(home);
    mkdirSync(at.binDir, { recursive: true });
    writeFileSync(`${at.binDir}/wsp-open`, "#!/bin/sh\n");
    // The name every tool execs, pointing at the shim: once the shim goes it is a link to nothing, which every
    // read that follows a link calls absent while the person is still left holding it.
    symlinkSync(`${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`);
    // Both spellings: the one a computer joined before the line was guarded carries, and the one a deploy writes
    // now. The sweep matches wsp's line by the file it names, so it takes out either.
    writeFileSync(join(home, ".profile"), `# theirs\n. ${at.profileFile}\nexport EDITOR=vi\n[ -f ${at.profileFile} ] && . ${at.profileFile}\n`);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(existsSync(`${at.binDir}/xdg-open`)).toBe(false);
    expect(swept.removed).toContain(`${at.binDir}/xdg-open`);
    // Their file keeps everything of theirs and loses the one line wsp put in it.
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# theirs\nexport EDITOR=vi\n");
    expect(swept.removed).toContain(`. ${at.profileFile}; [ -f ${at.profileFile} ] && . ${at.profileFile} (out of ${join(home, ".profile")})`);
  });

  it("takes its line out of the login file by the one config write: a killed write's temp swept, a hard-linked file left whole and said", async () => {
    const home = tmp("sweep-profile-write");
    const at = placeDaemonPaths(home);
    const line = `[ -f ${at.profileFile} ] && . ${at.profileFile}`;
    writeFileSync(join(home, ".profile"), `# theirs\n${line}\n`);
    const stale = join(home, ".wsp-config-tmp.dead01");
    writeFileSync(stale, "half a file");
    const aged = new Date(Date.now() - 11 * 60_000);
    utimesSync(stale, aged, aged);
    await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# theirs\n");
    expect(existsSync(stale)).toBe(false);

    writeFileSync(join(home, ".profile"), `# theirs\n${line}\n`);
    linkSync(join(home, ".profile"), join(home, "profile-twin"));
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(readFileSync(join(home, "profile-twin"), "utf8")).toBe(`# theirs\n${line}\n`);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`# theirs\n${line}\n`);
    expect(swept.kept).toContain(`${line} stays in ${join(home, ".profile")}: ${configHardLinkRefusal(join(home, ".profile"))}`);
  });

  it("leaves a login file it never wrote to exactly as it was", async () => {
    const home = tmp("sweep-untouched");
    writeFileSync(join(home, ".profile"), "# theirs\n");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# theirs\n");
    expect(swept.removed.some(line => line.includes(".profile"))).toBe(false);
  });
});

describe("what wsp add asks the host for", () => {
  /** A host answering the two ops wsp add sends, with what it was asked kept. A door named as a sentence is a host
   * that refused the ask with it; nothing at all is a host that serves no door. */
  const fakeClient = (door: PlaceDoorView | string | undefined): { client: NonNullable<Parameters<typeof addCommand>[4]>["dial"]; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      client: () =>
        Promise.resolve({
          request: (op: string) => {
            asked.push(op);
            if (op === "pair.issue") return Promise.resolve({ code: "7QK3M2VD", expiresAt: 600_000 } as never);
            if (op === "places.door") {
              if (door === undefined) return Promise.reject(new Error(PLACE_DOOR_UNSERVED));
              return typeof door === "string" ? Promise.reject(new Error(door)) : Promise.resolve({ door } as never);
            }
            return Promise.reject(new Error(`unexpected op ${op}`));
          },
          events: () => Promise.resolve(),
          onFrame: () => () => {},
          closed: Promise.resolve(),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const addDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("opens the door by asking for it and prints its address, so a host on loopback alone is still one a computer can join", async () => {
    const home = tmp("add-door");
    const io = captured();
    const fake = fakeClient({ port: 4420, addresses: ["http://192.168.1.20:4420"], hostKey: `SHA256:${"c".repeat(43)}` });
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await addCommand(io, opts, [], {}, addDeps(fake.client))).toBe(0);
    expect(fake.asked).toEqual(["pair.issue", "places.door"]);
    // The token names the key the host on this computer signs with, off the pair beside its state file, so the
    // computer typing this line can tell that host from anything else answering at that address.
    expect(io.lines.join("\n")).toContain(`wsp join http://192.168.1.20:4420 --code ${joinToken("7QK3M2VD", hostKeyHere(opts.statePath))}`);
    // The loopback refusal is about a host nothing can dial; a host that just opened a door is not one.
    expect(io.errors.join("\n")).not.toContain("--listen");
  });

  it("prints the door's own sentence when the host has one and could not open it, and points at no other fix", async () => {
    const home = tmp("add-door-held");
    const io = captured();
    const fake = fakeClient(doorPortHeldLine(4420));
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await addCommand(io, opts, [], {}, addDeps(fake.client))).toBe(0);
    expect(io.errors.join("\n")).toContain(doorPortHeldLine(4420));
    expect(io.errors.join("\n")).not.toContain("--listen");
  });

  it("falls back to the host's own address and says a loopback host can be dialled by nothing when it serves no door", async () => {
    const home = tmp("add-no-door");
    const io = captured();
    const fake = fakeClient(undefined);
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await addCommand(io, opts, [], {}, addDeps(fake.client))).toBe(0);
    expect(io.errors.join("\n")).toContain("--listen");
    expect(io.lines.join("\n")).toContain("wsp join http://127.0.0.1:");
    // A door that would not open still leaves the key readable here, so the line it prints names one.
    expect(io.lines.join("\n")).toContain(hostKeyHere(opts.statePath));
  });
});

describe("wsp add <place> --sign-in <agent>", () => {
  const spoo: PlaceView = {
    id: "p_1",
    kind: "computer",
    name: "spoo",
    default: true,
    joinedAt: new Date(0).toISOString(),
    agents: ["claude", "codex"],
    logins: "/var/lib/wsp/logins",
  };

  /** A host holding one joined computer, answering the listing and planning each line: the sign-in itself is handed in. */
  const planned: { target: unknown; agent: unknown }[] = [];
  const landed: Record<string, unknown>[] = [];
  const listing = (places: PlaceView[] = [spoo]): NonNullable<Parameters<typeof addCommand>[4]>["dial"] => () =>
    Promise.resolve({
      request: (op: string, params: Record<string, unknown> = {}) =>
        op === "places.list"
          ? Promise.resolve({ places } as never)
          : op === "agents.signInLine"
            ? (planned.push({ target: params["target"], agent: params["agent"] }), Promise.resolve({ line: { command: `${String(params["agent"])} login` } } as never))
            : op === "places.loginLanded"
              ? (landed.push(params), Promise.resolve({} as never))
              : Promise.reject(new Error(`unexpected op ${op}`)),
      events: () => Promise.resolve(),
      onFrame: () => () => {},
      closed: Promise.resolve(),
      closeWords: () => "",
      close: () => {},
    } as never);

  const signingIn = (answer: Awaited<ReturnType<NonNullable<Parameters<typeof addCommand>[4]>["signIn"]>>, places?: PlaceView[]) => {
    const asked: { agent?: string; line: SignInLine }[] = [];
    return {
      asked,
      deps: {
        ...systemPlaceDeps,
        dial: listing(places),
        signIn: async (o: { agent?: string; line: SignInLine }) => {
          asked.push({ agent: o.agent, line: o.line });
          return answer;
        },
      } as Parameters<typeof addCommand>[4],
    };
  };

  it("signs the agent in on the computer named by the line the host plans for it there", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true, detail: "ChatGPT" });
    planned.length = 0;
    landed.length = 0;
    expect(await addCommand(io, opts(tmp("signin-place")), ["spoo"], { signIn: "codex" }, run.deps)).toBe(0);
    expect(planned).toEqual([{ target: { placeId: "p_1" }, agent: "codex" }]);
    // That computer lists its logins only when it dials, so the host is told the one the tool's status said landed.
    expect(landed).toEqual([{ placeId: "p_1", agent: "codex" }]);
    expect(run.asked).toEqual([{ agent: "codex", line: { command: "codex login" } }]);
    expect(io.lines.join("\n")).toContain("Codex is signed in on spoo (ChatGPT); every workspace there shares that login.");
    // A row that says where that computer keeps its logins is never turned away: the host asks its backend again
    // whenever a computer dials back on another daemon, so a box that has just taken this one is ready here.
    expect(io.errors.join("\n")).not.toContain(placeNoLoginsLine("spoo"));
  });

  it("signs in an agent whose login is not shared too, as the host plans it, and says so without a shared login", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true });
    expect(await addCommand(io, opts(tmp("signin-gemini")), ["spoo"], { signIn: "gemini" }, run.deps)).toBe(0);
    expect(run.asked).toEqual([{ agent: "gemini", line: { command: "gemini login" } }]);
    expect(io.lines.join("\n")).toContain("Gemini CLI is signed in on spoo.");
    expect(io.lines.join("\n")).not.toContain("shares that login");
  });

  it("answers a sign-in that did not land with what the tool said and the line that runs it again", async () => {
    const io = captured();
    const run = signingIn({ signedIn: false, said: "Not logged in" });
    landed.length = 0;
    expect(await addCommand(io, opts(tmp("signin-not")), ["spoo"], { signIn: "codex" }, run.deps)).toBe(1);
    expect(landed).toEqual([]);
    expect(io.lines.join("\n")).toContain("Not logged in");
    expect(io.lines.join("\n")).toContain("wsp add spoo --sign-in codex");
  });

  it("refuses an agent whose login sits in the image, a computer no place answers to, and the flags of a join", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true });
    // Claude Code's login is a token on this computer, so there is nothing to sign in on a box.
    expect(await addCommand(io, opts(tmp("signin-claude")), ["spoo"], { signIn: "claude" }, run.deps)).toBe(1);
    expect(io.errors.join("\n")).toContain("codex");
    expect(run.asked).toEqual([]);
    const gone = captured();
    expect(await addCommand(gone, opts(tmp("signin-none")), ["laptop"], { signIn: "codex" }, run.deps)).toBe(1);
    expect(gone.errors[0]).toContain("It holds spoo.");
    const named = captured();
    expect(await addCommand(named, opts(tmp("signin-flags")), ["spoo"], { signIn: "codex", name: "box" }, run.deps)).toBe(1);
    expect(named.errors[0]).toBe(SIGN_IN_FLAGS_REFUSAL);
    // And a computer that has not said where it keeps them has nowhere to put one.
    const quiet = signingIn({ signedIn: true }, [{ ...spoo, logins: undefined }]);
    const unsaid = captured();
    expect(await addCommand(unsaid, opts(tmp("signin-unsaid")), ["spoo"], { signIn: "codex" }, quiet.deps)).toBe(1);
    expect(unsaid.errors[0]).toBe(placeNoLoginsLine("spoo"));
    expect(quiet.asked).toEqual([]);
  });
});

describe("wsp add <place> --update", () => {
  /** A host holding one joined computer, answering the two ops the flag sends and keeping what it was asked. */
  const updateClient = (
    answer: Record<string, unknown> | Error,
    places: PlaceView[] = [{ id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString(), daemonVersion: DAEMON_VERSION - 1 }],
  ): { dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]; asked: { op: string; params?: Record<string, unknown> }[] } => {
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    return {
      asked,
      dial: () =>
        Promise.resolve({
          request: (op: string, params?: Record<string, unknown>) => {
            asked.push({ op, ...(params === undefined ? {} : { params }) });
            if (op === "places.list") return Promise.resolve({ places } as never);
            if (op === "places.update") return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as never);
            return Promise.reject(new Error(`unexpected op ${op}`));
          },
          events: () => Promise.resolve(),
          onFrame: () => () => {},
          closed: Promise.resolve(),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const updateDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("names the place by the word wsp places prints and asks the host to move it, then says both versions and the road", async () => {
    const home = tmp("update-place");
    const io = captured();
    const fake = updateClient({ name: "spoo", daemon: { from: 27, to: DAEMON_VERSION, road: "link", at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" } });
    expect(await addCommand(io, opts(home), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(0);
    expect(fake.asked.map(a => a.op)).toEqual(["places.list", "places.update"]);
    // The id off the listing, never the word the person typed: two computers may share a name and the host keys by id.
    // The stream the recipe's rows ride is minted here, so they are read from the first one.
    expect(fake.asked[1]!.params).toEqual({ placeId: "p_1", addId: expect.stringMatching(/^a_[0-9a-f]{12}$/) });
    expect(io.lines.join("\n")).toContain(`spoo: daemon 27 to ${DAEMON_VERSION}, over the link`);
    expect(io.lines.join("\n")).toContain("/home/maya/.wsp/daemon/wsp-daemon");
    // Where the one it replaced was kept, which is the first thing to look at on a box that will not come up.
    expect(io.lines.join("\n")).toContain("the old one     /home/maya/.wsp/daemon/wsp-daemon.old");
    // A daemon that answered no kept path simply says nothing of it rather than an empty row.
    expect(updatedLines({ name: "spoo", daemon: { from: 27, to: 34, road: "link", at: "/x" } }).some(line => line.includes("the old one"))).toBe(false);
  });

  it("says the note when the computer took the daemon and had not dialled back on it yet", async () => {
    const io = captured();
    const fake = updateClient({ name: "spoo", daemon: { from: 27, to: 27, road: "ssh", at: "/home/maya/.wsp/daemon/wsp-daemon", note: "spoo took the daemon and had not dialled back on it within 60s; its row reads the new version once it does" } });
    expect(await addCommand(io, opts(tmp("update-slow")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(0);
    expect(io.lines.join("\n")).toContain("over the ssh road");
    expect(io.lines.join("\n")).toContain("had not dialled back on it within 60s");
  });

  /** A host whose update answers `reply` and, while it does, pushes the recipe's own rows back on the stream the
   * line minted. The listing it answers with carries the job as it stands once the rows have landed. */
  const recipeClient = (reply: Record<string, unknown> | Error, listed: PlaceProvision) => {
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const rows: PlaceView[] = [{ id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString(), daemonVersion: DAEMON_VERSION }];
    return {
      asked,
      dial: (): Promise<never> =>
        Promise.resolve({
          request: (op: string, params?: Record<string, unknown>) => {
            asked.push({ op, ...(params === undefined ? {} : { params }) });
            // The row carries the job from the moment the first line started it, which is before this line asks.
            if (op === "places.list") return Promise.resolve({ places: rows.map(r => (reply instanceof Error || asked.some(a => a.op === "places.update") ? { ...r, provision: listed } : r)) } as never);
            if (op !== "places.update") return Promise.reject(new Error(`unexpected op ${op}`));
            if (reply instanceof Error) return Promise.reject(reply);
            const addId = String(params!["addId"]);
            for (const fn of frames) {
              for (const row of listed.rows) fn({ type: "place.stage", addId, step: "provision", state: "running", note: `${row.label}: ${row.outcome}` });
              fn({ type: "place.stage", addId, step: "provision", state: listed.state === "done" ? "done" : "failed", note: "the rows are in" });
              // Another computer's job on the same host is another stream, and this line prints none of it.
              fn({ type: "place.stage", addId: "a_other", step: "provision", state: "running", note: "somebody else's row" });
            }
            return Promise.resolve(reply as never);
          },
          events: () => Promise.resolve(),
          onFrame: (fn: (frame: Record<string, unknown>) => void) => {
            frames.push(fn);
            return () => frames.splice(frames.indexOf(fn), 1);
          },
          closed: Promise.resolve(),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const jobOf = (rows: PlaceProvision["rows"], state: PlaceProvision["state"] = "done"): PlaceProvision => ({
    state,
    addId: "a_1",
    recipeAt: "2026-09-17T10:00:00.000Z",
    startedAt: "2026-09-17T10:01:00.000Z",
    rows,
  });

  it("puts the recipe on a computer already running this daemon, saying so and then printing every row", async () => {
    const io = captured();
    const job = jobOf([
      { id: "agents/node", label: "Node 22.23.2", outcome: "present" },
      { id: "agents/codex", label: "Codex", outcome: "installed" },
    ]);
    const fake = recipeClient({ name: "spoo", provision: { ...job, state: "running" } }, job);
    expect(await addCommand(io, opts(tmp("update-recipe")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(0);
    const said = io.lines.join("\n");
    // No daemon half in the reply: the computer is current, and the line says so rather than refusing the update.
    expect(said).toContain(placeCurrentLine("spoo", DAEMON_VERSION));
    expect(said).toContain("Codex: installed");
    expect(said).toContain("spoo: 1 installed: Codex, 1 already there");
    expect(said).not.toContain("somebody else's row");
    // The rows are read off the row the host keeps, which is what outlives the run.
    expect(fake.asked.map(a => a.op)).toEqual(["places.list", "places.update", "places.list"]);
  });

  it("exits 1 naming the row that failed, and 0 when every row landed or was already there", async () => {
    const io = captured();
    const failed = jobOf([
      { id: "agents/codex", label: "Codex", outcome: "installed" },
      { id: "tools/brew/gh", label: "gh", outcome: "failed", note: "brew answered 404" },
    ]);
    const fake = recipeClient({ name: "spoo", provision: { ...failed, state: "running" } }, failed);
    expect(await addCommand(io, opts(tmp("update-failed")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(1);
    expect(io.lines.join("\n")).toContain("x gh: brew answered 404");
    const stopped = jobOf([{ id: "agents/codex", label: "Codex", outcome: "installed" }], "stopped");
    const gone = recipeClient({ name: "spoo", provision: { ...stopped, state: "running" } }, { ...stopped, said: "spoo is not connected" });
    const quiet = captured();
    expect(await addCommand(quiet, opts(tmp("update-stopped")), ["spoo"], { update: true }, updateDeps(gone.dial))).toBe(1);
    expect(quiet.lines.join("\n")).toContain("spoo: spoo is not connected");
  });

  it("returns on a computer whose recipe is already going on, in the one sentence, rather than waiting on a job it did not start", async () => {
    const io = captured();
    // What the host answers a second update: the op's own refusal, while the listing's row still carries the job
    // the first line started. A line that followed that row would wait on a stream nothing of its own ends.
    const job = jobOf([{ id: "agents/codex", label: "Codex", outcome: "installed" }], "running");
    const busy = placeProvisioningLine("spoo", { label: "Codex", index: 1, of: 2 });
    const fake = recipeClient(Object.assign(new Error(busy), { kind: "conflict" }), job);
    const code = await Promise.race([
      addCommand(io, opts(tmp("update-busy")), ["spoo"], { update: true }, updateDeps(fake.dial)),
      new Promise<string>(resolve => setTimeout(() => resolve("still waiting"), 1000)),
    ]);
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain(busy);
    // Nothing of the running job's tally is printed: those rows are not this line's to say.
    expect(io.lines.join("\n")).not.toContain("Codex: installed");
    expect(fake.asked.map(a => a.op)).toEqual(["places.list", "places.update"]);
  });

  it("says what a computer that got no recipe at all got, and exits 0: nothing failed", async () => {
    const io = captured();
    const fake = updateClient({ name: "spoo", said: placeNoRecipeLine("spoo", "/Users/lena/.wsp/recipe.json") });
    expect(await addCommand(io, opts(tmp("update-norecipe")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(0);
    expect(io.lines.join("\n")).toContain("this computer has no recipe at /Users/lena/.wsp/recipe.json");
    // Nothing to follow, so nothing is read again.
    expect(fake.asked.map(a => a.op)).toEqual(["places.list", "places.update"]);
  });

  it("refuses a word no place answers to in the line the person typed, never in the remove's", async () => {
    const io = captured();
    const fake = updateClient(new Error("never asked"));
    expect(await addCommand(io, opts(tmp("update-none")), ["laptop"], { update: true }, updateDeps(fake.dial))).toBe(1);
    expect(fake.asked.map(a => a.op)).toEqual(["places.list"]);
    expect(io.errors[0]).toContain(placeUpdateLine("laptop"));
    expect(io.errors[0]).toContain("It holds spoo.");
    expect(io.errors[0]).not.toContain("wsp remove");
  });

  it("names the ids when two computers share the word, since ids tell them apart", async () => {
    const io = captured();
    const two: PlaceView[] = [
      { id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString() },
      { id: "p_2", kind: "computer", name: "spoo", default: false, joinedAt: new Date(0).toISOString() },
    ];
    const fake = updateClient(new Error("never asked"), two);
    expect(await addCommand(io, opts(tmp("update-two")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(1);
    expect(io.errors[0]).toContain("p_1, p_2");
    expect(io.errors[0]).toContain(placeUpdateLine("spoo"));
  });

  it("refuses the flag with no place named, and beside the flags a join takes", async () => {
    const io = captured();
    const fake = updateClient(new Error("never asked"));
    await expect(addCommand(io, opts(tmp("update-bare")), [], { update: true }, updateDeps(fake.dial))).rejects.toThrow(/takes the place/);
    const beside = captured();
    expect(await addCommand(beside, opts(tmp("update-flags")), ["spoo"], { update: true, name: "other" }, updateDeps(fake.dial))).toBe(1);
    expect(beside.errors).toEqual([UPDATE_FLAGS_REFUSAL]);
    // Nothing was dialled for either: both are read off the line before a socket is opened.
    expect(fake.asked).toEqual([]);
  });
});

describe("which binary an update carries and how it travels", () => {
  /** A daemon asset holding one binary per target, each with its own bytes, as a release stages it. */
  const daemonDir = (): string => {
    const dir = tmp("update-asset");
    for (const target of GUEST_DAEMON_TARGETS) {
      const at = daemonBinaryIn(dir, target.triple);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, `a daemon for ${target.uname}`);
    }
    return dir;
  };

  /** A link that keeps every frame it was sent and answers the last part with where the binary landed. */
  const fakeLink = (): { link: NonNullable<PlaceUpdateRequest["link"]>; frames: Record<string, unknown>[] } => {
    const frames: Record<string, unknown>[] = [];
    return {
      frames,
      link: {
        request: (op: string, params?: Record<string, unknown>) => {
          frames.push({ op, ...params });
          if (op === "exec") return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", truncated: false });
          return Promise.resolve(params?.["last"] === true ? { at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" } : {});
        },
      } as never,
    };
  };

  const reportOf = (over: Partial<PlaceReport> = {}): PlaceReport => ({
    name: "spoo",
    platform: "linux",
    arch: "x64",
    os: "Ubuntu 24.04",
    shape: { cpu: 2, memMb: 7747 },
    login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
    runsWorkspaces: true,
    engine: "none",
    daemonVersion: 27,
    agents: [],
    wsp: ["/home/maya/.wsp/daemon/wsp/dist/bin.js"],
    dialed: "http://192.168.1.20:4400",
    ...over,
  });

  it("picks the binary by the chip that computer said it is, never this one's, and sends it as bytes under one upload id", async () => {
    const dir = daemonDir();
    const { link, frames } = fakeLink();
    const landed = await placeUpdater({ daemonDir: dir })({ placeId: "p_1", name: "spoo", report: reportOf({ arch: "arm64" }), daemon: true, link });
    // Both paths come off the last part's own reply, so the line names what that computer actually did.
    expect(landed).toEqual({ road: "link", at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" });
    // The chip the box said, so a host on x64 deploys to an arm64 box the binary that box can run.
    const wanted = readFileSync(daemonBinaryIn(dir, "aarch64-unknown-linux-musl"));
    // The bytes are the parts alone: ahead of them rides the one exec that writes wsp's login files there, which
    // the cases below read.
    const parts = frames.filter(f => f["op"] === "place.update");
    expect(frames.map(f => f["op"])).toEqual(["exec", ...parts.map(() => "place.update")]);
    expect(Buffer.concat(parts.map(f => Buffer.from(String(f["data"]), "base64")))).toEqual(wanted);
    expect(new Set(parts.map(f => f["uploadId"]))).toHaveProperty("size", 1);
    // Every part carries the sha256 of the whole, which is what the last part is checked against before anything
    // is moved over the binary the unit starts.
    expect(new Set(parts.map(f => f["sha256"]))).toEqual(new Set([createHash("sha256").update(wanted).digest("hex")]));
    expect(parts.map(f => f["seq"])).toEqual([...parts.keys()]);
    expect(parts.at(-1)!["last"]).toBe(true);
    // Never a command line: a command sits in a world readable /proc/<pid>/cmdline while it runs.
    expect(parts.some(f => typeof f["cmd"] === "string")).toBe(false);
  });

  it("refuses a chip this wsp builds no daemon for, and a computer with no link and no login, before a byte moves", async () => {
    const dir = daemonDir();
    const { link, frames } = fakeLink();
    await expect(placeUpdater({ daemonDir: dir })({ placeId: "p_1", name: "spoo", report: reportOf({ arch: "riscv64" }), daemon: true, link })).rejects.toThrow(
      placeNoChipLine("spoo", "linux", "riscv64"),
    );
    await expect(placeUpdater({ daemonDir: dir })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true })).rejects.toThrow(placeNoUpdateRoadLine("spoo"));
    expect(frames).toEqual([]);
  });

  it("says which file is missing where this command carries no daemon for that chip at all", async () => {
    const { link } = fakeLink();
    const empty = tmp("update-no-asset");
    await expect(placeUpdater({ daemonDir: empty })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, link })).rejects.toThrow(/wsp-daemon binary missing/);
  });
});

describe("wsp's own login files on a computer already joined, written by every update", () => {
  const HOME = "/home/maya";
  /** The lines this host spells for that box, off the place its login names: the one home of the text, which the
   * deploy at the join reads too. */
  const FILES = loginFilesStep(sshDaemonPlace({ home: HOME, path: "/usr/bin" })).join("\n");

  const reportOf = (over: Partial<PlaceReport> = {}): PlaceReport => ({
    name: "spoo",
    platform: "linux",
    arch: "x64",
    os: "Ubuntu 24.04",
    shape: { cpu: 2, memMb: 7747 },
    login: { HOME, USER: "maya", PATH: "/usr/bin" },
    runsWorkspaces: true,
    engine: "none",
    daemonVersion: 27,
    agents: [],
    wsp: [`${HOME}/.wsp/daemon/wsp/dist/bin.js`],
    dialed: "http://192.168.1.20:4400",
    ...over,
  });

  /** A daemon asset with one binary per target, as the update's own cases stage it. */
  const daemonDir = (): string => {
    const dir = tmp("login-files-asset");
    for (const target of GUEST_DAEMON_TARGETS) {
      const at = daemonBinaryIn(dir, target.triple);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, `a daemon for ${target.uname}`);
    }
    return dir;
  };

  const fakeLink = (): { link: NonNullable<PlaceUpdateRequest["link"]>; frames: Record<string, unknown>[] } => {
    const frames: Record<string, unknown>[] = [];
    return {
      frames,
      link: {
        request: (op: string, params?: Record<string, unknown>) => {
          frames.push({ op, ...params });
          if (op === "exec") return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", truncated: false });
          return Promise.resolve(params?.["last"] === true ? { at: `${HOME}/.wsp/daemon/wsp-daemon` } : {});
        },
      } as never,
    };
  };

  /** One box over ssh, as the update's road sees it: what it was asked to run and what landed on it. */
  const fakeBox = (answer = { exitCode: 0, stdout: `${PLACE_UPDATED_LINE} /usr/local/bin/wsp-daemon\n`, stderr: "" }, home = HOME, system = "Linux") => {
    const ran: string[] = [];
    const landed: string[] = [];
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async (path: string) => {
        landed.push(path);
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Ubuntu 24.04" }),
      run: async (script: string) => {
        ran.push(script);
        return answer;
      },
    };
    return { ran, landed, backend: { adopt: async () => ({ machine, login: { HOME: home, PATH: "/usr/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, system, arch: "x86_64" }) } };
  };

  it("sends them over the link as one exec ahead of the first frame of the swap, in the text the deploy writes", async () => {
    const { link, frames } = fakeLink();
    const landed = await placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, link });
    expect(landed).toMatchObject({ road: "link" });
    // One exec, and it carries the one home of the text: wsp's own profile file and the guarded line for the
    // person's login file, with every older line naming that file taken out first.
    const execs = frames.filter(f => f["op"] === "exec");
    expect(execs).toHaveLength(1);
    expect(execs[0]!["cmd"]).toBe(FILES);
    expect(String(execs[0]!["cmd"])).toContain(profileSourceLine(sshDaemonPaths(HOME).profileFile));
    expect(String(execs[0]!["cmd"])).toContain(`grep -vF '${sshDaemonPaths(HOME).profileFile}' '${HOME}/.profile'`);
    // Ahead of the bytes: the swap restarts that daemon and drops this link, so an exec sent after it reaches
    // nothing.
    expect(frames.findIndex(f => f["op"] === "exec")).toBeLessThan(frames.findIndex(f => f["op"] === "place.update"));
  });

  it("writes them on an update that carries no binary, and answers no landing", async () => {
    const { link, frames } = fakeLink();
    // No daemon asset at all: an update that carries no binary reads none, so nothing here can land one.
    const answer = await placeUpdater({ daemonDir: tmp("login-files-no-asset") })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false, link });
    expect(answer).toBeUndefined();
    expect(frames.map(f => f["op"])).toEqual(["exec"]);
    expect(frames[0]!["cmd"]).toBe(FILES);
  });

  it("refuses a computer it holds no road to, on an update that carries no binary as on one that does", async () => {
    // A computer joined by a code holds no ssh login, so a link that is down leaves this nothing to run the
    // lines over: an update of a computer that cannot be reached is refused rather than passed over quietly.
    await expect(
      placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false }),
    ).rejects.toThrow(placeNoUpdateRoadLine("spoo"));
  });

  it("passes over a computer whose report records no home, on either kind of update", async () => {
    const bare = reportOf({ login: { USER: "maya", PATH: "/usr/bin" } });
    const none = fakeLink();
    expect(await placeUpdater({ daemonDir: tmp("login-files-bare") })({ placeId: "p_1", name: "spoo", report: bare, daemon: false, link: none.link })).toBeUndefined();
    expect(none.frames).toEqual([]);
    // And where a binary goes all the same: every path the lines build comes off that home and there is none.
    const moving = fakeLink();
    await placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "spoo", report: bare, daemon: true, link: moving.link });
    expect(moving.frames.every(f => f["op"] === "place.update")).toBe(true);
  });

  it("puts them ahead of the swap in the one script over ssh, off the login that road just read", async () => {
    const box = fakeBox();
    const landed = await placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({
      placeId: "p_1",
      name: "spoo",
      report: reportOf(),
      daemon: true,
      ssh: { ssh: "maya@box" },
    });
    expect(landed).toEqual({ road: "ssh", at: "/usr/local/bin/wsp-daemon", kept: "/usr/local/bin/wsp-daemon.old" });
    expect(box.ran).toHaveLength(1);
    expect(box.ran[0]).toContain(FILES);
    expect(box.ran[0]!.indexOf(FILES)).toBeLessThan(box.ran[0]!.indexOf("systemctl restart"));
  });

  it("refuses a box that now says it is a Mac before a byte lands, though its chip matches a Linux row", async () => {
    const box = fakeBox(undefined, HOME, "Darwin");
    await expect(
      placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, ssh: { ssh: "maya@box" } }),
    ).rejects.toThrow(noPlaceSystemLine("Darwin", "that computer", true));
    expect(box.landed).toEqual([]);
    expect(box.ran).toEqual([]);
  });

  it("runs them alone over ssh where no binary goes, and lands nothing", async () => {
    const box = fakeBox({ exitCode: 0, stdout: "", stderr: "" });
    expect(
      await placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false, ssh: { ssh: "maya@box" } }),
    ).toBeUndefined();
    expect(box.ran).toEqual([FILES]);
    expect(box.landed).toEqual([]);
  });

  it("stops the update on the box's own words where the lines could not be written", async () => {
    const box = fakeBox({ exitCode: 1, stdout: "", stderr: "/home/maya/.profile: Permission denied" });
    await expect(
      placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false, ssh: { ssh: "maya@box" } }),
    ).rejects.toThrow(placeLoginFilesFailedLine("spoo", "/home/maya/.profile: Permission denied"));
  });

  /** The text each road sends, run for real under bash on a home of this test's own: what a person's login file
   * holds afterwards is the whole of what these lines promise. Both roads run them under a plain `bash -c`, the
   * daemon's exec on the link road and the transport's on the ssh road, and neither sets `set -e`. */
  const ranOn = (body: string): void => {
    execFileSync("bash", ["-c", body], { encoding: "utf8" });
  };

  it("leaves a login file holding the old unguarded line with exactly one guarded line and the rest byte for byte", async () => {
    const home = tmp("login-files-live");
    const at = sshDaemonPaths(home);
    // What the correction read on that computer: the line the deploy wrote before the guard, with the person's
    // own lines around it.
    writeFileSync(join(home, ".profile"), `# theirs\n. ${at.profileFile}\n# after\n`);
    const { link, frames } = fakeLink();
    await placeUpdater({ daemonDir: tmp("login-files-live-asset") })({
      placeId: "p_1",
      name: "spoo",
      report: reportOf({ login: { HOME: home, USER: "maya", PATH: "/usr/bin" } }),
      daemon: false,
      link,
    });
    ranOn(String(frames[0]!["cmd"]));
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`# theirs\n# after\n${profileSourceLine(at.profileFile)}\n`);
    expect(readFileSync(at.profileFile, "utf8")).toBe(`export BROWSER=${at.binDir}/wsp-open\nunset DISPLAY\n`);
    // The copy the take-out writes is its own and goes with it: nothing of wsp's is left beside their file.
    expect(existsSync(`${join(home, ".profile")}.wsp-out`)).toBe(false);
  });

  it("makes the one line over ssh where the login has no file of its own, and says it once however often it runs", async () => {
    const home = tmp("login-files-fresh");
    const at = sshDaemonPaths(home);
    const box = fakeBox({ exitCode: 0, stdout: "", stderr: "" }, home);
    await placeUpdater({ daemonDir: tmp("login-files-fresh-asset"), backend: box.backend as never })({
      placeId: "p_1",
      name: "spoo",
      report: reportOf(),
      daemon: false,
      ssh: { ssh: "maya@box" },
    });
    // The script that road sent, off the login the adopt read: no restart in it, since this update carries no
    // binary.
    ranOn(box.ran[0]!);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`${profileSourceLine(at.profileFile)}\n`);
    // Run again, as the next update runs it: one line, not two.
    ranOn(box.ran[0]!);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`${profileSourceLine(at.profileFile)}\n`);
  });
});

describe("the update over the ssh road, where the link is down", () => {
  const HOME = "/home/maya";
  const UNIT = placeUnit(HOME);

  it("names the unit and its scope through the manager that writes them, never by spelling either here", () => {
    const at = placeService(HOME, 0);
    const manager = SERVICE_MANAGERS.systemd;
    expect(UNIT.name).toBe(manager.unit(at).name);
    // A place's unit is the machine's since #750's ruling, so it is driven with no --user and read the same way.
    expect(manager.needsRoot?.(at)).toBe(true);
    expect(UNIT.systemctl).toEqual(["systemctl"]);
    expect(UNIT.journalctl).toEqual(["journalctl"]);
  });

  it("moves the landed binary over the path the unit itself names, keeps the old one and restarts, sweeping nothing", () => {
    const landed = `${placeDaemonPaths(HOME).putDir}/wsp-daemon`;
    const script = placeUpdateScript(HOME, landed);
    // The path is read back out of systemd rather than worked out here: the join wrote that unit with whatever
    // path the wsp on that computer resolved.
    expect(script).toContain(`systemctl show -p ExecStart --value ${shellQuote(UNIT.name)}`);
    expect(script).toContain("PLACE_NO_UNIT");
    // A keep that failed ends the update, as the link road's own install does: a box is never left on the new
    // daemon with no way back to the one it ran.
    expect(script).toContain(`cp -f "$exe" "$exe.old" || { echo ${PLACE_NO_KEEP_LINE}; exit 1; }`);
    expect(script).not.toContain(`"$exe.old" 2>/dev/null || true`);
    // A move, never a write into a running executable.
    expect(script).toContain(`mv -f ${shellQuote(landed)} "$exe"`);
    expect(script).not.toMatch(/cat > "\$exe"|> "\$exe"/);
    expect(script).toContain(`systemctl restart ${shellQuote(UNIT.name)}`);
    // The old port file goes before the restart, never after: a Type=simple restart returns as the process forks,
    // so a daemon that binds quickly would have its own fresh port file removed and the wait below would read a
    // daemon that is up as one that never came.
    expect(script.indexOf(`rm -f ${shellQuote(placeDaemonPaths(HOME).portFile)}`)).toBeLessThan(script.indexOf("restart"));
    expect(script).toContain("PLACE_UPDATED");
    expect(script).toContain("PLACE_UPDATE_DOWN");
    // Nothing of the person's and nothing of the workspaces is touched: an update is not a leave.
    for (const path of placeOwnedPaths(HOME).filter(at => at !== placeDaemonPaths(HOME).portFile)) expect(script).not.toContain(`rm -rf ${path}`);
    expect(script).not.toContain("place.json");
  });

  it("says what the box printed when its agent did not come back up", () => {
    expect(placeUpdateFailedLine("spoo", "Job for wsp-place-1234abcd.service failed")).toContain("spoo took the daemon and its agent did not come back up");
    expect(placeNoUpdateRoadLine("spoo")).toContain("switch it on and run the line again");
  });
});

describe("the leave over the ssh road, which a remove takes wherever this host holds a login", () => {
  /** One ssh child, as the transport sees it: the dial it was given and the line it was asked to run. */
  const leaver = (answer: { exitCode: number; stdout?: string; stderr?: string }) => {
    const asked: { reach: SshReach; script: string }[] = [];
    const transport: SshTransport = async (reach, script) => {
      asked.push({ reach, script });
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    };
    return { asked, leave: placeLeaver({ transport }) };
  };

  /** The line that box said starts its own wsp, which is the one this road runs the leave with. */
  const WSP = ["/usr/bin/node", "/home/maya/.wsp/daemon/wsp/dist/bin.js"];

  const reportOf = (over: Partial<PlaceReport> = {}): PlaceReport => ({
    name: "vps",
    platform: "linux",
    arch: "x64",
    os: "Ubuntu 24.04",
    shape: { cpu: 2, memMb: 7747 },
    login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
    runsWorkspaces: true,
    engine: "none",
    daemonVersion: DAEMON_VERSION,
    agents: [],
    wsp: WSP,
    dialed: "http://192.168.1.20:4400",
    ...over,
  });

  const asking = (report: PlaceReport = reportOf()) => ({
    placeId: "p_1",
    name: "vps",
    report,
    ssh: { ssh: "root@65.21.4.12:2222", keyPath: "/Users/lena/.ssh/hetzner" },
  });

  it("runs the leave that computer already carries, over the login on the record, and spells no sweep of its own", async () => {
    const { asked, leave } = leaver({ exitCode: 0 });
    await leave(asking());
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reach).toMatchObject({ user: "root", host: "65.21.4.12", port: 2222, keyPath: "/Users/lena/.ssh/hetzner" });
    // The line the box itself reported for running wsp there, word for word, with the verb off its one spelling.
    expect(asked[0]!.script).toBe(`${WSP.join(" ")} ${PLACE_LEAVE_VERB}`);
    // What comes off that computer and in what order is its own leave's: a manager command or a path written from
    // here would be a second copy of the sweep, one that ages the day the unit scheme or the path list moves.
    expect(asked[0]!.script).not.toContain("systemctl");
    expect(asked[0]!.script).not.toContain("rm ");
    const at = placeDaemonPaths("/home/maya");
    for (const path of [at.placeFile, at.placeKey, at.tokenPath, at.inbox]) expect(asked[0]!.script).not.toContain(path);
  });

  it("reads back what that leave said it took, and none of the sentences a person reads around them", async () => {
    const home = tmp("leave-over-ssh");
    const at = placeDaemonPaths(home);
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "vps", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    writeFileSync(placeKeyPath(home), "key");
    writeFileSync(at.tokenPath, "token");
    mkdirSync(at.inbox, { recursive: true });
    const io = captured();
    expect(await leaveCommand(io, [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    // The box's own leave, printed as that computer would print it: this road reads it back by the one rule that
    // leave marks what it took with, so the two cannot drift apart.
    const { leave } = leaver({ exitCode: 0, stdout: `${io.lines.join("\n")}\n` });
    const swept = await leave(asking());
    expect(swept).toContain(placeFilePath(home));
    expect(swept).toContain(at.tokenPath);
    // The work folder is the person's and stayed; which wsp the computer left and what the host still has to be
    // told are its terminal's to say, not things that came off it.
    expect(swept.some(line => line.includes("stays: the work your threads did there is yours"))).toBe(false);
    expect(swept.some(line => line.includes("left the wsp at"))).toBe(false);
    expect(swept.some(line => line.includes("wsp remove"))).toBe(false);
  });

  it("hands back ssh's own line where the login will not stand, so the remove says the agent is still installed", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const { leave } = leaver({ exitCode: 255, stderr: `debug1: Reading configuration data\n${said}\n` });
    await expect(leave(asking())).rejects.toThrow(said);
    await expect(leave(asking())).rejects.not.toThrow(/debug/);
    // The refusal of the login itself, as its own kind: nothing ran on that computer, and the line a remove reads
    // out turns on telling that from a leave that ran there and stopped.
    await expect(leave(asking())).rejects.toBeInstanceOf(PlaceLoginRefusedError);
  });

  it("carries that computer's own words where the leave ran there and stopped, rather than ssh's", async () => {
    const { leave } = leaver({ exitCode: 1, stdout: "this computer is not a place in any wsp, so there is nothing to leave\n" });
    await expect(leave(asking())).rejects.toThrow(placeLeaveFailedLine("vps", { stdout: "this computer is not a place in any wsp, so there is nothing to leave\n", stderr: "" }));
    await expect(leave(asking())).rejects.not.toThrow(/refused the login over ssh/);
    // The login stood, so this is not the refusal kind: what came back is that computer talking.
    await expect(leave(asking())).rejects.not.toBeInstanceOf(PlaceLoginRefusedError);
  });

  it("says the wait ran out where that computer answered nothing at all, rather than ending on a colon", async () => {
    const { leave } = leaver({ exitCode: 124 });
    await expect(leave(asking())).rejects.toThrow("vps ran the leave and had not finished it within 180s");
    expect(placeLeaveFailedLine("vps", { stdout: "", stderr: "" })).not.toMatch(/:$/);
  });

  it("runs whatever line that computer said starts its wsp, including the bare word a box with none falls back to", async () => {
    const { asked, leave } = leaver({ exitCode: 0 });
    await leave(asking(reportOf({ wsp: ["wsp"] })));
    expect(asked[0]!.script).toBe(`wsp ${PLACE_LEAVE_VERB}`);
  });

  it("brings back a sweep that stopped the agent and disabled it while its unit file stood, and reloaded once it had gone", async () => {
    const home = tmp("leave-road-unit");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "vps", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const unit = manager.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    // What the manager was asked, and whether the unit file was still there when it was asked: the removal is the
    // one step of the order that runs no command, and a sweep that took the file first leaves systemd restarting
    // an agent with nothing to serve.
    const seen: { argv: string[]; unitThere: boolean }[] = [];
    const watching: ServiceRunner = argv => {
      seen.push({ argv: [...argv], unitThere: existsSync(unit.path) });
      return runner.run(argv);
    };
    // The computer at the end of the road, running the leave it already carries: the sweep is that computer's own
    // and this host reads back what it printed by the one mark those lines carry.
    const said = await sweepPlace({ home, manager, run: watching, uid: 0 });
    expect(seen).toEqual([
      { argv: ["systemctl", "stop", unit.name], unitThere: true },
      { argv: ["systemctl", "disable", unit.name], unitThere: true },
      { argv: ["systemctl", "daemon-reload"], unitThere: false },
      { argv: ["systemctl", "--user", "stop", unit.name], unitThere: false },
      { argv: ["systemctl", "--user", "disable", unit.name], unitThere: false },
    ]);
    const printed = ["vps left the wsp at http://192.168.1.20:4400; removed:", ...said.removed.map(line => sweptLine(line)), ...said.kept];
    const { leave } = leaver({ exitCode: 0, stdout: `${printed.join("\n")}\n` });
    // What came back over the road names the unit among what went, so a person reading a remove sees the service
    // go and not only the files.
    expect(await leave(asking())).toContain(`systemd system unit ${unit.name} (stopped)`);
    expect(await leave(asking())).toContain(placeFilePath(home));
  });
});

describe("what a remove says about the device the join bought", () => {
  const removeClient = (devices: { id: string; name: string }[]): NonNullable<Parameters<typeof removeCommand>[3]>["dial"] => () =>
    Promise.resolve({
      request: (op: string) => {
        if (op === "places.list") return Promise.resolve({ places: [{ id: "p_1", kind: "computer", name: "old-macbook", default: true, joinedAt: new Date(0).toISOString() }] } as never);
        if (op === "places.remove") return Promise.resolve({ removed: true, swept: ["/Users/maya/.wsp/place.json"], dropped: [] } as never);
        if (op === "devices.list") return Promise.resolve({ devices } as never);
        return Promise.reject(new Error(`unexpected op ${op}`));
      },
      events: () => Promise.resolve(),
      onFrame: () => () => {},
      closed: Promise.resolve(),
      closeWords: () => "",
      close: () => {},
      drop: () => {},
    } as never);

  const removeDeps = (dial: NonNullable<Parameters<typeof removeCommand>[3]>["dial"]): Parameters<typeof removeCommand>[3] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("names the token that computer's window still holds and how to take it back", async () => {
    const home = tmp("remove-device");
    const io = captured();
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await removeCommand(io, opts, ["old-macbook"], removeDeps(removeClient([{ id: "d_1", name: "old-macbook" }])))).toBe(0);
    const said = io.lines.join("\n");
    expect(said).toContain(deviceLeftLine("old-macbook", ["d_1"]));
    expect(said).toContain("wsp host devices revoke d_1 takes it back.");
    // One command per id, since wsp host devices revoke takes exactly one.
    expect(deviceLeftLine("old-macbook", ["d_1", "d_2"])).toContain("wsp host devices revoke d_1, wsp host devices revoke d_2 take them back.");
    // The line sits before the last one, so what is gone is still the sentence the remove ends on.
    expect(io.lines.at(-1)).toBe("old-macbook is no longer a place in this wsp.");
  });

  it("says nothing about devices when no device wears that computer's name", async () => {
    const home = tmp("remove-no-device");
    const io = captured();
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await removeCommand(io, opts, ["old-macbook"], removeDeps(removeClient([{ id: "d_2", name: "a browser tab" }])))).toBe(0);
    expect(io.lines.join("\n")).not.toContain("wsp host devices revoke");
  });
});

describe("a join as the app's shell runs it", () => {
  it("names the shim it was handed as this computer's wsp, writes the wsp's name and buys the window its token", async () => {
    const home = tmp("join-shell");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    const joined = await joinPlace(io, {
      home,
      addresses: [host.url],
      code: "7QK3M2VD",
      hostKey: keyFingerprint(host.publicKey),
      name: "old-macbook",
      client: true,
      wsp: { execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", "/opt/wsp/bin.js"], version: "9.9.9", PATH: "", shim: `${home}/.wsp/bin/wsp` },
      platform: "linux",
      manager: unitsUnder(home),
      uid: 0,
      run: runner.run,
      dial: url => new WebSocket(wsUrlOf(url)),
    });
    expect(joined).toMatchObject({ hostName: "zingzy-mbp", hostUrls: [host.url], device: { deviceId: "d_1", deviceToken: "dev-token" } });
    expect(joined.report.name).toBe("old-macbook");
    const file = readPlaceFile(placeFilePath(home))!;
    expect(file).toMatchObject({ hostName: "zingzy-mbp", name: "old-macbook" });
    const unitDir = join(home, "etc-systemd-system");
    const written = readFileSync(join(unitDir, readdirSync(unitDir)[0]!), "utf8");
    // The unit runs the daemon; the shim is what the daemon reports as the wsp a turn's agent runs here.
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain(`'--wsp-argv' '${home}/.wsp/bin/wsp'`);
    // The client rode the join frame, which is what the one code bought a device for, and it wears the place's own
    // name rather than this computer's: wsp remove finds the token a computer still holds by the place's name, so a
    // second word here would be a device nothing could ever name. The two are different words in this run.
    expect(placeNameHere()).not.toBe("old-macbook");
    expect(host.frames.find(f => f["op"] === "place.prove")!["client"]).toEqual({ name: "old-macbook" });
  });

  it("is the same road the command line takes, which hands the daemon binary and its flags", async () => {
    const home = tmp("join-cli-argv");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, runner.run))).toBe(0);
    const unitDir = join(home, "etc-systemd-system");
    const written = readFileSync(join(unitDir, readdirSync(unitDir)[0]!), "utf8");
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain("'--kind' 'place'");
    // Nothing on that road asks for a window, so nothing on it buys a device.
    expect(host.frames.find(f => f["op"] === "place.prove")!["client"]).toBeUndefined();
  });

  it("takes a bare host and port as the join screen shows it, and refuses a word that is no address", async () => {
    const home = tmp("join-bare");
    const host = await fakeHost();
    const bare = new URL(host.url).host;
    expect(await joinCommand(captured(), [bare], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(readPlaceFile(placeFilePath(home))!.hostUrls).toEqual([`http://${bare}`]);
    await expect(joinCommand(captured(), ["box"], { code: NOWHERE_CODE }, joinDepsFor(tmp("join-word"), fakeRunner().run))).rejects.toThrow(/not an address/);
  });
});

describe("the daemon's line on a joined computer", () => {
  it("is the flags every daemon under a login takes, told the place kind, then the place file, the home, the wsp line and the agents", () => {
    const home = "/home/maya";
    const file = placeDaemonPaths(home).placeFile;
    const flags = placeDaemonFlags(home, file, { execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", "/opt/wsp/bin.js"], version: "9.9.9", PATH: "" });
    const at = placeDaemonPaths(home);
    // Loopback, a port of the machine's own, every file under the login's folder, and the kind that picks the readings.
    expect(flags.slice(0, flags.indexOf("--home"))).toEqual(daemonFlags({ ...sshDaemonPlace({ home, path: "" }), kind: "place" }));
    expect(flags).toContain("127.0.0.1");
    expect(flags[flags.indexOf("--kind") + 1]).toBe("place");
    expect(flags[flags.indexOf("--port-file") + 1]).toBe(at.portFile);
    expect(flags[flags.indexOf("--token-path") + 1]).toBe(at.tokenPath);
    expect(flags[flags.indexOf("--home") + 1]).toBe(home);
    expect(flags[flags.indexOf("--work-folder") + 1]).toBe(workFolderIn(home));
    expect(flags[flags.indexOf("--place-file") + 1]).toBe(file);
    // The line that runs wsp here, one word per flag, with the verb left for the daemon to add.
    const wsp = flags.flatMap((word, i) => (word === "--wsp-argv" ? [flags[i + 1]] : []));
    expect(wsp).toEqual(["/usr/bin/node", "/opt/wsp/bin.js"]);
    // Every catalog agent as id=command: the daemon looks each one up on PATH at every dial.
    const agents = flags[flags.indexOf("--agents") + 1]!.split(",");
    expect(agents).toEqual(CATALOG_AGENTS.map(a => `${a.id}=${a.bin}`));
    expect(agents.length).toBeGreaterThan(0);
  });

  it("what the daemon needs on disk is made before it starts: wsp's folder, the inbox, the work folder and a fresh token nobody else can read", () => {
    const home = tmp("place-home");
    preparePlaceHome(home);
    const at = placeDaemonPaths(home);
    for (const dir of [at.wsp, at.inbox, workFolderIn(home)]) expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(at.tokenPath).mode & 0o777).toBe(0o600);
    const first = readFileSync(at.tokenPath, "utf8");
    expect(first).toMatch(/^[0-9a-f]{48}\n$/);
    // Minted again at every start: the host replaces it on its first reach either way.
    preparePlaceHome(home);
    expect(readFileSync(at.tokenPath, "utf8")).not.toBe(first);
  });
});

describe("the sweep a joined computer runs on itself", () => {
  it("leaves no unit, no place file and no key after a join, and keeps the work folder", async () => {
    const home = tmp("leave-after-join");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, runner.run))).toBe(0);
    const unitDir = join(home, "etc-systemd-system");
    const work = join(home, "wsp-work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "a-thread-wrote-this"), "mine");
    // The sweep is given the manager the join wrote its unit with, so it looks under this test's home and not the machine's.
    const manager = unitsUnder(home);
    const { removed } = await sweepPlace({ home, manager, run: runner.run, uid: 0 });
    expect(readdirSync(unitDir)).toEqual([]);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
    expect(readFileSync(join(work, "a-thread-wrote-this"), "utf8")).toBe("mine");
    expect(removed.some(line => line.includes("wsp-place-"))).toBe(true);
  });
});

describe("a join typed on a Mac", () => {
  it("refuses in the Mac sentence before it writes or dials anything, though a Mac has a manager", async () => {
    const host = await fakeHost();
    const home = tmp("join-mac");
    const runner = fakeRunner();
    await expect(
      joinPlace(captured(), { home, addresses: [host.url], code: "A", hostKey: keyFingerprint(host.publicKey), platform: "darwin", uid: 501, run: runner.run, dial: url => new WebSocket(wsUrlOf(url)) }),
    ).rejects.toThrow(noPlaceSystemLine("Darwin", "this computer"));
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(host.frames.filter(f => f["op"] === "place.join")).toEqual([]);
    expect(runner.ran).toEqual([]);
  });
});

describe("which manager holds the agent's unit", () => {
  it("takes the manager the platform has, and refuses a computer that has none before it writes or dials anything", async () => {
    const host = await fakeHost();
    const none = tmp("manager-none");
    await expect(joinPlace(captured(), { home: none, addresses: [host.url], code: "A", hostKey: keyFingerprint(host.publicKey), platform: "win32", dial: url => new WebSocket(wsUrlOf(url)) })).rejects.toThrow("writes no service on win32");
    // Nothing would keep the daemon up there, so nothing of a join lands: no place file, no key, no frame to the host.
    expect(existsSync(placeFilePath(none))).toBe(false);
    expect(host.frames.filter(f => f["op"] === "place.join")).toEqual([]);
    const home = tmp("manager-own");
    const own = captured();
    const runner = fakeRunner();
    await joinPlace(own, { home, addresses: [host.url], code: "B", hostKey: keyFingerprint(host.publicKey), platform: "linux", uid: 0, manager: unitsUnder(home), run: runner.run, dial: url => new WebSocket(wsUrlOf(url)) });
    // Linux's own module, with only the folder its unit lands in moved off this machine's real one: a platform that
    // has a manager is asked to take the unit, which the branch above never does.
    expect(runner.ran.length).toBeGreaterThan(0);
    expect(own.errors.join("\n")).not.toContain("writes no service");
  });
});

describe("wsp add <folder> --on <computer>: the menu before anything travels", () => {
  const FOLDER = "/Users/dev/spoo-landing";
  const PLAN = {
    source: FOLDER,
    remote: "https://github.com/spoo-me/frontend.git",
    branch: "refactor/dashboard-polish",
    defaultBranch: "main",
    unpushed: { commits: 2, base: "9f1c2e4aa11b0c3d4e5f60718293a4b5c6d7e8f9" },
    uncommitted: 4,
    memory: { key: "-Users-dev-spoo-landing", files: 5, bytes: 28_000 },
    files: [
      { path: ".env.local", dir: false, bytes: 4096, kind: "config", row: { id: "next", name: "Next" }, ticked: true },
      { path: "node_modules", dir: true, bytes: 2_600_000_000, kind: "rebuilt", row: { id: "node", name: "Node" }, ticked: false },
      { path: ".git-credentials", dir: false, bytes: 300, kind: "never", row: { id: "logins", name: "logins" }, ticked: false },
      { path: "docs", dir: true, bytes: 18_000_000, kind: "unknown", ticked: false },
    ],
    remembered: false,
  };
  /** The computers a host lists: this one, which works a folder where it sits, and a box that clones. */
  const PLACES: PlaceView[] = [
    { id: "here", kind: "computer", name: "studio.local", default: false, present: true },
    { id: "p_1", kind: "computer", name: "spoo", default: true },
  ];
  const project = {
    id: "pr_1",
    name: "spoo-landing",
    computer: "p_1",
    source: { kind: "folder", path: FOLDER },
    path: "/root/spoo-landing",
    remote: PLAN.remote,
    defaultBranch: "main",
    memoryKey: PLAN.memory.key,
    memoryDir: "/var/lib/wsp/projects/pr_1/memory",
    createdAt: new Date(0).toISOString(),
  };

  /** A host answering the menu and the add, keeping what it was asked. */
  const menuClient = (): { dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]; asked: { op: string; params?: Record<string, unknown> }[] } => {
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    return {
      asked,
      dial: () =>
        Promise.resolve({
          request: (op: string, params?: Record<string, unknown>) => {
            asked.push({ op, ...(params === undefined ? {} : { params }) });
            if (op === "project.seed.plan") return Promise.resolve({ plan: PLAN } as never);
            if (op === "projects.add") return Promise.resolve({ project } as never);
            if (op === "places.list") return Promise.resolve({ places: PLACES } as never);
            return Promise.reject(new Error(`unexpected op ${op}`));
          },
          events: () => Promise.resolve(),
          onFrame: () => () => {},
          closed: Promise.resolve(),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const menuDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "darwin",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("prints the menu and sends nothing until the person says what travels", async () => {
    const home = tmp("add-seed-menu");
    const { dial, asked } = menuClient();
    const io = captured();
    expect(await addCommand(io, opts(home), [FOLDER], { on: "spoo" }, menuDeps(dial))).toBe(0);
    const printed = io.lines.join("\n");
    // Every row with its size and the words its catalogue row ends in, widest first, and the ticks the catalogue decided.
    expect(printed).toContain("[x]  .env.local");
    expect(printed).toContain("rebuilt on the box");
    expect(printed).toContain("never travels");
    expect(printed).toContain("not in the catalogue");
    expect(printed).toContain("2.4 GB");
    // What stays here, and the two lines that send it.
    expect(printed).toContain("nothing was sent");
    expect(printed).toContain("4 uncommitted changes stay on this computer");
    expect(printed).toContain("--yes");
    // The computer's own kind is read first, then the menu, and nothing was recorded.
    expect(asked.map(a => a.op)).toEqual(["places.list", "project.seed.plan"]);
  });

  it("with --yes it sends the ticks the catalogue decided, and the keeps and cuts move them", async () => {
    const home = tmp("add-seed-yes");
    for (const [flags, files] of [
      [{ on: "spoo", yes: true }, [".env.local"]],
      [{ on: "spoo", yes: true, cut: [".env.local"] }, []],
      [{ on: "spoo", yes: true, keep: ["docs"] }, [".env.local", "docs"]],
    ] as const) {
      const { dial, asked } = menuClient();
      expect(await addCommand(captured(), opts(home), [FOLDER], { ...flags }, menuDeps(dial))).toBe(0);
      expect(asked.find(a => a.op === "projects.add")?.params).toMatchObject({ source: FOLDER, on: "spoo", seed: { files, memory: true, commits: true } });
    }
  });

  it("the two words that leave the memory and the patch here, and the one that remembers the ticks", async () => {
    const home = tmp("add-seed-flags");
    const { dial, asked } = menuClient();
    expect(await addCommand(captured(), opts(home), [FOLDER], { on: "spoo", yes: true, noMemory: true, noCommits: true, remember: true }, menuDeps(dial))).toBe(0);
    expect(asked.find(a => a.op === "projects.add")?.params).toMatchObject({ seed: { files: [".env.local"], memory: false, commits: false, remember: true } });
  });

  it("refuses to carry a login by name, whatever was kept", async () => {
    const home = tmp("add-seed-login");
    const { dial, asked } = menuClient();
    const io = captured();
    await expect(addCommand(io, opts(home), [FOLDER], { on: "spoo", yes: true, keep: [".git-credentials"] }, menuDeps(dial))).rejects.toThrow(/never travels in a seed/);
    expect(asked.map(a => a.op)).toEqual(["places.list", "project.seed.plan"]);
  });

  it("draws and sends the ticks a remembered choice put on the plan, not the catalogue's own", async () => {
    const home = tmp("add-seed-remembered");
    // What the host answers once a choice was remembered for this folder: their ticks on the same rows.
    const remembered = { ...PLAN, remembered: true, files: PLAN.files.map(f => ({ ...f, ticked: f.path === "docs" })) };
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    const dial = (): Promise<never> =>
      Promise.resolve({
        request: (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, ...(params === undefined ? {} : { params }) });
          if (op === "project.seed.plan") return Promise.resolve({ plan: remembered } as never);
          if (op === "projects.add") return Promise.resolve({ project } as never);
          if (op === "places.list") return Promise.resolve({ places: PLACES } as never);
          return Promise.reject(new Error(`unexpected op ${op}`));
        },
        events: () => Promise.resolve(),
        onFrame: () => () => {},
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
    const io = captured();
    expect(await addCommand(io, opts(home), [FOLDER], { on: "spoo" }, menuDeps(dial))).toBe(0);
    // The menu reads their ticks: the config row they unticked is unticked and the folder they kept is ticked.
    expect(io.lines.join("\n")).toContain("[ ]  .env.local");
    expect(io.lines.join("\n")).toContain("[x]  docs/");
    // And --yes sends those, not the catalogue's.
    const sent = menuClient();
    expect(await addCommand(captured(), opts(home), [FOLDER], { on: "spoo", yes: true }, menuDeps(dial))).toBe(0);
    expect(asked.filter(a => a.op === "projects.add").at(-1)?.params).toMatchObject({ seed: { files: ["docs"] } });
    void sent;
  });

  it("a folder onto this computer is worked where it sits, so no menu is read and nothing is asked about it", async () => {
    const home = tmp("add-seed-here");
    const { dial, asked } = menuClient();
    // The computer the app runs on, named by the word its own row carries.
    expect(await addCommand(captured(), opts(home), [FOLDER], { on: "here" }, menuDeps(dial))).toBe(0);
    // The places listing is read before the add now, since the add's own stages land while it runs and each names
    // the computer by its id.
    expect(asked.map(a => a.op)).toEqual(["places.list", "places.list", "projects.add"]);
  });

  it("a folder with no computer named is a project here and reads no menu at all", async () => {
    const home = tmp("add-seed-here");
    const { dial, asked } = menuClient();
    expect(await addCommand(captured(), opts(home), [FOLDER], {}, menuDeps(dial))).toBe(0);
    expect(asked.map(a => a.op)).toEqual(["places.list", "projects.add"]);
  });
});

describe("wsp add <owner/repo>: a repo the computer's own command line clones", () => {
  it("is a project's source like any other word that names one, and never a provider or an address", async () => {
    const home = tmp("add-owner-repo");
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    const project = {
      id: "pr_2",
      name: "frontend",
      computer: "p_1",
      source: { kind: "github", repo: "spoo-me/frontend" },
      path: "/root/frontend",
      remote: "https://github.com/spoo-me/frontend.git",
      defaultBranch: "main",
      memoryKey: "-root-frontend",
      memoryDir: "/root/.claude-cfg/projects/-root-frontend/memory",
      createdAt: new Date(0).toISOString(),
    };
    const dial = (): Promise<never> =>
      Promise.resolve({
        request: (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, ...(params === undefined ? {} : { params }) });
          if (op === "projects.add") return Promise.resolve({ project } as never);
          if (op === "places.list") return Promise.resolve({ places: [{ id: "p_1", kind: "computer", name: "spoo", default: true }] } as never);
          return Promise.reject(new Error(`unexpected op ${op}`));
        },
        events: () => Promise.resolve(),
        onFrame: () => () => {},
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
    const io = captured();
    expect(await addCommand(io, opts(home), ["spoo-me/frontend"], { on: "spoo" }, { ...systemPlaceDeps, dial })).toBe(0);
    // It reaches the host as the word that was typed, and no menu is read: only a folder here has one.
    expect(asked.map(a => a.op)).toEqual(["places.list", "projects.add"]);
    expect(asked[1]?.params).toMatchObject({ source: "spoo-me/frontend", on: "spoo" });
    expect(io.lines.join("\n")).toContain("frontend pr_2");
  });
});

describe("what wsp add prints while a project lands on a computer", () => {
  const spooRow: PlaceView = { id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString(), agents: ["claude"] };
  const landed = {
    id: "pr_1a2b3c4d",
    name: "landing-906",
    computer: "p_1",
    source: { kind: "git" as const, url: "https://github.com/spoo-me/spoo-ts" },
    path: "/srv/landing-906",
    remote: "https://github.com/spoo-me/spoo-ts",
    defaultBranch: "main",
    memoryKey: "-srv-landing-906",
    memoryDir: "/wsp/projects/pr_1a2b3c4d/memory",
    checkout: "/wsp/projects/pr_1a2b3c4d/checkout",
    createdAt: new Date(0).toISOString(),
  };

  /** A host that pushes the add's own stages while the request is in flight, which is how they land: the reply
   * comes only once the clone and the install are over. */
  const staging = (frames: readonly Record<string, unknown>[], notice?: string): NonNullable<Parameters<typeof addCommand>[4]>["dial"] => {
    const sinks: ((f: Record<string, unknown>) => void)[] = [];
    return () =>
      Promise.resolve({
        request: (op: string) => {
          if (op === "places.list") return Promise.resolve({ places: [spooRow] } as never);
          if (op === "projects.add") {
            for (const frame of frames) for (const sink of sinks) sink(frame);
            return Promise.resolve({ project: landed, ...(notice === undefined ? {} : { notice }) } as never);
          }
          return Promise.reject(new Error(`unexpected op ${op}`));
        },
        events: () => Promise.resolve(),
        onFrame: (fn: (f: Record<string, unknown>) => void) => {
          sinks.push(fn);
          return () => {};
        },
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
  };

  const stage = (computer: string, stage: string, message: string): Record<string, unknown> => ({ type: "project.add", projectId: landed.id, computer, stage, message, elapsedMs: 1 });

  const addDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("prints each stage as it lands there, and says where the project is once: the done stage and no line of its own", async () => {
    const io = captured();
    const done = addedProjectOn(landed, "spoo");
    const lost = "the 1 commit on main did not land on spoo: fatal: empty ident name (for <>) not allowed; the checkout is on main";
    const dial = staging(
      [
        stage("p_1", "planned", "landing-906 from https://github.com/spoo-me/spoo-ts, nothing seeded."),
        stage("p_1", "cloning", "Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout."),
        // Another computer's add, running at the same time on the same host: none of its lines are this one's.
        stage("p_2", "cloning", "Cloning something else."),
        stage("p_1", "seeding", lost),
        stage("p_1", "installing", "npm ci in /srv/landing-906."),
        stage("p_1", "done", done),
      ],
      lost,
    );
    expect(await addCommand(io, opts(tmp("add-stages")), ["https://github.com/spoo-me/spoo-ts"], { on: "spoo", name: "landing-906" }, addDeps(dial))).toBe(0);
    // The computer's own stages are the whole of it: where the project is is said once, and what did not land
    // the way it was asked is said once too, by the stage that said it while it was happening.
    expect(io.lines).toEqual([
      "landing-906 from https://github.com/spoo-me/spoo-ts, nothing seeded.",
      "Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout.",
      lost,
      "npm ci in /srv/landing-906.",
      done,
    ]);
  });

  it("leaves a failed stage's sentence to the failure, which the terminal prints once", async () => {
    const io = captured();
    const sentence = "git clone https://github.com/spoo-me/spoo-ts failed on spoo: Repository not found.";
    const sinks: ((f: Record<string, unknown>) => void)[] = [];
    const dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"] = () =>
      Promise.resolve({
        request: (op: string) => {
          if (op === "places.list") return Promise.resolve({ places: [spooRow] } as never);
          for (const sink of sinks) {
            sink(stage("p_1", "cloning", "Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout."));
            sink(stage("p_1", "failed", sentence));
          }
          return Promise.reject(new Error(sentence));
        },
        events: () => Promise.resolve(),
        onFrame: (fn: (f: Record<string, unknown>) => void) => {
          sinks.push(fn);
          return () => {};
        },
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
    await expect(addCommand(io, opts(tmp("add-stage-failed")), ["https://github.com/spoo-me/spoo-ts"], { on: "spoo" }, addDeps(dial))).rejects.toThrow(sentence);
    expect(io.lines).toEqual(["Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout."]);
    expect(io.errors).toEqual([]);
  });

  it("prints no stage at all where no computer was named, so another session's add never lands in this terminal", async () => {
    const io = captured();
    const folder = tmp("add-here-stages");
    // Another session's add on a computer, arriving on this socket while a folder is recorded here.
    const dial = staging([stage("p_1", "cloning", "Cloning somebody else's repo."), stage("p_1", "done", "theirs is on spoo.")]);
    expect(await addCommand(io, opts(tmp("add-here")), [folder], {}, addDeps(dial))).toBe(0);
    expect(io.lines.filter(line => line.includes("somebody else"))).toEqual([]);
    expect(io.lines.some(line => line.includes("theirs is on spoo"))).toBe(false);
    // A record that landed with no stage of its own to read still says where the project is, off the answer.
    expect(io.lines).toEqual([addedProjectLine(landed, new Map([["p_1", "spoo"]]), hostPlatform())]);
  });

  it("says where the project is itself, with what did not travel, where the host sent no stage of this add", async () => {
    const io = captured();
    const lost = "1 login inside the folders you ticked stayed on this computer: config/.netrc";
    // Another session's add finishing on the same computer while this one runs: its done line is that project's,
    // so this add still says its own.
    const theirs = { type: "project.add", projectId: "pr_someone", computer: "p_1", stage: "done", message: "theirs is on spoo.", elapsedMs: 1 };
    const dial = staging([theirs], lost);
    expect(await addCommand(io, opts(tmp("add-no-stages")), ["https://github.com/spoo-me/spoo-ts"], { on: "spoo" }, addDeps(dial))).toBe(0);
    expect(io.lines).toEqual(["theirs is on spoo.", addedProjectLine(landed, new Map([["p_1", "spoo"]]), hostPlatform()), lost]);
  });
});
