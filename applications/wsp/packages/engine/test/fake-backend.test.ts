// SPDX-License-Identifier: AGPL-3.0-only
// The provider a harness serves a fixture through: it answers for machines it
// never minted, says plainly that there is no guest behind them until one is
// wired, and keeps what it holds where a second process reads it.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeGuest } from "../src/fake-backend.js";
import { FAKE_NO_GUEST, FakeBackend, standInRecordsUnreadable } from "../src/fake-backend.js";

describe("the provider that answers out of memory", () => {
  it("names itself when a road reaches for the guest, rather than answering an empty success", async () => {
    const machine = await new FakeBackend().get("fk_c0ffee");
    await expect(machine.exec("echo WSP_LAUNCHED")).rejects.toThrow(FAKE_NO_GUEST);
    await expect(machine.run("echo hi", { deadlineMs: 1_000 })).rejects.toThrow(FAKE_NO_GUEST);
    // Exit 0 with nothing was read by the launch check as a failure it could not word: "exit 0: " with no reason
    // after it, which a tester met as the app losing their thread.
    // The sentence is for a person who has never read this code: it says what the provider is and what it will
    // not do, in words nobody has to be taught.
    expect(FAKE_NO_GUEST).toContain("stand-in provider for testing");
    expect(FAKE_NO_GUEST).toContain("nothing runs on them");
    for (const jargon of ["out of memory", "no guest", "capability", "landsBytes"]) expect(FAKE_NO_GUEST).not.toContain(jargon);
  });

  it("still answers for a machine a fixture names, since the record has to load, and reads its state off the records", async () => {
    // Running unless the records say otherwise: the id used to carry a suffix for the word asleep, which is a
    // second place one fact lived and which printed in the MACHINE column of the table wsp draws.
    const backend = new FakeBackend();
    expect(await (await backend.get("fk_c0ffee")).state()).toBe("running");
    expect(await (await backend.get("fk_c0ffee.paused")).state()).toBe("running");
  });
});

describe("the records a stand-in keeps where more than one process reads them", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const throwaway = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-stand-in-test-"));
    made.push(dir);
    return dir;
  };

  it("holds its machines in the file it was given, so a second host on one state file finds the fleet the first holds", async () => {
    const records = join(throwaway(), "records.json");
    await (await new FakeBackend({ records }).get("fk_c0ffee")).pause();
    // A tester typing a verb starts a second process against the same state file; with the fleet in one process's
    // memory that second one reads every machine as something it has never heard of.
    const second = new FakeBackend({ records });
    expect(await (await second.get("fk_c0ffee")).state()).toBe("paused");
    expect((await second.list()).map(m => m.id)).toEqual(["fk_c0ffee"]);
  });

  it("lists the snapshots a harness seeded and the ones its machines take, so an account is not empty beside its own image", async () => {
    const records = join(throwaway(), "records.json");
    const sealed = { id: "fksnap_v2", name: "wsp-standin-default-v2", sizeBytes: 8, createdAt: "2026-09-12T09:00:00Z" };
    writeFileSync(records, JSON.stringify({ machines: {}, snapshots: [sealed] }));
    const backend = new FakeBackend({ records });
    // A fixture's image says two versions are sealed; a provider listing none priced that account at zero
    // snapshots, and the snapshot a tester then took did not move it either.
    expect(await backend.listSnapshots()).toEqual([sealed]);
    const taken = await (await backend.get("fk_c0ffee")).snapshot("wsp-standin-project-notes", { firstLife: true });
    expect((await new FakeBackend({ records }).listSnapshots()).map(r => r.id)).toEqual([sealed.id, taken]);
    await backend.deleteSnapshot(sealed.id);
    expect((await new FakeBackend({ records }).listSnapshots()).map(r => r.id)).toEqual([taken]);
    expect(JSON.parse(readFileSync(records, "utf8")).machines.fk_c0ffee.state).toBe("running");
  });

  it("never takes a file it cannot read for an empty fleet, and writes by renaming so nobody reads half of one", async () => {
    const records = join(throwaway(), "records.json");
    const whole = JSON.stringify({
      machines: { "fk_slr_2": { state: "paused", shape: { cpu: 4, memMb: 8192, diskGb: 20 }, labels: {} } },
      snapshots: [{ id: "fksnap_v1", sizeBytes: 8 }, { id: "fksnap_v2", sizeBytes: 8 }],
    });
    // The file as a reader in another process saw it while it was being written: cut at half its length.
    const torn = whole.slice(0, Math.floor(whole.length / 2));
    writeFileSync(records, torn);
    const backend = new FakeBackend({ records });
    // Reading it as an empty fleet was the whole of the harm: the next change wrote that emptiness back, so the
    // snapshots a harness had seeded went and a fork somebody had paused read Running again.
    await expect(backend.get("fk_slr_1")).rejects.toThrow(standInRecordsUnreadable(records, ""));
    await expect(backend.listSnapshots()).rejects.toThrow(/is not this stand-in provider's records/);
    expect(readFileSync(records, "utf8")).toBe(torn);

    // A rename is one step, so what a second process reads is the records before a change or after it. Nothing is
    // left beside them either.
    writeFileSync(records, whole);
    await (await backend.get("fk_slr_1")).pause();
    expect(existsSync(`${records}.next`)).toBe(false);
    const after = new FakeBackend({ records });
    expect((await after.listSnapshots()).map(r => r.id)).toEqual(["fksnap_v1", "fksnap_v2"]);
    expect(await (await after.get("fk_slr_2")).state()).toBe("paused");

    // A folder a caller named and nobody seeded is an empty fleet, which is not the same thing.
    const fresh = new FakeBackend({ records: join(throwaway(), "records.json") });
    expect(await fresh.listSnapshots()).toEqual([]);
    expect(await fresh.list()).toEqual([]);
  });

  it("runs a machine's commands in that machine's own folder once a guest is wired, and has no route to a port without one", async () => {
    const root = throwaway();
    const guest: FakeGuest = {
      folder: machineId => join(root, machineId),
      tokenPath: machineId => join(root, machineId, "token"),
      reach: async machineId => ({ url: `http://127.0.0.1:1/${machineId}`, token: "", expiresAt: 1 }),
    };
    // Without one nothing is reachable and nothing runs, which is what it has always been.
    expect(new FakeBackend().capabilities.previewUrls).toBe(false);
    expect((await new FakeBackend().get("fk_c0ffee")).previewUrl).toBeUndefined();
    const backend = new FakeBackend({ guest });
    expect(backend.capabilities.previewUrls).toBe(true);
    const machine = await backend.get("fk_c0ffee");
    // Three cloud personas in a row met Live unreachable, Processes empty and no terminal on a Running fork; all
    // three are the daemon rooted in this folder answering.
    expect((await machine.exec("pwd")).stdout.trim()).toBe(realpathSync(join(root, "fk_c0ffee")));
    expect((await machine.run("echo hello", { deadlineMs: 5_000 })).stdout.trim()).toBe("hello");
    expect(await machine.previewUrl!(7070)).toEqual({ url: "http://127.0.0.1:1/fk_c0ffee", token: "", expiresAt: 1 });
    // The runtime writes a machine's daemon token by running a command on it, and a shell on this computer cannot
    // write the path a Linux guest keeps one at, so the machine says where its own is.
    expect(machine.daemonTokenPath).toBe(join(root, "fk_c0ffee", "token"));
  });
});
