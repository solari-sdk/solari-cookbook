// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLACE_PORT,
  DEFAULT_PORT,
  DEFAULT_WS_PORT,
  EventUnion,
  GUEST_DAEMON_DIR,
  GUEST_WSP_BIN,
  KNOWN_HOSTS,
  PLACE_ADD_WORDS,
  PLACE_LINK_NONCE_BYTES,
  PlaceProvision,
  PlaceUpdateReply,
  PlaceView,
  placeNoHomeLine,
  placeNoRecipeLine,
  placeProvisionPaths,
  placeProvisioningLine,
  provisionLines,
  provisionCountWord,
  provisionWord,
  MCP_ID_PREFIX,
  PLACE_PORT_OFFSET,
  PlaceAddStep,
  PlaceAuthRequest,
  PlaceJoinReply,
  PlaceJoinDevice,
  PlaceJoinRequest,
  PlaceProveRequest,
  PlaceReport,
  DAEMON_VERSION,
  joinAddressOf,
  placeBehindLine,
  placeCurrentLine,
  placeDaemonBehind,
  placeServesDaemonLine,
  placeWatchesItselfLine,
  forkProcsUnreadLine,
  forkOpRefusedLine,
  placeNoChipLine,
  placeUpdateLine,
  placeAddSheetWord,
  sentPairCode,
  shownPairCode,
  joinToken,
  readJoinToken,
  JOIN_NO_KEY_REFUSAL,
  WORKSPACE_KIND_WORDS,
  WorkspaceKind,
  workspacesBlockedBy,
  CGROUP_CONTROLLERS_PATH,
  PROC_FILESYSTEMS_PATH,
  placeDaemonPaths,
  placeLinkTranscript,
  sshDaemonPaths,
  workFolderIn,
  workspacePlaceId,
  wspBinIn,
} from "../src/index.js";

const nonce = Buffer.alloc(PLACE_LINK_NONCE_BYTES, 7).toString("base64");
const publicKey = Buffer.alloc(44, 3).toString("base64");
const signature = Buffer.alloc(64, 5).toString("base64");

const report = {
  name: "old-macbook",
  platform: "darwin" as const,
  arch: "arm64",
  os: "Darwin 24.5.0",
  shape: { cpu: 4, memMb: 8192 },
  login: { HOME: "/Users/maya", USER: "maya", PATH: "/usr/bin" },
  runsWorkspaces: true,
  engine: "none",
  daemonVersion: 17,
  agents: [],
  wsp: ["/usr/local/bin/wsp"],
  dialed: "http://192.168.1.20:4400",
};

describe("what a joining computer may send", () => {
  const ephemeral = Buffer.alloc(32, 8).toString("base64");

  it("takes a whole join frame: the key it will prove and the two public values, and nothing of the person's", () => {
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", publicKey, nonce, ephemeral }).success).toBe(true);
    // The code and the report ride the prove, inside the seal: the first frame carries neither.
    const first = PlaceJoinRequest.parse({ id: 1, op: "place.join", publicKey, nonce, ephemeral, code: "7QK3M2VD", report });
    expect(Object.keys(first).sort()).toEqual(["ephemeral", "id", "nonce", "op", "publicKey"]);
  });

  it("refuses a half of the key agreement that is not the length one is, and takes a frame with none from a computer whose wsp seals nothing", () => {
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", publicKey, nonce, ephemeral: Buffer.alloc(16, 8).toString("base64") }).success).toBe(false);
    // Absent reads, so the host can refuse it in its own sentence rather than with a word about a field.
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", publicKey, nonce }).success).toBe(true);
  });

  it("refuses a nonce that is not the length a challenge is: a short one is a nonce somebody could have seen before", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", publicKey, nonce: short, ephemeral }).success).toBe(false);
  });

  it("refuses a key that is not an ed25519 public key's length", () => {
    const wrong = Buffer.alloc(32, 3).toString("base64");
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", publicKey: wrong, nonce, ephemeral }).success).toBe(false);
  });

  it("refuses a code longer than any this host mints, on the prove that carries it", () => {
    expect(PlaceProveRequest.safeParse({ id: 2, op: "place.prove", signature, report, code: "x".repeat(65) }).success).toBe(false);
    expect(PlaceProveRequest.safeParse({ id: 2, op: "place.prove", signature, report, code: "7QK3M2VD" }).success).toBe(true);
  });

  it("refuses a report whose login is not string to string: every value there lands in a path a turn runs under", () => {
    const bad = { ...report, login: { HOME: 3 } };
    expect(PlaceProveRequest.safeParse({ id: 2, op: "place.prove", signature, report: bad }).success).toBe(false);
  });

  it("refuses a report that dialed something other than an http address", () => {
    const bad = { ...report, dialed: "ftp://192.168.1.20" };
    expect(PlaceProveRequest.safeParse({ id: 2, op: "place.prove", signature, report: bad }).success).toBe(false);
  });

  it("takes an auth frame from a place that already joined", () => {
    expect(PlaceAuthRequest.safeParse({ id: 1, op: "place.auth", placeId: "p_ab12cd34", nonce, ephemeral }).success).toBe(true);
  });
});

describe("the bytes both sides of a link sign", () => {
  const a = Buffer.alloc(PLACE_LINK_NONCE_BYTES, 1).toString("base64");
  const b = Buffer.alloc(PLACE_LINK_NONCE_BYTES, 2).toString("base64");
  const keys = { challenger: Buffer.alloc(32, 3).toString("base64"), answerer: Buffer.alloc(32, 4).toString("base64") };
  const bytes = (v: Uint8Array): string => Buffer.from(v).toString("hex");

  it("differs by the role, so neither side's signature can be replayed back at it as the other's", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b, keys))).not.toBe(bytes(placeLinkTranscript("place", "p_1", a, b, keys)));
  });

  it("differs by the order of the two nonces, so a transcript is one direction of one link", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b, keys))).not.toBe(bytes(placeLinkTranscript("host", "p_1", b, a, keys)));
  });

  it("differs by the place, so a signature for one place proves nothing about another", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b, keys))).not.toBe(bytes(placeLinkTranscript("host", "p_2", a, b, keys)));
  });

  it("covers both halves of the key agreement, so a carrier that swapped either of them has signed nothing", () => {
    const swapped = { challenger: keys.challenger, answerer: Buffer.alloc(32, 5).toString("base64") };
    expect(bytes(placeLinkTranscript("host", "p_1", a, b, keys))).not.toBe(bytes(placeLinkTranscript("host", "p_1", a, b, swapped)));
    expect(bytes(placeLinkTranscript("host", "p_1", a, b, keys))).not.toBe(bytes(placeLinkTranscript("host", "p_1", a, b, { challenger: keys.answerer, answerer: keys.challenger })));
  });

  it("is the same bytes for the same reading, so the two sides cannot drift", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b, keys))).toBe(bytes(placeLinkTranscript("host", "p_1", a, b, keys)));
  });
});

describe("the kinds a workspace can be", () => {
  it("holds no kind for the computer a place is: a place is not a workspace, and its forks are the workspaces", () => {
    expect(Object.keys(WORKSPACE_KIND_WORDS)).not.toContain("place");
    expect(WorkspaceKind.safeParse("place").success).toBe(false);
  });
});

describe("where a daemon on somebody's own computer keeps things", () => {
  it("is one function under two names, so the ssh road and the place road cannot put a token in two folders", () => {
    expect(placeDaemonPaths).toBe(sshDaemonPaths);
  });

  it("names the work folder by the one rule this computer's own workspace reads", () => {
    expect(workFolderIn("/Users/maya/")).toBe("/Users/maya/wsp-work");
    expect(placeDaemonPaths("/Users/maya").tokenPath).toBe("/Users/maya/.wsp/daemon-token");
  });
});

describe("the steps of an install on a computer over ssh", () => {
  it("has words for every one of them, so a step added is a step a person can read", () => {
    expect(Object.keys(PLACE_ADD_WORDS).sort()).toEqual([...PlaceAddStep.options].sort());
    for (const step of PlaceAddStep.options) expect(PLACE_ADD_WORDS[step].length).toBeGreaterThan(0);
  });

  it("says a step in the app's sheet as that sheet says it, a done one as the state it reached, and takes the terminal's word for the rest", () => {
    expect(placeAddSheetWord("connect", "running")).toBe(PLACE_ADD_WORDS.connect);
    expect(placeAddSheetWord("connect", "done")).toBe(PLACE_ADD_WORDS.connect);
    expect(placeAddSheetWord("wsp", "running")).toBe("installing wsp under ~/.wsp");
    expect(placeAddSheetWord("service", "running")).toBe("starting the agent as a user service");
    expect(placeAddSheetWord("join", "running")).toBe("waiting for it to connect to this computer");
    // A line under a check reading as the wait it was in is the wrong word for a step that is over.
    expect(placeAddSheetWord("join", "done")).toBe("connected to this computer");
    // What one line of the sheet's list holds at 12 px mono beside a check: a longer word is cut from the right.
    for (const step of PlaceAddStep.options) for (const state of ["running", "done"] as const) expect(placeAddSheetWord(step, state).length).toBeLessThanOrEqual(51);
  });

  it("names the one thing the add does to the computer the person is sitting at, before Add is pressed, and names the file by the path they would type", () => {
    // Every other step is about the box; this one is about this computer, and a list that leaves it out tells a
    // person who reads before they click that nothing here touches their own machine.
    expect(PlaceAddStep.options).toContain("host-key");
    expect(placeAddSheetWord("host-key", "running")).toContain(KNOWN_HOSTS);
    expect(placeAddSheetWord("host-key", "running")).toBe("keeps the box's host key in ~/.ssh/known_hosts here");
    expect(PLACE_ADD_WORDS["host-key"]).toContain(KNOWN_HOSTS);
    // It belongs where it happens: the dial that connects is what writes the file.
    expect(PlaceAddStep.options.indexOf("host-key")).toBe(PlaceAddStep.options.indexOf("connect") + 1);
  });

  it("checks the box can reach this host as a step of its own, after the login and before anything of wsp's lands", () => {
    expect(PlaceAddStep.options.slice(0, 4)).toEqual(["connect", "host-key", "reach", "wsp"]);
    expect(PLACE_ADD_WORDS.reach).toBe("checking it can reach this computer");
    expect(placeAddSheetWord("reach", "running")).toBe("checking it can reach this computer");
    expect(placeAddSheetWord("reach", "done")).toBe("reaches this computer");
  });
});

describe("where a computer joined as a place keeps its own two files", () => {
  it("puts them in the folder the daemon's own files are in, so one sweep takes the lot", () => {
    const at = placeDaemonPaths("/home/maya");
    expect(at.placeFile).toBe("/home/maya/.wsp/place.json");
    expect(at.placeKey).toBe("/home/maya/.wsp/place-key.pem");
    expect(at.placeLog).toBe("/home/maya/.wsp/place.log");
    for (const path of [at.placeFile, at.placeKey, at.placeLog]) expect(path.startsWith(`${at.wsp}/`)).toBe(true);
  });

  it("names the wsp command in a bundle by one rule, which a fork and a joined computer both read", () => {
    expect(wspBinIn(GUEST_DAEMON_DIR)).toBe(GUEST_WSP_BIN);
    expect(wspBinIn("/home/maya/.wsp/daemon")).toBe("/home/maya/.wsp/daemon/wsp/dist/bin.js");
  });
});

describe("the address a person types on the join screen", () => {
  it("makes a bare host and port into the http address the join road dials", () => {
    expect(joinAddressOf("192.168.1.20:4420")).toBe("http://192.168.1.20:4420");
    expect(joinAddressOf("  old-macbook.local:4420 ")).toBe("http://old-macbook.local:4420");
  });

  it("leaves an address that already carries a scheme alone", () => {
    expect(joinAddressOf("https://p_x.singhi.me")).toBe("https://p_x.singhi.me");
    expect(joinAddressOf("http://192.168.1.20:4420")).toBe("http://192.168.1.20:4420");
  });

  it("is nothing for a word that names no port and for a scheme this road cannot dial", () => {
    expect(joinAddressOf("box")).toBeUndefined();
    expect(joinAddressOf("")).toBeUndefined();
    expect(joinAddressOf("ws://x")).toBeUndefined();
  });
});

describe("the port the door for computers you own answers on", () => {
  it("sits the offset above the app port and is not the runtime's own", () => {
    expect(DEFAULT_PLACE_PORT).toBe(DEFAULT_PORT + 20);
    expect(PLACE_PORT_OFFSET).toBe(20);
    expect(DEFAULT_PLACE_PORT).not.toBe(DEFAULT_WS_PORT);
  });
});

describe("what a join carrying the app's own ask may send", () => {
  it("takes a client the window's token is minted for, and refuses one with no name, on the prove that carries it", () => {
    expect(PlaceProveRequest.safeParse({ id: 2, op: "place.prove", signature, report, code: "7QK3M2VD", client: { name: "old-macbook" } }).success).toBe(true);
    expect(PlaceProveRequest.safeParse({ id: 2, op: "place.prove", signature, report, code: "7QK3M2VD", client: { name: "" } }).success).toBe(false);
  });

  it("answers the primary computer's name and its half of the key agreement, and the window's token only with both halves of it", () => {
    const ephemeral = Buffer.alloc(32, 8).toString("base64");
    const base = { placeId: "p_1", hostPublicKey: publicKey, nonce, signature, ephemeral, hostName: "zingzy-mbp" };
    expect(PlaceJoinReply.safeParse(base).success).toBe(true);
    expect(PlaceJoinReply.safeParse({ ...base, hostName: "" }).success).toBe(false);
    // The reply to frame one is the last that travels in the clear, so nothing of the person's is on it.
    expect(PlaceJoinReply.safeParse({ ...base, ephemeral: undefined }).success).toBe(false);
    expect(PlaceJoinDevice.safeParse({ deviceId: "d_1", deviceToken: "" }).success).toBe(false);
    expect(PlaceJoinDevice.safeParse({ deviceId: "d_1", deviceToken: "t" }).success).toBe(true);
  });

  it("takes the word for how a computer copies a project, and a report from one that says none", () => {
    for (const copies of ["reflink", "snapshot", "plain"]) {
      expect(PlaceReport.safeParse({ ...report, copies }).success, copies).toBe(true);
    }
    // A computer that runs no workspaces has no copy to describe, and a word nothing makes is not one.
    expect(PlaceReport.safeParse(report).success).toBe(true);
    expect(PlaceReport.safeParse({ ...report, copies: "hardlink" }).success).toBe(false);
  });

  it("takes the agents a computer found on itself, up to the cap the sentence they land in can hold", () => {
    expect(PlaceReport.safeParse({ ...report, agents: ["claude", "codex"] }).success).toBe(true);
    expect(PlaceReport.safeParse({ ...report, agents: Array.from({ length: 33 }, () => "claude") }).success).toBe(false);
  });
});

describe("the four events a computer you own rides the runtime's own stream on", () => {
  const place = { id: "p_1", kind: "computer" as const, name: "old-macbook", default: true };

  it("parses each with the sequence every other event carries", () => {
    expect(EventUnion.safeParse({ type: "place.joined", place, from: "192.168.1.34", seq: 3 }).success).toBe(true);
    expect(EventUnion.safeParse({ type: "place.present", placeId: "p_1", from: "192.168.1.34", seq: 4 }).success).toBe(true);
    expect(EventUnion.safeParse({ type: "place.absent", placeId: "p_1", seq: 5 }).success).toBe(true);
    expect(EventUnion.safeParse({ type: "place.removed", placeId: "p_1", seq: 6 }).success).toBe(true);
  });

  it("refuses a join with no address it came from, since the sheet says where it connected from", () => {
    expect(EventUnion.safeParse({ type: "place.joined", place, seq: 3 }).success).toBe(false);
  });
});

describe("a pairing code as a person reads it and as the host takes it", () => {
  it("shows in two halves and comes back as the letters alone, whichever screen it was copied off", () => {
    expect(shownPairCode("QW4K7PZX")).toBe("QW4K-7PZX");
    expect(shownPairCode("qw4k7pzx")).toBe("QW4K-7PZX");
    expect(shownPairCode("QW4K")).toBe("QW4K");
    expect(sentPairCode("QW4K-7PZX")).toBe("QW4K7PZX");
    expect(sentPairCode("qw4k-7pzx")).toBe("QW4K7PZX");
    expect(sentPairCode(shownPairCode("QW4K7PZX"))).toBe("QW4K7PZX");
  });
});

describe("the one token a join line carries", () => {
  const KEY = `SHA256:${"a".repeat(43)}`;

  it("writes the code as a screen shows it and the key beside it, and reads both back", () => {
    expect(joinToken("QW4K7PZX", KEY)).toBe(`QW4K-7PZX.${KEY}`);
    expect(readJoinToken(joinToken("QW4K7PZX", KEY))).toEqual({ code: "QW4K7PZX", hostKey: KEY });
  });

  it("takes the code the way every other screen takes one, and leaves the key exactly as it was written", () => {
    // The code is folded to the letters alone; the key is base64 and case is what tells two keys apart.
    expect(readJoinToken(`  qw4k-7pzx.${KEY}  `)).toEqual({ code: "QW4K7PZX", hostKey: KEY });
    expect(readJoinToken(`QW4K-7PZX.SHA256:aB+/cD`).hostKey).toBe("SHA256:aB+/cD");
  });

  it("answers no key for a token that carries none, which is what the join refuses on", () => {
    expect(readJoinToken("QW4K-7PZX")).toEqual({ code: "QW4K7PZX" });
    expect(readJoinToken("QW4K-7PZX.")).toEqual({ code: "QW4K7PZX" });
    expect(JOIN_NO_KEY_REFUSAL).toContain("wsp add");
  });

  it("splits at the first mark, so a key holding one is read whole", () => {
    expect(readJoinToken(`QW4K-7PZX.SHA256:a.b`).hostKey).toBe("SHA256:a.b");
  });
});

describe("which row of the places list a workspace stands on", () => {
  const here = { id: "here", kind: "computer" as const };
  const laptop = { id: "p_1", kind: "computer" as const };
  const ascii = { id: "box", kind: "provider" as const };
  const solari = { id: "solari", kind: "provider" as const };
  const places = [here, laptop, ascii, solari];

  it("takes the computer a fork's record names", () => {
    expect(workspacePlaceId({ kind: "cloud", machineId: "m1", place: "p_1" }, places)).toBe("p_1");
  });

  it("puts this computer's own workspace on the first row, which is the computer the host runs on", () => {
    expect(workspacePlaceId({ kind: "local", machineId: "local" }, places)).toBe("here");
  });

  it("puts a fork on the provider its record was stamped with, so two providers in one list do not share a total", () => {
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1", provider: "solari" }, places)).toBe("solari");
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_2", provider: "box" }, places)).toBe("box");
  });

  it("stands a fork written before records carried that word at the first provider, where a host that forks at one put it", () => {
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1" }, places)).toBe("box");
    expect(workspacePlaceId({ machineId: "fk_1" }, places)).toBe("box");
  });

  it("places a fork stamped with a provider this list does not hold nowhere, so a removed provider's spend is on nobody's row", () => {
    // Removing a provider deletes its workspaces where they stand and keeps their series for the month. Falling
    // back to the first provider would add every one of them to the provider that is left.
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1", provider: "hetzner" }, places)).toBeUndefined();
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1", provider: "solari" }, [here, ascii])).toBeUndefined();
  });

  it("places nothing it cannot: a computer that has been removed, and a fork on a list with no provider at all", () => {
    expect(workspacePlaceId({ kind: "cloud", machineId: "m1", place: "p_gone" }, places)).toBeUndefined();
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1" }, [here])).toBeUndefined();
  });
});

describe("the one word a row says about the daemon a place runs", () => {
  it("names both versions when this wsp deploys a newer daemon than the computer runs", () => {
    expect(placeDaemonBehind({ daemonVersion: 27 })).toBe(`daemon 27, host ${DAEMON_VERSION}`);
    expect(placeDaemonBehind({ daemonVersion: DAEMON_VERSION - 1 })).toBe(`daemon ${DAEMON_VERSION - 1}, host ${DAEMON_VERSION}`);
  });

  it("says nothing of a computer that is level, one that is ahead, or one that has never reported", () => {
    expect(placeDaemonBehind({ daemonVersion: DAEMON_VERSION })).toBeUndefined();
    // A computer running a daemon from a newer host than this one is not behind, and a row that said so would send
    // a person to move it backwards.
    expect(placeDaemonBehind({ daemonVersion: DAEMON_VERSION + 1 })).toBeUndefined();
    expect(placeDaemonBehind({})).toBeUndefined();
  });

  it("answers the word with the line that moves it, which is the flag on the verb that joins a computer", () => {
    expect(placeUpdateLine("spoo")).toBe("wsp add spoo --update");
    expect(placeBehindLine("spoo", placeDaemonBehind({ daemonVersion: 27 })!)).toBe(
      `spoo is behind: daemon 27, host ${DAEMON_VERSION}; wsp add spoo --update puts this wsp's daemon on it`,
    );
  });

  it("says which computer answers a workspace that runs no daemon of its own, rather than a route to a port nothing listens on", () => {
    expect(placeServesDaemonLine("landing-a", "spoo")).toBe("landing-a has no daemon of its own: spoo answers its files and git through this host");
  });

  it("says whose the ports and the load are where a pane asks a workspace for readings its computer takes for itself", () => {
    expect(placeWatchesItselfLine("spoo")).toBe("spoo watches its own ports and load, which are that computer's rather than one workspace's");
  });

  it("says a workspace's processes on a computer somebody owns are not readable from here yet, naming both", () => {
    expect(forkProcsUnreadLine("landing-a", "spoo")).toBe("landing-a's processes on spoo are not readable from here yet");
  });

  it("says a workspace on a computer somebody owns is driven from here by its shells, files and git alone, naming the op refused", () => {
    expect(forkOpRefusedLine("exec", "landing-a", "spoo")).toBe("spoo answers landing-a's shells, files and git from here, not exec");
  });

  it("refuses a place already on this daemon and one whose chip this wsp builds none for, each naming what it read", () => {
    expect(placeCurrentLine("spoo", DAEMON_VERSION)).toBe(`spoo already runs daemon ${DAEMON_VERSION}, which is the one this wsp deploys`);
    expect(placeNoChipLine("spoo", "linux", "riscv64")).toBe("spoo says it is linux riscv64, and this wsp carries no daemon built for it");
  });
});

describe("the recipe on a computer you own", () => {
  const row = (over: Partial<PlaceProvision["rows"][number]> = {}) => ({ id: "agents/codex", label: "Codex", outcome: "installed" as const, ...over });
  const running: PlaceProvision = { state: "running", addId: "a_1", recipeAt: "2026-09-17T10:00:00.000Z", startedAt: "2026-09-17T10:01:00.000Z", rows: [], at: { label: "Codex", index: 3, of: 7 } };
  const done = (rows: PlaceProvision["rows"]): PlaceProvision => ({ state: "done", addId: "a_1", recipeAt: running.recipeAt, startedAt: running.startedAt, finishedAt: "2026-09-17T10:09:00.000Z", rows });

  it("parses a job under way with the row it is on and one that is over with its rows, and refuses a job on no stream", () => {
    expect(PlaceProvision.parse(running)).toEqual(running);
    expect(PlaceProvision.parse(done([row(), row({ id: "tools/release/gh", label: "GitHub CLI", outcome: "failed", note: "no Linux build" })]))).toMatchObject({ state: "done" });
    expect(PlaceProvision.safeParse({ ...running, addId: "" }).success).toBe(false);
    expect(PlaceProvision.safeParse({ ...running, at: { label: "Codex", index: 0, of: 7 } }).success).toBe(false);
    // A row off the wire says one of the four things that can have become of it and nothing else.
    expect(PlaceProvision.safeParse(done([row({ outcome: "done" as never })])).success).toBe(false);
  });

  it("rides the row of the computer it is on, so wsp computers, the app's row and the MCP tool read one thing", () => {
    const view = { id: "p_1", kind: "computer" as const, name: "spoo", default: false, provision: running };
    expect(PlaceView.parse(view).provision).toEqual(running);
    expect(PlaceView.parse({ id: "p_1", kind: "computer" as const, name: "spoo", default: false }).provision).toBeUndefined();
  });

  it("is what an update answers beside the daemon half, which is absent on a computer already running this daemon", () => {
    expect(PlaceUpdateReply.parse({ name: "spoo", daemon: { from: 27, to: DAEMON_VERSION, road: "link", at: "/root/.wsp/daemon/wsp-daemon" }, provision: running })).toMatchObject({ name: "spoo" });
    expect(PlaceUpdateReply.parse({ name: "spoo", provision: running }).daemon).toBeUndefined();
    expect(PlaceUpdateReply.parse({ name: "spoo", said: "spoo got no agents or tools" }).provision).toBeUndefined();
    expect(PlaceUpdateReply.safeParse({}).success).toBe(false);
  });

  it("is a step of the install, with words of its own, since a join puts it on too", () => {
    expect(PlaceAddStep.options).toContain("provision");
    // Last of them: the recipe goes on once the computer is a place at all.
    expect(PlaceAddStep.options.at(-1)).toBe("provision");
    expect(PLACE_ADD_WORDS.provision).toBe("installing agents, tools, skills and servers");
  });

  it("says on the row what is under way, or what stands, in one word each", () => {
    expect(provisionWord(undefined)).toBe("");
    expect(provisionWord(running)).toBe("setting up 3/7: Codex");
    expect(provisionWord({ ...running, at: undefined })).toBe("setting up");
    // What the rows put there, never the word row: a row is the recipe's own word and nobody reading a computer's
    // row has seen a recipe.
    expect(provisionWord(done([row(), row({ id: "tools/uv/ruff", label: "ruff", outcome: "present" })]))).toBe("2 tools ready");
    expect(provisionWord(done([row()]))).toBe("1 tool ready");
    // The files in the agents' homes there and the servers in their configs are rows of the same job, counted by
    // what they are; a row that says nothing is a tool, which is what every row was before there were others.
    expect(
      provisionWord(
        done([
          row(),
          row({ id: "files/.claude-cfg/skills", label: "Claude Code /root/.claude-cfg/skills", kind: "file", outcome: "installed" }),
          row({ id: "files/.codex/AGENTS.md", label: "Codex /root/.codex/AGENTS.md", kind: "file", outcome: "skipped" }),
          row({ id: `${MCP_ID_PREFIX}claude/github`, label: "Claude Code github", kind: "server", outcome: "present" }),
        ]),
      ),
    ).toBe("1 tool, 2 files, 1 MCP server ready");
    expect(provisionCountWord({})).toBe("0 tools");
    expect(provisionCountWord({ server: 2 })).toBe("2 MCP servers");
    expect(provisionWord(done([row(), row({ id: "tools/release/gh", label: "GitHub CLI", outcome: "failed" }), row({ id: "tools/uv/uv", label: "uv", outcome: "failed" })]))).toBe(
      "2 of 3 failed: GitHub CLI, uv",
    );
    expect(provisionWord({ ...running, state: "stopped", said: "spoo is not connected" })).toBe("stopped: spoo is not connected");
  });

  it("prints what installed by name, how many were already there, and every row that did not land with its reason", () => {
    const lines = provisionLines("spoo", done([
      row(),
      row({ id: "tools/uv/ruff", label: "ruff", outcome: "present" }),
      row({ id: "tools/release/gh", label: "GitHub CLI", outcome: "failed", note: "no Linux build" }),
      row({ id: "tools/brew-cask/raycast", label: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" }),
    ]));
    expect(lines).toEqual([
      "spoo: 1 installed: Codex, 1 already there",
      "  x GitHub CLI: no Linux build",
      "  - Raycast: macOS app, no Linux build",
    ]);
    expect(provisionLines("spoo", done([row({ outcome: "present" })]))[0]).toBe("spoo: nothing installed, 1 already there");
    // A job that stopped says so under its rows, since the rows it did get are still what landed.
    expect(provisionLines("spoo", { ...running, state: "stopped", rows: [row()], said: "spoo is not connected" }).at(-1)).toBe("spoo: spoo is not connected");
  });

  it("says in one sentence why a workspace cannot be made there yet, and what to read, naming the row it is on", () => {
    expect(placeProvisioningLine("spoo", running.at)).toBe(
      "spoo is still being set up (Codex, 3 of 7); wsp computers shows it, and a workspace there can be made once it is done",
    );
    expect(placeProvisioningLine("spoo")).toBe("spoo is still being set up; wsp computers shows it, and a workspace there can be made once it is done");
  });

  it("says when this computer holds no recipe to put on, with the two lines that write one and put it on", () => {
    expect(placeNoRecipeLine("spoo", "/Users/lena/.wsp/recipe.json")).toBe(
      "spoo got no agents or tools: this computer has no recipe at /Users/lena/.wsp/recipe.json. wsp recipe writes one; wsp add spoo --update then puts it on spoo",
    );
  });

  it("says a computer that reported no home folder got none either, in the same words", () => {
    expect(placeNoHomeLine("spoo")).toBe("spoo got no agents or tools: it reported no home folder for its login, so nothing on it could be reached");
    // The two read as one kind of answer: the computer is joined, the recipe went nowhere, and why.
    for (const line of [placeNoHomeLine("spoo"), placeNoRecipeLine("spoo", "/x/recipe.json")]) expect(line.startsWith("spoo got no agents or tools: ")).toBe(true);
  });

  it("keeps its log and its outcome in the folder wsp already owns on that computer, never inside a workspace", () => {
    const at = placeProvisionPaths("/root");
    expect(at).toEqual({
      dir: "/root/.wsp/provision",
      runDir: "/root/.wsp/provision/run",
      log: "/root/.wsp/provision/log",
      result: "/root/.wsp/provision/result.json",
      staging: "/root/.wsp/provision/files",
      landed: "/root/.wsp/provision/landed",
      landing: "/root/.wsp/provision/landing",
      asked: "/root/.wsp/provision/asked",
    });
    for (const path of Object.values(at)) expect(path.startsWith(`${placeDaemonPaths("/root").wsp}/`)).toBe(true);
  });
});

describe("the one rule that decides whether a computer can be a place", () => {
  /** A kernel, as the rule reads one: the two files it asks for, and nothing else on this machine. */
  const box = (files: Record<string, string>) => (path: string): string | undefined => files[path];
  const CGROUP: Record<string, string> = { [CGROUP_CONTROLLERS_PATH]: "cpuset cpu io memory pids\n", [PROC_FILESYSTEMS_PATH]: "nodev sysfs\next4\nnodev overlay\n" };

  it("takes a Linux box with cgroup v2, the two controllers a cap needs, an overlay and root", () => {
    expect(workspacesBlockedBy({ platform: "linux", read: box(CGROUP), euid: 0 })).toBeUndefined();
  });

  it("turns down anything that is not Linux before it reads a file at all", () => {
    let asked = 0;
    const counting = (path: string): string | undefined => {
      asked++;
      return CGROUP[path];
    };
    expect(workspacesBlockedBy({ platform: "darwin", read: counting, euid: 0 })).toBe("wsp runs workspaces on a Linux computer");
    expect(asked).toBe(0);
  });

  it("names cgroup v1 when the controllers file is not there, since that is what mounting v1 looks like", () => {
    const said = workspacesBlockedBy({ platform: "linux", read: box({ [PROC_FILESYSTEMS_PATH]: CGROUP[PROC_FILESYSTEMS_PATH]! }), euid: 0 });
    expect(said).toContain("cgroup v1");
    expect(said).toContain("systemd.unified_cgroup_hierarchy=1");
  });

  it("names the controller a cap needs and does not have, one at a time", () => {
    const without = (drop: string) => box({ ...CGROUP, [CGROUP_CONTROLLERS_PATH]: "cpuset cpu io memory pids\n".replace(`${drop} `, "") });
    expect(workspacesBlockedBy({ platform: "linux", read: without("memory"), euid: 0 })).toBe("this computer's cgroup root offers no memory controller, which wsp needs to run workspaces here");
    expect(workspacesBlockedBy({ platform: "linux", read: without("cpu"), euid: 0 })).toBe("this computer's cgroup root offers no cpu controller, which wsp needs to run workspaces here");
  });

  it("names the overlay a workspace's layers stack on, whether the file is missing or does not list it", () => {
    const overlay = "this computer's kernel has no overlay filesystem, which a workspace here reads this computer's own directories through";
    expect(workspacesBlockedBy({ platform: "linux", read: box({ [CGROUP_CONTROLLERS_PATH]: CGROUP[CGROUP_CONTROLLERS_PATH]! }), euid: 0 })).toBe(overlay);
    expect(workspacesBlockedBy({ platform: "linux", read: box({ ...CGROUP, [PROC_FILESYSTEMS_PATH]: "nodev sysfs\next4\n" }), euid: 0 })).toBe(overlay);
  });

  it("names root last, so a box that has everything else reads the one thing a person can change from here", () => {
    expect(workspacesBlockedBy({ platform: "linux", read: box(CGROUP), euid: 1000 })).toBe("wsp runs workspaces on this computer as root, and this daemon is not root");
    expect(workspacesBlockedBy({ platform: "linux", read: box(CGROUP) })).toContain("as root");
  });

  it("asks in one order, so the reason a person reads is the first thing missing rather than the last", () => {
    // A Mac with none of it reads the platform, not the cgroup; a Linux box missing both cgroup and overlay reads
    // the cgroup. Every sentence above is reachable, and only the first one that applies is ever said.
    expect(workspacesBlockedBy({ platform: "darwin", read: box({}), euid: 1000 })).toContain("Linux computer");
    expect(workspacesBlockedBy({ platform: "linux", read: box({}), euid: 1000 })).toContain("cgroup v1");
    expect(workspacesBlockedBy({ platform: "linux", read: box({ [CGROUP_CONTROLLERS_PATH]: "cpu memory\n" }), euid: 1000 })).toContain("overlay");
  });
});
