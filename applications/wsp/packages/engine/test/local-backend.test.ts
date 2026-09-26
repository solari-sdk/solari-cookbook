// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_MACHINE_ID, LocalBackend, localShape } from "../src/local-backend.js";

describe("local backend", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-local-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("every capability a provider fork has and a computer does not is false, it offers no sizes, and it says the machine is kept", () => {
    const backend = new LocalBackend({ root });
    expect(backend.capabilities).toEqual({
      liveCloneForks: false,
      replacesMachine: false,
      previewUrls: false,
      signedUrls: false,
      callbackRelay: false,
      diskSnapshots: false,
      images: false,
      snapshotsAnyLife: false,
      snapshotListing: false,
      templates: false,
      // This computer is the person's own: its files and sign-ins outlive every turn, so a thread on it starts at
      // the access its harness asks for rather than at skip-everything. The one fact that road reads.
      kept: true,
      // A workspace here is a copy of the project folder at a path of its own, and every copy binds this one
      // computer's ports, which is why each gets a port base and the row says the ports are shared.
      copies: true,
      ownNetwork: false,
      sizes: [],
    });
    expect(backend.pricing.rateUsdPerHour({ cpu: 2, memMb: 4096 })).toBe(0);
  });

  it("this computer's size is its cores and its memory in whole GB, since a kernel reports a little under the chips it has", () => {
    // A 16 GB Linux box reports about 15.5 GiB as MemTotal; a Mac reports the whole 16.
    expect(localShape(10, 16_654_508_032)).toEqual({ cpu: 10, memMb: 16_384 });
    expect(localShape(10, 16 * 1024 ** 3)).toEqual({ cpu: 10, memMb: 16_384 });
    expect(localShape(8, 8 * 1024 ** 3)).toEqual({ cpu: 8, memMb: 8_192 });
    expect(new LocalBackend({ root }).pricing.defaultSize.memMb % 1024).toBe(0);
  });

  it("get and list answer with the one machine that already exists, and it reads running", async () => {
    const backend = new LocalBackend({ root });
    const machine = await backend.get();
    expect(machine.id).toBe(LOCAL_MACHINE_ID);
    expect(await machine.state()).toBe("running");
    const listed = await backend.list();
    expect(listed).toEqual([{ id: LOCAL_MACHINE_ID, state: "running", labels: {} }]);
  });

  it("facts say what this computer is: the system by its maker's name, how long it has been up, and the folder commands start in", async () => {
    const backend = new LocalBackend({ root });
    const machine = await backend.get();
    expect(machine.facts).toBeDefined();
    const facts = await machine.facts!();
    expect(facts.os).toMatch(/^(macOS \d|[A-Z][A-Za-z]+ )/);
    expect(facts.os).not.toBe("");
    expect(facts.uptimeMs).toBeGreaterThan(0);
    expect(facts.folder).toBe(root);
    // The name is read once and held; the uptime is read again.
    expect((await machine.facts!()).os).toBe(facts.os);
  });

  it("exec runs a shell command on this computer under the workspace folder and returns its exit code", async () => {
    const backend = new LocalBackend({ root });
    const machine = await backend.get();
    const ok = await machine.exec("printf hi; pwd");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("hi");
    const bad = await machine.exec("exit 7");
    expect(bad.exitCode).toBe(7);
  });

  it("files read and write under the workspace folder through exec", async () => {
    const backend = new LocalBackend({ root });
    const machine = await backend.get();
    const wrote = await machine.exec("printf pong > note.txt");
    expect(wrote.exitCode).toBe(0);
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("pong");
    const read = await machine.exec("cat note.txt");
    expect(read.stdout).toBe("pong");
  });

  it("run streams each line and answers with the exit code", async () => {
    const backend = new LocalBackend({ root });
    const machine = await backend.get();
    const lines: string[] = [];
    const res = await machine.run("printf 'a\\nb\\n'; exit 3", { deadlineMs: 5000, onLine: l => lines.push(l) });
    expect(lines).toEqual(["a", "b"]);
    expect(res.exitCode).toBe(3);
  });

  it("a command past its deadline is killed and answers 124", async () => {
    const backend = new LocalBackend({ root });
    const machine = await backend.get();
    const res = await machine.run("sleep 5", { deadlineMs: 150 });
    expect(res.exitCode).toBe(124);
  });

  it("the moves only a provider fork takes are refused, and it serves no preview or signed URL", async () => {
    const backend = new LocalBackend({ root });
    const machine = await backend.get();
    // Each refusal is a rejection, never a synchronous throw, so a caller's .catch sees it.
    await expect(machine.snapshot("x", { firstLife: true })).rejects.toThrow();
    await expect(machine.pause()).rejects.toThrow();
    await expect(machine.resume()).rejects.toThrow();
    expect(machine.previewUrl).toBeUndefined();
    await expect(machine.downloadUrl("/x")).rejects.toThrow();
    await expect(machine.uploadUrl("/x")).rejects.toThrow();
    await expect(backend.create()).rejects.toThrow();
    await expect(backend.deleteSnapshot()).rejects.toThrow();
    // Deleting a local workspace drops its record only: kill is a no-op, never a stop.
    await expect(machine.kill()).resolves.toBeUndefined();
    expect(await machine.state()).toBe("running");
  });
});
