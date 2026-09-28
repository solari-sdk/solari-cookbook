import { describe, expect, it } from "vitest";
import {
  creationAwaits,
  vaultMemberRefusal,
  vaultUnlistedRefusal,
  WORKSPACE_GLYPHS,
  lookWord,
  Recipe,
  RecipeSource,
  Capabilities,
  namesSize,
  PauseMode,
  GoldenVersion,
  DAEMON_ROOTS_PATH,
  MACHINE_LACKS_LINES,
  machineLacking,
  machineLacksLine,
  machineLacksShort,
  NO_LINGER_LINE,
  NO_NODE_LINE,
  NO_SYSTEMD_LINE,
  noImportRoadLine,
  noSshDaemonLine,
  OVER_SSH,
  rootsPathIn,
  sshDaemonPaths,
  DAEMON_VERSION,
  daemonVersionOf,
  DaemonAuthRequest,
  DaemonErrorCode,
  DaemonErrorResponse,
  DaemonEvent,
  DaemonReachView,
  DaemonRequest,
  DaemonResponse,
  EventUnion,
  EventsSubscribeReply,
  FsListReply,
  FsReadReply,
  GitDiffReply,
  GitStatusReply,
  GoldenManifest,
  GoldenStageEvent,
  goldenHead,
  goldenImage,
  HarnessCatalog,
  HostFolderListing,
  contextWindowsFor,
  effortsFor,
  keepsRename,
  mcpServersBlocked,
  noMcpServersLine,
  takesMcpServers,
  markedDefault,
  PortReachView,
  ProjectExportEvent,
  ProjectExportResult,
  ProjectGolden,
  ProjectImportResult,
  ProjectPlan,
  RUNTIME_OPS,
  RuntimeErrorResponse,
  RuntimeRequest,
  RuntimeResponse,
  SESSION_EVENT_TYPES,
  isSessionEvent,
  SessionAccessResult,
  SessionAnswerResult,
  SessionEvent,
  SessionInterruptResult,
  SessionSteerResult,
  SessionStartResult,
  SnapshotLineage,
  SnapshotRollbackResult,
  SessionOrigin,
  THREAD_OPS,
  SessionView,
  ThreadView,
  ExecEvent,
  foldThreads,
  threadState,
  threadStateWord,
  threadWordOf,
  threadsFollowed,
  waitingLine,
  threadRan,
  NOTIFY_ME,
  WorkspaceListing,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
} from "../src/index.js";

import * as wire from "../src/index.js";

import { COPY_CURRENT, COPY_STALE, NETWORK_LOST_LINE, SealedImage as SealedImageSchema, ToolPin, agentOfRow, buildsImages, copyBuildOf, copyBuildingLine, copyIsCurrent, copyStanding, copyStoppedLine, placeWorkspacesParts, recipePins, sealedBuiltLine, sealedCopyLine, type PlaceView, type SealedImage, type SealedImageCopy } from "../src/index.js";

describe("a copy of the image beside the record", () => {
  const image: SealedImage = { name: "default", version: 2, hash: "a".repeat(64), recipeHash: "rh", logins: [], sealedAt: "t", sealedFrom: "h1" };
  const copy = (o: Partial<SealedImageCopy>): SealedImageCopy => ({ place: "solari", version: 1, snapshotId: "s", builtAt: "t", ...o });

  it("is current on the hash alone: each place numbers its own manifest, so the version says nothing about the record", () => {
    // A second place's first copy is its v1 and was built from the record's v2; the hash is what they share.
    expect(copyIsCurrent(image, copy({ version: 1, hash: image.hash }))).toBe(true);
    expect(copyIsCurrent(image, copy({ version: 9, hash: image.hash }))).toBe(true);
    expect(copyIsCurrent(image, copy({ version: 2, hash: "b".repeat(64) }))).toBe(false);
    expect(copyIsCurrent(image, copy({ version: 2 }))).toBe(false);
  });

  it("keeps the pins beside the recipe, one per tick that recorded one in id order with its road, and parses without them as a record sealed before they were read", () => {
    const pins = recipePins({
      ticks: [{ id: "tools/npm/wrangler", version: "4.1.0", road: "npm", installer: "i", pin: { tag: "4.1.0" } }, { id: "agents/codex" }, { id: "tools/catalog/gh", road: "release", installer: "k", pin: { tag: "v2.86.0", sha256: "b".repeat(64) } }, { id: "tools/catalog/tmux", road: "apt", installer: "j", pin: { tag: "3.3a-3", latest: true } }],
    });
    expect(pins).toEqual([
      { id: "tools/catalog/gh", tag: "v2.86.0", sha256: "b".repeat(64), road: "release" },
      { id: "tools/catalog/tmux", tag: "3.3a-3", latest: true, road: "apt" },
      { id: "tools/npm/wrangler", tag: "4.1.0", road: "npm" },
    ]);
    expect(SealedImageSchema.parse({ ...image, pins }).pins).toEqual(pins);
    expect(SealedImageSchema.parse(image).pins).toBeUndefined();
    // A caller's key names the row across computers; the pins sort by that key, so two rows for one tool cannot hide behind their order.
    const keyed = recipePins({ ticks: [{ id: "tools/npm/wrangler", pin: { tag: "4.1.0" } }, { id: "tools/catalog/gh", pin: { tag: "v2.86.0" } }] }, id => id.slice(id.lastIndexOf("/") + 1));
    expect(keyed.map(p => p.id)).toEqual(["gh", "wrangler"]);
    // The one rule for the agents rung: the agent an agents row names, nothing for an MCP server's row or another rung.
    expect(agentOfRow({ id: "agents/codex" })).toBe("codex");
    expect(agentOfRow({ id: "agents/mcp/claude/wsp" })).toBeUndefined();
    expect(agentOfRow({ id: "tools/npm/codex" })).toBeUndefined();
    // The one pin shape: a version, a sum where a road hashed one, the latest mark; a sum alone or a bare object is none.
    expect(ToolPin.parse({ tag: "4.1.0" })).toEqual({ tag: "4.1.0" });
    expect(ToolPin.safeParse({ sha256: "b".repeat(64) }).success).toBe(false);
    expect(ToolPin.safeParse({ tag: "4.1.0", latest: false }).success).toBe(false);
  });

  it("says how it stands in one word, and says nothing where the record holds no vault to judge it by", () => {
    const sealed = { ...image, vault: { sha256: "c".repeat(64), bytes: 10, paths: 2, takenAt: "t" } };
    expect(copyStanding(sealed, copy({ hash: image.hash }))).toBe(COPY_CURRENT);
    expect(copyStanding(sealed, copy({ hash: "b".repeat(64) }))).toBe(COPY_STALE);
    expect(copyStanding(sealed, copy({}))).toBe(COPY_STALE);
    expect(copyStanding(image, copy({ hash: image.hash }))).toBeUndefined();
    // The line a person reads on the command line is the same rule spelled once: what it says is what the word says.
    expect(sealedCopyLine(sealed, copy({ hash: image.hash }))).toBe(`solari  v1  ${COPY_CURRENT}`);
    expect(sealedCopyLine(image, copy({ hash: image.hash }))).toBe("solari  v1");
  });

  it("a build's own line is the copy's, and says when nothing was built", () => {
    const sealed = { ...image, vault: { sha256: "c".repeat(64), bytes: 10, paths: 2, takenAt: "t" } };
    const built = copy({ hash: image.hash });
    expect(sealedBuiltLine(sealed, { copy: built, built: true })).toBe(sealedCopyLine(sealed, built));
    expect(sealedBuiltLine(sealed, { copy: built, built: false })).toBe(`${sealedCopyLine(sealed, built)}  already built from this image; nothing was built`);
  });

  it("a place's row says the stage a copy build there is at in the seal's own words, or why the last one stopped, and that sentence is the row's note while it stands", () => {
    expect(copyBuildingLine("creating")).toBe("copying your image: creating the machine");
    expect(copyBuildingLine("uploading-files")).toBe("copying your image: copying your files");
    expect(copyStoppedLine("no room today")).toBe("the build stopped: no room today");
    expect(copyStoppedLine()).toBe("the build stopped");
    expect(copyStoppedLine("fetch failed")).toBe(`the build stopped: ${NETWORK_LOST_LINE}`);
    const box: PlaceView = { id: "p_1", kind: "computer", name: "box", default: false, takesForks: true, build: copyBuildingLine("creating") };
    expect(placeWorkspacesParts(box, 2)).toEqual({ count: "2", note: copyBuildingLine("creating") });
    const provider: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, takesForks: true, build: copyStoppedLine("no room") };
    expect(placeWorkspacesParts(provider, 1, 0.41)).toEqual({ count: "1", note: copyStoppedLine("no room") });
    expect(placeWorkspacesParts({ ...provider, build: undefined }, 1, 0.41)).toEqual({ count: "1", note: "$0.41 this month" });
  });

  it("one rule reads a build frame as the copy building, stopped or cleared, in the row's own words", () => {
    expect(copyBuildOf({ stage: "installing-tools" })).toEqual({ line: copyBuildingLine("installing-tools"), stopped: false });
    expect(copyBuildOf({ stage: "failed", detail: "no room today" })).toEqual({ line: copyStoppedLine("no room today"), stopped: true });
    expect(copyBuildOf({ stage: "sealed" })).toBeUndefined();
  });

  it("a place builds a copy only where it both forks a machine and copies its disk", () => {
    const size = { cpu: 2, memMb: 4096, rateUsdPerHour: 0.1 };
    expect(buildsImages({ sizes: [size], diskSnapshots: true })).toBe(true);
    // A computer somebody joined: it runs their agents and forks nothing.
    expect(buildsImages({ sizes: [], diskSnapshots: false })).toBe(false);
    // A provider that forks but keeps no disk copy has nothing to seal a version out of.
    expect(buildsImages({ sizes: [size], diskSnapshots: false })).toBe(false);
  });
});

describe("what a computer says about its agents, and what a person reads off it", () => {
  const report = {
    name: "spoo",
    platform: "linux" as const,
    arch: "x64",
    os: "Linux 6.8.0",
    shape: { cpu: 4, memMb: 4096 },
    login: { HOME: "/root", USER: "root", PATH: "/usr/bin" },
    runsWorkspaces: true,
    engine: "none" as const,
    daemonVersion: 54,
    wsp: ["/usr/bin/wsp"],
    agents: ["claude", "codex"],
    dialed: "https://relay.example.com",
  };

  it("a report carries each agent's version line and the files under the logins folder, and no name that walks out of it", () => {
    const said = { ...report, agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" }, logins: ["codex/auth.json"] };
    expect(wire.PlaceReport.parse(said)).toEqual(said);
    // A daemon older than these two fields sends neither, which reads as unknown rather than as none.
    expect(wire.PlaceReport.parse(report).logins).toBeUndefined();
    expect(wire.PlaceReport.safeParse({ ...said, logins: ["../../root/.ssh/id_ed25519"] }).success).toBe(false);
    expect(wire.PlaceReport.safeParse({ ...said, logins: ["/wsp/logins/codex/auth.json"] }).success).toBe(false);
    expect(wire.PlaceReport.safeParse({ ...said, agentVersions: 17 }).success).toBe(false);
    expect(wire.PlaceReport.safeParse({ ...said, agentVersions: { claude: "x".repeat(65) } }).success).toBe(false);
    // The map is keyed by the agents list, so it is under that list's own cap: one rule, and the daemon's own
    // deserialiser holds a report to the same number.
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`a${n}`, "1.0.0"]));
    expect(wire.PlaceReport.safeParse({ ...said, agentVersions: many }).success).toBe(false);
    expect(wire.PlaceReport.safeParse({ ...said, agentVersions: Object.fromEntries(Object.entries(many).slice(0, 32)) }).success).toBe(true);
  });

  it("a computer's row carries those versions and the one word the host worked out per agent", () => {
    const row = { id: "p_1", kind: "computer" as const, name: "spoo", default: false, agents: ["claude", "codex"], agentVersions: { claude: "2.1.270 (Claude Code)" }, signIns: { claude: "vault-key" as const, codex: "none" as const } };
    expect(wire.PlaceView.parse(row)).toEqual(row);
    expect(wire.PlaceView.safeParse({ ...row, signIns: { codex: "maybe" } }).success).toBe(false);
  });

  it("the version is the number an agent printed, whichever way it worded the line", () => {
    expect(wire.agentVersionWord("codex-cli 0.153.0")).toBe("0.153.0");
    expect(wire.agentVersionWord("2.1.270 (Claude Code)")).toBe("2.1.270");
    // Nothing of that shape in the line: the computer's own words stand rather than a guess at a number.
    expect(wire.agentVersionWord(" nightly ")).toBe("nightly");
  });

  it("a version read off a vendor is a whole strict semver under 64 characters or nothing, never lifted out of other words", () => {
    expect(wire.strictVersion(" 2.1.283\n")).toBe("2.1.283");
    expect(wire.strictVersion("v0.96.1")).toBe("0.96.1");
    expect(wire.strictVersion("0.0.1790352060-g26b83c")).toBe("0.0.1790352060-g26b83c");
    for (const bad of ["nginx/1.18.0", "\x1b[31m2.1.283\x07", "<html>moved</html>", "01.2.3", "1.2", `1.0.0-${"a".repeat(60)}`, `${"9".repeat(100)}.0.0`]) expect(wire.strictVersion(bad), bad).toBeUndefined();
  });

  it("the agents cell names each agent, its version and its sign-in, and says nothing for a row that reported none", () => {
    const row = { agents: ["claude", "codex"], agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" }, signIns: { claude: "vault-key" as const, codex: "none" as const } };
    expect(wire.agentsCell(row)).toBe("claude 2.1.270 your key, codex 0.153.0 not signed in");
    expect(wire.agentsCell({ agents: ["codex"], signIns: { codex: "signed-in" } })).toBe("codex signed in");
    expect(wire.agentsCell({})).toBe("");
    expect(wire.agentSignInWord("signed-in")).toBe("signed in");
  });

  it("a key the provider turned down is said as a refused key, with what the provider said about it", () => {
    const login = "codex login --device-auth";
    expect(wire.codexKeyRefusedLine("OPENAI_API_KEY", "invalid_api_key", login)).toBe(
      `OpenAI refused your OPENAI_API_KEY: invalid_api_key. Put a working key in ~/.wsp/.env, or sign Codex in where this workspace runs with ${login}.`,
    );
    // A refusal the provider said nothing after drops the clause rather than reading as a colon with nothing behind it.
    expect(wire.codexKeyRefusedLine("OPENAI_API_KEY", "", login)).toBe(
      `OpenAI refused your OPENAI_API_KEY. Put a working key in ~/.wsp/.env, or sign Codex in where this workspace runs with ${login}.`,
    );
    // The provider's reason is a clause in somebody else's sentence, so it is cut before it becomes a paragraph.
    expect(wire.codexKeyRefusedLine("OPENAI_API_KEY", "x".repeat(200), login)).toContain(`: ${"x".repeat(80)}.`);
  });
});

describe("the recipe's pins", () => {
  it("a recipe row and a digest tick carry one pin shape, the version with the sum where a road hashed one, beside the tick's road and install lines", () => {
    const pin = { tag: "v2.86.0", sha256: "b".repeat(64) };
    expect(wire.ToolPin.parse(pin)).toEqual(pin);
    expect(wire.ToolPin.parse({ tag: "4.1.0" })).toEqual({ tag: "4.1.0" });
    expect(wire.ToolPin.safeParse({ sha256: "b".repeat(64) }).success).toBe(false);
    const row = { id: "gh", kind: "tool", on: true, source: { kind: "popular", sessions: 1, images: 1 }, pin };
    expect(wire.RecipeRow.parse(row)).toEqual(row);
    const tick = { id: "tools/catalog/gh", road: "release", installer: "a".repeat(64), pin };
    expect(wire.RecipeDigest.parse({ ticks: [tick, { id: "agents/claude" }], files: [] })).toEqual({ ticks: [tick, { id: "agents/claude" }], files: [] });
  });
});

describe("protocol views", () => {
  it("parses a WorkspaceView and rejects a bad phase", () => {
    const ws = {
      id: "ws_1",
      name: "task-1",
      machineId: "m1",
      phase: "running",
      golden: "snap_g",
      createdAt: "2026-09-01T00:00:00.000Z",
      project: { id: "pr_1a2b3c4d", name: "task-1", path: "/root/task-1", computer: "here" },
    };
    expect(WorkspaceView.parse(ws)).toEqual(ws);
    expect(() => WorkspaceView.parse({ ...ws, phase: "hibernating" })).toThrow();
  });

  it("parses a SessionView", () => {
    const s = {
      id: "0b6a9c1e-0000-4000-8000-000000000000",
      workspaceId: "ws_1",
      harness: "claude",
      status: "running",
    };
    expect(SessionView.parse(s)).toEqual(s);
    expect(() => SessionView.parse({ ...s, status: "done" })).toThrow();
  });

  it("WorkspaceView and WorkspaceStatus carry the desktop stream as screen.streamUrl, absent for headless machines", () => {
    const view = {
      id: "ws_1",
      name: "task-1",
      machineId: "m1",
      phase: "running",
      golden: "snap_g",
      createdAt: "2026-09-01T00:00:00.000Z",
      project: { id: "pr_1a2b3c4d", name: "task-1", path: "/root/task-1", computer: "here" },
      screen: { streamUrl: "wss://stream.example/m1" },
    };
    expect(WorkspaceView.parse(view)).toEqual(view);
    expect(WorkspaceView.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
    const { screen, ...headless } = view;
    void screen;
    expect(WorkspaceView.parse(headless)).toEqual(headless);
    expect(() => WorkspaceView.parse({ ...view, screen: {} })).toThrow();

    const status = { ...view, machineState: "running", reach: { state: "unsupported" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
    expect(WorkspaceStatus.parse(status)).toEqual(status);
  });

  it("the listing every command line and tool reads carries what the machine said it is, and still no route to it", () => {
    const facts = { os: "Ubuntu 24.04.3 LTS", uptimeMs: 90_061_000, folder: "/home/dev" };
    const status = {
      id: "ws_1",
      name: "box",
      machineId: "ssh://dev@box:22",
      phase: "running",
      golden: "",
      createdAt: "2026-09-11T00:00:00.000Z",
      project: { id: "pr_1a2b3c4d", name: "box", path: "/home/dev/box", computer: "pl_box" },
      kind: "ssh",
      machineState: "running",
      reach: { state: "reachable", url: "http://127.0.0.1:40000", expiresAt: 1789041249000 },
      size: { cpu: 8, memMb: 16384 },
      rateUsdPerHour: 0,
      facts,
    };
    const listed = WorkspaceListing.parse(status);
    // The three the Machine pane draws, so a person at a terminal or an agent through the tools reads the same ones.
    expect(listed.facts).toEqual(facts);
    // What the pick is for: the reach's state without the route the app dials, and nothing minted riding out.
    expect(listed.reach).toEqual({ state: "reachable" });
    // A machine that has not said what it is leaves the field off rather than carrying an empty one.
    const { facts: said, ...quiet } = status;
    void said;
    expect(WorkspaceListing.parse(quiet).facts).toBeUndefined();
  });
});

describe("a workspace's look", () => {
  const view = { id: "ws_1", name: "task-1", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00.000Z", project: { id: "pr_1a2b3c4d", name: "task-1", path: "/root/task-1", computer: "here" } };
  const theme = { dots: [{ angle: 200, radius: 0.5 }, { angle: 20, radius: 0.5 }], harmony: "complementary", grain: 0.25, opacity: 0.6, mode: "auto" };

  it("about two dozen glyphs, each one word so its name needs no second table, and none of them an emoji", () => {
    expect(WORKSPACE_GLYPHS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(WORKSPACE_GLYPHS).size).toBe(WORKSPACE_GLYPHS.length);
    for (const glyph of WORKSPACE_GLYPHS) expect(glyph).toMatch(/^[a-z]+$/);
    expect(lookWord("terminal")).toBe("Terminal");
  });

  it("the view carries the theme and the glyph, absent is none, and a theme outside the shape is refused", () => {
    expect(WorkspaceView.parse(view)).toEqual(view);
    const looked = { ...view, theme, glyph: "flask" };
    expect(WorkspaceView.parse(looked)).toEqual(looked);
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, dots: [] } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, dots: [...theme.dots, ...theme.dots] } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, opacity: 0 } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, grain: 2 } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, mode: "sepia" } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, tint: "cyan" })).not.toThrow();
    expect(WorkspaceView.parse({ ...view, tint: "cyan" })).toEqual(view);
    expect(() => WorkspaceView.parse({ ...view, glyph: "🚀" })).toThrow();
  });

  it("the op takes one fact at a time, null to clear it, and refuses a theme outside the shape", () => {
    for (const req of [
      { id: 1, op: "workspaces.look", workspaceId: "ws_1", theme },
      { id: 2, op: "workspaces.look", workspaceId: "ws_1", glyph: null },
      { id: 3, op: "workspaces.look", workspaceId: "ws_1", theme: null, glyph: "rocket" },
      { id: 4, op: "workspaces.look", workspaceId: "ws_1" },
    ]) {
      expect(RuntimeRequest.parse(req)).toEqual(req);
    }
    expect(() => RuntimeRequest.parse({ id: 5, op: "workspaces.look", workspaceId: "ws_1", theme: "red" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 6, op: "workspaces.look", theme })).toThrow();
  });

  it("the event carries both facts whole, so a cleared one reads null rather than going missing", () => {
    const e = { type: "workspace.look", workspaceId: "ws_1", theme, glyph: null };
    expect(EventUnion.parse(e)).toEqual(e);
    expect(() => EventUnion.parse({ type: "workspace.look", workspaceId: "ws_1", theme })).toThrow();
  });
});

describe("protocol event union", () => {
  it("covers workspace.*, session.* (mirroring AdapterEvent), port.*, inbox.*", () => {
    const samples = [
      {
        type: "workspace.created",
        workspace: {
          id: "ws_1",
          name: "x",
          machineId: "m1",
          phase: "running",
          golden: "snap_g",
          createdAt: "2026-09-01T00:00:00.000Z",
          project: { id: "pr_1a2b3c4d", name: "task-1", path: "/root/task-1", computer: "here" },
        },
      },
      { type: "workspace.napped", workspaceId: "ws_1" },
      { type: "workspace.woken", workspaceId: "ws_1", machineId: "m2", resurrected: true },
      { type: "workspace.upgraded", workspaceId: "ws_1", machineId: "m3" },
      { type: "workspace.deleted", workspaceId: "ws_1" },
      { type: "session.start", workspaceId: "ws_1", sessionId: "s1", model: "claude-sonnet-4-5" },
      { type: "session.delta", workspaceId: "ws_1", sessionId: "s1", kind: "text", text: "hi" },
      {
        type: "session.delta",
        workspaceId: "ws_1",
        sessionId: "s1",
        kind: "tool_use",
        text: "{}",
        toolName: "Bash",
        toolUseId: "tu_1",
      },
      {
        type: "session.done",
        workspaceId: "ws_1",
        sessionId: "s1",
        result: { status: "completed", durationMs: 1200, costUsd: 0.01, text: "ok" },
      },
      { type: "session.end", workspaceId: "ws_1", sessionId: "s1", exitCode: 0, sawResult: true },
      { type: "port.open", workspaceId: "ws_1", port: 8080, pid: 123 },
      { type: "port.close", workspaceId: "ws_1", port: 8080 },
      { type: "inbox.file", workspaceId: "ws_1", path: "/root/.wsp/inbox/a.png", bytes: 168 },
    ];
    for (const s of samples) expect(EventUnion.parse(s)).toEqual(s);
    expect(() => EventUnion.parse({ type: "workspace.exploded" })).toThrow();
    // session.start may carry the prompt so a replayed transcript shows the user's turn
    const started = { type: "session.start", workspaceId: "ws_1", sessionId: "s1", prompt: "fix the flaky test" };
    expect(EventUnion.parse(started)).toEqual(started);
    expect(SessionEvent.parse(started)).toEqual(started);
    expect(() => SessionEvent.parse({ type: "workspace.napped", workspaceId: "ws_1" })).toThrow();
    // session.end with a null exit code (kill path) is valid
    expect(
      EventUnion.parse({ type: "session.end", workspaceId: "w", sessionId: "s", exitCode: null, sawResult: false }),
    ).toBeTruthy();
  });

  it("session.steer is a session event: the message the person sent into a running turn, with the turn's scope and the send's request id", () => {
    const steered = { type: "session.steer", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0001", threadId: "thread_0001", at: 1756687889412, prompt: "and say pineapple", requestId: "req_7" };
    expect(SessionEvent.parse(steered)).toEqual(steered);
    expect(EventUnion.parse(JSON.parse(JSON.stringify(steered)))).toEqual(steered);
    expect(EventUnion.parse({ ...steered, seq: 9 })).toEqual({ ...steered, seq: 9 });
    const { requestId: _r, ...plain } = steered;
    expect(SessionEvent.parse(plain)).toEqual(plain);
    expect(() => SessionEvent.parse({ ...steered, prompt: undefined })).toThrow();
    expect(() => SessionEvent.parse({ ...steered, prompt: 7 })).toThrow();
  });
});

describe("a create's stage lines on the wire", () => {
  const stage = { type: "workspace.creating", workspaceId: "ws_1", name: "clone-test", stage: "hostname-set", elapsedMs: 4_100 } as const;

  it("a step's own detail rides the event beside its message, and is not a notice", () => {
    const said = { ...stage, message: "hostname not set; the workspace keeps the machine's own name", detail: "hostname clone-test on fk_0b77 failed: hostname: sethostname: Operation not permitted" };
    expect(EventUnion.parse(said)).toEqual(said);
    expect(EventUnion.parse({ ...stage, message: "ready" })).toEqual({ ...stage, message: "ready" });
    expect(() => EventUnion.parse({ ...stage, message: "ready", detail: 7 })).toThrow();
  });

  it("the hostname's verdict is a note on a step taken; every other line is the step the create waits on", () => {
    expect(creationAwaits("hostname-set")).toBe(false);
    for (const word of ["fork-requested", "preview-route", "daemon-answering", "ready", "failed", "image"]) {
      expect(creationAwaits(word)).toBe(true);
    }
  });
});

describe("a relayed permission prompt on the wire", () => {
  const ask = {
    type: "session.permission",
    workspaceId: "ws_1",
    sessionId: "s1",
    turnId: "turn_0001",
    threadId: "thread_0001",
    at: 1757320000000,
    askId: "d9aa99d3-be4e-4a2b-8766-1b9494cde4f6",
    toolName: "Write",
    toolUseId: "toolu_1",
    input: '{"file_path":"/root/out.txt","content":"hi"}',
    detail: "out.txt",
    options: [
      { id: "allow", label: "Allow", effect: "allow" },
      { id: "deny", label: "Deny", effect: "deny" },
      { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode", mode: "acceptEdits" },
    ],
  };
  const closed = { type: "session.permission.closed", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0001", threadId: "thread_0001", at: 1757320005000, askId: ask.askId, outcome: "allowed", optionId: "allow" };

  it("both halves are session events, so a transcript replays a prompt and how it closed", () => {
    for (const e of [ask, closed]) {
      expect(SessionEvent.parse(e)).toEqual(e);
      expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
      expect(EventUnion.parse({ ...e, seq: 12 })).toEqual({ ...e, seq: 12 });
    }
    // Every session type is read off the union, so an added event is never missed by a client's own list.
    expect([...SESSION_EVENT_TYPES]).toContain("session.permission");
    expect([...SESSION_EVENT_TYPES]).toContain("session.permission.closed");
    expect(SESSION_EVENT_TYPES.has("session.queued" as never)).toBe(false);
    // The one predicate every reader that folds a thread's events out of the whole channel makes.
    expect(isSessionEvent(ask)).toBe(true);
    expect(isSessionEvent({ type: "workspace.napped" })).toBe(false);
  });

  it("a prompt with nothing the harness did not name still parses, and one missing what it must name does not", () => {
    const { detail: _d, toolUseId: _t, ...bare } = ask;
    expect(SessionEvent.parse(bare)).toEqual(bare);
    for (const key of ["askId", "toolName", "input", "options"] as const) {
      expect(() => SessionEvent.parse({ ...ask, [key]: undefined })).toThrow();
    }
    expect(() => SessionEvent.parse({ ...ask, options: [{ id: "allow", label: "Allow", effect: "maybe" }] })).toThrow();
  });

  it("a close names its outcome from the four, and the option only where one closed it", () => {
    for (const outcome of ["allowed", "denied", "unanswered", "cancelled"]) expect(SessionEvent.parse({ ...closed, outcome })).toMatchObject({ outcome });
    expect(() => SessionEvent.parse({ ...closed, outcome: "timedout" })).toThrow();
    const { optionId: _o, ...noOption } = closed;
    expect(SessionEvent.parse(noOption)).toEqual(noOption);
    expect(() => SessionEvent.parse({ ...closed, askId: undefined })).toThrow();
  });

  it("the answer op and its outcomes are on the wire, so a client can name an option and read what came of it", () => {
    const req = { id: 31, op: "sessions.answer", sessionId: "s1", askId: ask.askId, optionId: "allow" };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ ...req, askId: undefined })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, optionId: undefined })).toThrow();
    for (const outcome of ["answered", "gone", "unsupported", "not-found", "no-option"]) {
      expect(SessionAnswerResult.parse({ outcome })).toEqual({ outcome });
    }
    expect(() => SessionAnswerResult.parse({ outcome: "denied" })).toThrow();
  });

  it("the access op and its outcomes are on the wire, so a pick made mid-turn can be sent and its answer read", () => {
    const req = { id: 32, op: "sessions.access", sessionId: "s1", permissionMode: "bypassPermissions" };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ ...req, permissionMode: undefined })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, sessionId: undefined })).toThrow();
    for (const outcome of ["set", "not-running", "unsupported", "not-found"]) {
      expect(SessionAccessResult.parse({ outcome })).toEqual({ outcome });
    }
    expect(() => SessionAccessResult.parse({ outcome: "refused" })).toThrow();
  });
});

describe("session.queued", () => {
  it("is a pushed event, not a session event: a start waiting behind the thread's running turn, with the send's request id, never in history", () => {
    const queued = { type: "session.queued", workspaceId: "ws_1", threadId: "thread_0001", prompt: "and then this", requestId: "req_8" };
    expect(EventUnion.parse(queued)).toEqual(queued);
    expect(EventUnion.parse({ ...queued, seq: 4 })).toEqual({ ...queued, seq: 4 });
    const { requestId: _r, ...plain } = queued;
    expect(EventUnion.parse(plain)).toEqual(plain);
    expect(() => EventUnion.parse({ ...queued, prompt: undefined })).toThrow();
    expect(() => EventUnion.parse({ ...queued, threadId: undefined })).toThrow();
    expect(() => SessionEvent.parse(queued)).toThrow();
  });
});

describe("session wire fields the face reads", () => {
  it("every session event may carry at (ms epoch) and turnId; both survive a JSON round trip", () => {
    const scope = { workspaceId: "ws_1", sessionId: "s1", at: 1756687889412, turnId: "turn_0001" };
    const events = [
      { type: "session.start", ...scope, prompt: "hello" },
      { type: "session.delta", ...scope, kind: "text", text: "hi" },
      { type: "session.done", ...scope, result: { status: "completed" } },
      { type: "session.end", ...scope, exitCode: 0, sawResult: true },
    ];
    for (const e of events) {
      expect(SessionEvent.parse(e)).toEqual(e);
      expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
    }
    expect(() => SessionEvent.parse({ ...events[0], at: "2026-09-01T00:00:00Z" })).toThrow();
    expect(() => SessionEvent.parse({ ...events[0], turnId: 7 })).toThrow();
  });

  it("every session event may carry a threadId; a transcript without one still parses", () => {
    const scope = { workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0001", threadId: "thread_0001" };
    const events = [
      { type: "session.start", ...scope, prompt: "hello" },
      { type: "session.delta", ...scope, kind: "text", text: "hi" },
      { type: "session.done", ...scope, result: { status: "completed" } },
      { type: "session.end", ...scope, exitCode: 0, sawResult: true },
    ];
    for (const e of events) {
      expect(SessionEvent.parse(e)).toEqual(e);
      expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
      const { threadId: _threadId, ...before } = e;
      expect(SessionEvent.parse(before)).toEqual(before);
    }
    expect(() => SessionEvent.parse({ ...events[0], threadId: 7 })).toThrow();
  });

  it("session.start carries the harness catalog from system/init", () => {
    const started = {
      type: "session.start",
      workspaceId: "ws_1",
      sessionId: "s1",
      harness: { slashCommands: ["compact", "review"], permissionMode: "bypassPermissions", agents: ["general-purpose"] },
    };
    expect(SessionEvent.parse(started)).toEqual(started);
    const partial = { ...started, harness: { permissionMode: "default" } };
    expect(SessionEvent.parse(partial)).toEqual(partial);
    expect(() => SessionEvent.parse({ ...started, harness: { slashCommands: "compact" } })).toThrow();
  });

  it("session.start may say the thread's previous turn was cut, and only as true: the fact is stated or absent", () => {
    const started = { type: "session.start", workspaceId: "ws_1", sessionId: "s1", afterCut: true };
    expect(SessionEvent.parse(started)).toEqual(started);
    expect(() => SessionEvent.parse({ ...started, afterCut: false })).toThrow();
  });

  it("SessionView carries prompt, startedAt and endedAt so the sidebar can title and sort threads", () => {
    const running = {
      id: "0b6a9c1e-0000-4000-8000-000000000000",
      workspaceId: "ws_1",
      harness: "claude",
      status: "running",
      prompt: "fix the flaky test",
      startedAt: 1756687889412,
    };
    expect(SessionView.parse(running)).toEqual(running);
    const ended = { ...running, status: "completed", endedAt: 1756687899870 };
    expect(SessionView.parse(ended)).toEqual(ended);
    expect(() => SessionView.parse({ ...running, startedAt: "soon" })).toThrow();
  });

  it("port.open names the listening process on both the daemon and runtime wires", () => {
    const daemonSide = { type: "port.open", port: 8080, pid: 123, process: "node" };
    expect(DaemonEvent.parse(daemonSide)).toEqual(daemonSide);
    const runtimeSide = { ...daemonSide, workspaceId: "ws_1" };
    expect(EventUnion.parse(runtimeSide)).toEqual(runtimeSide);
    expect(() => DaemonEvent.parse({ ...daemonSide, process: 1 })).toThrow();
  });

  it("port.close may say who held the port, whether it exited and when, on both wires", () => {
    const daemonSide = { type: "port.close", port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: "2026-09-05T12:04:00.000Z" };
    expect(DaemonEvent.parse(daemonSide)).toEqual(daemonSide);
    const runtimeSide = { ...daemonSide, workspaceId: "ws_1" };
    expect(EventUnion.parse(runtimeSide)).toEqual(runtimeSide);
    expect(DaemonEvent.parse({ type: "port.close", port: 8412 })).toEqual({ type: "port.close", port: 8412 });
    expect(() => DaemonEvent.parse({ ...daemonSide, exited: "yes" })).toThrow();
  });
});

describe("event replay wire fields", () => {
  it("every event may carry seq, a positive integer that survives a JSON round trip; history events need not", () => {
    const events = [
      { type: "workspace.napped", workspaceId: "ws_1", seq: 1 },
      { type: "workspace.status", status: { id: "ws_1", name: "x", machineId: "m1", phase: "running", golden: "g", createdAt: "t", project: { id: "pr_1a2b3c4d", name: "x", path: "/root/x", computer: "here" }, machineState: "running", reach: { state: "unsupported" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.1 }, seq: 2 },
      { type: "session.delta", workspaceId: "ws_1", sessionId: "s1", kind: "text", text: "hi", seq: 3 },
      { type: "port.open", workspaceId: "ws_1", port: 8080, seq: 4 },
      { type: "golden.stage", name: "default", stage: "ready", seq: 5 },
    ];
    for (const e of events) expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
    const { seq, ...unstamped } = events[0]!;
    void seq;
    expect(EventUnion.parse(unstamped)).toEqual(unstamped);
    expect(() => EventUnion.parse({ ...events[0], seq: 0 })).toThrow();
    expect(() => EventUnion.parse({ ...events[0], seq: 1.5 })).toThrow();
    expect(() => EventUnion.parse({ ...events[0], seq: "1" })).toThrow();
    const history = { type: "session.delta", workspaceId: "ws_1", sessionId: "s1", kind: "text", text: "hi" };
    expect(SessionEvent.parse(history)).toEqual(history);
  });

  it("events.subscribe takes an optional after cursor, a non-negative integer", () => {
    const bare = { id: 1, op: "events.subscribe" };
    const cursor = { id: 2, op: "events.subscribe", after: 41 };
    const start = { id: 3, op: "events.subscribe", after: 0 };
    const resumed = { id: 4, op: "events.subscribe", after: 41, stream: "0b6a9c1e-0000-4000-8000-000000000000" };
    for (const r of [bare, cursor, start, resumed]) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(() => RuntimeRequest.parse({ ...bare, stream: 7 })).toThrow();
    expect(() => RuntimeRequest.parse({ ...bare, after: -1 })).toThrow();
    expect(() => RuntimeRequest.parse({ ...bare, after: 2.5 })).toThrow();
    expect(() => RuntimeRequest.parse({ ...bare, after: "41" })).toThrow();
  });

  it("the subscribe reply names the runtime's head and stream and, when the cursor is gone, gap", () => {
    expect(EventsSubscribeReply.parse({ seq: 0 })).toEqual({ seq: 0 });
    const stamped = { seq: 5002, gap: true, stream: "0b6a9c1e-0000-4000-8000-000000000000" };
    expect(EventsSubscribeReply.parse(JSON.parse(JSON.stringify(stamped)))).toEqual(stamped);
    expect(() => EventsSubscribeReply.parse({ seq: 1, stream: 7 })).toThrow();
    expect(() => EventsSubscribeReply.parse({ seq: 5002, gap: false })).toThrow();
    expect(() => EventsSubscribeReply.parse({ gap: true })).toThrow();
    expect(RuntimeResponse.parse({ id: 1, ok: true, seq: 7, gap: true })).toBeTruthy();
  });
});

describe("daemon wire types (one home for the ops the daemon answers)", () => {
  it("parses requests, responses, and push events", () => {
    const reqs = [
      { id: 1, op: "pty.create", cols: 80, rows: 24, shell: "bash" },
      { id: 2, op: "pty.attach", ptyId: "p1" },
      { id: 3, op: "pty.write", ptyId: "p1", data: "ls\n" },
      { id: 4, op: "pty.resize", ptyId: "p1", cols: 100, rows: 30 },
      { id: 5, op: "pty.kill", ptyId: "p1" },
      { id: 6, op: "pty.list" },
      { id: 7, op: "ports.watch" },
      { id: 8, op: "manifest.get" },
      { id: 9, op: "manifest.record", cmd: "pnpm dev", cwd: "/root/app", port: 3000 },
      { id: 10, op: "manifest.restartScript" },
      { id: 11, op: "inbox.watch" },
      { id: 12, op: "inbox.rescan" },
      { id: 13, op: "ping" },
    ];
    for (const r of reqs) expect(DaemonRequest.parse(r)).toEqual(r);
    expect(() => DaemonRequest.parse({ id: 1, op: "pty.explode" })).toThrow();

    expect(DaemonResponse.parse({ id: 1, ok: true, ptyId: "p1", pid: 42 })).toBeTruthy();
    expect(DaemonResponse.parse({ id: 1, ok: false, error: "no such pty" })).toBeTruthy();

    const events = [
      { type: "daemon.hello", root: "/root" },
      { type: "pty.data", ptyId: "p1", data: "hello" },
      { type: "pty.exit", ptyId: "p1", exitCode: 0, signal: undefined },
      { type: "port.open", port: 8080, pid: 12 },
      { type: "port.close", port: 8080 },
      { type: "inbox.file", path: "/root/.wsp/inbox/x.png", bytes: 10 },
    ];
    for (const e of events) expect(DaemonEvent.parse(e)).toBeTruthy();
    expect(() => DaemonEvent.parse({ type: "daemon.hello" })).toThrow();
  });

  it("the hello carries the daemon's version; one without is the first version, as every daemon deployed before the field", () => {
    expect(DAEMON_VERSION).toBeGreaterThanOrEqual(2);
    const current = DaemonEvent.parse({ type: "daemon.hello", root: "/root", version: DAEMON_VERSION });
    expect(current).toEqual({ type: "daemon.hello", root: "/root", version: DAEMON_VERSION });
    expect(daemonVersionOf(current as { version?: number })).toBe(DAEMON_VERSION);
    expect(daemonVersionOf(DaemonEvent.parse({ type: "daemon.hello", root: "/root" }) as { version?: number })).toBe(1);
    expect(() => DaemonEvent.parse({ type: "daemon.hello", root: "/root", version: "2" })).toThrow();
    // No client asks for a daemon update: the runtime reads the hello on its own connect and replaces an old daemon itself.
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.updateDaemon", workspaceId: "ws_a" })).toThrow();
  });
});

describe("backend capabilities", () => {
  it("requires every flag, callbackRelay, templates, diskSnapshots, images, snapshotsAnyLife, replacesMachine, kept, copies, ownNetwork and the sizes list included, so no backend can leave one unstated", () => {
    const full = { liveCloneForks: true, pauseMode: "memory", replacesMachine: true, previewUrls: true, signedUrls: true, callbackRelay: true, diskSnapshots: true, images: true, snapshotsAnyLife: false, snapshotListing: true, templates: true, kept: false, copies: true, ownNetwork: true, sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }] };
    expect(Capabilities.parse(full)).toEqual(full);
    const { templates: _t, ...noTemplates } = full;
    expect(() => Capabilities.parse(noTemplates)).toThrow();
    const { callbackRelay: _r, ...noRelay } = full;
    expect(() => Capabilities.parse(noRelay)).toThrow();
    // A backend that never says whether its machine's disk can be copied would have the snapshot verb guessing.
    const { diskSnapshots: _d, ...noDiskSnapshots } = full;
    expect(() => Capabilities.parse(noDiskSnapshots)).toThrow();
    // And one that never says whether it keeps an image at all would have the fork road reading three flags to
    // learn it: a computer somebody joined keeps none, and a fork there names no image and builds no golden.
    const { images: _i, ...noImages } = full;
    expect(() => Capabilities.parse(noImages)).toThrow();
    expect(Capabilities.parse({ ...full, images: false }).images).toBe(false);
    // And one that never says which life the copy may be taken from would have the golden road guessing whether a
    // builder that woke still has a seal in it.
    const { snapshotsAnyLife: _a, ...noAnyLife } = full;
    expect(() => Capabilities.parse(noAnyLife)).toThrow();
    // And one that never says whether a fresh machine may stand in for another leaves the rebuild and the image move guessing.
    const { replacesMachine: _m, ...noReplace } = full;
    expect(() => Capabilities.parse(noReplace)).toThrow();
    // A backend that never says whether its machine is the person's own would have every turn's access decided for it.
    const { kept: _k, ...noKept } = full;
    expect(() => Capabilities.parse(noKept)).toThrow();
    // A backend that never says whether it makes a workspace by copying itself leaves a second piece of work on
    // one project with no road, and one that never says whether a copy gets a network of its own leaves the port
    // base and the row's ports cell guessing.
    const { copies: _c, ...noCopies } = full;
    expect(() => Capabilities.parse(noCopies)).toThrow();
    const { ownNetwork: _n, ...noNetwork } = full;
    expect(() => Capabilities.parse(noNetwork)).toThrow();
    const { sizes: _s, ...noSizes } = full;
    expect(() => Capabilities.parse(noSizes)).toThrow();
    expect(() => Capabilities.parse({ ...full, sizes: [{ cpu: 2, memMb: 4096 }] })).toThrow();
  });

  it("whether a request names a size has one home, so the create's gate reads no copy of the rule", () => {
    // Either half names one; a create naming neither takes the size its golden was sealed at.
    expect([namesSize({ cpu: 4 }), namesSize({ memMb: 8192 }), namesSize({ cpu: 4, memMb: 8192 })]).toEqual([true, true, true]);
    expect([namesSize({}), namesSize(undefined), namesSize({ envs: { A: "1" } } as Partial<WorkspaceSize>)]).toEqual([false, false, false]);
  });

  it("pauseMode is optional and one of memory or disk; a boolean is refused", () => {
    const full = { liveCloneForks: true, replacesMachine: true, previewUrls: true, signedUrls: true, callbackRelay: true, diskSnapshots: true, images: true, snapshotsAnyLife: false, snapshotListing: true, templates: true, kept: false, copies: true, ownNetwork: true, sizes: [] };
    // Absent is a machine that cannot be paused: this computer, a machine reached over ssh.
    expect(Capabilities.parse(full)).toEqual(full);
    expect(Capabilities.parse({ ...full, pauseMode: "memory" })).toMatchObject({ pauseMode: "memory" });
    expect(Capabilities.parse({ ...full, pauseMode: "disk" })).toMatchObject({ pauseMode: "disk" });
    expect(PauseMode.options).toEqual(["memory", "disk"]);
    // The old boolean said two things at once; a backend still declaring it is refused rather than read as a mode.
    expect(() => Capabilities.parse({ ...full, pauseMode: true })).toThrow();
    expect(() => Capabilities.parse({ ...full, pauseMode: "frozen" })).toThrow();
  });
});

describe("runtime wire types", () => {
  it("parses the client ops serveRuntime dispatches", () => {
    const reqs = [
      { id: 1, op: "auth", token: "t" },
      { id: 2, op: "ticket.issue", purpose: "connect" },
      { id: 3, op: "events.subscribe" },
      { id: 4, op: "workspaces.create", project: "spoo-landing", golden: "snap_g", name: "x", cpu: 2 },
      { id: 4.5, op: "projects.add", source: "/Users/dev/wsp" },
      { id: 5, op: "workspaces.list" },
      { id: 6, op: "workspaces.get", workspaceId: "ws_1" },
      { id: 7, op: "workspaces.nap", workspaceId: "ws_1" },
      { id: 8, op: "workspaces.wake", workspaceId: "ws_1" },
      { id: 9, op: "workspaces.upgrade", workspaceId: "ws_1" },
      { id: 10, op: "workspaces.delete", workspaceId: "ws_1" },
      { id: 11, op: "sessions.start", workspaceId: "ws_1", prompt: "do the thing" },
      { id: 12, op: "sessions.list" },
      { id: 13, op: "golden.get", name: "default" },
      { id: 14, op: "capabilities.get" },
      { id: 15, op: "sessions.history", workspaceId: "ws_1" },
      { id: 16, op: "daemon.open", workspaceId: "ws_1" },
      { id: 17, op: "golden.prepare", name: "default" },
      { id: 18, op: "golden.prepare", name: "default", kind: "desktop" },
      { id: 19, op: "golden.seal", builderId: "m1" },
      { id: 20, op: "daemon.send", channel: "ch_1", frame: { op: "pty.write", ptyId: "p1", data: "ls\r" } },
      { id: 21, op: "sessions.interrupt", sessionId: "s1" },
      { id: 22, op: "workspaces.forget", workspaceId: "ws_1" },
      { id: 23, op: "workspaces.stopWake", workspaceId: "ws_1" },
      { id: 24, op: "daemon.close", channel: "ch_1" },
    ];
    for (const r of reqs) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(() => RuntimeRequest.parse({ id: 21, op: "sessions.interrupt" })).toThrow(); // sessionId required
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.create" })).toThrow(); // project+name required
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.create", name: "x" })).toThrow(); // a workspace is a project's
    // The image is the project's computer's own head unless a project image is named outright.
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.create", project: "spoo-landing", name: "x" })).not.toHaveProperty("golden");
    // The two roads that recorded a workspace of their own leave with the projects recut: this computer is a
    // project recorded with wsp add, and a machine somebody owns is a computer their projects are cloned onto.
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.createLocal" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.createSsh", address: "dev@box" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.prepare", name: "d", kind: "browser" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.seal" })).toThrow(); // builderId required
    // The two roads that handed a daemon token out leave the wire with the relay: nothing outside the host dials a daemon.
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.daemonReach", workspaceId: "ws_1" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.builderReach", builderId: "m1" })).toThrow();
    expect(RUNTIME_OPS).not.toContain("workspaces.daemonReach");
    expect(RUNTIME_OPS).not.toContain("golden.builderReach");
    expect(RuntimeResponse.parse({ id: 4, ok: true, workspace: { id: "w" } })).toBeTruthy();
    expect(RuntimeResponse.parse({ id: 4, ok: false, error: "nope" })).toBeTruthy();
  });

  it("every request carries where it reached the host from, on the envelope and not per op", () => {
    const relayed = [
      { id: 1, op: "workspaces.list", origin: "relayed" },
      { id: 2, op: "workspaces.nap", workspaceId: "ws_1", origin: "relayed" },
      { id: 3, op: "sessions.start", workspaceId: "ws_1", prompt: "go", origin: "relayed" },
      { id: 4, op: "workspaces.exec", workspaceId: "ws_1", argv: ["ls"], origin: "here" },
    ];
    for (const r of relayed) expect(RuntimeRequest.parse(r)).toEqual(r);
    // A client on this computer names none, and nothing is added to what it sent.
    expect(RuntimeRequest.parse({ id: 5, op: "workspaces.list" })).toEqual({ id: 5, op: "workspaces.list" });
    expect(() => RuntimeRequest.parse({ id: 6, op: "workspaces.list", origin: "machine" })).toThrow();
  });

  it("the daemon channel ops carry a frame the host never authenticates for the page, and the panes' ops are not a thread's", () => {
    const frame = { op: "fs.list", path: "/root", gitignore: true };
    expect(wire.DaemonFrame.parse(frame)).toEqual(frame);
    // The host sent the auth frame when it opened the channel; a page that could send one would pick the socket's identity.
    expect(() => wire.DaemonFrame.parse({ op: "auth", token: "t" })).toThrow();
    expect(() => wire.DaemonFrame.parse({ ptyId: "p1" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "daemon.send", channel: "ch_1", frame: { op: "auth", token: "t" } })).toThrow();
    // A channel is one daemon's, and which one is the caller's to say: a workspace of this host's, or a computer
    // the person owns. Naming both, or neither, is refused by the runtime in one sentence rather than by the shape,
    // which carries the two roads as one op.
    expect(RuntimeRequest.parse({ id: 1, op: "daemon.open", workspaceId: "w_1" })).toMatchObject({ workspaceId: "w_1" });
    expect(RuntimeRequest.parse({ id: 1, op: "daemon.open", placeId: "p_1" })).toMatchObject({ placeId: "p_1" });
    expect(wire.DAEMON_OPEN_ONE_OF).toContain("one daemon");
    expect(() => RuntimeRequest.parse({ id: 1, op: "daemon.close" })).toThrow();

    expect(wire.DaemonOpenReply.parse({ channel: "ch_1" })).toEqual({ channel: "ch_1" });
    expect(wire.DaemonSendReply.parse({ reply: { id: 3, ok: true, ptyId: "p1" } })).toEqual({ reply: { id: 3, ok: true, ptyId: "p1" } });
    expect(wire.DaemonSendReply.parse({ reply: { id: 3, ok: false, error: "no such pty", code: "not-found" } })).toBeTruthy();

    const event = { type: "daemon.event", channel: "ch_1", event: { type: "pty.data", ptyId: "p1", data: "hi" } };
    expect(wire.DaemonChannelEvent.parse(event)).toEqual(event);
    // A daemon of another version may push a type this host does not know; the host carries it and the page validates it.
    expect(wire.DaemonChannelEvent.parse({ type: "daemon.event", channel: "ch_1", event: { type: "future.thing" } })).toBeTruthy();
    const closed = { type: "daemon.closed", channel: "ch_1", code: 4401, reason: "unauthorized" };
    expect(wire.DaemonChannelEvent.parse(closed)).toEqual(closed);
    expect(() => wire.DaemonChannelEvent.parse({ type: "daemon.closed", channel: "ch_1", code: "4401", reason: "x" })).toThrow();

    // The panes are the person's: an agent inside a machine drives workspaces through the exec and session ops.
    for (const op of ["daemon.open", "daemon.send", "daemon.close", "workspaces.daemonReach"]) expect(THREAD_OPS).not.toContain(op);
  });

  it("the device list holds only ops the host serves, none of the ops that start a process, touch a computer, write keys or read this disk, and both route ops", () => {
    for (const op of wire.DEVICE_OPS) expect(wire.RUNTIME_OPS, op).toContain(op);
    expect(new Set(wire.DEVICE_OPS).size).toBe(wire.DEVICE_OPS.length);
    const held = [
      "sessions.start", "sessions.steer", "sessions.interrupt", "sessions.rename", "sessions.answer", "sessions.access", "workspaces.exec", "workspaces.bringBack", "daemon.open", "daemon.send", "daemon.close",
      "places.add", "places.update", "places.remove", "places.dial", "places.loginLanded", "places.doctor", "places.door", "places.mint", "places.sshHosts", "projects.add",
      "init.keys", "init.start", "init.answer", "init.step", "init.draft", "init.retry", "init.build", "init.signInCode", "init.cancel", "image.build", "golden.prepare", "golden.seal",
      "image.export", "host.folders", "agents.read", "servers.tools", "servers.icon", "agents.signIn", "servers.signIn", "agents.signInCode", "agents.signInStop", "agents.signInLine", "agents.key", "agents.addTools", "skills.search", "skills.get", "skills.preview", "skills.add", "skills.remove", "skills.toggle", "servers.add", "servers.remove", "servers.toggle", "project.seed.plan", "project.plan", "project.import", "project.export",
      "pair.issue", "pair.redeem", "seal.open", "device.auth", "place.join", "place.auth", "place.prove", "host.restart", "guest.open", "guest.send",
    ];
    for (const op of held) {
      expect(wire.RUNTIME_OPS, op).toContain(op);
      expect(wire.DEVICE_OPS, op).not.toContain(op);
    }
    // Every op the host serves is on one side or the other, so an op added later is placed on purpose.
    for (const op of wire.RUNTIME_OPS) expect(wire.DEVICE_OPS.includes(op) || held.includes(op), op).toBe(true);
    // The newest release is read by every window the person has, their phone's included; a restart is not a phone's.
    for (const op of ["status.list", "workspaces.create", "release.get", "release.check"]) expect(wire.DEVICE_OPS).toContain(op);
    expect(wire.deviceHeldRefusal("workspaces.exec")).toBe("workspaces.exec is not a paired computer's to ask for until the owner gives this device a role; run it on the computer the host runs on");
  });

  it("device.auth carries the key a computer on the account proves, and a device's record says which road it came by", () => {
    const frame = { id: 7, op: "device.auth", publicKey: Buffer.alloc(44).toString("base64"), name: "the laptop", signature: Buffer.alloc(64).toString("base64") };
    expect(RuntimeRequest.parse(frame)).toEqual(frame);
    // A frame with no signature over the seal's transcript is no frame at all: the key alone names nobody.
    const { signature: _s, ...unsigned } = frame;
    expect(() => RuntimeRequest.parse(unsigned)).toThrow();
    expect(() => RuntimeRequest.parse({ ...frame, name: "" })).toThrow();
    // One record for both roads: a code leaves the road absent, the account writes it, and the key rides along so
    // a device admitted here can sign for the next one.
    const via = { kind: "account", relayDeviceId: "c_1", fingerprint: "SHA256:aaa", publicKey: "bbb", admittedBy: "SHA256:ccc" };
    const device = { id: "d_1", name: "the laptop", createdAt: "2026-09-22T00:00:00.000Z", lastSeenAt: "2026-09-22T00:00:00.000Z", via };
    expect(wire.DeviceView.parse(device)).toEqual(device);
    const { via: _v, ...coded } = device;
    expect(wire.DeviceView.parse(coded)).toEqual(coded);
    expect(() => wire.DeviceView.parse({ ...device, via: { ...via, kind: "code" } })).toThrow();
  });

  it("an admission binds the key admitted, the key that signed and the moment, and no host, so one stands at every host that trusts the signer", () => {
    const bytes = wire.deviceAdmissionTranscript("SHA256:device", "SHA256:signer", "2026-09-22T00:00:00.000Z");
    expect(new TextDecoder().decode(bytes)).toBe("wsp device admission v1\nSHA256:device\nSHA256:signer\n2026-09-22T00:00:00.000Z\n");
    // Every part of it moves the bytes, so nothing a relay could swap on the way leaves a signature standing.
    for (const bent of [["SHA256:other", "SHA256:signer", "2026-09-22T00:00:00.000Z"], ["SHA256:device", "SHA256:other", "2026-09-22T00:00:00.000Z"], ["SHA256:device", "SHA256:signer", "2026-09-22T00:00:01.000Z"]]) {
      expect(new TextDecoder().decode(wire.deviceAdmissionTranscript(bent[0]!, bent[1]!, bent[2]!))).not.toBe(new TextDecoder().decode(bytes));
    }
    // The time is the string the relay stores and hands back, byte for byte, since the bytes are built from it.
    expect(new TextDecoder().decode(wire.deviceAdmissionTranscript("a", "b", "2026-09-22T00:00:00Z"))).toContain("2026-09-22T00:00:00Z");
  });

  it("sessions.start carries the composer's model, effort and permission mode as the harness's own slugs", () => {
    const picked = { id: 22, op: "sessions.start", workspaceId: "ws_1", prompt: "go", model: "claude-opus-5", effort: "high", permissionMode: "acceptEdits", contextWindow: "1m" };
    expect(RuntimeRequest.parse(picked)).toEqual(picked);
    const { model: _m, effort: _e, permissionMode: _p, contextWindow: _c, ...bare } = picked;
    expect(RuntimeRequest.parse(bare)).toEqual(bare);
    expect(() => RuntimeRequest.parse({ ...picked, effort: 3 })).toThrow();
    expect(RuntimeRequest.parse({ id: 23, op: "harnesses.list" })).toEqual({ id: 23, op: "harnesses.list" });
    expect(RuntimeRequest.parse({ id: 23, op: "harnesses.list", workspaceId: "ws_1" })).toEqual({ id: 23, op: "harnesses.list", workspaceId: "ws_1" });
  });

  it("a harness catalog lists what each picker may offer, says where the lists came from, and a model may narrow them", () => {
    const catalog = {
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.257",
      models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }, { value: "claude-haiku-4-5", label: "Haiku", efforts: [], contextWindows: [] }],
      efforts: [{ value: "high", label: "High", isDefault: true }],
      contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
      permissionModes: [{ value: "plan", label: "Plan", description: "Read and plan only" }],
      steers: true,
      renames: true,
      images: true,
    };
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(HarnessCatalog.parse({ ...catalog, isDefault: true })).toEqual({ ...catalog, isDefault: true });
    const bare = { harness: "pi", label: "Pi", source: "table", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false };
    expect(HarnessCatalog.parse(bare)).toEqual(bare);
    // steers says whether a running turn of this harness takes a message; the composer decides send-now from it before the click
    // screenCommands names the CLI's commands that work only in its own terminal, each with the wsp control that serves
    // it; the composer lists none of them and sends nothing for one. Absent is none, a catalog from before the field.
    const screen = { ...catalog, screenCommands: [{ name: "login", control: "sign-in" }, { name: "model", control: "model" }] };
    expect(HarnessCatalog.parse(screen)).toEqual(screen);
    expect(() => HarnessCatalog.parse({ ...catalog, screenCommands: ["login"] })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, screenCommands: [{ name: "login", control: "terminal" }] })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, steers: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, steers: "yes" })).toThrow();
    // renames says whether a name of a person's survives in the harness's own store; a client offers the rename from it
    expect(() => HarnessCatalog.parse({ ...catalog, renames: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, renames: "yes" })).toThrow();
    // images says whether a message to this harness may carry one; the composer offers its picker from it
    expect(() => HarnessCatalog.parse({ ...catalog, images: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, images: "yes" })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, models: [{ value: "x" }] })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, efforts: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, source: "guess" })).toThrow();
    const { source: _s, version: _v, contextWindows: _w, ...old } = catalog;
    expect(() => HarnessCatalog.parse(old)).toThrow();
  });

  it("whether a rename is kept is the adapter's answer: a row the runtime's table stood in for is no answer, never a no", () => {
    const row = (over: Partial<HarnessCatalog>): HarnessCatalog => ({
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.263",
      models: [],
      efforts: [],
      contextWindows: [],
      permissionModes: [],
      steers: true,
      renames: true,
      images: true,
      ...over,
    });
    expect(keepsRename(row({}))).toBe(true);
    // The machine answered no: no client offers the rename.
    expect(keepsRename(row({ renames: false }))).toBe(false);
    // The table stood in, so nobody has asked the machine yet: the client offers it and the runtime answers.
    expect(keepsRename(row({ source: "table", renames: false }))).toBe(true);
    expect(keepsRename(null)).toBe(true);
    expect(keepsRename(undefined)).toBe(true);
    // Whether a launch may carry MCP servers is not the machine's answer but this host's adapter, so a table row is
    // the answer and absent is a no: a client offering an agent whose launch drops them is the fault, not the fix.
    expect(takesMcpServers(row({ mcpServers: true }))).toBe(true);
    expect(takesMcpServers(row({ source: "table", mcpServers: true }))).toBe(true);
    expect(takesMcpServers(row({}))).toBe(false);
    expect(takesMcpServers(row({ mcpServers: false }))).toBe(false);
    expect(takesMcpServers(null)).toBe(false);
    expect(takesMcpServers(undefined)).toBe(false);
  });

  it("servers named for an agent whose adapter renders none are refused in that agent's name, and naming none is never refused", () => {
    const wsp = { wsp: { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp"] } };
    expect(mcpServersBlocked(wsp, undefined, "Codex")).toBe(noMcpServersLine("Codex"));
    expect(mcpServersBlocked(wsp, true, "Claude Code")).toBeNull();
    expect(mcpServersBlocked(undefined, undefined, "Codex")).toBeNull();
    expect(mcpServersBlocked({}, undefined, "Codex")).toBeNull();
    expect(noMcpServersLine("Codex")).toContain("Codex");
  });

  it("a model without its own lists takes the catalog's; a model with lists narrows them in the catalog's order; the marked default is one option or none", () => {
    const catalog: HarnessCatalog = {
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.257",
      models: [
        { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] },
        { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [] },
        { value: "claude-haiku-4-5", label: "Haiku", efforts: [], contextWindows: [] },
        { value: "claude-next", label: "Next", efforts: ["high"] },
      ],
      efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
      contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
      permissionModes: [{ value: "plan", label: "Plan" }],
      steers: true,
      renames: true,
      images: true,
    };
    expect(effortsFor(catalog, catalog.models[0]!).map(o => o.value)).toEqual(["low", "high"]);
    expect(effortsFor(catalog, catalog.models[3]!).map(o => o.value)).toEqual(["high"]);
    expect(effortsFor(catalog, catalog.models[2]!)).toEqual([]);
    expect(effortsFor(catalog, null)).toEqual(catalog.efforts);
    expect(contextWindowsFor(catalog, catalog.models[0]!).map(o => o.value)).toEqual(["200k", "1m"]);
    expect(contextWindowsFor(catalog, catalog.models[1]!)).toEqual([]);
    expect(contextWindowsFor(catalog, catalog.models[3]!).map(o => o.value)).toEqual(["200k", "1m"]);
    expect(contextWindowsFor(catalog, null)).toEqual([]);
    expect(markedDefault(catalog.models)?.value).toBe("claude-opus-5");
    expect(markedDefault(catalog.contextWindows)?.value).toBe("1m");
    expect(markedDefault(catalog.permissionModes)).toBeUndefined();
    expect(markedDefault([])).toBeUndefined();
  });

  it("SessionView records the model, effort, permission mode and context window the session runs with", () => {
    const view = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running", model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions", contextWindow: "1m" };
    expect(SessionView.parse(view)).toEqual(view);
    expect(() => SessionView.parse({ ...view, model: 5 })).toThrow();
  });

  it("sessions.interrupt answers one of three outcomes, none of them an error reply", () => {
    for (const outcome of ["accepted", "not-running", "not-found"]) expect(SessionInterruptResult.parse({ outcome })).toEqual({ outcome });
    expect(() => SessionInterruptResult.parse({ outcome: "stopped" })).toThrow();
    expect(() => SessionInterruptResult.parse({})).toThrow();
    expect(RuntimeResponse.parse({ id: 21, ok: true, outcome: "not-running" })).toBeTruthy();
  });

  it("sessions.steer carries the message for the running turn and answers one of four outcomes", () => {
    const steer = { id: 24, op: "sessions.steer", sessionId: "s1", prompt: "also check the tests", requestId: "req_2" };
    expect(RuntimeRequest.parse(steer)).toEqual(steer);
    const { requestId: _r, ...plain } = steer;
    expect(RuntimeRequest.parse(plain)).toEqual(plain);
    expect(() => RuntimeRequest.parse({ id: 24, op: "sessions.steer", sessionId: "s1" })).toThrow(); // prompt required
    expect(() => RuntimeRequest.parse({ id: 24, op: "sessions.steer", prompt: "x" })).toThrow(); // sessionId required
    for (const outcome of ["accepted", "not-running", "unsupported", "not-found"]) expect(SessionSteerResult.parse({ outcome })).toEqual({ outcome });
    expect(() => SessionSteerResult.parse({ outcome: "queued" })).toThrow();
    expect(() => SessionSteerResult.parse({})).toThrow();
  });

  it("sessions.start answers the session and how the start went: started, steered into the running turn, or queued behind it", () => {
    const session = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running" };
    for (const outcome of ["started", "steered", "queued"]) expect(SessionStartResult.parse({ session, outcome, turnId: "t1" })).toEqual({ session, outcome, turnId: "t1" });
    expect(() => SessionStartResult.parse({ session, outcome: "accepted", turnId: "t1" })).toThrow();
    expect(() => SessionStartResult.parse({ session, turnId: "t1" })).toThrow();
    expect(() => SessionStartResult.parse({ session, outcome: "started" })).toThrow();
    expect(() => SessionStartResult.parse({ outcome: "started", turnId: "t1" })).toThrow();
  });

  it("snapshots.list / snapshots.rollback parse, and SnapshotLineage is the manifest plus its name", () => {
    const list = { id: 20, op: "snapshots.list" };
    const named = { id: 21, op: "snapshots.list", name: "default" };
    const roll = { id: 22, op: "snapshots.rollback", version: 11 };
    for (const r of [list, named, roll]) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(() => RuntimeRequest.parse({ id: 23, op: "snapshots.rollback" })).toThrow(); // version required
    const version = {
      version: 11,
      snapshotId: "snap_golden-v11",
      baseTemplate: "base",
      setupSha: "abc",
      createdAt: "2026-08-14T00:00:00.000Z",
      smoke: { cmd: "claude --version", exitCode: 0 },
    };
    const lineage = { name: "default", head: 11, versions: [version] };
    expect(SnapshotLineage.parse(lineage)).toEqual(lineage);
    expect(SnapshotLineage.parse({ name: "default", head: null, versions: [] })).toEqual({ name: "default", head: null, versions: [] });
    const rolled = { lineage, existingWorkspaces: "untouched" };
    expect(SnapshotRollbackResult.parse(rolled)).toEqual(rolled);
    expect(() => SnapshotRollbackResult.parse({ lineage, existingWorkspaces: "upgraded" })).toThrow();
  });

  it("workspaces.portReach names the workspace and one guest port; PortReachView is the route without the daemon token", () => {
    const req = { id: 21, op: "workspaces.portReach", workspaceId: "ws_1", port: 3000 };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ id: 21, op: "workspaces.portReach", workspaceId: "ws_1" })).toThrow();
    for (const port of [0, 65536, 30.5]) expect(() => RuntimeRequest.parse({ ...req, port })).toThrow();
    const reach = { url: "https://m-3000.preview.example/?pt_token=edge", expiresAt: 1_700_000_000_000 };
    expect(PortReachView.parse(reach)).toEqual(reach);
    expect(PortReachView.parse({ ...reach, daemonToken: "d" })).toEqual(reach);
    expect(() => PortReachView.parse({ url: "x" })).toThrow();
  });

  it("DaemonReachView carries the preview route, its expiry, and the daemon token when the guest has one", () => {
    const full = { url: "https://m-7070.preview.example/?pt_token=edge", expiresAt: 1_700_000_000_000, daemonToken: "d" };
    expect(DaemonReachView.parse(full)).toEqual(full);
    const bare = { url: "https://m-7070.preview.example/?pt_token=edge", expiresAt: 1 };
    expect(DaemonReachView.parse(bare)).toEqual(bare);
    expect(() => DaemonReachView.parse({ url: "x" })).toThrow();
  });
});

describe("golden wire schemas", () => {
  it("golden.stage rides the event union with a closed stage enum and an optional detail", () => {
    const e = { type: "golden.stage", name: "default", stage: "smoke-forking", detail: "claude --version" };
    expect(EventUnion.parse(e)).toEqual(e);
    expect(GoldenStageEvent.parse({ type: "golden.stage", name: "default", stage: "sealed" })).toBeTruthy();
    expect(() => GoldenStageEvent.parse({ type: "golden.stage", name: "default", stage: "vibing" })).toThrow();
    for (const stage of ["applying-setup", "uploading-files", "installing-tools"]) {
      expect(GoldenStageEvent.parse({ type: "golden.stage", name: "default", stage, detail: "3 files" })).toMatchObject({ stage });
    }
  });

  it("a golden.stage frame may name the install step it belongs to, with the command a person reads for it", () => {
    const step = { label: "mongosh", command: "npm install -g mongosh" };
    const e = { type: "golden.stage", name: "default", stage: "installing-tools", detail: "mongosh (24/30)", step };
    expect(EventUnion.parse(e)).toEqual(e);
    expect(() => GoldenStageEvent.parse({ ...e, step: { label: "mongosh" } })).toThrow();
  });

  it("a manifest sealed before kind was recorded still parses; new ones carry the kind", () => {
    const old = { version: 1, snapshotId: "snap_a", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };
    const parsed = GoldenManifest.parse({ head: 2, versions: [old, { ...old, version: 2, kind: "desktop" }] });
    expect(parsed.versions[0]!.kind).toBeUndefined();
    expect(parsed.versions[1]!.kind).toBe("desktop");
  });

  it("error replies may carry a typed kind", () => {
    expect(RuntimeErrorResponse.parse({ id: 1, ok: false, error: "refused", kind: "notFirstLife" }).kind).toBe("notFirstLife");
  });
});

describe("daemon auth frame", () => {
  it("carries the token and, for a socket meant for one guest port, that port", () => {
    expect(DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t" })).toEqual({ id: 1, op: "auth", token: "t" });
    expect(DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: 3000 })).toEqual({ id: 1, op: "auth", token: "t", port: 3000 });
    expect(() => DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: 0 })).toThrow();
    expect(() => DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: 65536 })).toThrow();
    expect(() => DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: "3000" })).toThrow();
    expect(DaemonErrorCode.parse("forbidden")).toBe("forbidden");
  });
});

describe("daemon files and diff ops", () => {
  it("parses the four requests and refuses a bad scope or encoding", () => {
    const reqs = [
      { id: 1, op: "fs.list", path: "src", gitignore: true },
      { id: 2, op: "fs.read", path: "src/index.ts", encoding: "base64" },
      { id: 3, op: "git.status", cwd: "." },
      { id: 4, op: "git.diff", cwd: ".", scope: "branch", path: "src" },
    ];
    for (const r of reqs) expect(DaemonRequest.parse(r)).toEqual(r);
    expect(() => DaemonRequest.parse({ id: 5, op: "git.diff", cwd: ".", scope: "all" })).toThrow();
    expect(() => DaemonRequest.parse({ id: 6, op: "fs.read", path: "x", encoding: "hex" })).toThrow();
    expect(() => DaemonRequest.parse({ id: 7, op: "fs.list", path: 7 })).toThrow();
  });

  it("takes the workspace a files or git frame is for on those seven ops and refuses one that is not a word", () => {
    // A workspace on a computer somebody owns runs no daemon of its own, so the daemon of the computer holding it
    // answers these seven for the workspace the frame names; the path is then the one that workspace sees.
    // The path is the checkout's own, absolute: the daemon answering for a workspace has no working directory
    // inside it, and it refuses a relative path rather than reading one against its own.
    const named = [
      { id: 1, op: "fs.list", path: "/root/repo", machineId: "wsp-a" },
      { id: 2, op: "fs.read", path: "/root/repo/README.md", machineId: "wsp-a" },
      { id: 3, op: "git.status", cwd: "/root/repo", machineId: "wsp-a" },
      { id: 4, op: "git.diff", cwd: "/root/repo", scope: "branch", machineId: "wsp-a" },
      { id: 5, op: "git.push", cwd: "/root/repo", base: "main", machineId: "wsp-a" },
      { id: 6, op: "git.pr", cwd: "/root/repo", base: "main", machineId: "wsp-a" },
      { id: 7, op: "git.prState", cwd: "/root/repo", machineId: "wsp-a" },
    ];
    for (const r of named) expect(DaemonRequest.parse(r)).toEqual(r);
    for (const r of named) expect(() => DaemonRequest.parse({ ...r, machineId: 1 })).toThrow();
    // And no other op of this road carries one: an exec on a workspace has its own road, over the machine ops.
    expect(DaemonRequest.parse({ id: 8, op: "exec", cmd: "true", machineId: "wsp-a" })).toEqual({ id: 8, op: "exec", cmd: "true" });
  });

  it("parses the typed replies", () => {
    const list = { entries: [{ name: "a.ts", type: "file", size: 12, mtime: 1_700_000_000_000 }], truncated: false, total: 1 };
    expect(FsListReply.parse(list)).toEqual(list);
    expect(() => FsListReply.parse({ entries: [{ ...list.entries[0], type: "socket" }], truncated: false, total: 1 })).toThrow();
    expect(() => FsListReply.parse({ entries: list.entries, truncated: false })).toThrow();
    const read = { content: "aGk=", size: 2, truncated: false };
    expect(FsReadReply.parse(read)).toEqual(read);
    const status = {
      branch: { oid: "abc", head: "main", upstream: "origin/main", ahead: 1, behind: 0 },
      entries: [
        { xy: ".M", path: "a.ts" },
        { xy: "R.", path: "b.ts", origPath: "old.ts" },
        { xy: "??", path: "new.ts" },
      ],
      root: "/root/app",
    };
    expect(GitStatusReply.parse(status)).toEqual(status);
    const diff = { base: "main", files: [{ path: "a.ts", patch: "diff --git a/a.ts b/a.ts\n" }], truncated: true };
    expect(GitDiffReply.parse(diff)).toEqual(diff);
  });

  it("carries a typed error code on refusals", () => {
    const err = { id: 1, ok: false, error: "path escapes the workspace root", code: "outside-root" };
    expect(DaemonErrorResponse.parse(err)).toEqual(err);
    expect(DaemonResponse.parse(err)).toEqual(err);
    expect(DaemonErrorResponse.parse({ id: 1, ok: false, error: "plain" })).toEqual({ id: 1, ok: false, error: "plain" });
    expect(() => DaemonErrorResponse.parse({ ...err, code: "whatever" })).toThrow();
  });

  it("names the roots file beside a home, and the guest's is that rule answered at /root", () => {
    expect(rootsPathIn("/root")).toBe("/root/.wsp/roots");
    // The value, not the expression: the runtime writes this exact path into a guest and DAEMON_CONTENT_SHA hashes it,
    // so a home-derived answer that moved it would redeploy every machine or reach none.
    expect(DAEMON_ROOTS_PATH).toBe("/root/.wsp/roots");
    expect(DAEMON_ROOTS_PATH).toBe(rootsPathIn("/root"));
    expect(rootsPathIn("/Users/z")).toBe("/Users/z/.wsp/roots");
    expect(rootsPathIn("/Users/z/")).toBe("/Users/z/.wsp/roots");
    expect(rootsPathIn("/")).toBe("/.wsp/roots");
  });

  it("names everywhere a daemon on a machine reached over ssh keeps something, all under one folder of its own", () => {
    const at = sshDaemonPaths("/home/maya");
    expect(at).toEqual({
      wsp: "/home/maya/.wsp",
      dir: "/home/maya/.wsp/daemon",
      bundle: "/home/maya/.wsp/daemon.tgz",
      inbox: "/home/maya/.wsp/inbox",
      tokenPath: "/home/maya/.wsp/daemon-token",
      portFile: "/home/maya/.wsp/daemon.port",
      runDir: "/home/maya/.wsp/run",
      putDir: "/home/maya/.wsp/put",
      openSocket: "/home/maya/.wsp/open.sock",
      manifestPath: "/home/maya/.wsp/manifest.json",
      profileFile: "/home/maya/.wsp/profile.sh",
      unitDir: "/home/maya/.config/systemd/user",
      binDir: "/home/maya/.local/bin",
      openShim: "/home/maya/.local/bin/wsp-open",
      rootsPath: "/home/maya/.wsp/roots",
      // A computer joined as a place keeps these three beside the daemon's own, so one sweep takes the lot.
      placeFile: "/home/maya/.wsp/place.json",
      placeKey: "/home/maya/.wsp/place-key.pem",
      placeLog: "/home/maya/.wsp/place.log",
    });
    // The deploy on the host writes these and the runtime reads the token and the port back off them, which is
    // why the rule sits here and in neither of them.
    expect(at.rootsPath).toBe(rootsPathIn("/home/maya"));
    expect(sshDaemonPaths("/home/maya/")).toEqual(at);
    // Nothing here is root's: the daemon on a machine somebody owns is installed under their own login.
    expect(Object.values(at).filter(path => !path.startsWith("/home/maya/"))).toEqual([]);
  });

  it("says a machine over ssh is served no road to a daemon, and names no verb, since nobody can type one", () => {
    // What the host does, not what the machine has: a daemon may be running there and nothing dials it. So the
    // line names no verb and promises no later try, neither of which anybody here would keep.
    expect(noSshDaemonLine("box")).toBe("box is a computer over ssh, and this host opens no road to a daemon on one, so its terminal, files and ports are not served");
    expect(noSshDaemonLine("box")).not.toContain("daemon update");
    // A login whose services stop with it would lose the daemon the moment the connection closed, so it is
    // refused with the one command that turns that off.
    expect(NO_LINGER_LINE).toContain("loginctl enable-linger");
    // The daemon is one static binary; the wsp command beside it still runs on node, so that is what is asked for.
    expect(NO_NODE_LINE).toContain("no Node 22");
    expect(NO_NODE_LINE).toContain("install Node 22 or newer");
    // A refusal the machine itself raised is marked where it is thrown, so a row can show those words and show a
    // deploy that failed further in the general line instead of the deploy's tail.
    expect(machineLacksLine(machineLacking(NO_NODE_LINE))).toBe(NO_NODE_LINE);
    expect(machineLacksLine(new Error(NO_NODE_LINE))).toBeUndefined();
    expect(machineLacksLine("daemon deploy failed: DAEMON_DOWN")).toBeUndefined();
    // Every refusal is written as what is wrong, then why, then what to do, so its first clause is the row's half
    // and fits the row, and the whole sentence keeps the command a person types.
    expect(machineLacksShort(NO_NODE_LINE)).toBe("this machine has no Node 22");
    expect(machineLacksShort(NO_LINGER_LINE)).toBe("this login does not linger");
    expect(machineLacksShort(NO_SYSTEMD_LINE)).toBe("this machine runs no systemd");
    // Off the one list beside the sentences, not a copy of it here: a refusal added to a place's preflight takes
    // this rule by being listed once, rather than by somebody remembering that this loop exists.
    expect(MACHINE_LACKS_LINES).toContain(NO_NODE_LINE);
    expect(MACHINE_LACKS_LINES).toContain(NO_LINGER_LINE);
    expect(MACHINE_LACKS_LINES).toContain(NO_SYSTEMD_LINE);
    for (const line of MACHINE_LACKS_LINES) {
      expect(machineLacksShort(line).length).toBeLessThanOrEqual(30);
      expect(line.length).toBeGreaterThan(machineLacksShort(line).length);
    }
    expect(noImportRoadLine("box", OVER_SSH)).toBe("box is a computer over ssh, which lands no folder yet; import to a fork, or register the folder on this computer");
  });
});

describe("golden version logins", () => {
  const base = { version: 1, snapshotId: "snap_1", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } };
  it("carries name and state per login when the seal was given them, and stays optional for older versions", () => {
    const logins = [{ name: "GitHub CLI login", state: "signed-in" }, { name: "Codex login", state: "skipped" }];
    expect(GoldenVersion.parse({ ...base, logins })).toEqual({ ...base, logins });
    expect(GoldenVersion.parse(base).logins).toBeUndefined();
    expect(() => GoldenVersion.parse({ ...base, logins: [{ name: "x", state: "done" }] })).toThrow();
  });

  it("carries the tools missing from the image with the cause and reason, and stays optional for versions sealed before", () => {
    const missingTools = [{ id: "tools/brew/gopls", name: "gopls", outcome: "skipped", note: "no Linux bottle" }, { id: "tools/homebrew", name: "Homebrew", outcome: "failed", note: "git: not found" }];
    expect(GoldenVersion.parse({ ...base, missingTools })).toEqual({ ...base, missingTools });
    expect(GoldenVersion.parse(base).missingTools).toBeUndefined();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ id: "tools/brew/gopls", name: "gopls", note: "no Linux bottle" }] })).toThrow();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ name: "gopls", outcome: "skipped", note: "no Linux bottle" }] })).toThrow();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ id: "tools/brew/gopls", name: "gopls", outcome: "installed", note: "" }] })).toThrow();
  });

  it("carries what the pack left off the image by row, path and note, and stays optional for versions sealed before", () => {
    const leftBehind = [{ id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: /opt/homebrew/bin/terminal-notifier" }];
    expect(GoldenVersion.parse({ ...base, leftBehind })).toEqual({ ...base, leftBehind });
    expect(GoldenVersion.parse(base).leftBehind).toBeUndefined();
    expect(() => GoldenVersion.parse({ ...base, leftBehind: [{ id: "agents/claude", note: "hook left behind: x" }] })).toThrow();
    expect(() => GoldenVersion.parse({ ...base, leftBehind: ["hook left behind: x"] })).toThrow();
  });
});

describe("goldenImage", () => {
  it("boots a version from its template once one is recorded and gives it no word; a version with none boots from its snapshot and is volatile", () => {
    expect(goldenImage({ snapshotId: "snap_a", templateId: "tpl_a" })).toEqual({ spec: { template: "tpl_a" }, marks: [] });
    expect(goldenImage({ snapshotId: "snap_a" })).toEqual({ spec: { fromSnapshot: "snap_a" }, marks: ["volatile"] });
  });

  it("a version record takes an optional templateId and parses without one, as every version sealed before templates did", () => {
    const v = { version: 1, snapshotId: "snap_a", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };
    expect(wire.GoldenVersion.parse(v).templateId).toBeUndefined();
    expect(wire.GoldenVersion.parse({ ...v, templateId: "tpl_a" }).templateId).toBe("tpl_a");
    expect(wire.GoldenStage.options).toContain("promoting");
  });
});

describe("the sentences a vault archive is refused with", () => {
  it("the member refusal names the member, the reason and what that refusal did in the room it is read in", () => {
    const why = "it lands at /etc/cron.d/x, which is not one of the paths the seal asked for or under one";
    for (const road of ["seal", "import"] as const) {
      expect(vaultMemberRefusal(road, "etc/cron.d/x", why)).toContain("etc/cron.d/x");
      expect(vaultMemberRefusal(road, "etc/cron.d/x", why)).toContain("not one of the paths the seal asked for");
    }
    // Nothing was ever going to be imported at the seal, and no copy is what the import stopped.
    expect(vaultMemberRefusal("seal", "etc/cron.d/x", why)).toContain("the seal is refused and no version is recorded");
    expect(vaultMemberRefusal("seal", "etc/cron.d/x", why)).not.toContain("imported");
    expect(vaultMemberRefusal("import", "etc/cron.d/x", why)).toContain("nothing of it was imported");
    expect(vaultMemberRefusal("import", "etc/cron.d/x", why)).not.toContain("the seal is refused");
  });

  it("the unlisted refusal names the image and its version and says to cut the next one", () => {
    const line = vaultUnlistedRefusal("default", 1);
    expect(line).toContain("default v1");
    expect(line).toContain("cut the next version");
  });

  it("neither sentence carries a path of the computer the record sits on", () => {
    for (const line of [vaultMemberRefusal("seal", "root/.codex/auth.json", "it points at /etc"), vaultMemberRefusal("import", "root/.codex/auth.json", "it points at /etc"), vaultUnlistedRefusal("default", 2)]) {
      expect(line).not.toMatch(/\/Users\/|\/home\/|\.wsp|state\.json/);
    }
  });

  it("a sealed vault reads with the paths it held, and one sealed before the list was kept reads without", () => {
    const vault = { sha256: "a".repeat(64), bytes: 10, paths: 2, takenAt: "2026-09-01T00:00:00Z" };
    expect(wire.SealedVault.parse(vault).held).toBeUndefined();
    expect(wire.SealedVault.parse({ ...vault, held: ["/root/.codex/auth.json"] }).held).toEqual(["/root/.codex/auth.json"]);
  });
});

describe("goldenHead", () => {
  const v1: GoldenVersion = { version: 1, snapshotId: "snap_1", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };

  it("is nothing without a manifest", () => {
    expect(goldenHead(undefined)).toBeUndefined();
  });

  it("is nothing when the head names a version the manifest lacks", () => {
    expect(goldenHead({ head: 2, versions: [v1] })).toBeUndefined();
  });

  it("is the version the head names", () => {
    const v2: GoldenVersion = { ...v1, version: 2, snapshotId: "snap_2" };
    expect(goldenHead({ head: 2, versions: [v1, v2] })).toBe(v2);
  });
});

describe("thread provenance", () => {
  const row = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "completed" } as const;

  it("SessionView carries who asked for the turn, person, cli or agent, and stays optional for rows written before", () => {
    expect(SessionView.parse({ ...row, startedBy: "cli" }).startedBy).toBe("cli");
    expect(SessionView.parse({ ...row, startedBy: "agent" }).startedBy).toBe("agent");
    expect(SessionView.parse(row).startedBy).toBeUndefined();
    expect(() => SessionView.parse({ ...row, startedBy: "robot" })).toThrow();
    expect(SessionOrigin.options).toEqual(["person", "cli", "agent"]);
  });

  it("sessions.start takes startedBy and nothing else new", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", startedBy: "cli" })).toMatchObject({ startedBy: "cli" });
    expect(() => RuntimeRequest.parse({ id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", startedBy: "app" })).toThrow();
  });

  it("sessions.start may name who its thread's ends are told, one target or several, each a thread id or me; session.notify carries the line to one of them in the ending thread's transcript", () => {
    const req = { id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "build it", notify: ["thread_parent_0001"] };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(RuntimeRequest.parse({ ...req, notify: [NOTIFY_ME, "thread_reviewer_0001"] })).toEqual({ ...req, notify: ["me", "thread_reviewer_0001"] });
    // One target is a list of one, never a bare string, and a list of none names nobody rather than the person.
    expect(() => RuntimeRequest.parse({ ...req, notify: "thread_parent_0001" })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, notify: [] })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, notify: 7 })).toThrow();
    // The token a turn's launch carries, which is what me is read against.
    expect(RuntimeRequest.parse({ ...req, turnToken: "a".repeat(32) })).toEqual({ ...req, turnToken: "a".repeat(32) });
    expect(() => RuntimeRequest.parse({ ...req, turnToken: 7 })).toThrow();
    const told = { type: "session.notify", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0002", threadId: "thread_child_0001", at: 1756687889412, notify: "thread_parent_0001", text: "thread thread_c finished (completed, 8m 12s, $1.94): all green" };
    expect(SessionEvent.parse(told)).toEqual(told);
    expect(EventUnion.parse(JSON.parse(JSON.stringify(told)))).toEqual(told);
    expect(EventUnion.parse({ ...told, seq: 12 })).toEqual({ ...told, seq: 12 });
    expect(() => SessionEvent.parse({ ...told, notify: undefined })).toThrow();
    expect(() => SessionEvent.parse({ ...told, text: undefined })).toThrow();
  });

  it("sessions.start may carry the client's request id, and session.start carries it back, so a client tells its own start from another's with the same prompt", () => {
    const req = { id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", requestId: "req_1" };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ ...req, requestId: 7 })).toThrow();
    const started = { type: "session.start", workspaceId: "ws_1", sessionId: "s1", prompt: "go", requestId: "req_1" };
    expect(SessionEvent.parse(started)).toEqual(started);
    expect(EventUnion.parse(JSON.parse(JSON.stringify(started)))).toEqual(started);
    const { requestId: _requestId, ...none } = started;
    expect(SessionEvent.parse(none)).toEqual(none);
  });

  it("foldThreads groups turns by threadId, titles by the opening turn, reads state, row id and resume id from the latest, keeps the opener's provenance, and says whether a turn ever ran", () => {
    const threads = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", startedBy: "cli", prompt: "make a server", claudeSessionId: "c1", startedAt: 1_000, endedAt: 2_000 },
      { ...row, id: "s2", threadId: "thr_b", prompt: "unrelated", startedAt: 3_000, endedAt: 4_000 },
      { ...row, id: "s3", threadId: "thr_a", status: "running", startedBy: "person", prompt: "and tests", claudeSessionId: "c2", startedAt: 5_000 },
      { ...row, id: "s4", status: "failed", prompt: "before threads", startedAt: 6_000, endedAt: 7_000 },
    ]);
    expect(threads).toEqual([
      { id: "thr_a", threadId: "thr_a", workspaceId: "ws_1", harness: "claude", startedBy: "cli", status: "running", title: "make a server", sessionId: "s3", claudeSessionId: "c2", startedAt: 5_000, turns: 2, ran: true },
      { id: "thr_b", threadId: "thr_b", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "completed", title: "unrelated", sessionId: "s2", startedAt: 3_000, endedAt: 4_000, turns: 1, ran: false },
      { id: "s4", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "failed", title: "before threads", sessionId: "s4", startedAt: 6_000, endedAt: 7_000, turns: 1, ran: false },
    ]);
    for (const t of threads) expect(ThreadView.parse(t)).toEqual(t);
  });

  it("foldThreads adds up what a thread's turns cost, and says nothing where no turn of it reported a figure", () => {
    const [spent, said] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", claudeSessionId: "c1", costUsd: 0.75, startedAt: 1_000, endedAt: 2_000 },
      { ...row, id: "s2", threadId: "thr_a", claudeSessionId: "c1", costUsd: 0.39, startedAt: 3_000, endedAt: 4_000 },
      { ...row, id: "s3", threadId: "thr_b", claudeSessionId: "c2", startedAt: 5_000, endedAt: 6_000 },
    ]);
    expect(spent!.costUsd).toBeCloseTo(1.14, 10);
    expect("costUsd" in said!).toBe(false);
  });

  it("a thread reads as run once a turn of it did work: announcing a session is not enough, since both CLIs announce before they learn they have no sign-in", () => {
    const [worked, neverAnnounced, working, refused] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", status: "failed", claudeSessionId: "c1" },
      { ...row, id: "s2", threadId: "thr_b", status: "failed" },
      { ...row, id: "s3", threadId: "thr_c", status: "running" },
      // The launch got as far as a session id and the agent then refused the whole task: no work behind it.
      { ...row, id: "s4", threadId: "thr_d", status: "failed", claudeSessionId: "c2", refusal: "sign-in" },
    ]);
    // One turn of the thread did work, so the thread did, whatever a later turn came to.
    const [signedInLater] = foldThreads([
      { ...row, id: "s5", threadId: "thr_e", claudeSessionId: "c3", status: "failed", refusal: "sign-in" },
      { ...row, id: "s6", threadId: "thr_e", claudeSessionId: "c3", status: "completed" },
    ]);
    expect([worked!.ran, neverAnnounced!.ran, working!.ran, refused!.ran, signedInLater!.ran]).toEqual([true, false, true, false, true]);
    expect(threadRan([])).toBe(false);
  });

  it("foldThreads carries the latest turn's process on this computer, so the pane heads a thread's tree with its name", () => {
    const [here, elsewhere] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", status: "running", prompt: "read the docs", pid: 4_242 },
      { ...row, id: "s2", threadId: "thr_b", status: "running", prompt: "on a machine" },
    ]);
    expect(here!.pid).toBe(4_242);
    expect(elsewhere).not.toHaveProperty("pid");
    expect(ThreadView.parse(here!).pid).toBe(4_242);
    // The latest turn is the one running: a thread whose earlier turn had a process carries none now.
    const [over] = foldThreads([
      { ...row, id: "s3", threadId: "thr_c", status: "completed", pid: 99 },
      { ...row, id: "s4", threadId: "thr_c", status: "completed" },
    ]);
    expect(over).not.toHaveProperty("pid");
  });

  it("foldThreads carries the latest turn's open prompt, so the word every row reads comes off the fold and nowhere else", () => {
    const [asked, quiet] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", status: "running", prompt: "write it", asking: "Permission for Write: out.txt" },
      { ...row, id: "s2", threadId: "thr_b", status: "running", prompt: "nothing to ask" },
    ]);
    expect(asked!.asking).toBe("Permission for Write: out.txt");
    expect(quiet).not.toHaveProperty("asking");
    expect(ThreadView.parse(asked!).asking).toBe("Permission for Write: out.txt");
    expect([threadState(asked!), threadState(quiet!)]).toEqual(["waiting", "running"]);
    expect([threadWordOf(asked!), threadWordOf(quiet!)]).toEqual(["Needs you", "Working"]);
    // A prompt raised on a turn that has since settled says nothing: the fold reads the latest turn alone.
    const [settled] = foldThreads([
      { ...row, id: "s3", threadId: "thr_c", status: "running", asking: "Permission for Bash: ls" },
      { ...row, id: "s4", threadId: "thr_c", status: "completed" },
    ]);
    expect(settled).not.toHaveProperty("asking");
    expect(threadWordOf(settled!)).toBe("Idle");
  });

  it("a thread whose own call is behind another thread's question is waiting too, and its line is that question", () => {
    const behind = {
      threadId: "thr_b",
      workspaceId: "ws_1",
      sessionId: "s2",
      title: "read the file",
      prompt: { askId: "ask_1", toolName: "Write", input: '{"file_path":"/root/hello.txt","content":"hi"}', options: [] },
    };
    const caller = { status: "running" as const, waitingOn: behind };
    expect(threadState(caller)).toBe("waiting");
    expect(threadWordOf(caller)).toBe("Needs you");
    expect(waitingLine(caller)).toBe("Write hello.txt in root (2 B) needs an answer");
    // Its own prompt leads: a thread asked something itself says that, whatever it is also behind.
    expect(waitingLine({ ...caller, asking: "Permission for Bash: ls" })).toBe("Permission for Bash: ls");
    expect(waitingLine({})).toBeUndefined();
    expect(threadState({ status: "running" })).toBe("running");
  });

  it("reads the wsp calls that wait for another thread off the call alone, and nothing else", () => {
    expect(threadsFollowed({ toolName: "mcp__wsp__send", input: '{"thread":"thr_b","message":"go"}' })).toEqual({ named: ["thr_b"] });
    expect(threadsFollowed({ toolName: "mcp__wsp__threads_wait", input: '{"threads":["thr_b","thr_c"],"timeout":60}' })).toEqual({ named: ["thr_b", "thr_c"] });
    // run opens the thread it follows, so the call names none and the caller is behind what it started.
    expect(threadsFollowed({ toolName: "mcp__wsp__run", input: '{"workspace":"api","task":"build it"}' })).toEqual({ opened: true });
    // Detached is the whole point of detach: the call answers at once and waits for nobody.
    expect(threadsFollowed({ toolName: "mcp__wsp__run", input: '{"workspace":"api","task":"build it","detach":true}' })).toBeUndefined();
    expect(threadsFollowed({ toolName: "mcp__wsp__send", input: '{"thread":"thr_b","message":"go","detach":true}' })).toBeUndefined();
    // A wsp verb that answers out of the host alone, another server's tool, the agent's own tools, and junk input.
    expect(threadsFollowed({ toolName: "mcp__wsp__threads", input: "{}" })).toBeUndefined();
    expect(threadsFollowed({ toolName: "mcp__other__send", input: '{"thread":"thr_b"}' })).toBeUndefined();
    expect(threadsFollowed({ toolName: "Read", input: '{"file_path":"/root/hello.txt"}' })).toBeUndefined();
    expect(threadsFollowed({ toolName: "mcp__wsp__send", input: "not json" })).toBeUndefined();
    expect(threadsFollowed({ toolName: "mcp__wsp__send", input: "{}" })).toBeUndefined();
  });

  it("every thread state has one word, and a turn that failed says so rather than reading as one that finished", () => {
    // The design spec's four words for a thread: Working, Idle, Failed and the prompt's own Needs you. A launch that
    // never ran is the row this separates from a thread that did its work and stopped.
    expect([threadStateWord("running"), threadStateWord("completed")]).toEqual(["Working", "Idle"]);
    expect(threadStateWord("failed")).toBe("Failed");
    expect(threadStateWord("interrupted")).toBe("Idle");
    expect(threadStateWord("waiting")).toBe("Needs you");
    expect(threadWordOf({ status: "failed" })).toBe("Failed");
    // Only a running turn is ever waiting on a person: the runtime clears the prompt however the turn ends, on the
    // harness's own exit and on the roads that cut it, so a settled row carrying one is a row nothing can answer.
    expect(threadWordOf({ status: "running", asking: "Permission for Write: out.txt" })).toBe("Needs you");
  });

  it("foldThreads carries the latest turn's folder, so every director shows where the thread works; a row without one shows none", () => {
    const [worked, bare] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", prompt: "make a server", cwd: "/root/work/proj" },
      { ...row, id: "s2", threadId: "thr_a", prompt: "and tests", cwd: "/root/work/proj/packages" },
      { ...row, id: "s3", threadId: "thr_b", prompt: "no folder" },
    ]);
    expect(worked!.cwd).toBe("/root/work/proj/packages");
    expect(bare).not.toHaveProperty("cwd");
    expect(ThreadView.parse(worked!).cwd).toBe("/root/work/proj/packages");
  });

  it("foldThreads titles a thread by its opening prompt's first line, so the CLI's table and the sidebar show one line for a multi-paragraph brief", () => {
    const [t] = foldThreads([{ ...row, prompt: "You are a builder.\n\nTicket: Zingzy/wsp-map#292.\nBuild: the fix." }]);
    expect(t!.title).toBe("You are a builder.");
  });

  it("foldThreads titles a thread with no harness title by its opening turn's first sentence, cut to 48 characters, so a brief-shaped turn never shows whole in the row, the breadcrumb, the switcher card or the CLI's table", () => {
    const brief = "You are a builder for the wsp repo, which is at /Users/dev/wsp on this Mac: read the ticket, then run `pnpm test` and report.\n\nTicket: Zingzy/wsp-map#408.";
    const [t] = foldThreads([{ ...row, prompt: brief }]);
    expect(t!.title).toBe("You are a builder for the wsp repo, which is at\u2026");
    const [two] = foldThreads([{ ...row, prompt: "Bump the lockfile. Then run the gate." }]);
    expect(two!.title).toBe("Bump the lockfile.");
  });

  it("foldThreads titles a thread by what the harness calls the session the next send resumes, so a rename made inside the harness shows everywhere", () => {
    const [t] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", prompt: "make a server", claudeSessionId: "c1", harnessTitle: "Building the server", startedAt: 1_000 },
      { ...row, id: "s2", threadId: "thr_a", prompt: "and tests", claudeSessionId: "c1", harnessTitle: "the sidebar's own name", startedAt: 2_000 },
    ]);
    expect(t!.title).toBe("the sidebar's own name");
  });

  it("foldThreads keeps the opening turn's words while the harness has no title of its own, and cuts a harness title to one line", () => {
    const [none] = foldThreads([{ ...row, id: "s1", threadId: "thr_a", prompt: "make a server" }]);
    expect(none!.title).toBe("make a server");
    const [wrapped] = foldThreads([{ ...row, id: "s2", threadId: "thr_b", prompt: "make a server", harnessTitle: "  Building  the server \nand its tests" }]);
    expect(wrapped!.title).toBe("Building the server");
    const [named] = foldThreads([{ ...row, id: "s3", threadId: "thr_c", claudeSessionId: "c3", harnessTitle: "Building the server" }]);
    expect(named!.title).toBe("Building the server");
  });

  it("a thread always says who opened it: the fold reads a row from before provenance as a person's, once, for every client", () => {
    const [t] = foldThreads([{ ...row, prompt: "old" }]);
    expect(t!.startedBy).toBe("person");
    expect(() => ThreadView.parse({ id: "s1", workspaceId: "ws_1", harness: "claude", status: "completed", title: "old", sessionId: "s1", turns: 1 })).toThrow();
  });
});

describe("workspaces.exec", () => {
  it("takes a workspace and the command as argv, at least one word, so quoting is the runtime's and never lost on the wire", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: ["grep", "a b", "f"] })).toMatchObject({ argv: ["grep", "a b", "f"] });
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: [] })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", cmd: "ls" })).toThrow();
  });

  it("takes the folder the command runs in as cwd, absent when the command runs in the home", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: ["git", "status"], cwd: "/root/work/proj" })).toMatchObject({ cwd: "/root/work/proj" });
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: ["git", "status"] })).not.toHaveProperty("cwd");
  });

  it("pushes output lines and one exit, whose code is null with a reason when the command was ended without one", () => {
    expect(ExecEvent.parse({ type: "exec.output", execId: "e1", text: "hello" })).toEqual({ type: "exec.output", execId: "e1", text: "hello" });
    expect(ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: 0 })).toEqual({ type: "exec.exit", execId: "e1", exitCode: 0 });
    expect(ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: null, error: "deadline" })).toMatchObject({ exitCode: null, error: "deadline" });
    expect(() => ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: 1.5 })).toThrow();
  });
});

describe("the small recipe", () => {
  const row = { id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 }, signIn: "copy" };
  const recipe = { version: 1, at: "2026-09-06T03:00:00.000Z", histories: [{ agent: "claude", state: "read", sessions: 149, calls: 87593 }], rows: [row] };

  it("is catalog ids with a tick and the source of it, and nothing a session or a file held", () => {
    expect(Recipe.parse(recipe)).toEqual(recipe);
    expect(Recipe.safeParse({ ...recipe, version: 2 }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, rows: [{ ...row, source: { kind: "guess" } }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, rows: [{ ...row, signIn: "maybe" }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, histories: [{ agent: "claude", state: "read", sessions: -1, calls: 0 }] }).success).toBe(false);
    expect(RecipeSource.parse({ kind: "installed", paths: ["~/.claude/settings.json"], bin: true })).toEqual({ kind: "installed", paths: ["~/.claude/settings.json"], bin: true });
    expect(RecipeSource.safeParse({ kind: "installed", paths: ["~/.claude/settings.json"] }).success).toBe(false);
  });
});

describe("this computer's folder listing", () => {
  it("takes an ask with neither the folder nor the hidden flag, and vouches for a level of folders with its roots beside it", () => {
    for (const req of [{ id: "r1", op: "host.folders" }, { id: "r1", op: "host.folders", dir: "/Users/dev/code", hidden: true }]) {
      expect(RuntimeRequest.parse(req)).toEqual(req);
    }
    expect(RuntimeRequest.safeParse({ id: "r1", op: "host.folders", hidden: "yes" }).success).toBe(false);
    const listing = { dir: "/Users/dev/code", roots: ["/Users/dev", "/Volumes/work/api"], folders: [{ path: "/Users/dev/code/spoo", repo: true }], hidden: 3 };
    expect(HostFolderListing.parse(listing)).toEqual(listing);
    expect(HostFolderListing.safeParse({ ...listing, folders: [{ path: "/Users/dev/code/spoo" }] }).success).toBe(false);
    expect(HostFolderListing.safeParse({ ...listing, hidden: 1.5 }).success).toBe(false);
    expect(HostFolderListing.safeParse({ ...listing, roots: undefined }).success).toBe(false);
  });
});

describe("the project plan", () => {
  it("names each agent with sessions for the folder and how its state travels", () => {
    const plan = { source: "/Users/dev/proj", repo: true, files: 1, bytes: 2, secrets: [], excluded: [], skipped: [], agents: [{ agent: "claude", name: "Claude Code", sessions: 2, bytes: 4096, carry: "moves" }] };
    expect(ProjectPlan.parse(plan)).toEqual(plan);
    expect(ProjectPlan.safeParse({ ...plan, agents: [{ ...plan.agents[0], carry: "maybe" }] }).success).toBe(false);
    const unreadable = { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "transcript-only", error: "file is not a database" };
    expect(ProjectPlan.parse({ ...plan, agents: [unreadable] }).agents).toEqual([unreadable]);
    expect(ProjectPlan.safeParse({ ...plan, agents: undefined }).success).toBe(false);
  });

  it("the import names the agents that travel and the result says what became of each", () => {
    const req = { id: "r1", op: "project.import", workspaceId: "ws_1", source: "/Users/dev/proj", dest: "/root/proj", agents: ["claude"] };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    const result = {
      dest: "/root/proj",
      files: 1,
      bytes: 2,
      parts: 1,
      cut: [],
      rewritten: [],
      agents: [
        { agent: "claude", files: 3, bytes: 40, outcome: "moved" },
        { agent: "codex", files: 1, bytes: 40, outcome: "moved", rows: 2 },
        { agent: "gemini", files: 1, bytes: 40, outcome: "carried" },
        { agent: "hermes", files: 0, bytes: 0, outcome: "transcript-only", note: "no /root/.hermes/state.db on the machine" },
        { agent: "opencode", files: 0, bytes: 0, outcome: "nothing" },
        { agent: "pi", files: 0, bytes: 0, outcome: "failed", error: "x already exists" },
      ],
      project: { name: "proj", dest: "/root/proj", importedAt: "2026-09-12T10:00:00.000Z", size: 2 },
    };
    expect(ProjectImportResult.parse(result)).toEqual(result);
    expect(ProjectImportResult.safeParse({ ...result, agents: [{ agent: "pi", files: 0, bytes: 0, outcome: "lost" }] }).success).toBe(false);
    expect(ProjectImportResult.safeParse({ ...result, agents: [{ agent: "codex", files: 1, bytes: 40, outcome: "moved", rows: "two" }] }).success).toBe(false);
  });
});

describe("the project export", () => {
  it("names the workspace, the folder on the machine and the folder here; agents narrow whose state comes home", () => {
    const req = { id: "r1", op: "project.export", workspaceId: "ws_1", source: "/root/work/proj", dest: "/Users/dev/proj", replace: true, agents: ["claude", "codex"] };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    const bare = { id: "r2", op: "project.export", workspaceId: "ws_1", source: "/root/work/proj", dest: "/Users/dev/proj" };
    expect(RuntimeRequest.parse(bare)).toEqual(bare);
    expect(RuntimeRequest.safeParse({ ...bare, dest: undefined }).success).toBe(false);
  });

  it("its events ride the union with the stages in order, and the result counts sessions and skipped rollouts per agent", () => {
    for (const stage of ["packing", "downloading", "landing", "done", "failed"]) {
      const e = { type: "project.export", workspaceId: "ws_1", source: "/root/work/proj", dest: "/Users/dev/proj", stage, message: "x", elapsedMs: 3, seq: 1 };
      expect(EventUnion.parse(e)).toEqual(e);
    }
    expect(ProjectExportEvent.safeParse({ type: "project.export", workspaceId: "w", source: "/a", dest: "/b", stage: "uploading", message: "", elapsedMs: 0 }).success).toBe(false);
    const result = {
      dest: "/Users/dev/proj",
      files: 12,
      bytes: 4096,
      excluded: ["node_modules", "dist"],
      agents: [
        { agent: "claude", files: 3, bytes: 40, outcome: "moved", sessions: 2 },
        { agent: "codex", files: 1, bytes: 40, outcome: "transcript-only", sessions: 2, skipped: 1 },
        { agent: "hermes", files: 0, bytes: 0, outcome: "nothing", sessions: 1 },
        { agent: "pi", files: 0, bytes: 0, outcome: "failed", error: "not a database" },
      ],
    };
    expect(ProjectExportResult.parse(result)).toEqual(result);
    expect(ProjectExportResult.safeParse({ ...result, excluded: undefined }).success).toBe(false);
    expect(ProjectImportResult.parse({ dest: "/root/p", files: 1, bytes: 1, parts: 1, cut: [], rewritten: [], agents: [{ agent: "codex", files: 1, bytes: 1, outcome: "transcript-only", skipped: 2 }], project: { name: "p", dest: "/root/p", importedAt: "2026-09-12T10:00:00.000Z" } }).agents[0]).toMatchObject({ skipped: 2 });
  });
});

describe("project goldens", () => {
  it("a project golden names its snapshot, the projects it carries, the golden version it stands on and the workspace it was taken from", () => {
    const golden = {
      snapshotId: "snap_project-proj",
      projects: [{ name: "proj", dest: "/root/work/proj", importedAt: "2026-09-06T10:00:00.000Z" }],
      golden: "snap_golden-v12",
      version: 12,
      workspaceId: "ws_1",
      workspaceName: "task",
      createdAt: "2026-09-06T10:05:00.000Z",
    };
    expect(ProjectGolden.parse(golden)).toEqual(golden);
    const { version: _v, ...unversioned } = golden;
    expect(ProjectGolden.parse(unversioned)).toEqual(unversioned);
    expect(ProjectGolden.safeParse({ ...golden, projects: undefined }).success).toBe(false);
    expect(ProjectGolden.safeParse({ ...golden, version: "12" }).success).toBe(false);
  });

  it("workspaces.snapshot names the workspace and projectGoldens.list takes nothing", () => {
    const snapshot = { id: 30, op: "workspaces.snapshot", workspaceId: "ws_1" };
    const list = { id: 31, op: "projectGoldens.list" };
    for (const r of [snapshot, list]) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(RuntimeRequest.safeParse({ id: 32, op: "workspaces.snapshot" }).success).toBe(false);
  });

  it("projectGoldens.remove names the snapshot, replies with the record and its line, and a view's project row may carry a size", () => {
    const remove = { id: 33, op: "projectGoldens.remove", snapshotId: "snap_project-proj" };
    expect(RuntimeRequest.parse(remove)).toEqual(remove);
    expect(RuntimeRequest.safeParse({ id: 34, op: "projectGoldens.remove" }).success).toBe(false);
    // The records of wsp's own machines, which a paired computer manages and a thread never deletes.
    expect(wire.DEVICE_OPS).toContain("projectGoldens.remove");
    expect(THREAD_OPS).not.toContain("projectGoldens.remove");
    const golden = { snapshotId: "snap_project-proj", projects: [{ name: "proj", dest: "/root/work/proj", importedAt: "2026-09-06T10:00:00.000Z" }], golden: "snap_golden-v12", workspaceId: "ws_1", workspaceName: "task", createdAt: "2026-09-06T10:05:00.000Z" };
    expect(wire.ProjectGoldenRemoved.parse({ projectGolden: golden, alreadyGone: true })).toEqual({ projectGolden: golden, alreadyGone: true });
    expect(wire.ProjectGoldenRemoved.safeParse({ projectGolden: golden }).success).toBe(false);
    const view = { image: null, copies: [], projects: [{ ...golden, sizeBytes: 5_000_000_000 }, golden] };
    expect(wire.SealedImageView.parse(view)).toEqual(view);
    expect(wire.sealedProjectLine(view.projects[0]!)).toBe("snap_project-proj  project task  proj  4.7 GB  2026-09-06T10:05:00.000Z");
  });
});

describe("packageOf", () => {
  it("is what follows the manager in a tools row's id, a tap formula's slashes kept; it lives here because the collector writes these ids without the engine", () => {
    expect(wire.packageOf({ id: "tools/brew/gh" })).toBe("gh");
    expect(wire.packageOf({ id: "tools/brew/zingzy/tap/diskbloom" })).toBe("zingzy/tap/diskbloom");
    expect(wire.packageOf({ id: "tools/npm/@scope/name" })).toBe("@scope/name");
    expect(wire.packageOf({ id: `${wire.BREW_ID_PREFIX}yq` })).toBe("yq");
    // The collector's id for a manager's package, which a scan row of the same manager and package stands for.
    expect(wire.toolRowId("brew", "zingzy/tap/diskbloom")).toBe(`${wire.BREW_ID_PREFIX}zingzy/tap/diskbloom`);
    expect(wire.packageOf({ id: wire.toolRowId("npm", "@scope/name") })).toBe("@scope/name");
    // Where a manager's rows sit, which is what the engine tests a row's id against and what the brew prefix is.
    expect(wire.toolRowPrefix("npm")).toBe("tools/npm/");
    expect(wire.BREW_ID_PREFIX).toBe(wire.toolRowPrefix("brew"));
    expect(wire.toolRowId("uv", "ruff").startsWith(wire.toolRowPrefix("uv"))).toBe(true);
  });
});

describe("the newest release as the host read it", () => {
  it("is asked for and checked with no arguments, and rides one event every socket folds", () => {
    for (const op of ["release.get", "release.check"]) expect(wire.RuntimeRequest.parse({ id: "r1", op })).toEqual({ id: "r1", op });
    for (const op of ["release.get", "release.check"]) expect(wire.THREAD_OPS).not.toContain(op);
    const release = {
      state: "read",
      latest: { version: "0.3.0", tag: "v0.3.0", url: "https://github.com/Zingzy/wsp/releases/tag/v0.3.0", publishedAt: "2026-09-24T10:00:00Z" },
      checkedAt: "2026-09-24T11:00:00.000Z",
      triedAt: "2026-09-24T11:00:00.000Z",
      shape: "service",
    };
    expect(wire.ReleaseView.parse(release)).toEqual(release);
    expect(wire.EventUnion.parse({ type: "release.changed", release, seq: 3 })).toEqual({ type: "release.changed", release, seq: 3 });
    // Off carries no reading, so nothing drawn off it can offer a download the person turned checks off for.
    expect(wire.ReleaseView.parse({ state: "off", shape: "app" })).toEqual({ state: "off", shape: "app" });
    expect(wire.ReleaseView.safeParse({ ...release, state: "stale" }).success).toBe(false);
    // The line that moves this host onto the release rides beside it, read on the road the host was installed by.
    const behind = { ...release, update: "npm i -g @zingzy/wsp@0.3.0" };
    expect(wire.ReleaseView.parse(behind)).toEqual(behind);
    // The restart road's own refusal rides as the words the page shows; absent, a restart brings the host back.
    const refused = { ...release, restartRefusal: wire.UP_RESTART_LINE };
    expect(wire.ReleaseView.parse(refused)).toEqual(refused);
    expect(wire.HOST_NO_RESTART_LINE).toBe("This host cannot restart itself.");
  });

  it("restarts the host with no arguments, an op no thread and no paired computer sends", () => {
    expect(wire.RuntimeRequest.parse({ id: "r1", op: "host.restart" })).toEqual({ id: "r1", op: "host.restart" });
    expect(wire.THREAD_OPS).not.toContain("host.restart");
    expect(wire.DEVICE_OPS).not.toContain("host.restart");
  });

  it("reads the release as ahead only when it is above a version that runs", () => {
    const view = wire.ReleaseView.parse({ state: "read", latest: { version: "0.3.0", tag: "v0.3.0", url: "u", publishedAt: "p" }, shape: "app" });
    expect(wire.releaseAbove(view, "0.2.0")).toBe(true);
    expect(wire.releaseAbove(view, "0.3.0", "0.2.0")).toBe(true);
    expect(wire.releaseAbove(view, "0.3.0")).toBe(false);
    // A host built ahead of the newest release, a prerelease or a checkout's, reads level.
    expect(wire.releaseAbove(view, "0.4.0-rc.1")).toBe(false);
    expect(wire.releaseAbove(wire.ReleaseView.parse({ state: "checking", shape: "app" }), "0.2.0")).toBe(false);
  });
});

describe("the person's terminal config", () => {
  it("takes an ask with or without a scheme, and vouches only for the keys the pane honours in their shapes", () => {
    for (const req of [{ id: "r1", op: "host.terminalConfig" }, { id: "r1", op: "host.terminalConfig", scheme: "light" }]) {
      expect(wire.RuntimeRequest.parse(req)).toEqual(req);
    }
    expect(wire.RuntimeRequest.safeParse({ id: "r1", op: "host.terminalConfig", scheme: "sepia" }).success).toBe(false);
    const none = { files: [], fontFamily: [], palette: Array<null>(16).fill(null) };
    expect(wire.TerminalConfig.parse(none)).toEqual(none);
    const full = {
      ...none,
      files: ["/Users/dev/.config/ghostty/config"],
      fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
      fontSize: 13,
      theme: "Catppuccin Mocha",
      background: { r: 30, g: 30, b: 46 },
      cursorStyle: "underline",
      cursorStyleBlink: false,
      windowPaddingX: { left: 2, right: 4 },
      backgroundOpacity: 0.85,
      backgroundBlur: 20,
    };
    expect(wire.TerminalConfig.parse(full)).toEqual(full);
    expect(wire.TerminalConfig.safeParse({ ...none, palette: [] }).success).toBe(false);
    expect(wire.TerminalConfig.safeParse({ ...none, background: { r: 256, g: 0, b: 0 } }).success).toBe(false);
    expect(wire.TerminalConfig.safeParse({ ...none, backgroundOpacity: 1.5 }).success).toBe(false);
    expect(wire.TerminalConfig.safeParse({ ...none, cursorStyle: "beam" }).success).toBe(false);
  });
});

describe("bringing work back", () => {
  const view = {
    id: "ws_child",
    name: "pricing-page-fork",
    machineId: "m2",
    phase: "running",
    golden: "snap_g",
    createdAt: "2026-09-17T00:00:00.000Z",
    project: { id: "pr_1a2b3c4d", name: "landing", path: "/root/landing", computer: "box" },
    parentWorkspaceId: "ws_parent",
  } as const;

  it("a workspace says which workspace it was forked out of, and every door hands that over", () => {
    expect(wire.WorkspaceView.parse(view)).toEqual(view);
    expect(wire.WorkspaceOut.parse(view).parentWorkspaceId).toBe("ws_parent");
    // A workspace a person made is nobody's child and carries none.
    const { parentWorkspaceId: _child, ...own } = view;
    expect(wire.WorkspaceOut.parse(own).parentWorkspaceId).toBeUndefined();
    expect(() => wire.WorkspaceView.parse({ ...view, parentWorkspaceId: 7 })).toThrow();
  });

  it("the three git frames parse, the base is the caller's to leave out, and the workspace op carries the two words a pull request takes", () => {
    for (const frame of [
      { id: 1, op: "git.push", cwd: "/root/landing", base: "main" },
      { id: 2, op: "git.push", cwd: "/root/landing" },
      { id: 3, op: "git.pr", cwd: "/root/landing", base: "main", title: "the pricing page", body: "what it does" },
      { id: 4, op: "git.prState", cwd: "/root/landing" },
    ]) {
      expect(wire.DaemonRequest.parse(frame)).toEqual(frame);
    }
    expect(() => wire.DaemonRequest.parse({ id: 5, op: "git.push", base: "main" })).toThrow();
    expect(() => wire.DaemonRequest.parse({ id: 6, op: "git.prState" })).toThrow();
    const asked = { id: 7, op: "workspaces.bringBack", workspaceId: "ws_child", title: "the pricing page" };
    expect(wire.RuntimeRequest.parse(asked)).toEqual(asked);
    // A thread may get its own work out, which is why the op is on the list a thread's token opens.
    expect(wire.THREAD_OPS).toContain("workspaces.bringBack");
  });

  it("the result carries the push, and the pull request or the reason there is none", () => {
    const pushed = { branch: "pricing-page", base: "main", ahead: 2, uncommitted: 0, stat: [" 1 file changed"] };
    const withPr = { ...pushed, pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com" } };
    expect(wire.BringBackResult.parse(withPr)).toEqual(withPr);
    const noted = { ...pushed, note: wire.noHostCliLine("github.com") };
    expect(wire.BringBackResult.parse(noted)).toEqual(noted);
    expect(noted.note).toBe("no signed-in command line for github.com is on this computer; the branch is pushed and the pull request waits for one");
    expect(() => wire.BringBackResult.parse({ ...withPr, pr: { ...withPr.pr, state: "draft" } })).toThrow();
    expect(wire.DaemonErrorCode.options).toContain("no-host-cli");
  });

  it("a thread works on its own project alone, and the refusal names both", () => {
    expect(wire.spawnProjectRefusal("thread_a1b2c3d4", "landing", "docs")).toBe(
      `this request came out of thread ${wire.threadWord("thread_a1b2c3d4")} on landing; a thread works on its own project alone, and docs is another`,
    );
    // Bringing work back is one of the acts a thread may ask for, and it is named in the table like the rest.
    expect(wire.SPAWN_ACTS_ALLOWED).toContain("bring_back");
    expect(wire.SPAWN_ACTS["bring_back"]).toBe("bring its work back");
    expect(wire.spawnActRefusal("thread_a1b2c3d4", "delete")).toContain("bring its work back");
  });
});

describe("the doctor's computer road on the wire", () => {
  it("takes the computer, the id its lines ride and the project, and refuses an id longer than the field", () => {
    for (const req of [
      { id: 1, op: "places.doctor", placeId: "p_1", doctorId: "d_abc" },
      { id: 2, op: "places.doctor", placeId: "p_1", doctorId: "d_abc", project: "spoo-landing" },
    ]) {
      expect(wire.RuntimeRequest.parse(req)).toEqual(req);
    }
    expect(() => wire.RuntimeRequest.parse({ id: 3, op: "places.doctor", placeId: "p_1" })).toThrow();
    expect(() => wire.RuntimeRequest.parse({ id: 4, op: "places.doctor", placeId: "p_1", doctorId: "d".repeat(65) })).toThrow();
  });

  it("one line of a road carries which run it is, the words and which stream said them", () => {
    for (const stream of ["out", "err"] as const) {
      const line = { type: "doctor.line", doctorId: "d_abc", line: "spoo answers", stream };
      expect(wire.DoctorLineEvent.parse(line)).toEqual(line);
    }
    expect(() => wire.DoctorLineEvent.parse({ type: "doctor.line", doctorId: "d_abc", line: "spoo answers", stream: "log" })).toThrow();
    // A host source's event and no member of the runtime's own union: nothing retains it and nothing replays it,
    // so a socket that comes back reads the lines said after it came back and no others.
    expect(() => wire.EventUnion.parse({ type: "doctor.line", doctorId: "d_abc", line: "spoo answers", stream: "out" })).toThrow();
  });
});
