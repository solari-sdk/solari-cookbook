// SPDX-License-Identifier: AGPL-3.0-only
// The init job on the wire: the one view the terminal, the app's modal and an
// agent over MCP read, its event, its ops, and the words every client prints
// for it.
import { describe, expect, it } from "vitest";
import {
  CLOUD_SETUP_WORDS,
  EventUnion,
  FIRST_WORKSPACE,
  InitJob,
  InitJobEvent,
  InitNeedsYouEvent,
  InitSetup,
  LOGIN_CHOICES,
  LOGIN_STATE_WORDS,
  SIGN_IN_ANSWERS,
  credentialOnBuilderLine,
  signInChoice,
  signInChoices,
  LoginState,
  NEEDS_YOU,
  RuntimeRequest,
  INIT_ROW_STATES,
  SIGN_IN_CODE_MAX,
  SOLARI_CONSOLE,
  SignInFinish,
  initAgentNoRecipeLine,
  initAgentPrompt,
  initAgentStep,
  initCostLine,
  initJobBuilding,
  initJobOver,
  initNeedWhat,
  initNeedsYouLine,
  initPhaseWord,
  initProgressLine,
  initRowOver,
  initRowFailed,
  initRowUnrun,
  SIGN_IN_DEFERRED_WORD,
  SIGN_IN_LATER,
  titleWithNeed,
  initSetupLines,
  initTallyCount,
  threadWorkingLine,
  permissionAskLine,
  INIT_SIGN_IN_WORDS,
  initDiskLine,
  initBuildRows,
  initShownScreens,
  initStageCount,
  initStageCountLine,
  initStepCounter,
  initSweeping,
  MACHINE_GONE_LINE,
  MACHINE_ROW_LABEL,
  machineLeftLine,
  MACHINE_SWEEP_LINE,
  initStageWhile,
  initStoppedLine,
  NETWORK_LOST_LINE,
  SIGN_IN_STAGE_ID,
  sizeTone,
  diskTone,
  initDiskOverLine,
  initImageBytes,
  initSizeTone,
  fmtBytesOfTotal,
  initTallyOf,
  initTicksOf,
  fmtCalls,
  GOLDEN_STAGE_TIMED,
  SAVING_IMAGE_LINE,
  InitRow,
  initElapsedLine,
  initRowTimed,
  initSignInLine,
  snapshotStageLine,
  templateStatusLine,
  type InitScreen,
} from "../src/index.js";

const MIB = 1024 * 1024;

const row = (over: Partial<InitRow> = {}): InitRow => ({ id: "stage/creating", kind: "stage", label: "Creating the machine", state: "done", ...over });

const SCREEN: InitScreen = { id: "agents", title: "Agents", top: "Which agents go on the image", items: [], ticks: [], answers: {}, footer: [] };

const JOB: InitJob = {
  id: "init_1",
  road: "manual",
  phase: "building",
  keys: { solari: true },
  step: 0,
  stoppable: true,
  screens: [],
  rows: [row(), row({ id: "stage/deploying-daemon", label: "Installing the base tools", state: "running" }), row({ id: "stage/ready", label: "Waiting for the machine", state: "waiting" })],
  progress: { done: 1, total: 3 },
  log: ["Recipe saved to /tmp/recipe.json"],
};

/** The same job with a sign-in's page open on the machine and the need the host wrote for it. */
const WAITING: InitJob = {
  ...JOB,
  phase: "signing-in",
  rows: [...JOB.rows, row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device", code: "8F4A-C21B" })],
  needsYou: { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 },
};

describe("the init job view", () => {
  it("parses a job with screens, rows and progress, and refuses a phase or a row kind outside the enum", () => {
    expect(InitJob.parse(JOB)).toEqual(JOB);
    expect(InitJob.safeParse({ ...JOB, phase: "sleeping" }).success).toBe(false);
    expect(InitJob.safeParse({ ...JOB, rows: [row({ kind: "chore" as InitRow["kind"] })] }).success).toBe(false);
    const screen = {
      id: "agents",
      title: "Agents",
      top: "Which agents go on the image",
      items: [{ id: "claude", label: "Claude Code", size: 208 * MIB, why: "on this Mac", detail: ["on this Mac", "about 208 MB installed on the machine (measured 2026-09-01)"] }],
      ticks: ["claude"],
      answers: {},
      footer: [],
      tally: "agents",
    };
    expect(InitJob.parse({ ...JOB, screens: [screen] }).screens[0]).toEqual(screen);
  });

  it("a row carries its size in bytes, null where nothing measured it, and a sign-in row the key variable its agent reads with whether the home holds one", () => {
    const items = [
      { id: "yq", label: "yq", size: null, detail: [] },
      { id: "logins/claude", label: "Claude Code login", detail: [], choices: [{ value: "machine", label: "sign in during the build" }, { value: "key", label: "paste an API key" }], key: { name: "ANTHROPIC_API_KEY", saved: false } },
    ];
    const screen = { id: "logins", title: "Sign-ins", top: "Each row is something the machine needs to be signed in to", items, ticks: [], answers: { "logins/claude": "key" }, footer: [] };
    expect(InitJob.parse({ ...JOB, screens: [screen] }).screens[0]!.items).toEqual(items);
    expect(InitJob.safeParse({ ...JOB, screens: [{ ...screen, items: [{ id: "x", label: "x", size: "208 MB", detail: [] }] }] }).success).toBe(false);
  });

  it("a screen with no row to pick is not shown, whichever screen it is, and a step's counter counts the steps shown", () => {
    const withRow = (id: InitScreen["id"]): InitScreen => ({ ...SCREEN, id, items: [{ id: `${id}/row`, label: id, detail: [] }] });
    const bare = (id: InitScreen["id"]): InitScreen => ({ ...SCREEN, id });
    expect(initShownScreens([withRow("agents"), withRow("tools"), bare("also"), bare("logins"), withRow("wsp")]).map(s => s.id)).toEqual(["agents", "tools", "wsp"]);
    expect(initShownScreens([withRow("agents"), withRow("tools"), withRow("also"), withRow("logins"), withRow("wsp")]).map(s => s.id)).toEqual(["agents", "tools", "also", "logins", "wsp"]);
    expect(initShownScreens([withRow("agents"), withRow("tools"), bare("also"), withRow("logins"), bare("wsp")]).map(s => s.id)).toEqual(["agents", "tools", "logins"]);
    expect(initStepCounter(1, 4)).toBe("1/4");
    expect(initStepCounter(4, 4)).toBe("4/4");
  });

  it("the job says which step the person is on and what the image's disk holds before their ticks, so a reopened setup lands where it was closed and the ring has a base", () => {
    const job = InitJob.parse({ ...JOB, step: 3, disk: { fixed: 3 * 1024 * MIB, total: 20 * 1024 * MIB } });
    expect(job.step).toBe(3);
    expect(job.disk).toEqual({ fixed: 3 * 1024 * MIB, total: 20 * 1024 * MIB });
    expect(InitJob.safeParse({ ...JOB, step: -1 }).success).toBe(false);
    const { step: _step, ...noStep } = JOB;
    expect(InitJob.safeParse(noStep).success).toBe(false);
    // The facts read off this computer are rows too, so the reading step fills row by row.
    const fact = row({ id: "fact/agents", kind: "fact", label: "Agents", state: "3 found" });
    expect(InitJob.parse({ ...JOB, rows: [fact] }).rows[0]).toEqual(fact);
  });

  it("the setup the modal opens on carries the provider key's presence alone, never a key, the agents here and the price", () => {
    const setup = InitSetup.parse({ keys: { solari: false }, home: "/Users/me", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null });
    expect(setup.job).toBeNull();
    expect(Object.keys(setup.keys)).toEqual(["solari"]);
    expect(InitSetup.safeParse({ keys: { solari: "slr_live_x" }, home: "/Users/me", agents: [], pricing: null, job: null }).success).toBe(false);
  });

  it("the event rides the events channel beside the runtime's own, and the ops parse as requests", () => {
    const event = InitJobEvent.parse({ type: "init.job", job: JOB });
    expect(EventUnion.parse({ ...event, seq: 3 })).toEqual({ ...event, seq: 3 });
    for (const op of [
      { id: 1, op: "init.get" },
      { id: 2, op: "init.keys", solari: "slr_live_x" },
      { id: 2, op: "init.keys", rows: { "logins/codex": "sk-x-fake" } },
      { id: 3, op: "init.start", road: "agent", harness: "claude" },
      { id: 4, op: "init.answer", screen: "tools", ticks: ["gh"], answers: {} },
      { id: 4, op: "init.step", at: 2 },
      { id: 5, op: "init.build", firstWorkspace: "first", importFolder: "/Users/me/proj" },
      { id: 6, op: "init.cancel" },
      { id: 7, op: "init.signInCode", tool: "gcloud", code: "4/0Afake" },
    ]) {
      expect(RuntimeRequest.safeParse(op).success, op.op).toBe(true);
    }
    expect(RuntimeRequest.safeParse({ id: 7, op: "init.start", road: "wizard" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 8, op: "init.answer", screen: "build" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 9, op: "init.step", at: -1 }).success).toBe(false);
    // A code is one line typed into a terminal on the machine, so the wire takes neither an empty one nor a flood.
    expect(RuntimeRequest.safeParse({ id: 10, op: "init.signInCode", tool: "gcloud", code: "" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 11, op: "init.signInCode", tool: "gcloud", code: "x".repeat(SIGN_IN_CODE_MAX + 1) }).success).toBe(false);
  });
});

describe("the words the clients print for the job", () => {
  it("one word per phase, in lower case, since it sits in a muted mono slot", () => {
    expect(initPhaseWord("agent")).toBe("agent writing the recipe");
    expect(initPhaseWord("reading")).toBe("reading this computer");
    expect(initPhaseWord("answering")).toBe("waiting for you");
    expect(initPhaseWord("building")).toBe("building");
    expect(initPhaseWord("signing-in")).toBe("signing in");
    expect(initPhaseWord("sealing")).toBe("sealing");
    expect(initPhaseWord("finishing")).toBe("finishing");
    expect(initPhaseWord("done")).toBe("done");
    expect(initPhaseWord("failed")).toBe("failed");
    expect(initPhaseWord("cancelled")).toBe("cancelled");
  });

  it("the collapsed row's line is the phase and the count while it builds, the sign-in waited on while one is open, and the phase alone otherwise", () => {
    expect(initProgressLine(JOB)).toBe("building 1/3");
    const waiting = { ...JOB, phase: "signing-in" as const, rows: [...JOB.rows, row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device", code: "8F4A-C21B" })] };
    expect(initProgressLine(waiting)).toBe("sign in to GitHub CLI login");
    expect(initProgressLine({ ...JOB, phase: "answering", rows: [] })).toBe("waiting for you");
    expect(initProgressLine({ ...JOB, phase: "failed", rows: [] })).toBe("failed");
  });

  it("only a wait the person is not looking at is a need: a sign-in's open page, never the screens they just opened", () => {
    expect(initNeedWhat(JOB)).toBeUndefined();
    expect(initNeedWhat(WAITING)).toBe("sign in to GitHub CLI login");
    // The screens wait on the person, but they are the thing the person is looking at, so they are no one's need.
    // The phase is not even an argument here, which is what keeps any of them from becoming one by accident.
    for (const phase of ["agent", "reading", "answering"] as const) {
      const job: InitJob = { ...JOB, phase, rows: [] };
      expect(initNeedWhat(job), phase).toBeUndefined();
    }
    // A sign-in that moved on waits on nobody, whatever it once said.
    expect(initNeedWhat({ ...WAITING, rows: WAITING.rows.map(r => (r.kind === "sign-in" ? { ...r, state: INIT_SIGN_IN_WORDS["signed-in"]("darwin"), login: "signed-in" as const } : r)) })).toBeUndefined();
    // The sidebar's line and the need are one spelling, so the toast never says it a second way.
    expect(initProgressLine(WAITING)).toBe(initNeedWhat(WAITING));
  });

  it("the toast and the system notification say the app's name and the need, and a title carries the mark once however often it is set", () => {
    expect(NEEDS_YOU).toBe("wsp needs you");
    expect(initNeedsYouLine("sign in to GitHub CLI login")).toBe("wsp needs you: sign in to GitHub CLI login");
    expect(titleWithNeed("wsp", true)).toBe("• wsp");
    expect(titleWithNeed("wsp", false)).toBe("wsp");
    expect(titleWithNeed(titleWithNeed("wsp", true), true)).toBe("• wsp");
    expect(titleWithNeed(titleWithNeed("wsp", true), false)).toBe("wsp");
  });

  it("the need's arrival is its own event on the same channel, one per need, and the wire refuses a need without its clock", () => {
    const event = InitNeedsYouEvent.parse({ type: "job.needs-you", jobId: "init_1", needsYou: { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 } });
    expect(EventUnion.parse({ ...event, seq: 4 })).toEqual({ ...event, seq: 4 });
    expect(InitNeedsYouEvent.safeParse({ type: "job.needs-you", jobId: "init_1", needsYou: { what: "sign in" } }).success).toBe(false);
    expect(InitJob.parse(WAITING).needsYou).toEqual(WAITING.needsYou);
    expect(InitJob.safeParse({ ...JOB, needsYou: { what: "sign in", since: -1 } }).success).toBe(false);
  });

  it("the cost line names the size and the rate once, from the backend's own number", () => {
    expect(initCostLine({ cpu: 2, memMb: 4096 }, 0.11)).toBe("A 2 vCPU, 4 GB workspace costs about $0.11 an hour while it runs and naps when idle");
  });

  it("the agent's first message names the two tools and where the recipe goes, asks the agent to ask nothing, and says plainly to run no commands", () => {
    const prompt = initAgentPrompt("/Users/me/.wsp/recipe.json");
    expect(prompt).toContain("recipe_scan");
    expect(prompt).toContain("recipe");
    expect(prompt).toContain("/Users/me/.wsp/recipe.json");
    expect(prompt).toMatch(/ask (them|the person) nothing/i);
    // The tools are named as the only road: a thread that reached for the command line instead asked for permission
    // once per call and got nowhere.
    expect(prompt).toMatch(/run no commands/i);
    expect(prompt).not.toContain("wsp init");
  });

  it("the line when the thread ended with no recipe names the file waited on, and the turn's own reason where it had one", () => {
    expect(initAgentNoRecipeLine("/Users/me/.wsp/recipe.json")).toBe("the thread ended without writing /Users/me/.wsp/recipe.json");
    expect(initAgentNoRecipeLine("/Users/me/.wsp/recipe.json", "the harness died")).toBe("the thread ended without writing /Users/me/.wsp/recipe.json: the harness died");
  });

  it("one predicate says the job's step is the agent's: its road writing the recipe, and a job that ended before any screen", () => {
    const agent = { ...JOB, road: "agent" as const, screens: [] };
    expect(initAgentStep({ ...agent, phase: "agent" })).toBe(true);
    expect(initAgentStep({ ...agent, phase: "failed" })).toBe(true);
    expect(initAgentStep({ ...agent, phase: "cancelled" })).toBe(true);
    // Past the step: the screens exist, so a failure there is the build's own.
    expect(initAgentStep({ ...agent, phase: "answering" })).toBe(false);
    expect(initAgentStep({ ...agent, phase: "failed", screens: [SCREEN] })).toBe(false);
    expect(initAgentStep({ ...JOB, road: "manual", phase: "failed" })).toBe(false);
  });

  it("a thread's one line is the tool it is running, the prompt it is blocked on, else its own last line; anything else leaves the line alone", () => {
    const scope = { workspaceId: "ws_1", sessionId: "s_1" };
    expect(threadWorkingLine({ type: "session.delta", ...scope, kind: "text", text: "reading\nwriting the recipe" })).toBe("writing the recipe");
    expect(threadWorkingLine({ type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", text: JSON.stringify({ command: "wsp recipe scan --json" }) })).toBe("$ wsp recipe scan --json");
    // The prompt reads here in the same words the chat row leads with: one table words them, and both read it.
    const scan = JSON.stringify({ command: "wsp recipe scan --json", description: "Read what the agents here use" });
    expect(threadWorkingLine({ type: "session.permission", ...scope, askId: "a1", toolName: "Bash", input: scan, detail: "Read what the agents here use", options: [] })).toBe("Run: wsp recipe scan --json");
    expect(threadWorkingLine({ type: "session.permission", ...scope, askId: "a1", toolName: "Bash", input: scan, options: [] })).toBe(permissionAskLine("Bash", scan));
    expect(threadWorkingLine({ type: "session.delta", ...scope, kind: "tool_result", text: "ok" })).toBeUndefined();
    expect(threadWorkingLine({ type: "session.end", ...scope, exitCode: 0, sawResult: true })).toBeUndefined();
  });

  it("wsp setup prints the keys as held or not, the agents with their tools, the price, and the job's rows with the page a sign-in waits on", () => {
    const setup = { keys: { box: false, solari: true }, home: "/Users/me", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }, { id: "codex", name: "Codex", configured: false, takesTools: false }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
    // One line per provider this computer can hold a key for, each in that provider's own words for its key.
    expect(initSetupLines(setup)).toEqual([
      "Box API key: not set",
      "Solari API key: saved",
      "Agents here: Claude Code (MCP added), Codex",
      "A 2 vCPU, 4 GB workspace costs about $0.11 an hour while it runs and naps when idle",
      "No setup is running; the app's Image section starts one.",
    ]);
    const waiting = { ...JOB, phase: "signing-in" as const, rows: [row(), row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device", code: "8F4A-C21B" })] };
    expect(initSetupLines({ ...setup, job: waiting }).slice(4)).toEqual(["Setup on the manual road: sign in to GitHub CLI login", "  Creating the machine: done", "  GitHub CLI login: waiting for you https://github.com/login/device code 8F4A-C21B"]);
    expect(JSON.stringify(initSetupLines(setup))).not.toMatch(/slr_live|sk-ant/);
  });

  it("the login states have one spelling, the one the terminal and the modal both print", () => {
    expect(LOGIN_STATE_WORDS).toEqual({ "signed-in": "signed in", "not-signed-in": "not signed in", copied: "copied", "not-verified": "not verified", skipped: "skipped", deferred: SIGN_IN_DEFERRED_WORD });
    // The phrase the answer and the outcome share has one home, so the row the picker offers and the row a run-out
    // leaves cannot come to say two different things.
    expect(SIGN_IN_LATER).toBe("sign in when you first need it");
    expect(SIGN_IN_DEFERRED_WORD).toBe(`not signed in, ${SIGN_IN_LATER}`);
  });

  it("the sign-in answers offer six words, each with the words its row and its counts print", () => {
    expect(LOGIN_CHOICES).toEqual(["copy", "machine", "later", "key", "skip", "token"]);
    for (const value of LOGIN_CHOICES) expect(SIGN_IN_ANSWERS[value], value).toBeDefined();
    expect(signInChoices("darwin").map(c => c.value)).toEqual([...LOGIN_CHOICES]);
    expect(signInChoice("token", "darwin").label).toBe("token from this computer");
    expect(SIGN_IN_ANSWERS.token.short).toBe("token");
  });

  it("a builder holding a sign-in file is refused in one sentence that names the paths", () => {
    expect(credentialOnBuilderLine(["/root/.claude-cfg/.credentials.json", "/root/.codex/auth.json"])).toBe(
      "the builder holds a sign-in file at /root/.claude-cfg/.credentials.json, /root/.codex/auth.json; sign-ins never sit in an image, so nothing was sealed",
    );
  });

  it("a row's state words have one table, and one predicate says which of them end the row", () => {
    expect(INIT_ROW_STATES).toEqual({ waiting: "waiting", running: "running", done: "done", failed: "failed", forking: "forking", forked: "forked", importing: "importing", imported: "imported", open: "waiting for you", slot: "waiting for a machine slot", notMade: "not made", retrying: "machine still running, retrying", gone: "gone", stopped: "stopped", keySet: "key set", skipped: "skipped", mcpAdded: "MCP added" });
    for (const word of ["done", "failed", "stopped", "forked", "imported", "MCP added", "key set", "not made", "gone", "skipped"]) expect(initRowOver({ state: word }), word).toBe(true);
    for (const word of ["waiting", "running", "forking", "importing", "waiting for you", "waiting for a machine slot", "machine still running, retrying"]) expect(initRowOver({ state: word }), word).toBe(false);
    // A sign-in ends on its outcome, never on the sentence it prints: the word a Linux host drew ends the row the
    // same as a Mac's, and a sentence with no outcome beside it ends nothing.
    for (const state of LoginState.options) expect(initRowOver({ state: INIT_SIGN_IN_WORDS[state]("linux"), login: state }), state).toBe(true);
    expect(initRowOver({ state: "copied from this computer", login: "copied" })).toBe(true);
    expect(initRowOver({ state: "copied from this Mac" }), "a sentence nothing names").toBe(false);
    // The app's row words for a sign-in's outcome, drawn for the computer the run read: done once the machine has
    // the credential, the copy named with that computer.
    expect(Object.fromEntries(LoginState.options.map(state => [state, INIT_SIGN_IN_WORDS[state]("darwin")]))).toEqual({ "signed-in": "done", "not-signed-in": "not signed in", copied: "copied from this Mac", "not-verified": "not verified", skipped: "skipped", deferred: SIGN_IN_DEFERRED_WORD });
    expect(Object.fromEntries(LoginState.options.map(state => [state, INIT_SIGN_IN_WORDS[state]("linux")]))).toEqual({ "signed-in": "done", "not-signed-in": "not signed in", copied: "copied from this computer", "not-verified": "not verified", skipped: "skipped", deferred: SIGN_IN_DEFERRED_WORD });
  });

  it("the sidebar's line says a machine an earlier build left is still going before it says anything about the job it is on", () => {
    const at = (id: string, state: string): InitRow => ({ id, kind: "stage", label: id, state });
    const building: Pick<InitJob, "phase" | "rows" | "progress"> = { phase: "building", rows: [at("stage/creating", "done"), at("stage/ready", "running")], progress: { done: 1, total: 2 } };
    expect(initProgressLine(building)).toBe("building 1/2");
    const left = (state: string): InitRow => ({ id: "machine/b_1", kind: "machine", label: "Builder b_1", state });
    const sweeping = { ...building, rows: [...building.rows, left(INIT_ROW_STATES.retrying)] };
    expect(initSweeping(building.rows)).toBe(false);
    expect(initSweeping(sweeping.rows)).toBe(true);
    expect(initProgressLine(sweeping)).toBe(MACHINE_SWEEP_LINE);
    // Once the provider took it the line goes back to the job the person is looking at.
    expect(initProgressLine({ ...building, rows: [...building.rows, left(INIT_ROW_STATES.gone)] })).toBe("building 1/2");
    // A machine row's name is words, never a bare provider id in a column of sentences.
    // No provider id in a row's name or a sentence: the builder is the builder, and a stopped build's machine is the machine.
    expect(MACHINE_ROW_LABEL).toBe("The builder");
    expect(MACHINE_GONE_LINE).toBe("The machine is gone; nothing is billing.");
    expect(`${MACHINE_ROW_LABEL} ${MACHINE_GONE_LINE} ${MACHINE_SWEEP_LINE}`).not.toMatch(/b_[a-z0-9]{6,}/);
    // A rollback the provider refused is a line on the stage's block with the provider's own words, never the headline.
    expect(machineLeftLine("getaddrinfo ENOTFOUND api.getsolari.com")).toBe("the machine could not be removed and bills on: getaddrinfo ENOTFOUND api.getsolari.com");
  });

  it("a stopped build's sentence is this computer's own word for what happened, and a reason said twice is said once", () => {
    // The provider's client raises one fetch failure per call, so an outage arrives as the same line repeated.
    expect(initStoppedLine("fetch failed; fetch failed")).toBe(NETWORK_LOST_LINE);
    expect(initStoppedLine("getaddrinfo ENOTFOUND api.getsolari.com")).toBe(NETWORK_LOST_LINE);
    expect(initStoppedLine("connect ECONNREFUSED 127.0.0.1:443; fetch failed")).toBe(NETWORK_LOST_LINE);
    // A refusal the provider gave is the provider's word, and it stands as it is.
    expect(initStoppedLine("Sandbox limit reached")).toBe("Sandbox limit reached");
    expect(initStoppedLine("Unauthorized; fetch failed")).toBe("Unauthorized; fetch failed");
    expect(initStoppedLine("the snapshot failed; the snapshot failed")).toBe("the snapshot failed");
    // The stop line the run writes names the stage the same way wherever it is read.
    expect(initStageWhile("Creating the machine")).toBe("while creating the machine");
  });

  it("one predicate says the job is over and one that it is building, so no client spells the phases again", () => {
    expect(["done", "failed", "cancelled"].map(p => initJobOver(p as InitJob["phase"]))).toEqual([true, true, true]);
    expect(["agent", "reading", "answering", "building", "signing-in", "sealing", "finishing"].map(p => initJobOver(p as InitJob["phase"]))).toEqual([false, false, false, false, false, false, false]);
    expect(["building", "signing-in", "sealing", "finishing"].map(p => initJobBuilding(p as InitJob["phase"]))).toEqual([true, true, true, true]);
    expect(["agent", "reading", "answering", "done", "failed", "cancelled"].map(p => initJobBuilding(p as InitJob["phase"]))).toEqual([false, false, false, false, false, false]);
  });

  it("a sign-in row names its tool beside its id, so a client draws its mark without parsing the id", () => {
    const signIn = row({ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device" });
    expect(InitJob.parse({ ...JOB, rows: [signIn] }).rows[0]).toEqual(signIn);
  });

  it("a sign-in row names the road it finishes on, so a client knows which row takes a code from the person", () => {
    expect(SignInFinish.options).toEqual(["callback", "code", "none"]);
    const takesCode = row({ id: "sign-in/gcloud", kind: "sign-in", tool: "gcloud", label: "Google Cloud login", state: INIT_ROW_STATES.open, page: "https://accounts.google.com/o/oauth2/auth", finish: "code" });
    expect(InitJob.parse({ ...JOB, rows: [takesCode] }).rows[0]).toEqual(takesCode);
    expect(InitJob.safeParse({ ...JOB, rows: [row({ finish: "paste" as InitRow["finish"] })] }).success).toBe(false);
  });

  it("the first workspace's default name lives here, so the terminal and the host read one spelling", () => {
    expect(FIRST_WORKSPACE).toBe("first");
  });

  it("the provider's console is spelled once, and no step's words name the host", () => {
    expect(SOLARI_CONSOLE).toBe("console.getsolari.com");
    expect(JSON.stringify(CLOUD_SETUP_WORDS)).not.toContain(SOLARI_CONSOLE);
  });

  it("every step has a sentence under its title, and no title or sentence ends in a period", () => {
    expect(CLOUD_SETUP_WORDS.build.slideTop).not.toMatch(/[.;]$/);
    for (const step of [CLOUD_SETUP_WORDS.choice, CLOUD_SETUP_WORDS.reading, CLOUD_SETUP_WORDS.agent, CLOUD_SETUP_WORDS.build]) {
      expect(step.top.length, step.top).toBeGreaterThan(20);
      expect(step.top, step.top).not.toMatch(/\.$/);
      expect(step.headline, step.headline).not.toMatch(/\.$/);
    }
  });

  it("the tally, the disk words and a row's calls come from one formatter each: whole units under a gigabyte, a thousands separator on calls", () => {
    expect([initTallyCount(3, "agents"), fmtBytesOfTotal(1.1 * 1024 * MIB)]).toEqual(["3 agents on the image", "1.1 GB"]);
    expect([initTallyCount(1, "tools"), fmtBytesOfTotal(60 * MIB)]).toEqual(["1 tool on the image", "60 MB"]);
    expect([initTallyCount(0, "agents"), fmtBytesOfTotal(0)]).toEqual(["0 agents on the image", "0 B"]);
    expect([initTallyCount(3, "more"), fmtBytesOfTotal(1.2 * 1024 * MIB)]).toEqual(["3 more on the image", "1.2 GB"]);
    expect([initTallyCount(1, "more"), fmtBytesOfTotal(MIB)]).toEqual(["1 more on the image", "1 MB"]);
    expect(initDiskLine(1.1 * 1024 * MIB, 20 * 1024 * MIB)).toBe("about 1.1 GB of 20 GB on the image");
    // Past the disk the tooltip carries the overshoot too: said there and in Continue's refusal, nowhere else.
    expect(initDiskLine(21 * 1024 * MIB, 20 * 1024 * MIB)).toBe("about 21 GB of 20 GB on the image, over by 1 GB");
    // The sign-in stage with a run-out is a failure to draw as one, beside the stage that failed; nothing else is.
    expect([initRowFailed({ state: INIT_ROW_STATES.failed }), initRowFailed({ state: INIT_SIGN_IN_WORDS["not-signed-in"]("linux"), login: "not-signed-in" }), initRowFailed({ state: INIT_ROW_STATES.done }), initRowFailed({ state: INIT_ROW_STATES.stopped })]).toEqual([true, true, false, false]);
    // The sentence alone says nothing: a row that carries no outcome is no failure, whatever its word reads.
    expect(initRowFailed({ state: "not signed in" })).toBe(false);
    // A sign-in the build never waited out is over and is no failure: the person chose to sign in later, or the
    // build's cap ended a wait they were not going to finish, and neither is the machine's doing.
    const deferredRow = { state: INIT_SIGN_IN_WORDS.deferred("darwin"), login: "deferred" as const };
    expect([initRowFailed(deferredRow), initRowOver(deferredRow), initRowUnrun(deferredRow.state)]).toEqual([false, true, false]);
    const rows: InitRow[] = [
      { id: "agent/claude", kind: "agent", label: "Claude Code", state: "MCP added" },
      { id: "stage/creating", kind: "stage", label: "Creating the machine", state: "done" },
      { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", state: "waiting for you" },
      { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Sign in to Claude Code", state: "key set" },
      { id: "stage/snapshotting", kind: "stage", label: "Taking the snapshot", state: "waiting" },
      { id: "workspace/first", kind: "workspace", label: "first", state: "waiting" },
    ];
    const folded = initBuildRows(rows);
    expect(folded.rows.map(r => r.id)).toEqual(["stage/creating", SIGN_IN_STAGE_ID, "stage/snapshotting", "workspace/first"]);
    expect(folded.rows[1]).toMatchObject({ kind: "stage", label: "Signing in on the computer", state: "waiting for you" });
    expect(folded.signIns.map(r => r.id)).toEqual(["sign-in/gh", "sign-in/claude"]);
    const settled = initBuildRows(rows.map(r => (r.id === "sign-in/gh" ? { ...r, state: "not signed in", login: "not-signed-in" as const } : r)));
    expect(settled.rows[1], "a sign-in that ran out keeps the stage from reading done and hands it its own outcome").toMatchObject({ state: "not signed in", login: "not-signed-in" });
    // The count reads the same answer the cross does: a fold whose sign-in ran out is over, and it is not done.
    expect(initStageCount(settled.rows)).toEqual({ done: 1, total: 3 });
    // A sign-in left to first use, or one the cap ended, folds as a stage that is over and done: the count and the
    // glyph read the same answer, and a build that deferred every sign-in still reads complete.
    const deferred = initBuildRows(rows.map(r => (r.id === "sign-in/gh" ? { ...r, ...{ state: INIT_SIGN_IN_WORDS.deferred("darwin"), login: "deferred" as const } } : r)));
    expect(deferred.rows[1]).toMatchObject({ state: "done" });
    expect(initStageCount(deferred.rows)).toEqual({ done: 2, total: 3 });
    // The stage folds on the outcomes, so a run on a Linux computer folds where a Mac's does, on the words that computer drew.
    const linux = initBuildRows(rows.map(r => (r.id === "sign-in/gh" ? { ...r, state: INIT_SIGN_IN_WORDS.copied("linux"), login: "copied" as const } : r)));
    expect(linux.rows[1]).toMatchObject({ state: "done" });
    expect(initBuildRows(rows.map(r => (r.id === "sign-in/gh" ? { ...r, state: "done", login: "signed-in" as const } : r))).rows[1]!.state).toBe("done");
    expect(initBuildRows(rows.map(r => (r.kind === "sign-in" ? { ...r, state: "waiting" } : r))).rows[1]!.state).toBe("waiting");
    // Stages alone: the bar measures the build, so the first workspace beside them moves neither end of it.
    expect(initStageCount(folded.rows)).toEqual({ done: 1, total: 3 });
    expect(initStageCount([row({ state: "done" }), row({ id: "stage/ready", state: "failed" })]), "a failed row is not done").toEqual({ done: 1, total: 2 });
    expect(initStageCount([row({ state: "done" }), row({ id: "stage/ready", state: "stopped" })]), "nor is a stopped one").toEqual({ done: 1, total: 2 });
    // A machine an earlier build left behind is not a stage, so it moves neither end of the count either.
    expect(initStageCount([row({ state: "done" }), { id: "machine/b_1", kind: "machine", label: "Builder b_1", state: "machine still running, retrying" }])).toEqual({ done: 1, total: 1 });
    expect(initStageCountLine({ done: 3, total: 12 })).toBe("3 of 12");
    expect([sizeTone(1024 * MIB), sizeTone(300 * MIB), sizeTone(100 * MIB), sizeTone(99 * MIB), sizeTone(0)]).toEqual(["danger", "warning", "yellow", "muted", "muted"]);
    expect([diskTone(13, 20), diskTone(14, 20), diskTone(18, 20), diskTone(21, 20), diskTone(1, 0)]).toEqual(["muted", "warning", "danger", "danger", "danger"]);
    expect(initDiskOverLine(300 * MIB)).toBe("over by 300 MB");
    expect(fmtCalls(29_623)).toBe("29,623 calls");
    expect(fmtCalls(1)).toBe("1 call");
  });

  it("every step's tally reads the step's count and the running image estimate against the disk, one function computes that estimate from the job's drafts over its answers, and only the tools and what-else screens weigh their sizes", () => {
    const GIB = 1024 * MIB;
    const agents: InitScreen = { id: "agents", title: "Agents", top: "Which agents go on the image", items: [{ id: "claude", label: "Claude Code", size: 208 * MIB, detail: [] }, { id: "codex", label: "Codex", size: 455 * MIB, detail: [] }, { id: "hermes", label: "Hermes Agent", size: 484 * MIB, detail: [] }], ticks: ["claude", "codex"], answers: {}, footer: [], tally: "agents" };
    const tools: InitScreen = { id: "tools", title: "Tools", top: "Tools from your usage", items: [{ id: "node", label: "Node", size: 300 * MIB, lock: "on", detail: [] }, { id: "rust", label: "Rust", size: 4 * GIB, detail: [] }, { id: "swift", label: "Swift", size: 3 * GIB, detail: [] }, { id: "bun", label: "bun", size: null, detail: [] }], ticks: ["rust", "bun"], answers: {}, footer: [], tally: "tools" };
    const logins: InitScreen = { id: "logins", title: "Sign-ins", top: "How sign-ins reach the machine", items: [{ id: "logins/gh", label: "GitHub CLI login", detail: [], choices: [{ value: "copy", label: "copy" }] }], ticks: [], answers: {}, footer: [] };
    const job = { disk: { fixed: 0, total: 20 * GIB }, screens: [agents, tools, logins] };
    // A locked row is on, a row with a picker is not counted, and a row nothing measured adds nothing.
    expect(initTallyOf(tools, new Set(["rust", "bun"]))).toEqual({ count: 3, bytes: 300 * MIB + 4 * GIB });
    expect(initTallyOf(logins, new Set())).toEqual({ count: 0, bytes: 0 });
    // Agents ticked to 663 MB and tools to 4.3 GB: the tools step counts its own rows and reads the whole image.
    expect(initImageBytes(job)).toBe(663 * MIB + 300 * MIB + 4 * GIB);
    expect([initTallyCount(3, "tools"), fmtBytesOfTotal(initImageBytes(job), job.disk.total)]).toEqual(["3 tools on the image", "4.9 GB of 20 GB"]);
    // What the disk holds before any tick is under every estimate; a draft kept on a step stands over what the host
    // last answered; the draft a client holds and the host has not echoed stands over both.
    expect(initImageBytes({ ...job, disk: { fixed: 2 * GIB, total: 20 * GIB } })).toBe(2 * GIB + 663 * MIB + 300 * MIB + 4 * GIB);
    expect(initImageBytes({ ...job, drafts: [{ at: "tools", ticks: ["rust", "swift"], answers: {} }] })).toBe(663 * MIB + 300 * MIB + 7 * GIB);
    expect(initImageBytes({ ...job, drafts: [{ at: "tools", ticks: ["rust", "swift"], answers: {} }] }, { at: "tools", ticks: new Set<string>() })).toBe(663 * MIB + 300 * MIB);
    expect(initImageBytes(job, { at: "agents", ticks: ["claude"] })).toBe(208 * MIB + 300 * MIB + 4 * GIB);
    expect(initImageBytes({ screens: [] })).toBe(0);
    // The one rule for a screen's ticks as they stand, which the screen's draft and the estimate both read.
    expect([...initTicksOf(tools)]).toEqual(["rust", "bun"]);
    expect([...initTicksOf(tools, { ticks: ["swift"] })]).toEqual(["swift"]);
    // The estimate reads in the tone its share of the disk earns, never its weight: 4.9 GB is the danger weight and a quarter of the disk.
    expect(fmtBytesOfTotal(4.9 * GIB, 20 * GIB)).toBe("4.9 GB of 20 GB");
    expect(fmtBytesOfTotal(4.9 * GIB)).toBe("4.9 GB");
    expect(initTallyCount(0, "more")).toBe("0 more on the image");
    expect(diskTone(initImageBytes(job), job.disk.total)).toBe("muted");
    expect(sizeTone(initImageBytes(job))).toBe("danger");
    // The agents screen's sizes are muted whatever they weigh; the tools and what-else screens' wear the weight table; nothing measured is muted anywhere.
    expect([initSizeTone(agents, 455 * MIB), initSizeTone(agents, 4 * GIB), initSizeTone(tools, 455 * MIB), initSizeTone(tools, 4 * GIB), initSizeTone({ id: "also" }, 150 * MIB), initSizeTone(tools, null)]).toEqual(["muted", "muted", "warning", "danger", "yellow", "muted"]);
  });

  it("a sign-in's sentence names what the machine waits on and never a command, the seal's stages say what a person can use with no snapshot name, and a running stage's clock rides the row in whole seconds", () => {
    expect(initSignInLine({ state: INIT_ROW_STATES.open, code: "8F4A-C21B" })).toBe("waiting for the code");
    expect(initSignInLine({ state: INIT_ROW_STATES.open, finish: "code" })).toBe("waiting for the code");
    expect(initSignInLine({ state: INIT_ROW_STATES.open })).toBe("the page is open on this computer");
    expect(initSignInLine({ state: INIT_SIGN_IN_WORDS.copied("darwin") })).toBeUndefined();
    expect(initSignInLine({ state: INIT_ROW_STATES.done })).toBeUndefined();
    expect(initSignInLine({ state: INIT_SIGN_IN_WORDS["not-signed-in"]("darwin") })).toBeUndefined();
    expect(snapshotStageLine(13 * 1024 * MIB)).toBe("snapshotting about 13 GB, usually under a minute");
    expect(snapshotStageLine(undefined)).toBe("snapshotting, usually under a minute");
    expect(SAVING_IMAGE_LINE).toBe("saving the image");
    expect(templateStatusLine("ready")).toBe("the image is saved");
    expect(templateStatusLine("building")).toBe("saving the image, the provider says building; asking again");
    // The two stages the provider says nothing during count their own seconds; the wire carries the clock's start.
    expect([...GOLDEN_STAGE_TIMED]).toEqual(["snapshotting", "promoting"]);
    expect([initRowTimed({ id: "stage/snapshotting" }), initRowTimed({ id: "stage/promoting" }), initRowTimed({ id: "stage/creating" }), initRowTimed({ id: "sign-in/gh" })]).toEqual([true, true, false, false]);
    expect([initElapsedLine(0), initElapsedLine(999), initElapsedLine(41_400), initElapsedLine(72_000)]).toEqual(["0s", "0s", "41s", "1m 12s"]);
    expect(InitRow.parse({ id: "stage/snapshotting", kind: "stage", label: "Taking the snapshot", state: "running", since: 1_760_000_000_000 }).since).toBe(1_760_000_000_000);
  });

  it("the screens' words never ask the person to run a command, and never say cloud machines", () => {
    const text = JSON.stringify(CLOUD_SETUP_WORDS);
    expect(text).not.toMatch(/wsp init|terminal/i);
    // These screens are about the image; a computer and a provider are PLACES_WORDS and are said nowhere here.
    expect(text).not.toMatch(/cloud machines/i);
    // And the word table's own rule: setup is never the noun for what is built here.
    expect(text).not.toMatch(/\bsetup\b/i);
    expect(CLOUD_SETUP_WORDS.choice.headline).toBe("What goes on your image");
  });

});
