// SPDX-License-Identifier: AGPL-3.0-only
// A workspace on a computer that keeps no image has no vault at all: its nap
// is the machine's own stop, nothing of that computer's home is read or
// stored, and a wake puts nothing back. The kinds that keep an image nap
// exactly as they did.
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { DAEMON_TOKEN_PATH } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { createOn, stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";

/** A port nothing listens on, so the wake's read of the daemon fails and the wake runs out its attempts. */
async function deadPort(): Promise<number> {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** A stub whose guest answers what the vault road asks of it: the listing of the home it would archive and the
 * size of the archive it wrote. Every tar and untar is recorded by machine, so a nap that took the vault road is
 * read back here by name rather than guessed at from a blob.
 */
function guestBackend(): { backend: StubBackend; tars: string[]; untars: string[] } {
  const backend = stubBackend();
  const tars: string[] = [];
  const untars: string[] = [];
  backend.execImpl = (m, cmd) => {
    if (cmd.includes(DAEMON_TOKEN_PATH)) return tokenGuest(m, cmd);
    if (cmd.includes("ls -A /root")) return { exitCode: 0, stdout: "notes.md\n", stderr: "" };
    if (cmd.startsWith("wc -c <")) return { exitCode: 0, stdout: "1000\n", stderr: "" };
    if (cmd.includes("tar czf")) tars.push(m.id);
    if (cmd.includes("tar xzf")) untars.push(m.id);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string }) => (init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")))),
  );
  return { backend, tars, untars };
}

/** Every command every machine of this backend was asked, oldest first. */
const commands = (backend: StubBackend): string[] => backend.machines.flatMap(m => m.execLog);

describe("the nap of a workspace on a computer that keeps no image", () => {
  const imageless = (): { backend: StubBackend; tars: string[]; untars: string[]; store: Store } => {
    const made = guestBackend();
    // What such a computer says about itself: a workspace on it is a copy of the computer, and the pause of one is
    // the stop of its machine on that computer's own disk.
    made.backend.capabilities.images = false;
    made.backend.capabilities.pauseMode = "disk";
    return { ...made, store: memoryStore() };
  };

  it("pauses the machine and reads nothing of the computer's home: no listing, no archive, no stored vault, and the record says nothing about a backup", async () => {
    const { backend, tars, untars, store } = imageless();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      const ws = await createOn(rt, { name: "x" });
      const m = backend.machines[0]!;
      // What the create left on the machine, so what the nap itself sends is read on its own.
      const sent = { execs: m.execLog.length, runs: m.runLog.length };
      const napped = await rt.workspaces.nap(ws.id);
      expect(napped.phase).toBe("napping");
      expect(m.paused).toBe(true);
      // The pause costs the machine nothing: no command and no script, which is where the tens of seconds went.
      expect({ execs: m.execLog.length, runs: m.runLog.length }).toEqual(sent);
      // The two commands the vault road runs on the machine: the breadcrumb it appends to that computer's home and
      // the listing it enumerates from. Neither is sent.
      expect(commands(backend).some(c => c.includes(".wsp-upgraded"))).toBe(false);
      expect(commands(backend).some(c => c.includes("ls -A /root"))).toBe(false);
      expect(tars).toEqual([]);
      expect(await store.getBlob("vaults", ws.id)).toBeUndefined();
      const record = await rt.workspaces.get(ws.id);
      expect(record.vaultedAt).toBeUndefined();
      expect(record.vaultRefused).toBeUndefined();
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken.phase).toBe("running");
      expect(backend.machines[0]!.resumes).toBe(1);
      expect(untars).toEqual([]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  it("drops what a nap before this rule wrote on the record about a backup, so no row reads a refusal about a vault the workspace never had", async () => {
    const { backend, store } = imageless();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      const ws = await createOn(rt, { name: "x" });
      // The record as spoo's own was after one nap over the cap: the stamp and the refusal a vault road wrote.
      const held = (await store.get("workspaces", ws.id)) as Record<string, unknown>;
      await store.put("workspaces", ws.id, { ...held, vaultedAt: "2026-09-17T00:00:00.000Z", vaultRefused: "the export was 580 MB, over the 200 MB cap" });
      await rt.close();
      const back = createRuntime({ backend, store, adapters: {} });
      try {
        const read = await back.workspaces.get(ws.id);
        expect(read.vaultRefused).toBeUndefined();
        expect(read.vaultedAt).toBeUndefined();
      } finally {
        await back.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resurrects a fresh copy when the wake runs out its attempts, carrying nothing onto it", async () => {
    const { backend, untars, store } = imageless();
    const port = await deadPort();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      backend.lifecycle.budgets.wakeAttempts = 1;
      const ws = await createOn(rt, { name: "x" });
      const m1 = backend.machines[0]!;
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      await rt.workspaces.nap(ws.id);
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken.machineId).toBe("m2");
      expect(m1.killed).toBe(true);
      // The fresh copy is the computer's own disk again: nothing was stashed at the nap and nothing lands here.
      expect(untars).toEqual([]);
      expect(await store.getBlob("vaults", ws.id)).toBeUndefined();
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  it("leaves a computer that keeps an image exactly as it was: every nap stashes the vault and the wake reads it", async () => {
    const { backend, tars, untars } = guestBackend();
    const store = memoryStore();
    const port = await deadPort();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      backend.lifecycle.budgets.wakeAttempts = 1;
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual(["m1"]);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      expect((await rt.workspaces.get(ws.id)).vaultedAt).toBeDefined();
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken.machineId).toBe("m2");
      expect(untars).toEqual(["m2"]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });
});
