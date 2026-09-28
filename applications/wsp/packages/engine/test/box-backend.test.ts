// SPDX-License-Identifier: AGPL-3.0-only
// The Box backend against a fake Box API in this process, its bodies shaped
// from the ones the live spike recorded on 2026-09-11. Nothing here dials the
// real API.

import { describe, expect, it, vi } from "vitest";
import { GuestUnusableError, MoveUnansweredError, ROAD_TRIES, isMissing, type RetryClock } from "../src/errors.js";
import { DAEMON_ENV_FILE, DEADLINE_EXIT, INLINE_EXEC_MS } from "../src/exec-detached.js";
import { EXEC_ENV } from "../src/golden-import.js";
import { GONE_READS, killUntilGone } from "../src/golden.js";
import {
  BACKSTOP_SLACK_MS,
  BOX_BASE_TEMPLATE,
  BOX_BUDGETS,
  BOX_CLASSES,
  BOX_INLINE_MAX_MS,
  BOX_NAME_MAX,
  BOX_PRICING,
  BoxBackend,
  type BoxBudgets,
  BoxMachine,
  FILE_PUT_MAX,
  FIREWALL_HOLD_MS,
  FIREWALL_WATCH_MS,
  SNAPSHOT_NAME_MAX,
  TRIAL_TTL_S,
  boxClassFor,
  boxLabels,
  boxName,
  boxSnapshotName,
  envLandingScript,
  sudoCommand,
} from "../src/box-backend.js";
import { BUILDER_LABEL, CREATED_AT_LABEL, GOLDEN_LABEL, NAME_LABEL, OWNER_LABEL, WORKSPACE_LABEL, WSP_LABEL } from "../src/labels.js";
import { goldenName, nameOwner } from "../src/snapshot-names.js";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body: unknown };
type Answer = Reply | ((seen: Seen) => Reply);

/** The API as the spike saw it: every route answers its scripted replies in order and repeats the last one. */
class FakeBox {
  readonly seen: Seen[] = [];
  private readonly routes = new Map<string, Answer[]>();

  on(method: string, path: string, ...answers: Answer[]): this {
    this.routes.set(`${method} ${path}`, answers);
    return this;
  }

  readonly fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const seen: Seen = { method, path: u.pathname.replace(/^\/api\/box\/v1/, ""), query: u.searchParams, headers, body };
    this.seen.push(seen);
    const queue = this.routes.get(`${method} ${seen.path}`);
    if (queue === undefined || queue.length === 0) return new Response(JSON.stringify(ERROR(404, "not_found", "not_found")), { status: 404 });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    const reply = typeof next === "function" ? next(seen) : next;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });

  calls(): string[] {
    return this.seen.map(s => `${s.method} ${s.path}`);
  }

  took(method: string, path: string): Seen | undefined {
    return this.seen.find(s => s.method === method && s.path === path);
  }
}

const BOX = (id: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: "Box 2026-09-11 06:28",
  state,
  error: null,
  type: "small",
  vcpu: 2,
  memoryGB: 4,
  billingMultiplier: 0.5,
  machineProvider: state === "archived" ? null : "hetzner",
  url: state === "archived" ? null : "https://box-node-f06a49ff29e4ed7a.on.ascii.dev",
  ip: state === "archived" ? null : "2001:41d0:8:8d24:100::29",
  sshEndpoint: null,
  createdAt: "2026-09-11T06:28:06.053Z",
  updatedAt: "2026-09-11T06:28:07.139Z",
  archiveAfter: state === "archived" ? null : "2026-09-11T08:28:06.059Z",
  desktopAvailable: true,
  desktopUrl: null,
  snapshotAvailable: true,
  subdomain: "box-node-f06a49ff29e4ed7a",
  environment: "base",
  environmentVersion: 1,
  ...extra,
});

const INFO = (id: string, state: string, extra: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, type: "box.info", box: BOX(id, state, extra) } });
const ERROR = (status: number, code: string, message: string): Record<string, unknown> => ({ ok: false, type: "box.error", status, code, message, requestId: "req_b603629401be48d082e623575a1b9111" });
const LIMITS = (tier: string): Reply => ({ status: 200, body: { ok: true, type: "limits.info", accessTier: tier, maxActiveBoxes: 2, startLimits: { perMinute: 5, perHour: 25, perDay: 75 } } });
const COMMAND = (stdout: string, exitCode: number | null = 0, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: { ok: true, type: "command.finished", success: exitCode === 0, exitCode, signal: null, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, ...extra },
});
const NAMED = (name: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  status,
  sourceBoxId: "bx_tumrjngm",
  createdAt: "2026-09-11T06:47:23.959Z",
  ...(status === "ready" ? { snapshotId: "dc8cd70e-d16b-472a-b5d7-070bc84db7a7", type: "small", sizeBytes: 1255755776 } : {}),
  ...extra,
});

/** The script inside one sudo wrapper, its shell quoting undone. */
const inner = (command: string): string => command.replace(/^sudo -n bash -c '/, "").replace(/'$/, "").replaceAll("'\\''", "'");

/** The text of the file one detached launch puts on the guest: the base64 its own exec carries. */
const launchedText = (command: string): string => Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(inner(command))![1]!, "base64").toString("utf8");

/** The commands endpoint answering as a guest that ran a detached script: the launch confirms, the first poll carries
 * the exit code and the streams, and the cleanup says nothing. */
const detachedGuest = (exitCode: number | string = 0, out = "", err = ""): ((seen: Seen) => Reply) => (seen: Seen) => {
  const { command } = seen.body as { command: string };
  if (command.includes("WSP_LAUNCHED")) return COMMAND("WSP_LAUNCHED\n");
  if (command.includes("WSP_POLL")) return COMMAND(`WSP_POLL\n${exitCode}\n${Buffer.from(out).toString("base64")}\n${Buffer.from(err).toString("base64")}\ndown\nWSP_POLL_END\n`);
  return COMMAND("");
};

/** Every command the fake was sent, in order. */
const commandsSent = (api: FakeBox): string[] => api.seen.filter(s => s.path.endsWith("/commands")).map(s => (s.body as { command: string }).command);

/** A clock whose sleeps cost nothing and move its own time. */
function fakeClock(): RetryClock & { at: number } {
  const clock = {
    at: 1_000_000,
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.at += ms;
    },
  };
  return clock;
}

function backendOn(api: FakeBox, tier = "trial", budgets: Partial<BoxBudgets> = {}): { backend: BoxBackend; clock: RetryClock & { at: number } } {
  api.on("GET", "/limits", LIMITS(tier));
  const clock = fakeClock();
  const backend = new BoxBackend({ apiKey: "box_x", fetch: api.fetch, clock, budgets: { pollMs: 10, pauseMs: 100, resumeMs: 100, createMs: 100, snapshotMs: 100, restoreMs: 100, ...budgets } });
  return { backend, clock };
}

const machineOn = (api: FakeBox, id = "bx_tumrjngm"): { backend: BoxBackend; machine: BoxMachine; clock: RetryClock & { at: number } } => {
  const { backend, clock } = backendOn(api);
  return { backend, machine: new BoxMachine(backend, id, "sandbox"), clock };
};

describe("BoxBackend declarations", () => {
  it("says what a box can and cannot do: a disk nap, hosted routes, containers, named snapshots as templates", () => {
    const { backend } = backendOn(new FakeBox());
    expect(backend.capabilities).toEqual({
      liveCloneForks: false,
      pauseMode: "disk",
      // A fresh box deployed from the snapshot stands in for one that is gone, which is what the rebuild gate reads.
      replacesMachine: true,
      previewUrls: true,
      signedUrls: false,
      callbackRelay: true,
      diskSnapshots: true,
      images: true,
      // A box's named snapshot is the disk as it stands, so one that stopped and booted again saves the same.
      snapshotsAnyLife: true,
      snapshotListing: true,
      templates: true,
      kept: false,
      // The project's checkout is copied into the fork by the box's own runtime, and each workspace there gets a
      // network and published ports of its own.
      copies: true,
      ownNetwork: true,
      sizes: [
        { cpu: 2, memMb: 4096, rateUsdPerHour: 0.018 },
        { cpu: 4, memMb: 8192, rateUsdPerHour: 0.036 },
        { cpu: 8, memMb: 16384, rateUsdPerHour: 0.072 },
      ],
    });
    expect(backend.baseTemplates).toEqual({ sandbox: BOX_BASE_TEMPLATE, desktop: BOX_BASE_TEMPLATE });
  });

  it("prices by class: small, default and large an hour, a stopped box nothing, no snapshot storage price", () => {
    expect(BOX_PRICING.rateUsdPerHour({ cpu: 2, memMb: 4096 })).toBe(0.018);
    expect(BOX_PRICING.rateUsdPerHour({ cpu: 4, memMb: 8192 })).toBe(0.036);
    expect(BOX_PRICING.rateUsdPerHour({ cpu: 8, memMb: 16384 })).toBe(0.072);
    expect(BOX_PRICING.defaultSize).toEqual({ cpu: 2, memMb: 4096 });
    expect(BOX_PRICING.snapshotStorage).toEqual({ freeGb: 0, usdPerGbMonth: 0, billedFrom: "" });
    expect(BOX_PRICING.builderDiskGb).toBeUndefined();
    for (const c of BOX_CLASSES) expect(BOX_PRICING.rateUsdPerHour(c)).toBe(c.rateUsdPerHour);
  });

  it("reads a size onto the class table: the match, else the smallest class that holds it, else the largest sold", () => {
    expect(boxClassFor({ cpu: 2, memMb: 4096 }).type).toBe("small");
    expect(boxClassFor({ cpu: 4, memMb: 8192 }).type).toBe("default");
    expect(boxClassFor({ cpu: 2, memMb: 8192 }).type).toBe("default");
    expect(boxClassFor({ cpu: 3, memMb: 1024 }).type).toBe("default");
    expect(boxClassFor({ cpu: 32, memMb: 65536 }).type).toBe("large");
    expect(boxClassFor({}).type).toBe("small");
  });

  it("an inline command is bounded well under the edge's cut, and above what the detached road's own execs ask for", () => {
    expect(BOX_INLINE_MAX_MS).toBeGreaterThan(INLINE_EXEC_MS);
    expect(BOX_INLINE_MAX_MS).toBeLessThan(70_000);
  });

  it("declares its lifecycle: one wake attempt, two minutes for the daemon, no asking again, a backstop the runtime pushes", () => {
    const { backend } = backendOn(new FakeBox());
    expect(backend.lifecycle.budgets).toBe(BOX_BUDGETS);
    expect(BOX_BUDGETS).toEqual({ wakeAttempts: 1, daemonAnswersMs: 120_000 });
    expect(Object.isFrozen(BOX_BUDGETS)).toBe(true);
    expect(backend.lifecycle.backstop).toBeDefined();
    expect(backend.capabilities.pauseMode).toBe("disk");
  });

  it("a machine's labels ride in the box name, shortened, and read back whole", () => {
    const labels = {
      [WSP_LABEL]: "1",
      [OWNER_LABEL]: "h_1a2b3c4d",
      [WORKSPACE_LABEL]: "ws_0f9e8d7c",
      [NAME_LABEL]: "dev;two=three%",
      [GOLDEN_LABEL]: "default",
      [CREATED_AT_LABEL]: "2026-09-11T12:00:00.000Z",
      "recipe-tag": "x",
    };
    const name = boxName(labels);
    expect(name).toBe("wsp;o=h_1a2b3c4d;w=ws_0f9e8d7c;t=2026-09-11T12:00:00.000Z;g=default;n=dev%3btwo%3dthree%25;recipe-tag=x");
    expect(name.length).toBeLessThanOrEqual(BOX_NAME_MAX);
    expect(boxLabels(name)).toEqual(labels);
    // Boxes wsp did not name carry no labels, and a name with the mark alone is wsp's with the one label.
    expect(boxLabels("Box 2026-09-11 06:28")).toBeUndefined();
    expect(boxLabels(null)).toBeUndefined();
    expect(boxLabels("wsp")).toEqual({ [WSP_LABEL]: "1" });
  });

  it("a name that would run past the API's cap keeps the pairs in rank order up to the first that does not fit, and nothing after it", () => {
    const labels = { [OWNER_LABEL]: "h_1a2b3c4d", [WORKSPACE_LABEL]: "ws_0f9e8d7c", [CREATED_AT_LABEL]: "2026-09-11T12:00:00.000Z", [BUILDER_LABEL]: "1", [GOLDEN_LABEL]: "g".repeat(70), [NAME_LABEL]: "n" };
    const name = boxName(labels);
    expect(name.length).toBeLessThanOrEqual(BOX_NAME_MAX);
    const read = boxLabels(name)!;
    expect(read).toEqual({ [WSP_LABEL]: "1", [OWNER_LABEL]: "h_1a2b3c4d", [WORKSPACE_LABEL]: "ws_0f9e8d7c", [CREATED_AT_LABEL]: "2026-09-11T12:00:00.000Z", [BUILDER_LABEL]: "1" });
    // The golden did not fit, so the one-letter name after it is left off too, though it would have: a reader who
    // finds no golden knows the name is missing as well rather than guessing which pairs went.
    expect(read[NAME_LABEL]).toBeUndefined();
  });

  it("a snapshot name is lowered onto the provider's pattern and a long one ends in a hash, with the owner mark still readable", () => {
    expect(boxSnapshotName(goldenName("mac", "default", 3))).toBe("wsp-mac-default-v3");
    expect(boxSnapshotName("wsp-mac-Default_v3")).toBe("wsp-mac-default-v3");
    const long = goldenName("mac", "project-" + "x".repeat(80), 12);
    const a = boxSnapshotName(long);
    const b = boxSnapshotName(goldenName("mac", "project-" + "x".repeat(80), 13));
    expect(a.length).toBeLessThanOrEqual(SNAPSHOT_NAME_MAX);
    expect(a).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(a).not.toBe(b);
    expect(nameOwner(a)).toBe("mac");
    expect(() => boxSnapshotName("---")).toThrow(/nothing a named snapshot/);
  });
});

describe("BoxBackend against a fake Box API", () => {
  it("creates from the stock image on the trial: the class, the two hour auto-stop, no account secrets, the labels in the name, the key on the header, ready before the handle", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, type: "box.created", status: "provisioning", ttlSeconds: 7200, box: BOX("bx_tumrjngm", "provisioning") } })
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "provisioning", { name: "wsp;o=h_1a2b3c4d" }), INFO("bx_tumrjngm", "ready", { name: "wsp;o=h_1a2b3c4d" }))
      .on("POST", "/boxes/bx_tumrjngm/commands", detachedGuest());
    const { backend } = backendOn(api);
    const machine = await backend.create({
      kind: "sandbox",
      template: BOX_BASE_TEMPLATE,
      cpu: 2,
      memMb: 4096,
      labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: "h_1a2b3c4d" },
      envs: { IS_SANDBOX: "1", ANTHROPIC_API_KEY: "sk-ant-x" },
      idempotencyKey: "wsp-golden-default-1",
    });
    expect(machine.id).toBe("bx_tumrjngm");
    expect(machine.replayed).toBe(false);
    expect(machine.streamUrl).toBeUndefined();
    const create = api.took("POST", "/boxes")!;
    expect(create.body).toEqual({ type: "small", ttlSeconds: TRIAL_TTL_S, noEnv: true, name: "wsp;o=h_1a2b3c4d" });
    expect(create.headers["idempotency-key"]).toBe("wsp-golden-default-1");
    // The environment lands where root's services read it, carried onto the guest as the launched script's own file.
    const landed = launchedText(commandsSent(api).find(c => c.includes("WSP_LAUNCHED"))!);
    expect(landed).toBe(envLandingScript({ IS_SANDBOX: "1", ANTHROPIC_API_KEY: "sk-ant-x" }));
    expect(landed).toContain(`cat > '${DAEMON_ENV_FILE}'`);
    expect(landed).toContain('ANTHROPIC_API_KEY="sk-ant-x"');
    expect(api.calls()).toEqual(["GET /limits", "POST /boxes", "GET /boxes/bx_tumrjngm", "GET /boxes/bx_tumrjngm", ...Array<string>(4).fill("POST /boxes/bx_tumrjngm/commands")]);
  });

  it("creates from a named snapshot with `from`, sets the name the provider replaced with the snapshot's, and off the trial asks no auto-stop", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, type: "box.created", status: "provisioning", ttlSeconds: null, from: "wsp-mac-default-v1", box: BOX("bx_uwepudz7", "provisioned", { name: "wsp-mac-default-v1" }) } })
      .on("GET", "/boxes/bx_uwepudz7", INFO("bx_uwepudz7", "cloning", { name: "wsp-mac-default-v1" }), INFO("bx_uwepudz7", "idle", { name: "wsp-mac-default-v1" }))
      .on("PATCH", "/boxes/bx_uwepudz7", INFO("bx_uwepudz7", "idle", { name: "wsp;o=h_1" }))
      .on("POST", "/boxes/bx_uwepudz7/commands", COMMAND(""));
    const { backend } = backendOn(api, "standard");
    const machine = await backend.create({ kind: "sandbox", template: "wsp-mac-default-v1", cpu: 4, memMb: 8192, labels: { [OWNER_LABEL]: "h_1" } });
    expect(machine.id).toBe("bx_uwepudz7");
    // No window named and no cap on the account: no timer, the provider's own meaning of null.
    expect(api.took("POST", "/boxes")!.body).toEqual({ type: "default", ttlSeconds: null, noEnv: true, name: "wsp;o=h_1", from: "wsp-mac-default-v1" });
    // The deployed box came back named after its snapshot, so the labels went back on with one update.
    expect(api.took("PATCH", "/boxes/bx_uwepudz7")!.body).toEqual({ name: "wsp;o=h_1" });
    // fromSnapshot names the image the same way.
    api.on("POST", "/boxes", { status: 202, body: { ok: true, type: "box.created", status: "provisioning", box: BOX("bx_uwepudz7", "provisioned") } });
    await backend.create({ kind: "sandbox", fromSnapshot: "wsp-mac-default-v2" });
    expect(api.seen.filter(s => s.method === "POST" && s.path === "/boxes").at(-1)!.body).toMatchObject({ from: "wsp-mac-default-v2", type: "small", name: "wsp" });
    expect(api.seen.filter(s => s.method === "PATCH").at(-1)!.body).toEqual({ name: "wsp" });
    // One read of the tier serves every create.
    expect(api.calls().filter(c => c === "GET /limits")).toHaveLength(1);
  });

  it("the create carries the runtime's idle window as the stop timer: the seconds to it off the trial, the cap on it when shorter", async () => {
    const off = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, status: "provisioning", box: BOX("bx_t1", "provisioning", { name: "wsp" }) } })
      .on("GET", "/boxes/bx_t1", INFO("bx_t1", "ready", { name: "wsp" }))
      .on("POST", "/boxes/bx_t1/commands", COMMAND(""));
    await backendOn(off, "standard").backend.create({ kind: "sandbox", onIdle: "pause", idleTimeoutMs: 40 * 60_000 });
    expect(off.took("POST", "/boxes")!.body).toMatchObject({ ttlSeconds: 40 * 60 });
    const trial = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, status: "provisioning", box: BOX("bx_t2", "provisioning", { name: "wsp" }) } })
      .on("GET", "/boxes/bx_t2", INFO("bx_t2", "ready", { name: "wsp" }))
      .on("POST", "/boxes/bx_t2/commands", COMMAND(""));
    const { backend } = backendOn(trial);
    await backend.create({ kind: "sandbox", onIdle: "pause", idleTimeoutMs: 6 * 60 * 60_000 });
    expect(trial.took("POST", "/boxes")!.body).toMatchObject({ ttlSeconds: TRIAL_TTL_S });
    await backend.create({ kind: "sandbox", onIdle: "pause", idleTimeoutMs: 40 * 60_000 });
    expect(trial.seen.filter(s => s.method === "POST" && s.path === "/boxes").at(-1)!.body).toMatchObject({ ttlSeconds: 40 * 60 });
  });

  it("a create answered from an earlier key reads replayed, and the envs still land", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, type: "box.created", status: "ready", ttlSeconds: 7200, box: BOX("bx_tumrjngm", "idle", { name: "wsp" }) } })
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "idle", { name: "wsp" }))
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND(""));
    const { backend } = backendOn(api);
    const machine = await backend.create({ kind: "sandbox" });
    expect(machine.replayed).toBe(true);
    expect(api.calls().filter(c => c.startsWith("PATCH"))).toEqual([]);
  });

  it("a create the provider leaves in error, or one that never reads ready inside the budget, fails naming the state, and the box it made is deleted", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, type: "box.created", status: "provisioning", box: BOX("bx_e1", "provisioning") } })
      .on("GET", "/boxes/bx_e1", INFO("bx_e1", "error", { error: "no capacity" }))
      .on("DELETE", "/boxes/bx_e1", { status: 202, body: { ok: true, operation: { id: "bdop_1" } } });
    const { backend } = backendOn(api);
    await expect(backend.create({ kind: "sandbox" })).rejects.toThrow(/bx_e1 reads error during create: no capacity/);
    expect(api.calls().filter(c => c.startsWith("DELETE"))).toEqual(["DELETE /boxes/bx_e1"]);
    api.on("GET", "/boxes/bx_e1", INFO("bx_e1", "provisioning"));
    await expect(backend.create({ kind: "sandbox" })).rejects.toThrow(/still reads provisioning/);
    expect(api.calls().filter(c => c.startsWith("DELETE"))).toHaveLength(2);
    // The environment failing to land ends the create the same way: nothing the caller cannot name is left running.
    api.on("GET", "/boxes/bx_e1", INFO("bx_e1", "ready", { name: "wsp" }));
    api.on("POST", "/boxes/bx_e1/commands", detachedGuest(1, "", "systemctl: not found"));
    await expect(backend.create({ kind: "sandbox", envs: { A: "1" } })).rejects.toThrow(/environment did not land on bx_e1/);
    expect(api.calls().filter(c => c.startsWith("DELETE"))).toHaveLength(3);
  });

  it("a landing of the environment runs detached and one that times out on a box still taking its disk in is launched again inside the budget", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, status: "provisioning", box: BOX("bx_l1", "provisioning", { name: "wsp" }) } })
      .on("GET", "/boxes/bx_l1", INFO("bx_l1", "ready", { name: "wsp" }))
      .on("POST", "/boxes/bx_l1/commands", COMMAND(""), detachedGuest(DEADLINE_EXIT), detachedGuest(DEADLINE_EXIT), detachedGuest(DEADLINE_EXIT), detachedGuest());
    const { backend } = backendOn(api);
    const machine = await backend.create({ kind: "sandbox", envs: { A: "1" } });
    expect(machine.id).toBe("bx_l1");
    // Every command the road sends is an inline exec of its own, none of them near the edge's cut.
    const asked = api.seen.filter(s => s.path === "/boxes/bx_l1/commands").map(s => (s.body as { timeoutSeconds: number }).timeoutSeconds);
    expect(new Set(asked)).toEqual(new Set([INLINE_EXEC_MS / 1000]));
    // The environment script travelled as the launched file's text, and the run that timed out was launched again.
    const launches = commandsSent(api).filter(c => c.includes("WSP_LAUNCHED"));
    expect(launches).toHaveLength(2);
    for (const l of launches) expect(launchedText(l)).toBe(envLandingScript({ A: "1" }));
    // A landing that fails for another reason is the failure at once, and a timeout past the budget too.
    api.on("POST", "/boxes/bx_l1/commands", detachedGuest(DEADLINE_EXIT)).on("DELETE", "/boxes/bx_l1", { status: 202, body: { ok: true, operation: { id: "bdop_l" } } });
    await expect(backend.create({ kind: "sandbox", envs: { A: "1" } })).rejects.toThrow(/environment did not land on bx_l1 \(exit 124\)/);
  });

  it("a box that reads ready but still refuses commands while its disk streams in is asked again inside the restore budget", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/commands", { status: 409, body: ERROR(409, "box_restoring", "Box is restoring.") }, { status: 409, body: ERROR(409, "box_starting", "Box is starting.") }, COMMAND("up\n"))
      .on("PUT", "/boxes/bx_tumrjngm/files", { status: 409, body: ERROR(409, "box_restoring", "Box is restoring.") }, { status: 200, body: { ok: true } });
    const { machine, clock } = machineOn(api);
    const before = clock.at;
    expect(await machine.exec("echo up")).toEqual({ exitCode: 0, stdout: "up\n", stderr: "" });
    expect(api.calls().filter(c => c.endsWith("/commands"))).toHaveLength(3);
    expect(clock.at - before).toBeGreaterThanOrEqual(20);
    await machine.putBytes("/tmp/x", new Uint8Array([1]));
    expect(api.calls().filter(c => c.endsWith("/files"))).toHaveLength(2);
    // Past the budget the refusal is the caller's, in the provider's words.
    const stuck = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", { status: 409, body: ERROR(409, "box_restoring", "Box is restoring.") });
    await expect(machineOn(stuck).machine.exec("true")).rejects.toMatchObject({ code: "box_restoring" });
    expect(stuck.calls().length).toBeGreaterThan(5);
  });

  it("a box that reads ready and answers 502 to its first commands is asked again at the poll pace inside the restore budget, and past it the 502 is the caller's", async () => {
    const gateway = { status: 502, body: ERROR(502, "bad_gateway", "Bad Gateway") };
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/commands", gateway, gateway, gateway, gateway, gateway, COMMAND("up\n"))
      .on("PUT", "/boxes/bx_tumrjngm/files", gateway, gateway, gateway, gateway, gateway, { status: 200, body: { ok: true } });
    const { backend, clock } = backendOn(api, "trial", { restoreMs: 10_000 });
    const machine = new BoxMachine(backend, "bx_tumrjngm", "sandbox");
    const before = clock.at;
    expect(await machine.exec("echo up")).toEqual({ exitCode: 0, stdout: "up\n", stderr: "" });
    expect(api.calls().filter(c => c.endsWith("/commands"))).toHaveLength(6);
    expect(clock.at - before).toBeGreaterThanOrEqual(10);
    await machine.putBytes("/tmp/x", new Uint8Array([1]));
    expect(api.calls().filter(c => c.endsWith("/files"))).toHaveLength(6);
    // Past the budget the gateway answer is the caller's, in the kind the engine reads it as.
    const stuck = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", gateway);
    const { backend: stuckBackend } = backendOn(stuck, "trial", { restoreMs: 10_000 });
    await expect(new BoxMachine(stuckBackend, "bx_tumrjngm", "sandbox").exec("true")).rejects.toMatchObject({ kind: "transient", status: 502 });
    expect(stuck.calls().filter(c => c.endsWith("/commands")).length).toBeGreaterThan(5);
    // A refusal that is neither the restore conflicts nor a gateway status is the caller's after one round.
    const refused = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", { status: 400, body: ERROR(400, "invalid_timeout", "timeoutSeconds must be between 1 and 600.") });
    await expect(machineOn(refused).machine.exec("true")).rejects.toMatchObject({ kind: "unknown", code: "invalid_timeout" });
    expect(refused.calls().filter(c => c.endsWith("/commands"))).toHaveLength(1);
  });

  it("a refusal is the provider's own envelope: the code, the message and the request id, as the engine's kinds", async () => {
    const api = new FakeBox().on("POST", "/boxes", { status: 429, body: ERROR(429, "rate_limited", "Too many machine starts this minute.") });
    const { backend } = backendOn(api);
    const e = await backend.create({ kind: "sandbox" }).catch((err: unknown) => err) as { kind: string; code: string; message: string; requestId: string; status: number };
    expect(e).toMatchObject({ kind: "concurrency", status: 429, code: "rate_limited", message: "Too many machine starts this minute.", requestId: "req_b603629401be48d082e623575a1b9111" });
    const bad = new FakeBox().on("GET", "/limits", { status: 401, body: ERROR(401, "unauthorized", "invalid api key") });
    const refused = new BoxBackend({ apiKey: "box_wrong", fetch: bad.fetch });
    await expect(refused.checkKey()).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("the concurrent-box cap is the concurrency kind whatever status carries it, so the seal kills the builder and the row names the holders", async () => {
    const trial = new FakeBox().on("POST", "/boxes", { status: 403, body: ERROR(403, "trial_limit", "Trial accounts can run 2 concurrent boxes. End the trial or buy a pack after subscribing to move to 100 concurrent boxes.") });
    await expect(backendOn(trial).backend.create({ kind: "sandbox" })).rejects.toMatchObject({ kind: "concurrency", status: 403, code: "trial_limit" });
    const plan = new FakeBox().on("POST", "/boxes", { status: 429, body: ERROR(429, "limit_reached", "Concurrent box limit reached.") });
    await expect(backendOn(plan).backend.create({ kind: "sandbox" })).rejects.toMatchObject({ kind: "concurrency", code: "limit_reached" });
    // A refusal about something else keeps its own kind.
    const forbidden = new FakeBox().on("POST", "/boxes", { status: 403, body: ERROR(403, "trial_machine_class_not_allowed", "large was requested on a trial account.") });
    await expect(backendOn(forbidden).backend.create({ kind: "sandbox", cpu: 8, memMb: 16384 })).rejects.toMatchObject({ kind: "plan", code: "trial_machine_class_not_allowed" });
  });

  it("checks the key against the account's limits and nothing else", async () => {
    const api = new FakeBox();
    const { backend } = backendOn(api);
    await backend.checkKey();
    expect(api.calls()).toEqual(["GET /limits"]);
  });

  it("runs every command as root through sudo under the exec environment, with the timeout in seconds", async () => {
    const api = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", COMMAND("hi\n"), COMMAND("", null, { timedOut: true, signal: "SIGTERM" }), { status: 409, body: ERROR(409, "machine_not_running", "Box machine is not running.") });
    const { machine } = machineOn(api);
    expect(await machine.exec("echo hi")).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    const sent = api.took("POST", "/boxes/bx_tumrjngm/commands")!.body as { command: string; timeoutSeconds: number };
    expect(sent.command).toBe(sudoCommand("echo hi"));
    expect(sent.command).toMatch(/^sudo -n bash -c '/);
    expect(inner(sent.command).split("\n")).toEqual(["unset SUDO_USER SUDO_UID SUDO_GID SUDO_COMMAND", EXEC_ENV, "echo hi"]);
    expect(sent.command).toContain(EXEC_ENV);
    expect(sent.command).not.toContain("-lc");
    expect(sent.timeoutSeconds).toBe(INLINE_EXEC_MS / 1000);
    // A command the provider cut off at its timeout reads as a run past its deadline does.
    expect((await machine.exec("true", { timeoutMs: BOX_INLINE_MAX_MS })).exitCode).toBe(DEADLINE_EXIT);
    expect((api.seen.at(-1)!.body as { timeoutSeconds: number }).timeoutSeconds).toBe(BOX_INLINE_MAX_MS / 1000);
    // A box that is not running refuses the command; that is the provider's signal and it is thrown as itself.
    await expect(machine.exec("true")).rejects.toMatchObject({ kind: "conflict", code: "machine_not_running" });
  });

  it("an exec asked for longer than the edge allows goes through the detached road, and no command sent carries more than the inline cap", async () => {
    const api = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", (seen: Seen) => {
      const { command, timeoutSeconds } = seen.body as { command: string; timeoutSeconds: number };
      // The edge cuts a long request itself, whatever the command asked for.
      if (timeoutSeconds > 30) return { status: 504, body: ERROR(504, "request_timeout", "Request timeout after 69998ms") };
      if (command.includes("WSP_LAUNCHED")) return COMMAND("WSP_LAUNCHED\n");
      if (command.includes("WSP_POLL")) return COMMAND(`WSP_POLL\n0\n${Buffer.from("late\n").toString("base64")}\n\ndown\nWSP_POLL_END\n`);
      return COMMAND("");
    });
    const { machine } = machineOn(api);
    expect(await machine.exec("sleep 100; echo late", { timeoutMs: 300_000 })).toEqual({ exitCode: 0, stdout: "late\n", stderr: "" });
    const asked = api.seen.filter(s => s.path.endsWith("/commands")).map(s => (s.body as { timeoutSeconds: number }).timeoutSeconds);
    expect(asked.length).toBeGreaterThan(1);
    expect(Math.max(...asked)).toBeLessThanOrEqual(BOX_INLINE_MAX_MS / 1000);
    // The script the caller asked for travelled as the launched file's text, not as one long request.
    const launch = api.seen.find(s => (s.body as { command?: string }).command?.includes("WSP_LAUNCHED") === true)!;
    expect(Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(inner((launch.body as { command: string }).command))![1]!, "base64").toString()).toBe("sleep 100; echo late");
    // Nothing is left on the guest: the run cleans up after itself.
    expect(api.seen.some(s => (s.body as { command?: string }).command?.includes("rm -rf") === true)).toBe(true);
  });

  it("a command road whose shell dies on the open-file limit is the provider's fault, not a command that failed", async () => {
    const api = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", COMMAND("", 127, { stderr: "bash: error while loading shared libraries: libtinfo.so.6: cannot open shared object file: Error 24\n" }));
    const { machine } = machineOn(api);
    const e = await machine.exec("true").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(GuestUnusableError);
    expect((e as Error).message).toContain("Box by ASCII left bx_tumrjngm running but nothing on it can run");
    expect((e as Error).message).toContain("libtinfo.so.6");
    expect((e as GuestUnusableError).status).toBe(200);
    // A command of its own that fails, even with a loader error of its own kind, is still a command's exit code.
    const ordinary = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", COMMAND("", 127, { stderr: "bash: nosuchthing: command not found\n" }));
    expect((await machineOn(ordinary).machine.exec("nosuchthing")).exitCode).toBe(127);
    // So is a child of the command that hits the same limit: the line is the box's only when what wsp starts died.
    const child = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", COMMAND("", 127, { stderr: "gh: error while loading shared libraries: libssl.so.3: cannot open shared object file: Error 24\n" }));
    expect((await machineOn(child).machine.exec("gh auth status")).exitCode).toBe(127);
    // The sudo that wraps every command is wsp's own and runs under the same limit, so it is the box's fault too.
    const wrapper = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", COMMAND("", 127, { stderr: "sudo: error while loading shared libraries: libaudit.so.1: cannot open shared object file: Error 24\n" }));
    await expect(machineOn(wrapper).machine.exec("true")).rejects.toBeInstanceOf(GuestUnusableError);
  });

  it("a commands endpoint that answers 500 because its agent could not spawn the shell is the same fault, with the agent's words", async () => {
    const api = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", { status: 500, body: ERROR(500, "internal_error", "undefined is not an object (evaluating 'D.stdout.on')") });
    const { machine } = machineOn(api);
    const e = await machine.exec("true").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(GuestUnusableError);
    expect((e as Error).message).toBe("Box by ASCII left bx_tumrjngm running but nothing on it can run: undefined is not an object (evaluating 'D.stdout.on')");
    // The status the provider answered with rides along: a caller that keys its creates spends the key on it.
    expect((e as GuestUnusableError).status).toBe(500);
    // Every other refusal of the endpoint keeps its own kind.
    const busy = new FakeBox().on("POST", "/boxes/bx_tumrjngm/commands", { status: 409, body: ERROR(409, "machine_not_running", "Box machine is not running.") });
    await expect(machineOn(busy).machine.exec("true")).rejects.toMatchObject({ kind: "conflict", code: "machine_not_running" });
  });

  it("a create whose box reads ready and then cannot run a command is deleted, and fails with the provider's line", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, status: "provisioning", box: BOX("bx_d1", "provisioning", { name: "wsp" }) } })
      .on("GET", "/boxes/bx_d1", INFO("bx_d1", "ready", { name: "wsp" }))
      .on("POST", "/boxes/bx_d1/commands", COMMAND("", 127, { stderr: "bash: error while loading shared libraries: libtinfo.so.6: cannot open shared object file: Error 24\n" }))
      .on("DELETE", "/boxes/bx_d1", { status: 202, body: { ok: true, operation: { id: "bdop_d" } } });
    const { backend } = backendOn(api);
    const e = await backend.create({ kind: "sandbox" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(GuestUnusableError);
    expect((e as Error).message).toContain("Box by ASCII left bx_d1 running but nothing on it can run");
    expect(api.calls().filter(c => c.startsWith("DELETE"))).toEqual(["DELETE /boxes/bx_d1"]);
  });

  it("a healthy create proves the road once, after the box reads ready and before the name and the environment", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, status: "provisioning", box: BOX("bx_p1", "provisioning", { name: "wsp-mac-default-v1" }) } })
      .on("GET", "/boxes/bx_p1", INFO("bx_p1", "ready", { name: "wsp-mac-default-v1" }))
      .on("PATCH", "/boxes/bx_p1", INFO("bx_p1", "ready", { name: "wsp" }))
      .on("POST", "/boxes/bx_p1/commands", COMMAND(""), detachedGuest());
    const { backend } = backendOn(api);
    await backend.create({ kind: "sandbox", fromSnapshot: "wsp-mac-default-v1", envs: { A: "1" } });
    expect(api.calls()).toEqual([
      "GET /limits",
      "POST /boxes",
      "GET /boxes/bx_p1",
      "POST /boxes/bx_p1/commands",
      "PATCH /boxes/bx_p1",
      "POST /boxes/bx_p1/commands",
      "POST /boxes/bx_p1/commands",
      "POST /boxes/bx_p1/commands",
    ]);
    expect(commandsSent(api)[0]).toBe(sudoCommand("true"));
  });

  it("a resume whose box reads ready and then cannot run a command ends the same way, so the wake reads it as a fault", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/resume", { status: 202, body: { ok: true, status: "resuming", box: BOX("bx_tumrjngm", "provisioned") } })
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "ready"))
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND("", 127, { stderr: "bash: error while loading shared libraries: libtinfo.so.6: cannot open shared object file: Error 24\n" }));
    await expect(machineOn(api).machine.resume()).rejects.toBeInstanceOf(GuestUnusableError);
  });

  it("the environment script writes the daemon's own file under /etc, one quoted line per variable, and nothing manager-wide", () => {
    const script = envLandingScript({ IS_SANDBOX: "1", PATH: "/usr/local/bin:/usr/bin", QUOTED: 'a"b\\c' });
    expect(script.split("\n")).toEqual([
      "mkdir -p '/etc/wsp'",
      `cat > '${DAEMON_ENV_FILE}' <<'WSP_ENV'`,
      'IS_SANDBOX="1"',
      'PATH="/usr/local/bin:/usr/bin"',
      'QUOTED="a\\"b\\\\c"',
      "WSP_ENV",
      `chmod 0600 '${DAEMON_ENV_FILE}'`,
    ]);
    expect(DAEMON_ENV_FILE).toBe("/etc/wsp/daemon.env");
    expect(script).not.toMatch(/DefaultEnvironment|system\.conf|set-environment/);
  });

  it("pauses with one stop and reads the box until archived; archiving is the stop under way, never a second stop, never force", async () => {
    const api = new FakeBox()
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "idle"), INFO("bx_tumrjngm", "archiving"), INFO("bx_tumrjngm", "archiving"), INFO("bx_tumrjngm", "archived"))
      .on("POST", "/boxes/bx_tumrjngm/stop", { status: 202, body: { ok: true, type: "box.stopping", id: "bx_tumrjngm", status: "archiving", box: BOX("bx_tumrjngm", "archiving") } });
    const { machine } = machineOn(api);
    await machine.pause();
    expect(api.calls()).toEqual(["GET /boxes/bx_tumrjngm", "POST /boxes/bx_tumrjngm/stop", "GET /boxes/bx_tumrjngm", "GET /boxes/bx_tumrjngm", "GET /boxes/bx_tumrjngm"]);
    expect(api.took("POST", "/boxes/bx_tumrjngm/stop")!.body).toEqual({});
  });

  it("a box already archiving or archived gets no stop at all", async () => {
    const api = new FakeBox().on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "archiving"), INFO("bx_tumrjngm", "archived"));
    const { machine } = machineOn(api);
    await machine.pause();
    expect(api.calls()).toEqual(["GET /boxes/bx_tumrjngm", "GET /boxes/bx_tumrjngm"]);
    api.on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "archived"));
    await machine.pause();
    expect(api.calls().filter(c => c.startsWith("POST"))).toEqual([]);
  });

  it("a stop the provider refuses is thrown in its words, and one it takes back leaves the machine running and the pause not taken", async () => {
    const refused = new FakeBox()
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "idle"))
      .on("POST", "/boxes/bx_tumrjngm/stop", { status: 400, body: ERROR(400, "stop_failed", "Snapshot failed; the box keeps running.") });
    await expect(machineOn(refused).machine.pause()).rejects.toMatchObject({ code: "stop_failed", message: "Snapshot failed; the box keeps running." });
    expect(refused.calls().filter(c => c.endsWith("/stop"))).toHaveLength(1);

    const undone = new FakeBox()
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "idle"), INFO("bx_tumrjngm", "archiving"), INFO("bx_tumrjngm", "idle"))
      .on("POST", "/boxes/bx_tumrjngm/stop", { status: 202, body: { ok: true, type: "box.stopping", status: "archiving", box: BOX("bx_tumrjngm", "archiving") } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const e = await machineOn(undone).machine.pause().catch((err: unknown) => err);
      expect(e).toBeInstanceOf(MoveUnansweredError);
      expect((e as Error).message).toMatch(/pause did not take: the provider left bx_tumrjngm idle/);
      expect(undone.calls().filter(c => c.endsWith("/stop"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a stop that never lands inside the budget ends the pause with the row's words, the machine still read as paused-in-progress", async () => {
    const api = new FakeBox()
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "idle"), INFO("bx_tumrjngm", "archiving"))
      .on("POST", "/boxes/bx_tumrjngm/stop", { status: 202, body: { ok: true, type: "box.stopping", status: "archiving", box: BOX("bx_tumrjngm", "archiving") } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { machine, clock } = machineOn(api);
      const before = clock.at;
      const e = await machine.pause().catch((err: unknown) => err);
      expect(e).toBeInstanceOf(MoveUnansweredError);
      expect((e as Error).message).toMatch(/^pause did not complete in .*; the provider did not answer and reads the machine paused; try again$/);
      expect(clock.at - before).toBeGreaterThanOrEqual(100);
    } finally {
      warn.mockRestore();
    }
  });

  it("resumes with the account's auto-stop and reads the box until ready; one attempt, nothing about the address kept", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/resume", { status: 202, body: { ok: true, type: "box.resuming", id: "bx_tumrjngm", status: "resuming", box: BOX("bx_tumrjngm", "provisioned") } })
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "provisioned"), INFO("bx_tumrjngm", "ready", { ip: "116.203.245.5" }))
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND(""));
    const { machine } = machineOn(api);
    await machine.resume();
    // The road every command takes is proved once the box reads ready, before the handle is anyone's to use.
    expect(api.calls()).toEqual(["GET /limits", "POST /boxes/bx_tumrjngm/resume", "GET /boxes/bx_tumrjngm", "GET /boxes/bx_tumrjngm", "POST /boxes/bx_tumrjngm/commands"]);
    expect(api.took("POST", "/boxes/bx_tumrjngm/resume")!.body).toEqual({ ttlSeconds: TRIAL_TTL_S });
    expect(JSON.stringify(machine)).not.toContain("116.203.245.5");
  });

  it("a resume arms the timer the box last had again from now, the create's window or the last backstop, and the cap where none is on record", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, status: "provisioning", box: BOX("bx_r1", "provisioning", { name: "wsp" }) } })
      .on("GET", "/boxes/bx_r1", INFO("bx_r1", "ready", { name: "wsp" }))
      .on("POST", "/boxes/bx_r1/resume", { status: 202, body: { ok: true, status: "resuming", box: BOX("bx_r1", "provisioned") } })
      .on("PATCH", "/boxes/bx_r1", INFO("bx_r1", "idle", { name: "wsp" }))
      .on("POST", "/boxes/bx_r1/commands", COMMAND(""));
    const { backend, clock } = backendOn(api, "standard");
    const machine = await backend.create({ kind: "sandbox", onIdle: "pause", idleTimeoutMs: 40 * 60_000 });
    // Hours later, with no arming since the create: the create's window, from now, not the instant that has passed.
    clock.at += 5 * 60 * 60_000;
    await machine.resume();
    expect(api.took("POST", "/boxes/bx_r1/resume")!.body).toEqual({ ttlSeconds: 40 * 60 });
    // A backstop armed since is the span a resume arms again.
    await backend.backstop(machine, clock.at + 90 * 60_000);
    clock.at += 3 * 60 * 60_000;
    await machine.resume();
    expect(api.seen.filter(s => s.path === "/boxes/bx_r1/resume").at(-1)!.body).toEqual({ ttlSeconds: 90 * 60 });
    // A handle from get() has nothing on record: the cap, which off the trial is no timer.
    api.on("POST", "/boxes/bx_r2/resume", { status: 202, body: { ok: true, status: "resuming", box: BOX("bx_r2", "provisioned") } }).on("GET", "/boxes/bx_r2", INFO("bx_r2", "ready")).on("POST", "/boxes/bx_r2/commands", COMMAND(""));
    await new BoxMachine(backend, "bx_r2", "sandbox").resume();
    expect(api.took("POST", "/boxes/bx_r2/resume")!.body).toEqual({ ttlSeconds: null });
  });

  it("a resume of a box the provider lost is missing, one that reads error names it, and one the caller stopped ends at once", async () => {
    const gone = new FakeBox().on("POST", "/boxes/bx_gone/resume", { status: 404, body: ERROR(404, "not_found", "not_found") });
    const lost = await machineOn(gone, "bx_gone").machine.resume().catch((e: unknown) => e);
    expect(isMissing(lost)).toBe(true);

    const broken = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/resume", { status: 202, body: { ok: true, status: "resuming", box: BOX("bx_tumrjngm", "provisioned") } })
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "error", { error: "restore failed" }));
    await expect(machineOn(broken).machine.resume()).rejects.toThrow(/reads error during resume: restore failed/);

    const slow = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/resume", { status: 202, body: { ok: true, status: "resuming", box: BOX("bx_tumrjngm", "provisioned") } })
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "provisioned"));
    const stop = new AbortController();
    const { machine } = machineOn(slow);
    const waiting = machine.resume(stop.signal);
    stop.abort(new Error("the person stopped waiting"));
    await expect(waiting).rejects.toThrow("the person stopped waiting");
  });

  it("a resume the caller stopped waiting on ends where the stop was, even while the probe is being refused", async () => {
    const stop = new AbortController();
    let refusals = 0;
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/resume", { status: 202, body: { ok: true, status: "resuming", box: BOX("bx_tumrjngm", "provisioned") } })
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "ready"))
      .on("POST", "/boxes/bx_tumrjngm/commands", () => {
        if (++refusals === 1) stop.abort(new Error("the person stopped waiting"));
        return { status: 502, body: ERROR(502, "bad_gateway", "Bad Gateway") };
      });
    const { backend } = backendOn(api, "trial", { restoreMs: 10_000 });
    const machine = new BoxMachine(backend, "bx_tumrjngm", "sandbox");
    await expect(machine.resume(stop.signal)).rejects.toThrow("the person stopped waiting");
    // The stop ends the probe's waiting too: no second round of commands goes to a box nobody is waiting for.
    expect(refusals).toBeLessThanOrEqual(ROAD_TRIES);
  });

  it("routes the daemon's port public with no firewall call, since the provider opens its own firewall for a public route and the daemon's token is the gate", async () => {
    const api = new FakeBox().on("POST", "/boxes/bx_tumrjngm/host", { status: 200, body: { ok: true, type: "port.hosted", success: true, port: 7070, url: "https://box-node-f06a49ff29e4ed7a-7070.on.ascii.dev", isProtected: false, access: "public" } });
    const { machine } = machineOn(api);
    const reach = await machine.previewUrl(7070);
    expect(reach).toEqual({ url: "https://box-node-f06a49ff29e4ed7a-7070.on.ascii.dev", token: "", expiresAt: Number.MAX_SAFE_INTEGER });
    expect(api.calls()).toEqual(["POST /boxes/bx_tumrjngm/host"]);
    expect(api.took("POST", "/boxes/bx_tumrjngm/host")!.body).toEqual({ port: 7070, public: true });
  });

  it("mints a private route for any other port once the guest firewall rule stands; the token rides in the query and never expires", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND(""))
      .on("POST", "/boxes/bx_tumrjngm/host", { status: 200, body: { ok: true, type: "port.hosted", success: true, port: 3000, url: "https://box-node-f06a49ff29e4ed7a-3000.on.ascii.dev?_token=tok_abc", isProtected: true, access: "private" } });
    const { machine } = machineOn(api);
    const reach = await machine.previewUrl(3000);
    expect(reach).toEqual({ url: "https://box-node-f06a49ff29e4ed7a-3000.on.ascii.dev?_token=tok_abc", token: "tok_abc", expiresAt: Number.MAX_SAFE_INTEGER });
    expect(api.calls()).toEqual(["POST /boxes/bx_tumrjngm/commands", "POST /boxes/bx_tumrjngm/host"]);
    expect(inner((api.took("POST", "/boxes/bx_tumrjngm/commands")!.body as { command: string }).command)).toContain("ufw status | grep -q '^3000/tcp '");
    expect(api.took("POST", "/boxes/bx_tumrjngm/host")!.body).toEqual({ port: 3000, public: false });
  });

  it("mints the route with one read when the firewall rule already stands", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND(""))
      .on("POST", "/boxes/bx_tumrjngm/host", { status: 200, body: { ok: true, port: 3000, url: "https://sulu-axioms-gelant-3000.on.ascii.dev?_token=t2", isProtected: true, access: "private" } });
    const { machine } = machineOn(api);
    expect((await machine.previewUrl(3000)).token).toBe("t2");
    const commands = api.seen.filter(s => s.path.endsWith("/commands")).map(s => inner((s.body as { command: string }).command).split("\n").at(-1));
    expect(commands).toEqual(["ufw status | grep -q '^3000/tcp '"]);
  });

  it("a rule the box's own agent wipes after boot is added again and held until it has stood for the hold window", async () => {
    // The box answers, in order: no rule; the add; a read that finds it; a read that finds it gone (the agent's
    // rewrite); the add again; then reads that keep finding it until the hold window is over.
    const script = [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const api = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/commands", ...script.map(code => COMMAND("", code)))
      .on("POST", "/boxes/bx_tumrjngm/host", { status: 200, body: { ok: true, port: 3000, url: "https://sulu-axioms-gelant-3000.on.ascii.dev?_token=t2", isProtected: true, access: "private" } });
    const { machine, clock } = machineOn(api);
    const before = clock.at;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await machine.previewUrl(3000)).token).toBe("t2");
      // The hold was real: the loop returned because the second add stood for the whole window, not because a
      // deadline counted from the start ran out under it.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    const commands = api.seen.filter(s => s.path.endsWith("/commands")).map(s => inner((s.body as { command: string }).command).split("\n").at(-1));
    expect(commands.filter(c => c === "ufw allow 3000/tcp")).toHaveLength(2);
    expect(commands[0]).toBe("ufw status | grep -q '^3000/tcp '");
    expect(commands[1]).toBe("ufw allow 3000/tcp");
    expect(commands[3]).toBe("ufw status | grep -q '^3000/tcp '");
    expect(commands[4]).toBe("ufw allow 3000/tcp");
    // Two adds five seconds of watching apart, then a full hold after the second: the loop ran past the first add's
    // hold window by the whole of the second's.
    expect(clock.at - before).toBeGreaterThanOrEqual(2 * FIREWALL_WATCH_MS + FIREWALL_HOLD_MS);
    expect(api.calls().at(-1)).toBe("POST /boxes/bx_tumrjngm/host");
  });

  it("a rule the guest refuses while it boots is asked for again; one that never holds is said once and the route minted anyway", async () => {
    const early = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND("", 1), COMMAND("", 1, { stderr: "ERROR: problem running ufw-init" }), COMMAND("", 1, { stderr: "ERROR: problem running ufw-init" }), COMMAND("Rule added\n"), COMMAND(""))
      .on("POST", "/boxes/bx_tumrjngm/host", { status: 200, body: { ok: true, port: 3000, url: "https://sulu-axioms-gelant-3000.on.ascii.dev?_token=t2", isProtected: true, access: "private" } });
    const { machine } = machineOn(early);
    expect((await machine.previewUrl(3000)).token).toBe("t2");
    const commands = early.seen.filter(s => s.path.endsWith("/commands")).map(s => inner((s.body as { command: string }).command).split("\n").at(-1));
    expect(commands.slice(0, 4)).toEqual(["ufw status | grep -q '^3000/tcp '", "ufw allow 3000/tcp", "ufw allow 3000/tcp", "ufw allow 3000/tcp"]);

    const never = new FakeBox()
      .on("POST", "/boxes/bx_tumrjngm/commands", { status: 409, body: ERROR(409, "machine_not_running", "Box machine is not running.") })
      .on("POST", "/boxes/bx_tumrjngm/host", { status: 200, body: { ok: true, port: 3000, url: "https://sulu-axioms-gelant-3000.on.ascii.dev?_token=t3", isProtected: true, access: "private" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { machine: stuck } = machineOn(never);
      expect((await stuck.previewUrl(3000)).token).toBe("t3");
      expect(never.calls().filter(c => c.endsWith("/commands")).length).toBeGreaterThan(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/firewall did not hold a rule for port 3000 \(Box machine is not running\.\)/);
    } finally {
      warn.mockRestore();
    }
  });

  it("puts bytes through PUT /files: straight into /tmp, and by way of /tmp into root's folders under sudo", async () => {
    const api = new FakeBox()
      .on("PUT", "/boxes/bx_tumrjngm/files", { status: 200, body: { ok: true, type: "file.written", success: true, path: "../../tmp/x", encoding: "base64", size: 3 } })
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND(""));
    const { machine } = machineOn(api);
    await machine.putBytes("/tmp/wsp-ping.sh", new Uint8Array([1, 2, 3]));
    expect(api.took("PUT", "/boxes/bx_tumrjngm/files")!.body).toEqual({ path: "/tmp/wsp-ping.sh", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" });
    expect(api.calls()).toEqual(["PUT /boxes/bx_tumrjngm/files"]);

    await machine.putBytes("/root/wsp-daemon.tgz", new Uint8Array([4, 5]));
    const staged = api.seen.at(-2)!.body as { path: string };
    expect(staged.path).toMatch(/^\/tmp\/wsp-put-[0-9a-f]{12}\.0$/);
    const joined = inner((api.seen.at(-1)!.body as { command: string }).command);
    expect(joined).toContain(`cat '${staged.path}' > '/root/wsp-daemon.tgz' && chmod 0644 '/root/wsp-daemon.tgz' && rm -f '${staged.path}'`);
    expect(joined).toContain("mkdir -p '/root'");
    expect(joined).toContain(`[ "$(stat -c %s '/root/wsp-daemon.tgz')" = 2 ]`);
  });

  it("bytes past the files endpoint's cap go up in pieces under the cap and are joined into place, the size read back; a join that fails says why", async () => {
    const api = new FakeBox()
      .on("PUT", "/boxes/bx_tumrjngm/files", { status: 200, body: { ok: true } })
      .on("POST", "/boxes/bx_tumrjngm/commands", COMMAND(""), COMMAND("WSP_SHORT 5242880\n", 1));
    const { machine } = machineOn(api);
    const big = new Uint8Array(2 * FILE_PUT_MAX + 7);
    big[FILE_PUT_MAX] = 9;
    await machine.putBytes("/tmp/big.tgz", big);
    const puts = api.seen.filter(s => s.method === "PUT").map(s => s.body as { path: string; content: string });
    expect(puts.map(p => Buffer.from(p.content, "base64").length)).toEqual([FILE_PUT_MAX, FILE_PUT_MAX, 7]);
    expect(Buffer.from(puts[1]!.content, "base64")[0]).toBe(9);
    expect(puts.map(p => p.path.replace(/wsp-put-[0-9a-f]{12}/, "wsp-put-X"))).toEqual(["/tmp/wsp-put-X.0", "/tmp/wsp-put-X.1", "/tmp/wsp-put-X.2"]);
    const joined = inner((api.seen.at(-1)!.body as { command: string }).command);
    expect(joined).toContain(`cat '${puts[0]!.path}' '${puts[1]!.path}' '${puts[2]!.path}' > '/tmp/big.tgz'`);
    expect(joined).toContain(`= ${2 * FILE_PUT_MAX + 7} ]`);
    // Sent again after a 502 that may have run it once already, the join finds the target at its size and is done
    // before it opens the target or misses the pieces.
    expect(joined.split("\n")[2]).toBe(`[ "$(stat -c %s '/tmp/big.tgz' 2>/dev/null)" = ${2 * FILE_PUT_MAX + 7} ] && exit 0`);
    await expect(machine.putBytes("/root/x", new Uint8Array(FILE_PUT_MAX + 1))).rejects.toThrow(/\/root\/x did not land on bx_tumrjngm \(exit 1\): WSP_SHORT 5242880/);
  });

  it("a snapshot is a named snapshot from any life of the box, answered with its name once the provider reads it ready", async () => {
    const api = new FakeBox()
      .on("POST", "/named-snapshots", { status: 202, body: { ok: true, type: "snapshot.named.saving", status: "saving", snapshot: NAMED("wsp-mac-default-v1", "saving") } })
      .on("GET", "/named-snapshots/wsp-mac-default-v1", { status: 200, body: { ok: true, snapshot: NAMED("wsp-mac-default-v1", "saving") } }, { status: 200, body: { ok: true, snapshot: NAMED("wsp-mac-default-v1", "ready") } });
    const { machine } = machineOn(api);
    expect(await machine.snapshot(goldenName("mac", "default", 1), { firstLife: false })).toBe("wsp-mac-default-v1");
    expect(api.took("POST", "/named-snapshots")!.body).toEqual({ boxId: "bx_tumrjngm", name: "wsp-mac-default-v1" });
    expect(api.calls()).toEqual(["POST /named-snapshots", "GET /named-snapshots/wsp-mac-default-v1", "GET /named-snapshots/wsp-mac-default-v1"]);
  });

  it("a save the provider fails, or one still saving at the budget, is a failure in its words", async () => {
    const failed = new FakeBox()
      .on("POST", "/named-snapshots", { status: 202, body: { ok: true, status: "saving", snapshot: NAMED("wsp-mac-default-v2", "saving") } })
      .on("GET", "/named-snapshots/wsp-mac-default-v2", { status: 200, body: { ok: true, snapshot: NAMED("wsp-mac-default-v2", "failed", { error: "capture timed out" }) } });
    await expect(machineOn(failed).machine.snapshot("wsp-mac-default-v2", { firstLife: true })).rejects.toThrow(/wsp-mac-default-v2 of bx_tumrjngm failed: capture timed out/);
    const slow = new FakeBox()
      .on("POST", "/named-snapshots", { status: 202, body: { ok: true, status: "saving", snapshot: NAMED("wsp-mac-default-v3", "saving") } })
      .on("GET", "/named-snapshots/wsp-mac-default-v3", { status: 200, body: { ok: true, snapshot: NAMED("wsp-mac-default-v3", "saving") } });
    await expect(machineOn(slow).machine.snapshot("wsp-mac-default-v3", { firstLife: true })).rejects.toThrow(/still reads saving/);
  });

  it("a named snapshot is the template: promoting answers the name, and the template reads the snapshot's own status", async () => {
    const api = new FakeBox()
      .on("GET", "/named-snapshots/wsp-mac-default-v1", { status: 200, body: { ok: true, type: "snapshot.named.info", snapshot: NAMED("wsp-mac-default-v1", "ready") } })
      .on("GET", "/named-snapshots/wsp-mac-default-v2", { status: 200, body: { ok: true, snapshot: NAMED("wsp-mac-default-v2", "saving") } })
      .on("GET", "/named-snapshots/wsp-mac-default-v3", { status: 200, body: { ok: true, snapshot: NAMED("wsp-mac-default-v3", "failed", { error: "capture timed out" }) } })
      .on("GET", "/named-snapshots", { status: 200, body: { ok: true, type: "snapshot.named.list", snapshots: [NAMED("wsp-mac-default-v1", "ready")] } })
      .on("DELETE", "/named-snapshots/wsp-mac-default-v1", { status: 200, body: { ok: true, type: "snapshot.named.deleted", name: "wsp-mac-default-v1" } });
    const { backend } = backendOn(api);
    expect(await backend.promoteSnapshot("wsp-mac-default-v1", "wsp-mac-default-v1")).toBe("wsp-mac-default-v1");
    expect(await backend.getTemplate("wsp-mac-default-v1")).toEqual({ id: "wsp-mac-default-v1", name: "wsp-mac-default-v1", status: "ready", createdAt: "2026-09-11T06:47:23.959Z" });
    expect(await backend.getTemplate("wsp-mac-default-v2")).toMatchObject({ status: "building" });
    expect(await backend.getTemplate("wsp-mac-default-v3")).toMatchObject({ status: "failed", error: "capture timed out" });
    expect(await backend.listTemplates()).toEqual([{ id: "wsp-mac-default-v1", name: "wsp-mac-default-v1", status: "ready", createdAt: "2026-09-11T06:47:23.959Z" }]);
    await backend.deleteTemplate("wsp-mac-default-v1");
    expect(api.calls().at(-1)).toBe("DELETE /named-snapshots/wsp-mac-default-v1");
    // A template the provider no longer holds is deleted already.
    await backend.deleteTemplate("wsp-mac-default-v9");
    // The promote made no call: the name was durable the moment the save read ready.
    expect(api.calls().filter(c => c.startsWith("POST"))).toEqual([]);
  });

  it("lists every snapshot with its size: the named ones under their names, and the provider's own history nameless", async () => {
    const api = new FakeBox()
      .on("GET", "/named-snapshots", { status: 200, body: { ok: true, snapshots: [NAMED("wsp-mac-default-v1", "ready")] } })
      .on("GET", "/snapshots", seen => {
        const first = seen.query.get("cursor") === null;
        return {
          status: 200,
          body: {
            ok: true,
            type: "snapshot.list",
            snapshots: first
              ? [{ id: "866f04de-8e8a-4401-9e29-cf58e1738213", boxId: "bx_tumrjngm", status: "completed", kind: "incremental", generation: 4, chainId: "d9365279-5b40-4860-85b4-4a168a878da1", createdAt: "2026-09-11T06:32:52.039Z", completedAt: "2026-09-11T06:32:53.272Z", sizeBytes: 343, fileCount: 2 }]
              : [{ id: "1826c6c1-6f77-4beb-8406-93f9e27281a2", boxId: "bx_tumrjngm", status: "completed", kind: "noop", generation: null, chainId: null, createdAt: "2026-09-11T06:55:43.354Z", completedAt: "2026-09-11T06:55:43.547Z", sizeBytes: null }],
            pageInfo: { nextCursor: first ? "c2" : null, hasMore: first, limit: 200 },
          },
        };
      });
    const { backend } = backendOn(api);
    expect(await backend.listSnapshots()).toEqual([
      { id: "wsp-mac-default-v1", name: "wsp-mac-default-v1", sizeBytes: 1255755776, createdAt: "2026-09-11T06:47:23.959Z" },
      { id: "866f04de-8e8a-4401-9e29-cf58e1738213", sizeBytes: 343, createdAt: "2026-09-11T06:32:53.272Z", parent: "d9365279-5b40-4860-85b4-4a168a878da1" },
      { id: "1826c6c1-6f77-4beb-8406-93f9e27281a2", sizeBytes: 0, createdAt: "2026-09-11T06:55:43.547Z", parent: null },
    ]);
    expect(api.seen.filter(s => s.path === "/snapshots").map(s => s.query.get("cursor"))).toEqual([null, "c2"]);
    const other = new FakeBox().on("GET", "/named-snapshots", { status: 200, body: { ok: true, items: [] } });
    await expect(backendOn(other).backend.listSnapshots()).rejects.toThrow("GET /named-snapshots answered without a snapshots array");
  });

  it("deletes a snapshot by what its id is: the provider's history with the confirm header, a named one by name, and one already gone is done", async () => {
    const api = new FakeBox()
      .on("DELETE", "/snapshots/866f04de-8e8a-4401-9e29-cf58e1738213", { status: 202, body: { ok: true } })
      .on("DELETE", "/named-snapshots/wsp-mac-default-v1", { status: 200, body: { ok: true } });
    const { backend } = backendOn(api);
    await backend.deleteSnapshot("866f04de-8e8a-4401-9e29-cf58e1738213");
    expect(api.seen.at(-1)!.headers["x-ascii-confirm-delete"]).toBe("866f04de-8e8a-4401-9e29-cf58e1738213");
    await backend.deleteSnapshot("wsp-mac-default-v1");
    await backend.deleteSnapshot("wsp-mac-default-v7");
    expect(api.calls()).toEqual(["DELETE /snapshots/866f04de-8e8a-4401-9e29-cf58e1738213", "DELETE /named-snapshots/wsp-mac-default-v1", "DELETE /named-snapshots/wsp-mac-default-v7"]);
    const refused = new FakeBox().on("DELETE", "/named-snapshots/wsp-mac-default-v1", { status: 409, body: ERROR(409, "save_in_progress", "a save under this name is still running") });
    await expect(backendOn(refused).backend.deleteSnapshot("wsp-mac-default-v1")).rejects.toMatchObject({ code: "save_in_progress" });
  });

  it("kills with the confirm header, keeps the operation id, and takes a box already gone as killed", async () => {
    const api = new FakeBox().on("DELETE", "/boxes/bx_tumrjngm", {
      status: 202,
      body: { ok: true, type: "box.deleting", operation: { id: "bdop_e35decb98f414320a0da76eb36fbf98d", kind: "box", targetId: "bx_tumrjngm", reason: "explicit", status: "pending", attemptCount: 0 } },
    });
    const { machine } = machineOn(api);
    await machine.kill();
    expect(api.took("DELETE", "/boxes/bx_tumrjngm")!.headers["x-ascii-confirm-delete"]).toBe("bx_tumrjngm");
    expect(machine.deletion).toBe("bdop_e35decb98f414320a0da76eb36fbf98d");
    // Nothing waits on the operation: the box is gone from GET within seconds while the operation reads blocked.
    expect(api.calls()).toEqual(["DELETE /boxes/bx_tumrjngm"]);
    const gone = new FakeBox().on("DELETE", "/boxes/bx_gone", { status: 404, body: ERROR(404, "not_found", "not_found") });
    await machineOn(gone, "bx_gone").machine.kill();
  });

  it("a delete is done when GET reads the box gone on every read in a row: a 404 and then the box running asks for the delete again", async () => {
    const deleting = { status: 202, body: { ok: true, type: "box.deleting", operation: { id: "bdop_1" } } };
    const missing = { status: 404, body: ERROR(404, "not_found", "not_found") };
    const api = new FakeBox().on("DELETE", "/boxes/bx_tumrjngm", deleting).on("GET", "/boxes/bx_tumrjngm", missing, INFO("bx_tumrjngm", "running"), missing);
    const { backend, machine } = machineOn(api);
    await killUntilGone(backend, machine, { graceMs: 50, pollMs: 1 });
    const calls = api.calls();
    expect(calls.filter(c => c.startsWith("DELETE"))).toHaveLength(2);
    expect(calls.slice(calls.lastIndexOf("DELETE /boxes/bx_tumrjngm") + 1)).toEqual(Array(GONE_READS).fill("GET /boxes/bx_tumrjngm"));
  });

  it("reads the provider's states onto the machine's four, a box it lost as gone", async () => {
    const api = new FakeBox();
    const { machine } = machineOn(api);
    for (const [theirs, ours] of [["init", "starting"], ["provisioning", "starting"], ["provisioned", "starting"], ["cloning", "starting"], ["ready", "running"], ["idle", "running"], ["running", "running"], ["archiving", "paused"], ["archived", "paused"], ["error", "gone"]] as const) {
      api.on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", theirs));
      expect(await machine.state(), theirs).toBe(ours);
    }
    api.on("GET", "/boxes/bx_tumrjngm", { status: 404, body: ERROR(404, "not_found", "not_found") });
    expect(await machine.state()).toBe("gone");
  });

  it("a state the table never learned reads running on the machine, its handle and the listing, so a delete never reads it gone", async () => {
    const api = new FakeBox()
      .on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "deleting"))
      .on("GET", "/boxes", seen => ({ status: 200, body: { ok: true, type: "box.list", boxes: seen.query.get("state") === "archived" ? [] : [BOX("bx_tumrjngm", "deleting", { name: "wsp" })], pageInfo: { nextCursor: null, hasMore: false, limit: 200 } } }))
      .on("DELETE", "/boxes/bx_tumrjngm", { status: 202, body: { ok: true, operation: { id: "bdop_1" } } });
    const { backend, machine } = machineOn(api);
    expect(await machine.state()).toBe("running");
    expect((await backend.get("bx_tumrjngm")).seen?.state).toBe("running");
    expect((await backend.list()).map(m => m.state)).toEqual(["running"]);
    await expect(killUntilGone(backend, machine, { graceMs: 5, pollMs: 1 })).rejects.toMatchObject({ kind: "machineAlive", state: "running" });
  });

  it("describes the class the box runs as, its disk the class floor, and its creation time", async () => {
    const api = new FakeBox().on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "idle", { type: "default", vcpu: 4, memoryGB: 8 }));
    const { machine } = machineOn(api);
    expect(await machine.describe()).toEqual({ cpu: 4, memMb: 8192, diskGb: 80, createdAt: "2026-09-11T06:28:06.053Z" });
  });

  it("get() reads the labels off the name and what the provider saw", async () => {
    const api = new FakeBox().on("GET", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "archived", { name: "wsp;o=h_1a2b3c4d;w=ws_1" }));
    const { backend } = backendOn(api);
    const machine = await backend.get("bx_tumrjngm");
    expect(machine.labels).toEqual({ [WSP_LABEL]: "1", [OWNER_LABEL]: "h_1a2b3c4d", [WORKSPACE_LABEL]: "ws_1" });
    expect(machine.seen).toEqual({ state: "paused", createdAt: "2026-09-11T06:28:06.053Z" });
  });

  it("lists wsp's boxes alone off both listings, the plain one and the archived one, a box on both once, by the labels asked for, following the cursor", async () => {
    // The plain listing as the spike read it at 20f: an archived box beside an idle one. The archived listing as it
    // read it at 26d, with the boxes the plain one may leave out on another day.
    const api = new FakeBox().on("GET", "/boxes", seen => {
      if (seen.query.get("state") === "archived") {
        return { status: 200, body: { ok: true, type: "box.list", boxes: [BOX("bx_s24x3q6e", "archived", { name: "wsp;o=h_1a2b3c4d;w=ws_1" }), BOX("bx_napping", "archived", { name: "wsp;o=h_1a2b3c4d;w=ws_2" })], pageInfo: { nextCursor: null, hasMore: false, limit: 200 } } };
      }
      const first = seen.query.get("cursor") === null;
      return {
        status: 200,
        body: {
          ok: true,
          type: "box.list",
          boxes: first
            ? [BOX("bx_s24x3q6e", "archived", { name: "wsp;o=h_1a2b3c4d;w=ws_1" }), BOX("bx_other", "idle", { name: "Box 2026-09-11 06:28" })]
            : [BOX("bx_tumrjngm", "idle", { name: "wsp;o=h_1a2b3c4d;b=1", type: "default", vcpu: 4, memoryGB: 8 }), BOX("bx_theirs", "idle", { name: "wsp;o=h_other" })],
          pageInfo: { nextCursor: first ? "c2" : null, hasMore: first, limit: 200 },
        },
      };
    });
    const { backend } = backendOn(api);
    expect(await backend.list({ [OWNER_LABEL]: "h_1a2b3c4d" })).toEqual([
      { id: "bx_s24x3q6e", state: "paused", labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: "h_1a2b3c4d", [WORKSPACE_LABEL]: "ws_1" }, size: { cpu: 2, memMb: 4096 } },
      { id: "bx_tumrjngm", state: "running", labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: "h_1a2b3c4d", [BUILDER_LABEL]: "1" }, size: { cpu: 4, memMb: 8192 } },
      { id: "bx_napping", state: "paused", labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: "h_1a2b3c4d", [WORKSPACE_LABEL]: "ws_2" }, size: { cpu: 2, memMb: 4096 } },
    ]);
    expect(api.seen.map(s => [s.query.get("limit"), s.query.get("cursor"), s.query.get("state")])).toEqual([["200", null, null], ["200", "c2", null], ["200", null, "archived"]]);
    expect((await backend.list()).map(r => r.id)).toEqual(["bx_s24x3q6e", "bx_tumrjngm", "bx_theirs", "bx_napping"]);
  });

  it("pushes the provider's stop timer to the runtime's backstop instant, capped by the trial, once a minute at most", async () => {
    const api = new FakeBox().on("PATCH", "/boxes/bx_tumrjngm", seen => INFO("bx_tumrjngm", "idle", { archiveAfter: new Date((seen.body as { ttlSeconds: number }).ttlSeconds * 1000).toISOString() }));
    const { backend, machine, clock } = machineOn(api);
    await backend.lifecycle.backstop!(machine, clock.at + 40 * 60_000);
    expect(api.took("PATCH", "/boxes/bx_tumrjngm")!.body).toEqual({ ttlSeconds: 40 * 60 });
    // Armed again a few seconds later on a streamed chunk: not worth a call.
    clock.at += 5_000;
    await backend.lifecycle.backstop!(machine, clock.at + 40 * 60_000);
    expect(api.calls().filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    // Past the slack it is.
    clock.at += BACKSTOP_SLACK_MS;
    await backend.lifecycle.backstop!(machine, clock.at + 40 * 60_000);
    expect(api.calls().filter(c => c.startsWith("PATCH"))).toHaveLength(2);
    // Auto-nap off hands over six hours; the trial takes two at most.
    clock.at += BACKSTOP_SLACK_MS;
    await backend.lifecycle.backstop!(machine, clock.at + 6 * 60 * 60_000);
    expect(api.seen.at(-1)!.body).toEqual({ ttlSeconds: TRIAL_TTL_S });
  });

  it("off the trial the backstop is the runtime's instant whole, and a killed box's instant is forgotten", async () => {
    const api = new FakeBox()
      .on("PATCH", "/boxes/bx_tumrjngm", INFO("bx_tumrjngm", "idle"))
      .on("DELETE", "/boxes/bx_tumrjngm", { status: 202, body: { ok: true, operation: { id: "bdop_1" } } });
    const { backend } = backendOn(api, "standard");
    const machine = new BoxMachine(backend, "bx_tumrjngm", "sandbox");
    const clock = backend.clock as ReturnType<typeof fakeClock>;
    await backend.backstop(machine, clock.at + 6 * 60 * 60_000);
    expect(api.took("PATCH", "/boxes/bx_tumrjngm")!.body).toEqual({ ttlSeconds: 6 * 60 * 60 });
    await machine.kill();
    await backend.backstop(machine, clock.at + 6 * 60 * 60_000);
    expect(api.calls().filter(c => c.startsWith("PATCH"))).toHaveLength(2);
  });

  it("a desktop machine boots the same box with no stream: the desktop stays off until the seam reads it per open", async () => {
    const api = new FakeBox()
      .on("POST", "/boxes", { status: 202, body: { ok: true, status: "provisioning", box: BOX("bx_d1", "provisioning", { name: "wsp" }) } })
      .on("GET", "/boxes/bx_d1", INFO("bx_d1", "ready", { name: "wsp" }))
      .on("POST", "/boxes/bx_d1/commands", COMMAND(""));
    const { backend } = backendOn(api);
    const machine = await backend.create({ kind: "desktop" });
    expect(machine.kind).toBe("desktop");
    expect(machine.streamUrl).toBeUndefined();
    expect(machine.daemonSupervisor).toBeUndefined();
  });

  it("the signed URL roads say where a box's bytes go instead", async () => {
    const { machine } = machineOn(new FakeBox());
    await expect(machine.downloadUrl()).rejects.toThrow(/GET \/files/);
    await expect(machine.uploadUrl()).rejects.toThrow(/PUT \/files/);
  });
});
