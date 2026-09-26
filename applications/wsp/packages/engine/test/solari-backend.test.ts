import { describe, expect, it, vi } from "vitest";
import { execFailedLine, machineUnreachableLine, napRefusedLine, RESUME_UNANSWERED } from "@wsp/protocol";
import { ExecFailedError, fetchCapMs, isCapped, isMissing, MachineUnreachableError, MoveUnansweredError, NapRefusedError, NotFirstLifeError, ResumeUnansweredError, type RetryClock } from "../src/errors.js";
import { IDLE_TIMEOUT_MAX_MS, PREVIEW_TTL_MS, previewTokenExpiry, REQUEST_ID_HEADER, RESUME_CAP_MS, SOLARI_INLINE_MAX_MS, SOLARI_LIFECYCLE, SOLARI_PRICING, SolariBackend, type MoveBudgets } from "../src/solari-backend.js";
import { BUILDER_DISK_GB } from "../src/tool-sizes.js";
import { EXEC_ENV } from "../src/golden-import.js";
import { GONE_READS, MachineAliveError, killUntilGone } from "../src/golden.js";
import { splitGateway } from "./split-gateway.js";

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A route is a fixed reply, or one read off the request's own body where a road sends several calls to one path. */
function fakeFetch(routes: Record<string, Reply | ((body: Record<string, unknown>) => Reply)>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    const route = routes[key];
    const hit = (typeof route === "function" ? route(JSON.parse(String(init?.body)) as Record<string, unknown>) : route) ?? { status: 404, body: { error: "no route " + key } };
    return new Response(JSON.stringify(hit.body), { status: hit.status, ...(hit.headers !== undefined ? { headers: hit.headers } : {}) });
  });
}

describe("SolariBackend", () => {
  it("declares the measured Solari capability truth", () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({}) });
    expect(b.capabilities).toEqual({
      liveCloneForks: true,
      pauseMode: "memory",
      replacesMachine: true,
      previewUrls: true,
      signedUrls: true,
      callbackRelay: true,
      diskSnapshots: true,
      images: true,
      // The provider answers 502 on a machine that was resumed, so a copy comes from a first life alone.
      snapshotsAnyLife: false,
      snapshotListing: true,
      templates: true,
      // A fork wsp made and can rebuild: nothing on it is the person's, so a turn runs without asking.
      kept: false,
      // A fork of the image with the project cloned into it, and the machine's localhost and ports are its own.
      copies: true,
      ownNetwork: true,
      sizes: [
        { cpu: 2, memMb: 4096, rateUsdPerHour: expect.closeTo(0.11, 10) },
        { cpu: 2, memMb: 8192, rateUsdPerHour: expect.closeTo(0.15, 10) },
      ],
    });
    // The offers' rates are the pricing's own, and the default size is the first offer.
    for (const s of b.capabilities.sizes) expect(s.rateUsdPerHour).toBeCloseTo(b.pricing.rateUsdPerHour(s), 10);
    expect(b.capabilities.sizes[0]).toMatchObject(b.pricing.defaultSize);
    // The root disk every builder and fork asks for here: this provider's cap, which the golden road reads off the
    // pricing rather than off a constant of its own, and the reason the estimate has a room to be over at all.
    expect(b.pricing.builderDiskGb).toBe(20);
    expect(SOLARI_PRICING.builderDiskGb).toBe(BUILDER_DISK_GB);
  });

  it("declares its lifecycle: two wake attempts, half a minute for the daemon, half an hour of asking once a minute, and a resume cap of half a minute", () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({}) });
    expect(b.lifecycle).toBe(SOLARI_LIFECYCLE);
    expect(SOLARI_LIFECYCLE.budgets).toEqual({ wakeAttempts: 2, daemonAnswersMs: 30_000, resumeAsks: { everyMs: 60_000, forMs: 30 * 60_000 } });
    expect(RESUME_CAP_MS).toBe(30_000);
    expect(b.capabilities.pauseMode).toBe("memory");
    // One object for every backend built here: a test that shrank a budget on it would shrink it for every file after.
    expect(Object.isFrozen(SOLARI_LIFECYCLE)).toBe(true);
    expect(Object.isFrozen(SOLARI_LIFECYCLE.budgets)).toBe(true);
    expect(Object.isFrozen(SOLARI_LIFECYCLE.budgets.resumeAsks)).toBe(true);
  });

  it("idleTimeoutMs above six hours is sent as six hours, the longest the create API has taken", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "s1", kind: "sandbox" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", onIdle: "pause", idleTimeoutMs: 12 * 60 * 60_000 });
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toMatchObject({ timeoutMs: IDLE_TIMEOUT_MAX_MS });
    await b.create({ kind: "sandbox", onIdle: "pause", idleTimeoutMs: 40 * 60_000 });
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toMatchObject({ timeoutMs: 40 * 60_000 });
    expect(IDLE_TIMEOUT_MAX_MS).toBe(6 * 60 * 60_000);
  });

  it("lists every snapshot on the account with the size the provider bills and the name wsp's owner mark rides on", async () => {
    const f = fakeFetch({
      "GET /snapshots": {
        status: 200,
        body: { snapshots: [{ id: "snap_a", parent: null, name: "golden", sizeBytes: 3839352763, createdAt: "2026-08-31T22:39:02.170Z", kind: "sandbox", template: "base" }, { id: "snap_b", parent: null, name: null, sizeBytes: 8_500_000_000, createdAt: "2026-09-04T10:00:00Z", kind: "sandbox", template: "base" }] },
      },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    // A snapshot the provider lists with a null name carries none, which is how a row with no owner reads.
    expect(await b.listSnapshots()).toEqual([
      { id: "snap_a", name: "golden", sizeBytes: 3839352763, createdAt: "2026-08-31T22:39:02.170Z", parent: null },
      { id: "snap_b", sizeBytes: 8_500_000_000, createdAt: "2026-09-04T10:00:00Z", parent: null },
    ]);
    expect(f.mock.calls.map(c => `${c[1]?.method} ${new URL(String(c[0])).pathname}`)).toEqual(["GET /snapshots"]);
  });

  it("promotes a snapshot to a template by name and answers the minted id; reads, lists and deletes templates on their own routes", async () => {
    const f = fakeFetch({
      "POST /snapshots/snap_dl8pcs2yj1fu/promote": { status: 200, body: { templateId: "tpl_e6f26b64338f4eba", name: "wsp-default-v1" } },
      "GET /templates/tpl_e6f26b64338f4eba": { status: 200, body: { templateId: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", kind: "sandbox", status: "ready", builtin: false, cpu: 2, memMb: 4096, createdAt: "2026-09-07T17:31:00Z" } },
      "GET /templates/tpl_bad": { status: 200, body: { templateId: "tpl_bad", name: "x", kind: "sandbox", status: "failed", builtin: false, error: "restore copy failed" } },
      "GET /templates": {
        status: 200,
        body: { templates: [{ templateId: "base", name: "base", kind: "sandbox", status: "ready", builtin: true, description: "Ubuntu base" }, { templateId: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", kind: "sandbox", status: "ready", builtin: false, cpu: 2, memMb: 4096, error: null, createdAt: "2026-09-07T17:31:00Z" }] },
      },
      "DELETE /templates/tpl_e6f26b64338f4eba": { status: 200, body: { ok: true } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    expect(await b.promoteSnapshot("snap_dl8pcs2yj1fu", "wsp-default-v1")).toBe("tpl_e6f26b64338f4eba");
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ name: "wsp-default-v1" });
    // createdAt is read for the same reason a snapshot's is: it is what gives a fresh promotion its grace.
    expect(await b.getTemplate("tpl_e6f26b64338f4eba")).toEqual({ id: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", status: "ready", createdAt: "2026-09-07T17:31:00Z" });
    expect(await b.getTemplate("tpl_bad")).toEqual({ id: "tpl_bad", name: "x", status: "failed", error: "restore copy failed" });
    expect(await b.listTemplates()).toEqual([
      { id: "base", name: "base", status: "ready" },
      { id: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", status: "ready", createdAt: "2026-09-07T17:31:00Z" },
    ]);
    await b.deleteTemplate("tpl_e6f26b64338f4eba");
    expect(f.mock.calls.map(c => `${c[1]?.method} ${new URL(String(c[0])).pathname}`)).toEqual([
      "POST /snapshots/snap_dl8pcs2yj1fu/promote",
      "GET /templates/tpl_e6f26b64338f4eba",
      "GET /templates/tpl_bad",
      "GET /templates",
      "DELETE /templates/tpl_e6f26b64338f4eba",
    ]);
  });

  it("a templates reply of another shape is a failure, never an empty registry", async () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({ "GET /templates": { status: 200, body: { items: [] } } }) });
    await expect(b.listTemplates()).rejects.toThrow("GET /templates answered without a templates array");
  });

  it("a listing reply of another shape is a failure, never an empty account", async () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({ "GET /snapshots": { status: 200, body: { items: [] } } }) });
    await expect(b.listSnapshots()).rejects.toThrow("GET /snapshots answered without a snapshots array");
  });

  it("prices snapshot storage from the one published constant", () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({}) });
    expect(b.pricing.snapshotStorage).toEqual({ freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" });
  });

  it("creates a sandbox and URL-encodes ids on follow-up calls", async () => {
    const id = "pool:vm_1:org.SIG"; // ids contain : and . — must be encoded
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: id, kind: "sandbox" } },
      [`POST /sandboxes/${encodeURIComponent(id)}/exec`]: { status: 200, body: { exitCode: 0, stdout: "hi", stderr: "" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base" });
    const r = await m.exec("echo hi");
    expect(r.stdout).toBe("hi");
  });
  it("maps onIdle and idleTimeoutMs to Solari's lifecycle and timeoutMs, omitting both otherwise", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "desktop" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "desktop", template: "default", onIdle: "kill", idleTimeoutMs: 7_200_000 });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1" });
    const bodies = f.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ kind: "desktop", lifecycle: { onTimeout: "kill" }, timeoutMs: 7_200_000 });
    expect(bodies[1]).not.toHaveProperty("lifecycle");
    expect(bodies[1]).not.toHaveProperty("timeoutMs");
  });
  it("sends the disk as camelCase diskGb when asked for and leaves it to the provider otherwise", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", template: "base", diskGb: 20 });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1" });
    const bodies = f.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ kind: "sandbox", template: "base", diskGb: 20 });
    expect(bodies[0]).not.toHaveProperty("disk_gb");
    expect(bodies[1]).not.toHaveProperty("diskGb");
  });
  it("every exec runs under bash -c with HOME and USER exported ahead of the command, and no SHELL", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "POST /sandboxes/x/exec": { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    await m.exec("go env GOPATH", { timeoutMs: 5_000 });
    const body = JSON.parse(String(f.mock.calls[1]![1]?.body)) as { cmd: string; args: string[]; timeoutMs: number };
    expect(body).toEqual({ cmd: "bash", args: ["-c", `${EXEC_ENV}\ngo env GOPATH`], timeoutMs: 5_000 });
    expect(EXEC_ENV).toBe("export HOME=/root USER=root");
    expect(body.args[1]).not.toContain("SHELL");
    expect(body.args[0]).toBe("-c");
  });
  it("an exec asked for longer than the provider's cap runs detached, and every call it makes stays under the cap", async () => {
    const asked: number[] = [];
    let polls = 0;
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "POST /sandboxes/x/exec": body => {
        const req = body as unknown as { args: string[]; timeoutMs: number };
        asked.push(req.timeoutMs);
        const cmd = req.args[1]!;
        if (cmd.includes("echo WSP_LAUNCHED")) return { status: 200, body: { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" } };
        if (cmd.includes("echo WSP_POLL")) {
          // The first poll carries the output and no exit code yet; the second carries the code and nothing new.
          const first = polls++ === 0;
          const out = first ? Buffer.from("2.1.280\n").toString("base64") : "";
          return { status: 200, body: { exitCode: 0, stdout: `WSP_POLL\n${first ? "" : "0"}\n${out}\n\nup\nWSP_POLL_END\n`, stderr: "" } };
        }
        return { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } };
      },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    const res = await m.exec("claude --version", { timeoutMs: 30_000 });
    expect(res).toEqual({ exitCode: 0, stdout: "2.1.280\n", stderr: "" });
    // The provider answers 400 to any of these above the cap, so the whole road has to stay under it.
    expect(asked.filter(ms => ms > SOLARI_INLINE_MAX_MS)).toEqual([]);
    expect(asked.length).toBeGreaterThan(1);
    expect(SOLARI_INLINE_MAX_MS).toBe(26_000);
  });

  it("an exec at the cap is one call to the provider, with the timeout it asked for", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "POST /sandboxes/x/exec": { status: 200, body: { exitCode: 0, stdout: "here\n", stderr: "" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    expect(await m.exec("echo here", { timeoutMs: SOLARI_INLINE_MAX_MS })).toEqual({ exitCode: 0, stdout: "here\n", stderr: "" });
    const bodies = f.mock.calls.slice(1).map(c => JSON.parse(String(c[1]?.body)) as { timeoutMs: number });
    expect(bodies).toEqual([{ cmd: "bash", args: ["-c", `${EXEC_ENV}\necho here`], timeoutMs: SOLARI_INLINE_MAX_MS }]);
  });

  it("passes the spec's envs through as the create body's envs, and sends none when the spec names none", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1", envs: { HOME: "/root", USER: "root", PATH: "/usr/bin:/bin" } });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1" });
    const bodies = f.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ fromSnapshot: "snap_1", envs: { HOME: "/root", USER: "root", PATH: "/usr/bin:/bin" } });
    expect(bodies[1]).not.toHaveProperty("envs");
  });
  it("reads GET /sandboxes/:id/metrics for the host's answer, and a 404 there is the machine missing", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "GET /sandboxes/x/metrics": { status: 200, body: { cpuPct: 12.5, memBytes: 734003200, memTotalBytes: 8589934592, diskBytes: 2147483648 } },
      "GET /sandboxes/lost": { status: 200, body: { sandboxId: "lost", kind: "sandbox", state: "running" } },
      "GET /sandboxes/lost/metrics": { status: 404, body: { error: "Sandbox not found" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    await expect(m.metrics!()).resolves.toBeUndefined();
    const lost = await b.get("lost");
    expect(await lost.state()).toBe("running");
    const refused = await lost.metrics!().then(() => undefined, (e: unknown) => e);
    expect(isMissing(refused)).toBe(true);
    expect(f.mock.calls.map(c => `${c[1]?.method} ${new URL(String(c[0])).pathname}`)).toEqual(["POST /sandboxes", "GET /sandboxes/x/metrics", "GET /sandboxes/lost", "GET /sandboxes/lost", "GET /sandboxes/lost/metrics"]);
  });
  it("a refused call's error carries the request id the reply's header named", async () => {
    const id = "vm_1";
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: id, kind: "sandbox" } },
      [`POST /sandboxes/${id}/snapshots`]: { status: 502, body: { error: "Failed to snapshot sandbox" }, headers: { [REQUEST_ID_HEADER]: "req_42" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base" });
    await expect(m.snapshot("g", { firstLife: true })).rejects.toMatchObject({ kind: "snapshotUnavailable", status: 502, requestId: "req_42" });
  });

  it("a snapshot of a machine whose life is not first is refused as notFirstLife before any call, and a first-life one posts", async () => {
    const f = fakeFetch({
      "GET /sandboxes/x": { status: 200, body: { sandboxId: "x", kind: "sandbox", state: "running" } },
      "POST /sandboxes/x/snapshots": { status: 200, body: { snapshotId: "snap_1" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.get("x");
    const sent = f.mock.calls.length;
    const err = await m.snapshot("v2", { firstLife: false }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(NotFirstLifeError);
    expect((err as NotFirstLifeError).kind).toBe("notFirstLife");
    expect((err as NotFirstLifeError).machineId).toBe("x");
    expect((err as NotFirstLifeError).message).toMatch(/^snapshot v2 refused: machine x is not first-life/);
    // The provider answers this with a 502 (measured), so the refusal is made here and nothing is sent.
    expect(f.mock.calls.length).toBe(sent);
    expect(await m.snapshot("v2", { firstLife: true })).toBe("snap_1");
    expect(f.mock.calls.length).toBe(sent + 1);
  });

  it("surfaces snapshotUnavailable without retrying", async () => {
    const id = "x";
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: id, kind: "sandbox" } },
      [`POST /sandboxes/${id}/snapshots`]: { status: 502, body: { error: "Failed to snapshot sandbox" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    await expect(m.snapshot("g", { firstLife: true })).rejects.toMatchObject({ kind: "snapshotUnavailable" });
    expect(f.mock.calls.filter(c => String(c[0]).includes("/snapshots")).length).toBe(1);
  });
});

// Token in the measured Solari shape: base64url(JSON claims) + "." + signature. Not a 3-part JWT, the sandboxId
// claim embeds literal dots, and exp is epoch milliseconds.
function mintToken(exp: number): string {
  const claims = {
    sandboxId: "desktop-pool-i-0fd9ed7dc03a79db2:vm_001130:cmthqj8lg.TIblxI9qSig",
    port: 7070,
    orgId: "cmthqj8lg00sso001svwbxyxb",
    exp,
  };
  return Buffer.from(JSON.stringify(claims)).toString("base64url") + ".WO_khRk6fakeSignature";
}

describe("previewTokenExpiry", () => {
  it("reads the ms exp claim from the real token shape", () => {
    const exp = Date.now() + 60 * 60_000;
    expect(previewTokenExpiry(mintToken(exp))).toBe(exp);
  });

  it("falls back to the measured 60-min TTL when the token is opaque", () => {
    const now = Date.now();
    expect(previewTokenExpiry("not-a-token-at-all", now)).toBe(now + PREVIEW_TTL_MS);
    expect(PREVIEW_TTL_MS).toBe(60 * 60_000);
  });
});

describe("SolariMachine.previewUrl", () => {
  it("mints via GET /sandboxes/:id/ports/:port and derives expiresAt from the token", async () => {
    const id = "pool:vm_1:org.SIG"; // ids contain : and . and must be encoded
    const exp = Date.now() + 60 * 60_000;
    const token = mintToken(exp);
    const url = `https://3fe6a8b705a72d14c7cc-7070.preview.getsolari.com?pt_token=${token}`;
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sandboxes") return new Response(JSON.stringify({ sandboxId: id, kind: "sandbox" }), { status: 201 });
      if (path === `/sandboxes/${encodeURIComponent(id)}/ports/7070`) return new Response(JSON.stringify({ url, token }), { status: 200 });
      return new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    if (!m.previewUrl) throw new Error("SolariMachine must support previewUrl");
    expect(await m.previewUrl(7070)).toEqual({ url, token, expiresAt: exp });
  });
});

describe("SolariBackend describe", () => {
  it("reads the provider's size and creation time off GET /sandboxes/:id", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "GET /sandboxes/x": { status: 200, body: { sandboxId: "x", kind: "sandbox", state: "running", cpu: 2, memMb: 2048, diskGb: 20, createdAt: "2026-09-02T19:03:35Z" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", memMb: 4096, diskGb: 20 });
    await expect(m.describe!()).resolves.toEqual({ cpu: 2, memMb: 2048, diskGb: 20, createdAt: "2026-09-02T19:03:35Z" });
  });
});

describe("SolariBackend list", () => {
  it("reads labels off metadata and size off cpu and memMb per row, follows the cursor, and filters by label", async () => {
    const pages: Record<string, unknown> = {
      "": {
        sandboxes: [
          { sandboxId: "a", kind: "sandbox", state: "running", metadata: { wsp: "1" }, cpu: 2, memMb: 4096 },
          { sandboxId: "b", kind: "sandbox", state: "paused" },
        ],
        nextCursor: "c2",
      },
      c2: { sandboxes: [{ sandboxId: "c", kind: "desktop", state: "archived", metadata: { poc: "p1" }, cpu: 4 }] },
    };
    const f = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe("/sandboxes");
      expect(u.searchParams.get("metadata.wsp")).toBe("1");
      return new Response(JSON.stringify(pages[u.searchParams.get("cursor") ?? ""]), { status: 200 });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await expect(b.list({ wsp: "1" })).resolves.toEqual([
      { id: "a", state: "running", labels: { wsp: "1" }, size: { cpu: 2, memMb: 4096 } },
      { id: "b", state: "paused", labels: {} },
      { id: "c", state: "gone", labels: { poc: "p1" } },
    ]);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("SolariBackend exec on a machine the provider cannot reach", () => {
  const noWait: RetryClock = { now: Date.now, sleep: async () => {} };
  const refusing = (status: number, error: string) =>
    fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "sbx_1", kind: "sandbox" } },
      "POST /sandboxes/sbx_1/exec": { status, body: { error } },
    });
  const execCalls = (f: ReturnType<typeof fakeFetch>): number => f.mock.calls.filter(c => String(c[0]).endsWith("/exec")).length;

  it("reads the provider's words on a 502 as the typed refusal once the gateway retries are spent", async () => {
    const f = refusing(502, "Sandbox is not reachable");
    const m = await new SolariBackend({ apiKey: "k", fetch: f, clock: noWait }).create({ kind: "sandbox" });
    const e = await m.exec("true").catch((err: unknown) => err);
    expect(e).toMatchObject({ name: "MachineUnreachableError", machineId: "sbx_1", said: "Sandbox is not reachable", status: 502 });
    expect(e).toBeInstanceOf(MachineUnreachableError);
    expect((e as Error).message).toBe(machineUnreachableLine("Sandbox is not reachable"));
    expect(execCalls(f)).toBe(3);
  });

  it("reads the same words on a 400 as the same refusal, carrying the 400", async () => {
    const f = refusing(400, "Sandbox is not reachable");
    const m = await new SolariBackend({ apiKey: "k", fetch: f, clock: noWait }).create({ kind: "sandbox" });
    const e = await m.exec("true").catch((err: unknown) => err);
    expect(e).toMatchObject({ name: "MachineUnreachableError", machineId: "sbx_1", said: "Sandbox is not reachable", status: 400 });
    expect((e as Error).message).toBe(machineUnreachableLine("Sandbox is not reachable"));
    expect(execCalls(f)).toBe(1);
  });

  it("leaves a 502 with any other words the plain error it was", async () => {
    const f = refusing(502, "Bad gateway");
    const m = await new SolariBackend({ apiKey: "k", fetch: f, clock: noWait }).create({ kind: "sandbox" });
    const e = await m.exec("true").catch((err: unknown) => err);
    expect(e).toMatchObject({ name: "Error", message: "Bad gateway", kind: "transient", status: 502 });
    expect(execCalls(f)).toBe(3);
  });

  it("reads a 502 exec failed as the same refusal with its own sentence once the gateway retries are spent", async () => {
    const f = refusing(502, "exec failed");
    const m = await new SolariBackend({ apiKey: "k", fetch: f, clock: noWait }).create({ kind: "sandbox" });
    const e = await m.exec("true").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ExecFailedError);
    expect(e).toBeInstanceOf(MachineUnreachableError);
    expect(e).toMatchObject({ name: "ExecFailedError", machineId: "sbx_1", said: "exec failed", status: 502 });
    expect((e as Error).message).toBe(execFailedLine("exec failed"));
    expect(execCalls(f)).toBe(3);
  });

  it("leaves exec failed on any other status the plain error it was", async () => {
    const f = refusing(500, "exec failed");
    const m = await new SolariBackend({ apiKey: "k", fetch: f, clock: noWait }).create({ kind: "sandbox" });
    const e = await m.exec("true").catch((err: unknown) => err);
    expect(e).not.toBeInstanceOf(MachineUnreachableError);
    expect(e).toMatchObject({ name: "Error", message: "exec failed", status: 500 });
  });
});

describe("SolariBackend pause the provider refuses", () => {
  const refusing = (error: string) =>
    fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "sbx_1", kind: "sandbox" } },
      "POST /sandboxes/sbx_1/pause": { status: 409, body: { error } },
    });
  const pauseCalls = (f: ReturnType<typeof fakeFetch>): number => f.mock.calls.filter(c => String(c[0]).endsWith("/pause")).length;

  it("reads a 409 whose words are Not pausable as the typed refusal, asked once", async () => {
    const f = refusing("Not pausable");
    const m = await new SolariBackend({ apiKey: "k", fetch: f }).create({ kind: "sandbox" });
    const e = await m.pause().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(NapRefusedError);
    expect(e).toMatchObject({ name: "NapRefusedError", machineId: "sbx_1", said: "Not pausable" });
    expect((e as Error).message).toBe(napRefusedLine("Not pausable"));
    expect(pauseCalls(f)).toBe(1);
  });

  it("leaves a 409 with any other words the plain conflict it was", async () => {
    const f = refusing("sandbox is not running");
    const m = await new SolariBackend({ apiKey: "k", fetch: f }).create({ kind: "sandbox" });
    const e = await m.pause().catch((err: unknown) => err);
    expect(e).not.toBeInstanceOf(NapRefusedError);
    expect(e).toMatchObject({ name: "Error", message: "sandbox is not running", kind: "conflict", status: 409 });
  });
});

describe("SolariBackend idempotency", () => {
  const headerOf = (call: unknown[]): string | null => new Headers((call[1] as RequestInit).headers).get("Idempotency-Key");

  it("sends the spec's key on POST /sandboxes and nothing on the POSTs the provider ignores it for", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "POST /sandboxes/x/exec": { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } },
      "POST /sandboxes/x/pause": { status: 200, body: {} },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    await m.exec("true");
    await m.pause();
    expect(f.mock.calls.map(headerOf)).toEqual(["workspace/ws_1:a1", null, null]);
  });

  it("holds one key across the retries of a single create, and mints one when the caller sent none", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: "upstream" }), { status: 503 })
        : new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox" }), { status: 201 });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    expect(f.mock.calls.map(headerOf)).toEqual(["workspace/ws_1:a1", "workspace/ws_1:a1"]);
    f.mockClear();
    await b.create({ kind: "sandbox", template: "base" });
    await b.create({ kind: "sandbox", template: "base" });
    const minted = f.mock.calls.map(headerOf);
    expect(minted.every(k => typeof k === "string" && k.length > 0)).toBe(true);
    expect(minted[0]).not.toBe(minted[1]);
  }, 15_000);

  it("retries a create once under the same key when the fetch itself throws, so a lost answer replays", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox" }), { status: 201, headers: { "Idempotent-Replayed": "true" } });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    expect(f.mock.calls.map(headerOf)).toEqual(["workspace/ws_1:a1", "workspace/ws_1:a1"]);
    expect(m.replayed).toBe(true);
    expect(m.id).toBe("x");
  }, 15_000);

  it("lets a second thrown fetch propagate, and never retries a thrown exec", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await expect(b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" })).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(2);
    f.mockClear();
    await expect(b.request("POST", "/sandboxes/x/exec", { cmd: "true" })).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("reads Idempotent-Replayed off the create reply onto the handle", async () => {
    let replays = 0;
    const f = vi.fn(async () => new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox" }), {
      status: 201,
      headers: replays++ === 0 ? {} : { "Idempotent-Replayed": "true" },
    }));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const first = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    const second = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });
});

describe("SolariBackend road retries", () => {
  /** A fetch that never left this computer, as node throws it: the system error under a TypeError. */
  const noRoad = (code = "ENOTFOUND"): TypeError =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ${code} api.getsolari.com`), { code }) });

  /** The retries' own sleeps, recorded instead of waited, so the ten seconds cost the test nothing. */
  const fakeClock = () => {
    const waits: number[] = [];
    return { waits, clock: { now: Date.now, sleep: async (ms: number): Promise<void> => { waits.push(ms); } } };
  };

  const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("tries a call that never left this computer three times over about ten seconds and logs one line per retry", async () => {
    const { waits, clock } = fakeClock();
    let calls = 0;
    const f = vi.fn(async () => {
      if (++calls <= 2) throw noRoad();
      return new Response(JSON.stringify({ snapshotId: "snap_1" }), { status: 200 });
    });
    const warn = quietWarn();
    try {
      const b = new SolariBackend({ apiKey: "k", fetch: f, clock });
      await expect(b.request("POST", "/sandboxes/x/snapshots", { name: "g" })).resolves.toEqual({ snapshotId: "snap_1" });
      expect(f).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
        "POST /sandboxes/x/snapshots did not leave this computer (ENOTFOUND); try 2 of 3",
        "POST /sandboxes/x/snapshots did not leave this computer (ENOTFOUND); try 3 of 3",
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(waits.length).toBe(2);
    const spanMs = waits.reduce((a, b) => a + b, 0);
    expect(spanMs).toBeGreaterThanOrEqual(9_000);
    expect(spanMs).toBeLessThan(11_000);
  });

  it("gives up after the third try and throws what the road threw", async () => {
    const { clock } = fakeClock();
    const f = vi.fn(async () => { throw noRoad("EAI_AGAIN"); });
    const warn = quietWarn();
    try {
      const b = new SolariBackend({ apiKey: "k", fetch: f, clock });
      await expect(b.request("GET", "/sandboxes/x")).rejects.toThrow("fetch failed");
      expect(f).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a road out of an AggregateError, one error per address tried", async () => {
    const { clock } = fakeClock();
    let calls = 0;
    const f = vi.fn(async () => {
      if (++calls === 1) {
        throw new TypeError("fetch failed", {
          cause: new AggregateError([
            Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }),
            Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }),
          ]),
        });
      }
      return new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox", state: "running" }), { status: 200 });
    });
    const warn = quietWarn();
    try {
      const b = new SolariBackend({ apiKey: "k", fetch: f, clock });
      await expect(b.get("x")).resolves.toMatchObject({ id: "x" });
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual(["GET /sandboxes/x did not leave this computer (ENETUNREACH); try 2 of 3"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a road that flapped before the first answer leaves the gateway retries whole: one drop, then 502, 502, 200 in four sends", async () => {
    const { clock } = fakeClock();
    const answers = [502, 502, 200];
    let calls = 0;
    const f = vi.fn(async () => {
      if (++calls === 1) throw noRoad();
      const status = answers[calls - 2]!;
      const body = status === 200 ? { sandboxId: "x", kind: "sandbox", state: "running" } : { error: "upstream sad" };
      return new Response(JSON.stringify(body), { status });
    });
    const warn = quietWarn();
    try {
      const b = new SolariBackend({ apiKey: "k", fetch: f, clock });
      await expect(b.get("x")).resolves.toMatchObject({ id: "x" });
      expect(f).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("never retries an answer: a 409 is the caller's on the first reply", async () => {
    const { clock } = fakeClock();
    const f = fakeFetch({ "POST /sandboxes/x/pause": { status: 409, body: { error: "sandbox is not running" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f, clock });
    await expect(b.request("POST", "/sandboxes/x/pause", {})).rejects.toMatchObject({ kind: "conflict", status: 409 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("never retries a refused, reset or timed out connection: those are the far end's", async () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
      const { clock } = fakeClock();
      const f = vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
      });
      const b = new SolariBackend({ apiKey: "k", fetch: f, clock });
      await expect(b.request("GET", "/sandboxes/x")).rejects.toThrow("fetch failed");
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("every road takes it: create, snapshot, pause, poll and promote each survive one dropped lookup", async () => {
    const routes: Record<string, unknown> = {
      "POST /sandboxes": { sandboxId: "x", kind: "sandbox" },
      "POST /sandboxes/x/snapshots": { snapshotId: "snap_1" },
      "POST /sandboxes/x/pause": {},
      "GET /sandboxes/x": { sandboxId: "x", kind: "sandbox", state: "running" },
      "POST /snapshots/snap_1/promote": { templateId: "tpl_1" },
    };
    const dropped = new Set<string>();
    const { clock } = fakeClock();
    const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
      if (!dropped.has(key)) {
        dropped.add(key);
        throw noRoad();
      }
      return new Response(JSON.stringify(routes[key]), { status: 200 });
    });
    const warn = quietWarn();
    try {
      const b = new SolariBackend({ apiKey: "k", fetch: f, clock });
      const m = await b.create({ kind: "sandbox", template: "base" });
      expect(await m.snapshot("g", { firstLife: true })).toBe("snap_1");
      await m.pause();
      expect(await m.state()).toBe("running");
      expect(await b.promoteSnapshot("snap_1", "wsp-default-v1")).toBe("tpl_1");
      expect(dropped.size).toBe(5);
      expect(f).toHaveBeenCalledTimes(10);
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });
});

// The backend settles its own pause and resume: a call the provider does not answer inside its share of the budget,
// or that the network dropped, is followed by one bounded read of the machine, and the runtime only ever sees the
// machine moved or one of the two typed failures with the row's words.
describe("a pause and a resume the provider does not answer", () => {
  type Play = Response | Error | "hangs";
  /** A fetch scripted per route: a Response, an error to throw, or "hangs", which holds the call until the signal on
   * it fires and then rejects with the signal's reason, as a socket under AbortSignal.timeout does. A list plays its
   * entries in order and repeats the last. */
  function scripted(script: Record<string, Play | Play[]>) {
    const calls: string[] = [];
    const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
      calls.push(key);
      const plays = script[key];
      const play = Array.isArray(plays) ? (plays.length > 1 ? plays.shift()! : plays[0]!) : plays;
      if (play === undefined) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
      if (play instanceof Error) throw play;
      if (play === "hangs") return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error), { once: true }));
      return play.clone();
    });
    return { f, calls, sent: (key: string) => calls.filter(c => c === key).length };
  }
  const reads = (state: string) => new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox", state }), { status: 200 });
  const ok = () => new Response("{}", { status: 200 });
  const noRoad = () => new TypeError("fetch failed");
  const BUDGETS = { pauseMs: 40, resumeCapMs: 20, stateReadMs: 20 };
  const PAUSE = "POST /sandboxes/x/pause";
  const RESUME = "POST /sandboxes/x/resume";
  const STATE = "GET /sandboxes/x";
  /** A machine handle off a create, so the first read the test sees is the move's own. */
  async function machine(f: typeof globalThis.fetch, over?: { budgets?: Partial<MoveBudgets>; clock?: RetryClock }) {
    const b = new SolariBackend({ apiKey: "k", fetch: f, budgets: { ...BUDGETS, ...over?.budgets }, ...(over?.clock !== undefined ? { clock: over.clock } : {}) });
    return b.create({ kind: "sandbox" });
  }
  const created = () => new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox" }), { status: 201 });
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("a pause the provider never finishes is sent twice, half the budget then the rest, and ends unanswered with the row's words and what the provider reads", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [PAUSE]: "hangs", [STATE]: reads("running") });
    const m = await machine(f);
    const warn = quiet();
    const started = Date.now();
    try {
      const err = await m.pause().catch(e => e as unknown);
      expect(err).toBeInstanceOf(MoveUnansweredError);
      expect((err as Error).message).toMatch(/^pause did not complete in \d+ms; the provider did not answer and reads the machine running; try again$/);
      expect(isCapped((err as Error).cause)).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGETS.pauseMs - 5);
    expect(sent(PAUSE)).toBe(2);
    expect(sent(STATE)).toBe(2);
  });

  it("a pause whose call never answers but landed at the provider is a pause: one call, one read", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [PAUSE]: "hangs", [STATE]: reads("paused") });
    const m = await machine(f);
    await m.pause();
    expect(sent(PAUSE)).toBe(1);
    expect(sent(STATE)).toBe(1);
  });

  it("a provider that cannot be read after the call ends the move at once with that in the words: no second call", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [PAUSE]: "hangs", [STATE]: noRoad() });
    const m = await machine(f);
    const warn = quiet();
    try {
      await expect(m.pause()).rejects.toThrow(/^pause did not complete in \d+ms; the provider did not answer and could not be read about the machine; try again$/);
    } finally {
      warn.mockRestore();
    }
    expect(sent(PAUSE)).toBe(1);
    expect(sent(STATE)).toBe(1);
  });

  it("a read that hangs is given up on within its own bound: one call, and the words say the provider could not be read", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [PAUSE]: "hangs", [STATE]: "hangs" });
    const m = await machine(f);
    const warn = quiet();
    const started = Date.now();
    try {
      await expect(m.pause()).rejects.toThrow(/could not be read about the machine/);
    } finally {
      warn.mockRestore();
    }
    // Half the pause budget on the call, then the read's own bound, and nothing more.
    expect(Date.now() - started).toBeLessThan(BUDGETS.pauseMs + BUDGETS.stateReadMs + 500);
    expect(sent(PAUSE)).toBe(1);
    expect(sent(STATE)).toBe(1);
  });

  it("a pause that fails on a network error is read and sent once more inside the budget; a second failure ends it with the words", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [PAUSE]: [noRoad(), noRoad()], [STATE]: reads("running") });
    const m = await machine(f);
    const warn = quiet();
    try {
      await expect(m.pause()).rejects.toThrow(/^pause did not complete in \d+ms; the provider did not answer and reads the machine running; try again$/);
    } finally {
      warn.mockRestore();
    }
    expect(sent(PAUSE)).toBe(2);
    expect(sent(STATE)).toBe(2);
  });

  it("a pause that fails once on a network error and lands on the second call is a pause: two calls, one read", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [PAUSE]: [noRoad(), ok()], [STATE]: reads("running") });
    const m = await machine(f);
    await m.pause();
    expect(sent(PAUSE)).toBe(2);
    expect(sent(STATE)).toBe(1);
  });

  it("a pause the provider refuses is not retried, and an odd millisecond left in the budget is no reason to fail before the call", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [PAUSE]: new Response(JSON.stringify({ error: "upstream request timeout" }), { status: 400 }), [STATE]: reads("running") });
    // The timer refuses the 19.5ms this budget leaves the first attempt unless the cap is made whole.
    const m = await machine(f, { budgets: { pauseMs: 39 }, clock: { now: () => 0, sleep: async () => {} } });
    const err = await m.pause().catch(e => e as unknown);
    expect((err as Error).message).toBe("upstream request timeout");
    expect(err).not.toBeInstanceOf(MoveUnansweredError);
    expect(sent(PAUSE)).toBe(1);
    expect(sent(STATE)).toBe(0);
  });

  it("a resume whose call never answers but landed at the provider goes through: one call, one read", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [RESUME]: "hangs", [STATE]: reads("running") });
    const m = await machine(f);
    await m.resume();
    expect(sent(RESUME)).toBe(1);
    expect(sent(STATE)).toBe(1);
  });

  it("a resume cut off at its cap with the machine still paused ends unanswered with the row's words: one call, one read, nothing sent twice", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [RESUME]: "hangs", [STATE]: reads("paused") });
    const m = await machine(f);
    const warn = quiet();
    try {
      const err = await m.resume().catch(e => e as unknown);
      expect(err).toBeInstanceOf(ResumeUnansweredError);
      expect(err).toBeInstanceOf(MoveUnansweredError);
      expect((err as Error).message).toBe(RESUME_UNANSWERED);
      expect(isCapped((err as Error).cause)).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(sent(RESUME)).toBe(1);
    expect(sent(STATE)).toBe(1);
  });

  it("a resume the network dropped is read like a capped one, and a machine that reads starting is a resume that landed", async () => {
    const { f, sent } = scripted({ "POST /sandboxes": created(), [RESUME]: noRoad(), [STATE]: reads("starting") });
    const m = await machine(f);
    await m.resume();
    expect(sent(RESUME)).toBe(1);
    expect(sent(STATE)).toBe(1);
  });

  it("ships four minutes for a pause, half a minute for a resume call and for a read, and takes shorter ones for tests", () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({}) });
    expect(b.budgets).toEqual({ pauseMs: 4 * 60_000, resumeCapMs: RESUME_CAP_MS, stateReadMs: 30_000 });
    expect(new SolariBackend({ apiKey: "k", fetch: fakeFetch({}), budgets: { pauseMs: 40 } }).budgets).toEqual({ pauseMs: 40, resumeCapMs: 30_000, stateReadMs: 30_000 });
  });
});

describe("the cap the caller puts on one call", () => {
  it("a resume carries its cap and a pause half its budget into the fetch; a read of the machine carries none", async () => {
    const seen: boolean[] = [];
    const f = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal !== undefined && init.signal !== null);
      return new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox", state: "paused" }), { status: 200 });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.get("x");
    await m.pause();
    await m.resume();
    expect(seen).toEqual([false, true, true]);
  });

  it("the caller's own signal ends the call, so a resume nobody waits on is not left running behind them", async () => {
    const stop = new AbortController();
    const f = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error));
        stop.abort();
      });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    // The cap rides the same fetch, so the failure is the stop's own and not the cap's: the runtime tells a wake
    // the person ended from one the provider never answered by exactly this.
    const failed = await b.request("POST", "/sandboxes/x/resume", {}, 30_000, stop.signal).catch((e: unknown) => e);
    expect(isCapped(failed)).toBe(false);
    expect((failed as Error).name).toBe("AbortError");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a provider that answers nothing inside the cap ends the resume there instead of holding the socket", async () => {
    const f = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error));
      });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    // The failure carries fetch's own name for a cap that fired, which is what the runtime reads to tell a call
    // nobody answered from one the provider refused.
    await expect(b.request("POST", "/sandboxes/x/resume", {}, 20)).rejects.toSatisfy(isCapped);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the cap a fetch is given is a whole number of milliseconds inside the timer's range", () => {
    expect(fetchCapMs(19.5)).toBe(20);
    expect(fetchCapMs(30_000)).toBe(30_000);
    expect(fetchCapMs(2 ** 32)).toBe(2_147_483_647);
    expect(fetchCapMs(-1)).toBe(0);
  });
});

describe("SolariBackend error bodies", () => {
  it("keeps a plain-text error body as the refusal's words instead of an empty one", async () => {
    const f = vi.fn(async () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }));
    const b = new SolariBackend({ apiKey: "k", fetch: f, clock: { now: () => 0, sleep: async () => {} } });
    const refused = (await b.create({ kind: "sandbox" }).then(() => null, (e: unknown) => e)) as Error & { status?: number };
    expect(refused).toBeInstanceOf(Error);
    expect(refused.status).toBe(500);
    expect(refused.message).toBe("Internal Server Error");
  });

  it("names the class and status where the provider said nothing at all", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    const b = new SolariBackend({ apiKey: "k", fetch: f, clock: { now: () => 0, sleep: async () => {} } });
    const refused = (await b.create({ kind: "sandbox" }).then(() => null, (e: unknown) => e)) as Error;
    expect(refused.message).not.toBe("");
    expect(refused.message).toContain("500");
  });
});

describe("a delete read back through a gateway whose copies disagree", () => {
  const confirm = { graceMs: 50, pollMs: 1 };

  it("a delete that lands on the copy that never held the machine is not gone: the read that finds it running asks again, and gone waits for the reads to agree", async () => {
    const { f, holder } = splitGateway(call => (call < 2 ? "empty" : "holder"));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await killUntilGone(b, await b.create({ kind: "sandbox" }), { graceMs: 60_000, pollMs: 1 });
    expect([...holder.keys()]).toEqual([]);
    const calls = f.mock.calls.map(c => c[1]?.method ?? "GET").slice(1);
    // Asked again on the read that found it running, not when a minute's grace ran out.
    expect(calls.slice(0, 4)).toEqual(["DELETE", "GET", "GET", "DELETE"]);
    expect(calls.slice(4)).toEqual(Array(GONE_READS).fill("GET"));
  });

  it("a state the provider names that the table never learned reads running on the handle, the machine and the listing, so a delete never reads it gone", async () => {
    const view = { sandboxId: "sb1", kind: "sandbox", state: "archiving" };
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "sb1", kind: "sandbox" } },
      "GET /sandboxes/sb1": { status: 200, body: view },
      "GET /sandboxes": { status: 200, body: { sandboxes: [view] } },
      "DELETE /sandboxes/sb1": { status: 200, body: { ok: true } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    expect((await b.get("sb1")).seen?.state).toBe("running");
    expect(await m.state()).toBe("running");
    expect((await b.list()).map(r => r.state)).toEqual(["running"]);
    await expect(killUntilGone(b, m, { graceMs: 5, pollMs: 1 })).rejects.toMatchObject({ kind: "machineAlive", state: "running" });
  });

  it("copies that disagree on every read end in one sentence naming the machine still running", async () => {
    const { f, holder } = splitGateway((call, method) => (method === "DELETE" ? "empty" : call % 2 === 0 ? "holder" : "empty"));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const err = await killUntilGone(b, await b.create({ kind: "sandbox" }), confirm).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MachineAliveError);
    expect(err).toMatchObject({ machineId: "sb1", state: "running", message: expect.stringContaining("sb1 is still running") });
    expect([...holder.keys()]).toEqual(["sb1"]);
  });
});
