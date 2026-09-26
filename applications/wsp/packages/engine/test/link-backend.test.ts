// SPDX-License-Identifier: AGPL-3.0-only
// Machines on another computer, driven a frame at a time. What the far side
// answers is what its own backend answered, and which optional calls a handle
// carries is the far side's to say.
import { describe, expect, it } from "vitest";
import { MACHINE_PUT_PART_BYTES, NO_IMAGES_HERE, type BackendFacts, type Capabilities, type MachineHandle, type MachineSpec } from "@wsp/protocol";
import { sharesIn } from "@wsp/catalog";
import { BUILDER_LABEL } from "../src/labels.js";
import { LINK_MARGIN_MS, LinkBackend, LinkMachine, PlaceAbsentError, isPlaceAbsent, type MachineLink } from "../src/link-backend.js";
import { INLINE_EXEC_MS } from "../src/exec-detached.js";
import { isMissing } from "../src/errors.js";

interface Sent {
  op: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  idempotencyKey?: string;
}

const CAPABILITIES: Capabilities = {
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
};

const FACTS: BackendFacts = {
  offer: "docker",
  capabilities: CAPABILITIES,
  pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
  lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
  baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
};

const ROADS: MachineHandle["roads"] = { previewUrl: true, daemonAnswers: true, putBytes: true, describe: true, facts: true, metrics: true };
const HANDLE: MachineHandle = { id: "c1", kind: "sandbox", daemonSupervisor: "entrypoint", roads: ROADS };

function link(answers: (sent: Sent) => unknown = () => ({}), dialsBack?: () => Promise<boolean>): { link: MachineLink; sent: Sent[]; forwarded: number[] } {
  const sent: Sent[] = [];
  const forwarded: number[] = [];
  return {
    sent,
    forwarded,
    link: {
      request: async (op, params, opts) => {
        sent.push({
          op,
          params: params ?? {},
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        });
        const answer = answers(sent.at(-1)!);
        if (answer instanceof Error) throw answer;
        return (answer as Record<string, unknown>) ?? {};
      },
      ...(dialsBack !== undefined ? { dialsBack } : {}),
      forward: async placePort => {
        forwarded.push(placePort);
        return { localPort: 51000 + forwarded.length };
      },
    },
  };
}

const opened = (answers: (sent: Sent) => unknown): ReturnType<typeof link> => {
  const made = link(sent => (sent.op === "machine.backend" ? FACTS : answers(sent)));
  return made;
};

describe("what a backend over a link says about itself", () => {
  it("asks once and answers with what the far side said", async () => {
    const l = opened(() => ({}));
    const backend = await LinkBackend.open(l.link);
    expect(l.sent.map(s => s.op)).toEqual(["machine.backend"]);
    expect(backend.capabilities).toEqual(CAPABILITIES);
    expect(backend.lifecycle?.budgets.wakeAttempts).toBe(1);
    expect(backend.baseTemplates?.sandbox).toBe("ubuntu:24.04");
    // The daemon writes the workspace's name into the machine's specification at every boot, so nothing above
    // this backend names one again; a provider's fork comes up as localhost and says nothing here.
    expect(backend.namesWorkspace).toBe(true);
  });

  it("carries no snapshot and no template call at all: a computer somebody joined keeps no image", async () => {
    const backend = await LinkBackend.open(opened(() => ({})).link);
    // Not optional-and-absent but gone: the link has no frame to send for any of them, whatever the far side
    // says about itself, so nothing here can promise one.
    for (const call of ["listSnapshots", "promoteSnapshot", "getTemplate", "listTemplates", "deleteTemplate"]) {
      expect(call in backend, call).toBe(false);
    }
    // The two the interfaces require are the far side's own sentence and send nothing.
    const l = opened(() => ({}));
    const with_link = await LinkBackend.open(l.link);
    await expect(with_link.deleteSnapshot("sha256:aa")).rejects.toThrow(NO_IMAGES_HERE);
    await expect(new LinkMachine(l.link, HANDLE).snapshot("v1", { firstLife: true })).rejects.toThrow(NO_IMAGES_HERE);
    expect(l.sent.map(s => s.op)).toEqual(["machine.backend"]);
  });

  it("prices a size off the offers the far side sent, and nothing for one it does not offer", async () => {
    const backend = await LinkBackend.open(opened(() => ({})).link);
    expect(backend.pricing.rateUsdPerHour({ cpu: 2, memMb: 4096 })).toBe(0);
    expect(backend.pricing.rateUsdPerHour({ cpu: 64, memMb: 9999 })).toBe(0);
    expect(backend.pricing.defaultSize).toEqual({ cpu: 2, memMb: 4096 });
  });
});

describe("a machine over a link", () => {
  const withMachine = async (answers: (sent: Sent) => unknown) => {
    const l = opened(sent => (sent.op === "machine.create" || sent.op === "machine.get" ? { machine: HANDLE } : answers(sent)));
    const backend = await LinkBackend.open(l.link);
    return { l, backend };
  };

  it("sends the spec whole and carries exactly the roads the handle named", async () => {
    const { l, backend } = await withMachine(() => ({}));
    const machine = await backend.create({ kind: "sandbox", template: "wsp/dev:template", cpu: 2, memMb: 4096 });
    expect(l.sent.at(-1)!.params["spec"]).toEqual({ kind: "sandbox", template: "wsp/dev:template", cpu: 2, memMb: 4096 });
    expect(machine.previewUrl).toBeDefined();
    expect(machine.putBytes).toBeDefined();
    expect(machine.daemonSupervisor).toBe("entrypoint");
  });

  it("carries the sentence the computer answered the create with, and none where it answered none", async () => {
    const said = "size 2x4 on 2 cores: cpu clamped to 1 and memory clamped to 2 GB";
    const l = opened(sent => (sent.op === "machine.create" ? { machine: { ...HANDLE, notice: said } } : {}));
    expect((await (await LinkBackend.open(l.link)).create({ kind: "sandbox", cpu: 2, memMb: 4096 })).notice).toBe(said);
    const { backend } = await withMachine(() => ({}));
    expect((await backend.create({ kind: "sandbox" })).notice).toBeUndefined();
  });

  it("leaves out a road the handle did not name", async () => {
    const l = opened(sent => (sent.op === "machine.create" ? { machine: { ...HANDLE, roads: { ...ROADS, previewUrl: false, metrics: false } } } : {}));
    const machine = await (await LinkBackend.open(l.link)).create({ kind: "sandbox" });
    expect(machine.previewUrl).toBeUndefined();
    expect(machine.metrics).toBeUndefined();
    expect(machine.describe).toBeDefined();
  });

  it("fills a create with the logins that computer signs in once and shares into every workspace on it", async () => {
    const l = link(sent =>
      sent.op === "machine.backend" ? { ...FACTS, logins: "/var/lib/wsp/logins" } : sent.op === "machine.create" ? { machine: HANDLE } : {},
    );
    const backend = await LinkBackend.open(l.link);
    await backend.create({ kind: "sandbox" });
    // The catalog's own rows, at the directory that computer said it keeps them in: Codex's auth.json today.
    expect((l.sent.at(-1)!.params["spec"] as MachineSpec).shares).toEqual(sharesIn("/var/lib/wsp/logins"));
    // A builder becomes an image, and a sign-in never sits in one, so it shares nothing at all.
    await backend.create({ kind: "sandbox", labels: { [BUILDER_LABEL]: "1" } });
    expect((l.sent.at(-1)!.params["spec"] as MachineSpec).shares).toBeUndefined();
  });

  it("shares nothing where the computer names no logins directory, which is every provider", async () => {
    const { l, backend } = await withMachine(() => ({}));
    await backend.create({ kind: "sandbox" });
    expect(l.sent.at(-1)!.params["spec"]).toEqual({ kind: "sandbox" });
  });

  it("execs with the caller's bound, and waits a little longer than it for the answer", async () => {
    const { l, backend } = await withMachine(() => ({ result: { exitCode: 0, stdout: "hi", stderr: "" } }));
    const machine = await backend.create({ kind: "sandbox" });
    expect(await machine.exec("echo hi", { timeoutMs: 1000 })).toEqual({ exitCode: 0, stdout: "hi", stderr: "" });
    expect(l.sent.at(-1)).toMatchObject({ op: "machine.exec", params: { machineId: "c1", cmd: "echo hi", timeoutMs: 1000 }, timeoutMs: 1000 + LINK_MARGIN_MS });
  });

  it("runs a script over exec frames and sends no run frame of its own", async () => {
    const { l, backend } = await withMachine(sent => ({
      result: { exitCode: 0, stdout: String(sent.params["cmd"]).includes("WSP_LAUNCHED") ? "WSP_LAUNCHED" : "0", stderr: "" },
    }));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.run("echo hi", { deadlineMs: 100, pollMs: 1 }).catch(() => undefined);
    expect(l.sent.every(s => s.op !== "machine.run")).toBe(true);
    expect(l.sent.filter(s => s.op === "machine.exec").length).toBeGreaterThan(0);
  });

  it("answers one daemon frame for this machine by sending it up the link with the machine named, and hands a refusal back as the reply", async () => {
    // A workspace on a computer somebody owns runs no daemon of its own: its files and its git are answered by the
    // daemon of the computer holding it, over the link this backend already holds.
    const { l, backend } = await withMachine(sent => (sent.op === "git.status" ? { branch: { head: "work" }, entries: [], root: "/root/work" } : {}));
    const machine = await backend.get("c1");
    const reply = await machine.daemonFrame!({ op: "git.status", cwd: "/root/work" });
    expect(l.sent.at(-1)).toMatchObject({ op: "git.status", params: { cwd: "/root/work", machineId: "c1" } });
    expect(reply).toMatchObject({ ok: true, root: "/root/work" });
    // A refusal comes back as the reply it was, with the code the daemon put on it, so a caller reads the reason:
    // a bring back tells a computer with no signed-in gh from a checkout with no remote by that code alone.
    const refused = opened(sent =>
      sent.op === "machine.get" ? { machine: HANDLE } : Object.assign(new Error("no signed-in command line for github.com"), { code: "no-host-cli" }),
    );
    const other = await (await LinkBackend.open(refused.link)).get("c1");
    expect(await other.daemonFrame!({ op: "git.pr", cwd: "/root/work" })).toEqual({
      ok: false,
      error: "no signed-in command line for github.com",
      code: "no-host-cli",
    });
  });

  it("reads a refusal the far side's own backend gave, so a container it lost is missing here", async () => {
    const l = opened(sent => (sent.op === "machine.get" ? Object.assign(new Error("no such container"), { kind: "missing", status: 404 }) : {}));
    const backend = await LinkBackend.open(l.link);
    await expect(backend.get("c9")).rejects.toSatisfy(isMissing);
  });

  it("passes a place that is not connected through as it is", async () => {
    const l = opened(sent => (sent.op === "machine.get" ? new PlaceAbsentError("srv is not connected right now") : {}));
    const backend = await LinkBackend.open(l.link);
    await expect(backend.get("c1")).rejects.toSatisfy(isPlaceAbsent);
  });

  it("sends a file in parts under one upload, in order, the last one marked", async () => {
    const { l, backend } = await withMachine(() => ({}));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.putBytes!("/root/big", new Uint8Array(9 * 1024 * 1024));
    const parts = l.sent.filter(s => s.op === "machine.putBytes");
    expect(parts.map(p => p.params["seq"])).toEqual([0, 1, 2]);
    expect(parts.map(p => p.params["last"])).toEqual([false, false, true]);
    expect(new Set(parts.map(p => p.params["uploadId"])).size).toBe(1);
    expect(Buffer.from(String(parts[0]!.params["data"]), "base64").length).toBe(MACHINE_PUT_PART_BYTES);
  });

  it("names a create by the key its spec carries, so the far side answers the machine it already made, and names one with no key not at all", async () => {
    const { l, backend } = await withMachine(() => ({}));
    await backend.create({ kind: "sandbox", idempotencyKey: "workspace/ws_1:a1" });
    expect(l.sent.at(-1)!.idempotencyKey).toBe("workspace/ws_1:a1");
    await backend.create({ kind: "sandbox" });
    expect(l.sent.at(-1)!.idempotencyKey).toBeUndefined();
  });

  it("names an exec the caller says lands the same twice, and sends every other one unnamed", async () => {
    const { l, backend } = await withMachine(() => ({ result: { exitCode: 0, stdout: "", stderr: "" } }));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.exec("rm -f /tmp/x", { idempotencyKey: "clean/1" });
    expect(l.sent.at(-1)!.idempotencyKey).toBe("clean/1");
    await machine.exec("echo hi");
    expect(l.sent.at(-1)!.idempotencyKey).toBeUndefined();
  });

  it("carries no key on a part, and sends the whole upload again under a fresh id when the link went and came back", async () => {
    let broken = true;
    const l = link(
      sent => {
        if (sent.op === "machine.backend") return FACTS;
        if (sent.op === "machine.create") return { machine: HANDLE };
        if (sent.op === "machine.putBytes" && broken && sent.params["seq"] === 1) return new Error("connection lost");
        return {};
      },
      async () => {
        broken = false;
        return true;
      },
    );
    const machine = await (await LinkBackend.open(l.link)).create({ kind: "sandbox" });
    await machine.putBytes!("/root/big", new Uint8Array(9 * 1024 * 1024));
    const parts = l.sent.filter(s => s.op === "machine.putBytes");
    // A part appended twice would splice the file, so no part names itself as one to ask again.
    expect(parts.every(p => p.idempotencyKey === undefined)).toBe(true);
    // Two parts of the broken upload, then all three again under a name the far side holds nothing under.
    expect(parts.map(p => p.params["seq"])).toEqual([0, 1, 0, 1, 2]);
    const ids = [...new Set(parts.map(p => p.params["uploadId"]))];
    expect(ids).toHaveLength(2);
    expect(parts.slice(2).every(p => p.params["uploadId"] === ids[1])).toBe(true);
  });

  it("fails an upload with the part's own answer when the computer never came back, and asks nothing again when the link never went", async () => {
    const away = link(
      sent => (sent.op === "machine.backend" ? FACTS : sent.op === "machine.create" ? { machine: HANDLE } : sent.op === "machine.putBytes" ? new Error("connection lost") : {}),
      async () => false,
    );
    const gone = await (await LinkBackend.open(away.link)).create({ kind: "sandbox" });
    await expect(gone.putBytes!("/root/big", new Uint8Array([1]))).rejects.toThrow("connection lost");
    expect(away.sent.filter(s => s.op === "machine.putBytes")).toHaveLength(1);

    const refused = link(
      sent => (sent.op === "machine.backend" ? FACTS : sent.op === "machine.create" ? { machine: HANDLE } : sent.op === "machine.putBytes" ? new Error("no space left on device") : {}),
      async () => false,
    );
    const full = await (await LinkBackend.open(refused.link)).create({ kind: "sandbox" });
    await expect(full.putBytes!("/root/big", new Uint8Array([1]))).rejects.toThrow("no space left on device");
    expect(refused.sent.filter(s => s.op === "machine.putBytes")).toHaveLength(1);
  });

  it("sends one part for one byte", async () => {
    const { l, backend } = await withMachine(() => ({}));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.putBytes!("/root/one", new Uint8Array([7]));
    const parts = l.sent.filter(s => s.op === "machine.putBytes");
    expect(parts.length).toBe(1);
    expect(parts[0]!.params["last"]).toBe(true);
  });

  it("turns the far side's own loopback route into one on this computer", async () => {
    const { l, backend } = await withMachine(sent => (sent.op === "machine.previewUrl" ? { reach: { url: "http://127.0.0.1:32773", token: "", expiresAt: 1 } } : {}));
    const machine = await backend.create({ kind: "sandbox" });
    const reach = await machine.previewUrl!(7070);
    expect(l.forwarded).toEqual([32773]);
    expect(reach).toEqual({ url: "http://127.0.0.1:51001", token: "", expiresAt: Number.MAX_SAFE_INTEGER });
  });

  it("asks the machine itself whether its daemon answers, with the caller's bound", async () => {
    const { l, backend } = await withMachine(() => ({ answers: true }));
    const machine = await backend.create({ kind: "sandbox" });
    expect(await machine.daemonAnswers!()).toBe(true);
    expect(l.sent.at(-1)).toMatchObject({ op: "machine.daemonAnswers", params: { timeoutMs: INLINE_EXEC_MS }, timeoutMs: INLINE_EXEC_MS + LINK_MARGIN_MS });
  });

  it("stops waiting on a resume the caller gave up on, having sent it once", async () => {
    const never = new Promise<never>(() => {});
    const l = opened(sent => {
      if (sent.op === "machine.create") return { machine: HANDLE };
      if (sent.op === "machine.resume") return never;
      return {};
    });
    const backend = await LinkBackend.open(l.link);
    const machine = await backend.create({ kind: "sandbox" });
    const stop = new AbortController();
    const resumed = machine.resume(stop.signal);
    stop.abort(new Error("the person stopped the wake"));
    await expect(resumed).rejects.toThrow("the person stopped the wake");
    expect(l.sent.filter(s => s.op === "machine.resume").length).toBe(1);
  });

  it("reads how long the machine has been quiet off one reading, and nothing where the far side does not count it", async () => {
    const reading = { state: "running" as const, cgroup: "/sys/fs/cgroup/wsp/c1", upper: "/wsp/run/c1/upper" };
    const l = opened(sent => {
      if (sent.op === "machine.create") return { machine: HANDLE };
      if (sent.op === "machine.metrics") return { reading: { ...reading, quietForMs: 143_000 } };
      return {};
    });
    const backend = await LinkBackend.open(l.link);
    const machine = await backend.create({ kind: "sandbox" });
    expect(await backend.lifecycle!.quietForMs!(machine)).toBe(143_000);
    expect(l.sent.at(-1)).toMatchObject({ op: "machine.metrics", params: { machineId: "c1" } });
    // A daemon that does not count it answers a reading without the figure, and the host is left with its own
    // clock: undefined and not zero, since zero would read as a workspace that was busy a moment ago.
    const quiet = opened(sent => {
      if (sent.op === "machine.create") return { machine: HANDLE };
      if (sent.op === "machine.metrics") return { reading };
      return {};
    });
    const older = await LinkBackend.open(quiet.link);
    expect(await older.lifecycle!.quietForMs!(await older.create({ kind: "sandbox" }))).toBeUndefined();
  });

  it("reads the capacity of the computer on the far side", async () => {
    const capacity = { cores: 3, memMb: 3900, memRoomMb: 1950, machineMemMb: 1950, diskFreeBytes: 10, images: [], machines: { running: 1, paused: 0 } };
    const l = opened(sent => (sent.op === "machine.capacity" ? capacity : {}));
    expect(await (await LinkBackend.open(l.link)).capacity()).toEqual(capacity);
  });
});

