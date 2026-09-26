// SPDX-License-Identifier: AGPL-3.0-only
// The contract every daemon speaking this wire is held to, as one fixture set
// under daemon/fixtures/contract: frames the schemas here must take and refuse,
// one file pair per op and per event type, and the words and numbers the
// daemon emits that a client or a test matches on. This side is the source:
// the words and numbers are regenerated from this package's exports and must
// equal the committed files, and a daemon written in another language checks
// its own constants and types against the same files, never against a build
// of this package.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZodLiteral, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import {
  AUTH_DEADLINE_MS,
  CACHE_DIRS,
  REPO_CAP,
  REPO_DEPTH,
  DAEMON_AUTH_DEADLINE_PASSED,
  DAEMON_TOKEN_ROTATED,
  DAEMON_DEFAULT_HOST,
  DAEMON_DEFAULT_PORT,
  DAEMON_FIRST_FRAME_NOT_AUTH,
  DAEMON_INVALID_JSON,
  DAEMON_NICE,
  DAEMON_NO_TOKEN,
  DAEMON_OOM_SCORE_ADJ,
  DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  DAEMON_ROOTS_PATH,
  DAEMON_SAMPLER_INTERVAL_MS,
  DAEMON_TOKEN_PATH,
  GUEST_WSP_HOME,
  HOMEBREW_HOME,
  HOMEBREW_PREFIX,
  SHARED_TOOL_ROOTS,
  TOOLS_PATH,
  PLACE_WORKSPACE_PATH,
  WORKSPACE_OVERLAID,
  DAEMON_TOKEN_REFUSED,
  DAEMON_VERSION,
  CopyReport,
  DaemonAuthRequest,
  DaemonErrorResponse,
  DaemonEvent,
  DaemonRequest,
  EXEC_BODY_MAX,
  MachineLinkRequest,
  EXEC_DEADLINE_EXIT,
  EXEC_OUTPUT_MAX,
  EXEC_TIMEOUT_DEFAULT_MS,
  FS_LIST_CAP_ENTRIES,
  FS_READ_CAP_BYTES,
  GIT_DIFF_CAP_BYTES,
  GUEST_ARGV_MAX,
  GUEST_CWD_MAX,
  GUEST_DAEMON_DIR,
  GUEST_DAEMON_SOCKET_PATH,
  GUEST_INBOX_DIR,
  GUEST_MANIFEST_PATH,
  GUEST_FRAME_CAP_BYTES,
  GUEST_IN_FLIGHT_CAP_BYTES,
  GUEST_IN_FLIGHT_FULL,
  GUEST_MESSAGE_CAP_BYTES,
  GUEST_NOT_WATCHER,
  GUEST_QUEUE_CAP_FRAMES,
  GUEST_QUEUE_FULL,
  GUEST_SESSIONS_PER_WORKSPACE_CAP,
  GUEST_WORKSPACE_FULL,
  GUEST_UNWATCHED,
  GUEST_UNWATCHED_MS,
  GUEST_TOKEN_MAX,
  GUEST_WSP_PATH,
  GitPrReply,
  GitPrStateReply,
  GitPushReply,
  GuestCliMessage,
  GuestOpenReply,
  HostFolderListing,
  HTTP_URL_MAX,
  NOT_ON_A_BRANCH,
  NO_REMOTE,
  noGitCredentialLine,
  noHostCliLine,
  nothingAheadLine,
  onBaseRefusal,
  MachineAnswersReply,
  MachineBackendReply,
  MachineCapacityReply,
  MachineExecReply,
  MachineHandleReply,
  MachineListReply,
  MachineReachReply,
  MachineReadingReply,
  MachineShapeReply,
  MachineStateReply,
  NO_IMAGES_HERE,
  NO_PLACE_FILE_LINE,
  NOT_ON_THIS_KIND,
  NOT_ON_THIS_ROAD,
  OPEN_SHIM_PATH,
  OPEN_SOCKET_PATH,
  PID_MAX,
  PLACE_LINK_NONCE_BYTES,
  PORT_COMMAND_BYTES,
  PRE_AUTH_MAX_BYTES,
  PROC_CAP,
  PROC_CMDLINE_BYTES,
  PROC_SAMPLER_STARTED,
  PROC_SAMPLER_STOPPED,
  PTY_SCROLLBACK_CAP_BYTES,
  PlaceAuthRequest,
  PlaceProveRequest,
  SYS_SAMPLER_STARTED,
  SYS_SAMPLER_STOPPED,
  TUNNEL_CAP,
  WORK_OOM_SCORE_ADJ,
  XDG_OPEN_PATH,
  WSP_WORKSPACE_APPARMOR_PATH,
  authUnreadableLine,
  daemonListeningLine,
  dialFailedLine,
  dialTimedOutLine,
  dialUnansweredLine,
  foldersOutsideLine,
  guestNoDaemonLine,
  HOST_CLOSED_LINE,
  placeKeptForLinkLine,
  guestWspShim,
  hostKeyRefusal,
  hostQuietLine,
  hostRefusedLine,
  linkHostUnsealedLine,
  linkOutOfOrderLine,
  linkedLine,
  notAFrameLine,
  placeDaemonPaths,
  placeOwnedPaths,
  portScopeRefusal,
  probePath,
  unknownOpLine,
  workScoreLine,
} from "../src/index.js";

const CONTRACT = fileURLToPath(new URL("../../../daemon/fixtures/contract/", import.meta.url));

/** The frames a file holds, which is always an array with something in it. */
function frames(dir: string, name: string): unknown[] {
  const path = join(CONTRACT, dir, name);
  const held = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(held) || held.length === 0) throw new Error(`${path} must hold a non-empty array of frames`);
  return held;
}

/** The op or type names a discriminated union takes, off its options. */
const namesOf = (union: { options: ZodObject<ZodRawShape>[] }, key: string): string[] =>
  union.options
    .map(option => {
      const literal = option.shape[key];
      if (!(literal instanceof ZodLiteral)) throw new Error(`${key} is not a literal on every option`);
      return String(literal.value);
    })
    .sort();

/** The op names with a file pair under frames, off the files. */
const filed = (dir: string): string[] => [...new Set(readdirSync(join(CONTRACT, dir)).map(f => f.replace(/\.(accept|reject)\.json$/, "")))].sort();

/** Which schema reads a frame by its op: every op the daemon answers inbound is one DaemonRequest option, the auth
 * frame is its own, the two the place sends outward to its host are theirs, and the machine ops the host sends a
 * place over the link are the link's own union. */
const OUTBOUND: Record<string, ZodTypeAny> = { auth: DaemonAuthRequest, "place.auth": PlaceAuthRequest, "place.prove": PlaceProveRequest };
const schemaFor = (op: string): ZodTypeAny => OUTBOUND[op] ?? (op.startsWith("machine.") ? MachineLinkRequest : DaemonRequest);

describe("every op and every event has its accept and reject frames", () => {
  it("names one file pair per op the daemon answers, per machine op on the link, plus auth and the two frames a place sends its host", () => {
    expect(filed("frames")).toEqual([...namesOf(DaemonRequest, "op"), ...namesOf(MachineLinkRequest, "op"), ...Object.keys(OUTBOUND)].sort());
  });

  it("names one file pair per event type the daemon pushes", () => {
    expect(filed("events")).toEqual(namesOf(DaemonEvent, "type"));
  });

  it("has both halves of every pair", () => {
    for (const dir of ["frames", "events"]) {
      for (const name of filed(dir)) {
        for (const half of ["accept", "reject"]) expect(existsSync(join(CONTRACT, dir, `${name}.${half}.json`)), `${dir}/${name}.${half}.json`).toBe(true);
      }
    }
  });
});

describe("the schemas take every accept frame and refuse every reject frame", () => {
  for (const op of filed("frames")) {
    it(`frames/${op}`, () => {
      const schema = schemaFor(op);
      for (const frame of frames("frames", `${op}.accept.json`)) {
        const parsed = schema.safeParse(frame);
        expect(parsed.success, `${op} must accept ${JSON.stringify(frame).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        // A frame under an op's file is that op's frame: the discriminant is what the file is named after.
        expect((frame as { op: string }).op).toBe(op);
      }
      for (const frame of frames("frames", `${op}.reject.json`)) {
        expect(schema.safeParse(frame).success, `${op} must refuse ${JSON.stringify(frame).slice(0, 200)}`).toBe(false);
      }
    });
  }

  for (const type of filed("events")) {
    it(`events/${type}`, () => {
      for (const event of frames("events", `${type}.accept.json`)) {
        const parsed = DaemonEvent.safeParse(event);
        expect(parsed.success, `${type} must accept ${JSON.stringify(event).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        expect((event as { type: string }).type).toBe(type);
      }
      for (const event of frames("events", `${type}.reject.json`)) {
        expect(DaemonEvent.safeParse(event).success, `${type} must refuse ${JSON.stringify(event).slice(0, 200)}`).toBe(false);
      }
    });
  }
});

/** A sentence with a value in it is kept as its template: the braces name what the daemon fills in. */
const words = (): Record<string, string> => ({
  tokenRefused: DAEMON_TOKEN_REFUSED,
  firstFrameNotAuth: DAEMON_FIRST_FRAME_NOT_AUTH,
  preAuthBytesExceeded: DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  authDeadlinePassed: DAEMON_AUTH_DEADLINE_PASSED,
  tokenRotated: DAEMON_TOKEN_ROTATED,
  invalidJson: DAEMON_INVALID_JSON,
  noToken: DAEMON_NO_TOKEN,
  unknownOp: unknownOpLine("{op}"),
  portScopeRefusal: portScopeRefusal("{port}"),
  foldersOutside: foldersOutsideLine("{dir}", "{roots}"),
  notOnThisRoad: NOT_ON_THIS_ROAD,
  notOnThisKind: NOT_ON_THIS_KIND,
  noImagesHere: NO_IMAGES_HERE,
  guestNotWatcher: GUEST_NOT_WATCHER,
  guestQueueFull: GUEST_QUEUE_FULL,
  guestInFlightFull: GUEST_IN_FLIGHT_FULL,
  guestWorkspaceFull: GUEST_WORKSPACE_FULL,
  guestUnwatched: GUEST_UNWATCHED,
  guestNoDaemon: guestNoDaemonLine("{port}"),
  hostClosed: HOST_CLOSED_LINE,
  placeKeptForLink: placeKeptForLinkLine("{path}"),
  onBase: onBaseRefusal("{base}"),
  notOnABranch: NOT_ON_A_BRANCH,
  nothingAhead: nothingAheadLine("{branch}", "{base}"),
  noRemote: NO_REMOTE,
  noHostCli: noHostCliLine("{host}"),
  noGitCredential: noGitCredentialLine("{host}", "{fix}"),
  noGitCredentialNoFix: noGitCredentialLine("{host}"),
  hostKeyRefusal: hostKeyRefusal("{url}"),
  listening: daemonListeningLine("{host}", "{port}"),
  sysSamplerStarted: SYS_SAMPLER_STARTED,
  sysSamplerStopped: SYS_SAMPLER_STOPPED,
  procSamplerStarted: PROC_SAMPLER_STARTED,
  procSamplerStopped: PROC_SAMPLER_STOPPED,
  noPlaceFile: NO_PLACE_FILE_LINE,
  linked: linkedLine("{url}"),
  hostQuiet: hostQuietLine("{url}", "{seconds}"),
  dialUnanswered: dialUnansweredLine("{url}"),
  dialTimedOut: dialTimedOutLine("{url}", "{seconds}"),
  dialFailed: dialFailedLine("{url}", "{error}"),
  notAFrame: notAFrameLine("{url}"),
  authUnreadable: authUnreadableLine("{url}", "{error}"),
  hostRefused: hostRefusedLine("{url}", "{refusal}"),
  linkOutOfOrder: linkOutOfOrderLine("{url}"),
  linkHostUnsealed: linkHostUnsealedLine("{url}"),
});

/** The home the owned-paths fixture is rendered for: one letter, so the list reads as the shape of the paths
 * rather than as somebody's login, and the daemon's twin renders the same one. */
const FIXTURE_HOME = "/h";

/** The binary the wsp shim's fixture is rendered onto: the shim's one hole, kept as its template the way a
 * sentence with a value in it is, since the path differs on each road that writes the shim. */
const SHIM_BINARY = "{binary}";

/** The home the probe path's fixture is rendered for: root's, since every directory the tools PATH names under a
 * home is under that one and a made-up home would take nothing off the list. */
const PROBE_HOME = "/root";

const numbers = (): Record<string, number | string | readonly string[]> => ({
  daemonVersion: DAEMON_VERSION,
  execBodyMax: EXEC_BODY_MAX,
  guestMessageCapBytes: GUEST_MESSAGE_CAP_BYTES,
  guestQueueCapFrames: GUEST_QUEUE_CAP_FRAMES,
  guestInFlightCapBytes: GUEST_IN_FLIGHT_CAP_BYTES,
  guestSessionsPerWorkspaceCap: GUEST_SESSIONS_PER_WORKSPACE_CAP,
  guestFrameCapBytes: GUEST_FRAME_CAP_BYTES,
  guestUnwatchedMs: GUEST_UNWATCHED_MS,
  guestTokenMax: GUEST_TOKEN_MAX,
  guestArgvMax: GUEST_ARGV_MAX,
  guestCwdMax: GUEST_CWD_MAX,
  execOutputMax: EXEC_OUTPUT_MAX,
  execTimeoutDefaultMs: EXEC_TIMEOUT_DEFAULT_MS,
  execDeadlineExit: EXEC_DEADLINE_EXIT,
  placeLinkNonceBytes: PLACE_LINK_NONCE_BYTES,
  preAuthMaxBytes: PRE_AUTH_MAX_BYTES,
  authDeadlineMs: AUTH_DEADLINE_MS,
  tunnelCap: TUNNEL_CAP,
  fsReadCapBytes: FS_READ_CAP_BYTES,
  fsListCapEntries: FS_LIST_CAP_ENTRIES,
  gitDiffCapBytes: GIT_DIFF_CAP_BYTES,
  ptyScrollbackCapBytes: PTY_SCROLLBACK_CAP_BYTES,
  procCmdlineBytes: PROC_CMDLINE_BYTES,
  portCommandBytes: PORT_COMMAND_BYTES,
  procCap: PROC_CAP,
  pidMax: PID_MAX,
  openBodyMax: HTTP_URL_MAX,
  daemonDefaultHost: DAEMON_DEFAULT_HOST,
  daemonDefaultPort: DAEMON_DEFAULT_PORT,
  daemonSamplerIntervalMs: DAEMON_SAMPLER_INTERVAL_MS,
  guestWspHome: GUEST_WSP_HOME,
  workspaceOverlaid: WORKSPACE_OVERLAID,
  homebrewHome: HOMEBREW_HOME,
  homebrewPrefix: HOMEBREW_PREFIX,
  sharedToolRoots: SHARED_TOOL_ROOTS,
  toolsPath: TOOLS_PATH,
  placeWorkspacePath: PLACE_WORKSPACE_PATH,
  daemonTokenPath: DAEMON_TOKEN_PATH,
  daemonRootsPath: DAEMON_ROOTS_PATH,
  guestInboxDir: GUEST_INBOX_DIR,
  guestManifestPath: GUEST_MANIFEST_PATH,
  openShimPath: OPEN_SHIM_PATH,
  xdgOpenPath: XDG_OPEN_PATH,
  workspaceApparmorPath: WSP_WORKSPACE_APPARMOR_PATH,
  openSocketPath: OPEN_SOCKET_PATH,
  guestDaemonSocketPath: GUEST_DAEMON_SOCKET_PATH,
  guestDaemonDir: GUEST_DAEMON_DIR,
  guestWspPath: GUEST_WSP_PATH,
  daemonOomScoreAdj: DAEMON_OOM_SCORE_ADJ,
  daemonNice: DAEMON_NICE,
  workOomScoreAdj: WORK_OOM_SCORE_ADJ,
  workScoreLine: workScoreLine(),
  cacheDirs: [...CACHE_DIRS],
  repoDepth: REPO_DEPTH,
  repoCap: REPO_CAP,
});

/** The replies a daemon answers the machine ops with, one file per reply schema under replies/, each holding samples
 * that use every optional field once and leave every one out once. A daemon in another language reads the same
 * files through its own reply types and must write them back byte for byte in meaning; the schemas here parse them,
 * so a field renamed on either side fails one of the two. Only the replies such a daemon answers today are listed. */
const REPLIES: Record<string, { schema: ZodTypeAny; samples: unknown[] }> = {
  MachineBackendReply: {
    schema: MachineBackendReply,
    samples: [
      {
        offer: "runtime",
        capabilities: {
          liveCloneForks: false,
          pauseMode: "disk",
          replacesMachine: true,
          previewUrls: false,
          signedUrls: false,
          callbackRelay: true,
          diskSnapshots: true,
          images: true,
          snapshotsAnyLife: false,
          snapshotListing: true,
          templates: true,
          sizes: [
            { cpu: 2, memMb: 4096, rateUsdPerHour: 0 },
            { cpu: 4, memMb: 8192, rateUsdPerHour: 0 },
          ],
          kept: false,
          copies: true,
          ownNetwork: true,
        },
        pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" }, builderDiskGb: 40 },
        lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30000, resumeAsks: { everyMs: 5000, forMs: 60000 } } },
        baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
        logins: "/var/lib/wsp/logins",
      },
      {
        offer: "runtime",
        capabilities: {
          liveCloneForks: false,
          replacesMachine: true,
          previewUrls: false,
          signedUrls: false,
          callbackRelay: false,
          diskSnapshots: false,
          images: false,
          snapshotsAnyLife: false,
          snapshotListing: false,
          templates: false,
          sizes: [],
          kept: false,
          copies: true,
          ownNetwork: true,
        },
        pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
      },
    ],
  },
  MachineCapacityReply: {
    schema: MachineCapacityReply,
    samples: [
      {
        cores: 4,
        memMb: 7751,
        memRoomMb: 2851,
        machineMemMb: 3875,
        cpuTaken: 1,
        memTakenMb: 1024,
        diskFreeBytes: 47400000000,
        images: [
          { id: "sha256:a61567bd31828687156d735ea8eb01ba4e37636e225dd6a48ba94136a70d9d61", name: "ubuntu:24.04", sizeBytes: 29763253 },
          { id: "sha256:0000000000000000000000000000000000000000000000000000000000000000", sizeBytes: 0 },
        ],
        machines: { running: 1, paused: 1 },
      },
    ],
  },
  MachineHandleReply: {
    schema: MachineHandleReply,
    samples: [
      {
        machine: {
          id: "wsp-live-665-build",
          kind: "sandbox",
          streamUrl: "https://stream.example/x",
          labels: { wsp: "1", "wsp-owner": "state-1" },
          seen: { state: "running", createdAt: "2026-09-12T13:00:00.000Z" },
          replayed: true,
          daemonSupervisor: "entrypoint",
          notice: "size 2x4 on 2 cores: cpu clamped to 1 and memory clamped to 2 GB",
          roads: { previewUrl: false, daemonAnswers: true, putBytes: true, describe: true, facts: false, metrics: true },
        },
      },
      { machine: { id: "wsp-8fef733ad77786dc", kind: "desktop", roads: { previewUrl: true, daemonAnswers: true, putBytes: false, describe: false, facts: true, metrics: false } } },
      { machine: { id: "c1", kind: "sandbox", seen: { state: "paused" }, roads: { previewUrl: false, daemonAnswers: false, putBytes: false, describe: false, facts: false, metrics: false } } },
    ],
  },
  MachineListReply: {
    schema: MachineListReply,
    samples: [
      {
        machines: [
          { id: "wsp-a", state: "running", labels: { wsp: "1", row: "yes" }, size: { cpu: 2, memMb: 1024 } },
          { id: "wsp-b", state: "gone", labels: {} },
        ],
      },
      { machines: [] },
    ],
  },
  MachineExecReply: { schema: MachineExecReply, samples: [{ result: { exitCode: 7, stdout: "out\n", stderr: "err\n" } }, { result: { exitCode: 124, stdout: "", stderr: "" } }] },
  MachineStateReply: { schema: MachineStateReply, samples: [{ state: "starting" }, { state: "running" }, { state: "paused" }, { state: "gone" }] },
  MachineReadingReply: {
    schema: MachineReadingReply,
    samples: [
      {
        reading: {
          state: "running",
          cpu: 1,
          memMb: 2048,
          memBytes: 734003200,
          cpuUsageUsec: 41200000,
          uptimeMs: 5430000,
          procs: 37,
          quietForMs: 143000,
          address: "10.65.0.6",
          cgroup: "/sys/fs/cgroup/wsp/wsp-8fef733ad77786dc",
          upper: "/var/lib/wsp/run/wsp-8fef733ad77786dc/upper",
        },
      },
      { reading: { state: "paused", cgroup: "/sys/fs/cgroup/wsp/wsp-a", upper: "/var/lib/wsp/run/wsp-a/upper" } },
    ],
  },
  MachineShapeReply: { schema: MachineShapeReply, samples: [{ shape: { cpu: 2, memMb: 1024, diskGb: 20, createdAt: "2026-09-12T13:00:00.000Z", usedBytes: 5284823040 } }, { shape: {} }] },
  MachineAnswersReply: { schema: MachineAnswersReply, samples: [{ answers: true }, { answers: false }] },
  MachineReachReply: { schema: MachineReachReply, samples: [{ reach: { url: "http://127.0.0.1:41234", token: "", expiresAt: 9007199254740991 } }] },
  GitPushReply: {
    schema: GitPushReply,
    samples: [
      {
        branch: "pricing-page",
        base: "main",
        remote: "origin",
        ahead: 2,
        uncommitted: 1,
        stat: [" src/page.tsx | 14 ++++++++++----", " 1 file changed, 10 insertions(+), 4 deletions(-)"],
      },
      { branch: "work", base: "main", remote: "origin", ahead: 1, uncommitted: 0, stat: [] },
    ],
  },
  GitPrReply: {
    schema: GitPrReply,
    samples: [
      { pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com" }, created: true },
      { pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "merged", host: "github.com" }, created: false },
    ],
  },
  GitPrStateReply: {
    schema: GitPrStateReply,
    samples: [{ pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "closed", host: "github.com" } }, {}],
  },
  GuestOpenReply: { schema: GuestOpenReply, samples: [{ session: "g1" }] },
  HostFolderListing: {
    schema: HostFolderListing,
    samples: [
      {
        dir: "/home/maya",
        roots: ["/home/maya", "/wsp/projects/p_1/checkout"],
        folders: [
          { path: "/home/maya/code", repo: true },
          { path: "/home/maya/notes", repo: false },
        ],
        hidden: 3,
      },
      { dir: "/home/maya/notes", roots: ["/home/maya"], folders: [], hidden: 0 },
      { dir: "/home/maya", roots: ["/home/maya"], folders: [{ path: "/home/maya/code/spoo", repo: true, branch: "main", touchedAt: 1758700000000 }], hidden: 0 },
    ],
  },
  GuestCliMessage: { schema: GuestCliMessage, samples: [{ stream: "out", text: "rows\n" }, { stream: "err", text: "one line\n" }, { exit: 3 }] },
  CopyReport: {
    schema: CopyReport,
    samples: [
      {
        road: "clonefile",
        path: "/Users/dev/spoo-landing-pricing-page",
        base: "1ac97f8d7ea55cc4f6a4f8f2f0e4f3b6ce9dc0c9",
        branch: "main",
        fetched: true,
        carried: "deps-and-config",
        excluded: [".next", "node_modules/.cache"],
        skipped: ["node_modules/.cache: node_modules is a link or not a folder, so nothing under it was removed"],
        bytes: 6442450944,
        ms: 4900,
      },
      {
        road: "worktree",
        path: "/Users/dev/spoo-landing-qr-codes",
        base: "2bd08e9f8fb66dd5a7b5a9a3a1f5a4c7df0ed1d0",
        branch: "",
        fetched: false,
        carried: "config-only",
        excluded: [],
        bytes: 21474836481,
        ms: 12400,
        fellBack: "the folder is 20.0 GB and a clone above 20.0 GB is not taken",
      },
      { road: "in-place", path: "/Users/dev/spoo-landing", base: "", branch: "", fetched: false, carried: "nothing", excluded: [], bytes: 0, ms: 0 },
    ],
  },
  DaemonErrorResponse: {
    schema: DaemonErrorResponse,
    samples: [
      { id: 7, ok: false, error: "no such workspace: wsp-x", kind: "missing", status: 404 },
      { id: "a", ok: false, error: "this computer's backend has no facts" },
      { id: null, ok: false, error: "invalid json" },
    ],
  },
};

describe("the replies are what the schemas parse and what the fixture set holds", () => {
  for (const [name, { schema, samples }] of Object.entries(REPLIES)) {
    it(`replies/${name}.json parses and equals its regeneration`, () => {
      for (const sample of samples) {
        const parsed = schema.safeParse(sample);
        expect(parsed.success, `${name} must accept ${JSON.stringify(sample).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      }
      const text = `${JSON.stringify(samples, null, 2)}\n`;
      const regenerated = join(tmpdir(), `wsp-contract-reply-${name}.json`);
      writeFileSync(regenerated, text);
      const path = join(CONTRACT, "replies", `${name}.json`);
      expect(existsSync(path), `daemon/fixtures/contract/replies/${name}.json is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
      expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/replies/${name}.json is behind the protocol. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
    });
  }

  it("names one file per reply and no other", () => {
    expect(readdirSync(join(CONTRACT, "replies")).map(f => f.replace(/\.json$/, "")).sort()).toEqual(Object.keys(REPLIES).sort());
  });
});

describe("the words and numbers are what this package exports", () => {
  for (const [name, regenerate] of [
    ["words.json", words],
    ["numbers.json", numbers],
    // The order a leave walks, which the daemon's own list is held to: the provision folder after the daemon's
    // and wsp's own folder last, so nothing under it is left on a computer the person joined.
    ["place-paths.json", () => placeOwnedPaths(FIXTURE_HOME)],
  ] as const) {
    it(`${name} equals its regeneration`, () => {
      const fresh = regenerate();
      const text = `${JSON.stringify(fresh, null, 2)}\n`;
      const regenerated = join(tmpdir(), `wsp-contract-${name}`);
      writeFileSync(regenerated, text);
      const committed = existsSync(join(CONTRACT, name)) ? (JSON.parse(readFileSync(join(CONTRACT, name), "utf8")) as unknown) : undefined;
      expect(committed, `daemon/fixtures/contract/${name} is behind the protocol. The regenerated file is at ${regenerated}: copy it over daemon/fixtures/contract/${name} and commit it`).toEqual(fresh);
      expect(readFileSync(join(CONTRACT, name), "utf8")).toBe(text);
    });
  }

  it("probe-path.txt equals its regeneration, so what the daemon runs a command through and what the job exports is one list", () => {
    const text = `${probePath(PROBE_HOME)}\n`;
    const regenerated = join(tmpdir(), "wsp-contract-probe-path.txt");
    writeFileSync(regenerated, text);
    const path = join(CONTRACT, "probe-path.txt");
    expect(existsSync(path), `daemon/fixtures/contract/probe-path.txt is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
    expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/probe-path.txt is behind the protocol. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
  });

  it("guest-wsp-shim.sh equals its regeneration, so the word inside a fork and inside a workspace is one text", () => {
    const text = guestWspShim(SHIM_BINARY);
    const regenerated = join(tmpdir(), "wsp-contract-guest-wsp-shim.sh");
    writeFileSync(regenerated, text);
    const path = join(CONTRACT, "guest-wsp-shim.sh");
    expect(existsSync(path), `daemon/fixtures/contract/guest-wsp-shim.sh is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
    expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/guest-wsp-shim.sh is behind the protocol. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
  });

  it("puts every file the daemon inside a machine writes for itself under one folder, by the names a joined computer uses", () => {
    // A workspace on a computer somebody joined has this folder of its own bound over the computer's, so a path
    // that slipped out of it would be written into a /root every workspace there shares: the second workspace's
    // deploy would rewrite the first one's token.
    for (const path of [DAEMON_TOKEN_PATH, GUEST_INBOX_DIR, GUEST_MANIFEST_PATH, OPEN_SOCKET_PATH, DAEMON_ROOTS_PATH, GUEST_DAEMON_SOCKET_PATH]) {
      expect(path.startsWith(`${GUEST_WSP_HOME}/`), path).toBe(true);
    }
    // And they are the names a daemon uses under the home of a computer somebody joined: one daemon, one rule.
    const at = placeDaemonPaths("/root");
    expect({ wsp: at.wsp, token: at.tokenPath, inbox: at.inbox, manifest: at.manifestPath, socket: at.openSocket, roots: at.rootsPath }).toEqual({
      wsp: GUEST_WSP_HOME,
      token: DAEMON_TOKEN_PATH,
      inbox: GUEST_INBOX_DIR,
      manifest: GUEST_MANIFEST_PATH,
      socket: OPEN_SOCKET_PATH,
      roots: DAEMON_ROOTS_PATH,
    });
    // The binary the host deploys is not one of them: it is the host's to land and sits beside the folder.
    expect(GUEST_DAEMON_DIR.startsWith(GUEST_WSP_HOME)).toBe(false);
  });

  it("holds every 4401 reason once, and the listening line names a host and a port", () => {
    const w = words();
    expect(new Set([w["tokenRefused"], w["firstFrameNotAuth"], w["preAuthBytesExceeded"], w["authDeadlinePassed"]]).size).toBe(4);
    expect(w["listening"]).toBe("wsp-daemon listening on {host}:{port}");
    expect(w["unknownOp"]).toBe("unknown op: {op}");
  });
});
