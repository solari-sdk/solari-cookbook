// SPDX-License-Identifier: AGPL-3.0-only
// A host that started with no provider key serves this computer alone; the
// init job saves a key while it serves, and the runtime's provider module
// has to become the real one without the runtime being rebuilt. The slot is
// the one backend the runtime holds; what it stands in front of can change.
import { describe, expect, it } from "vitest";
import { NoProviderBackend } from "../src/no-provider-backend.js";
import { providerSlot } from "../src/provider-slot.js";
import type { MachineBackend } from "../src/machine.js";

describe("the provider slot", () => {
  it("delegates every read and call to the module it holds, and a swap moves them all at once", async () => {
    const slot = providerSlot(new NoProviderBackend());
    expect(slot.backend.capabilities.previewUrls).toBe(false);
    await expect(slot.backend.create({ name: "m" } as never)).rejects.toThrow();
    expect(slot.backend.listSnapshots).toBeUndefined();
    const listed: string[] = [];
    const real = {
      ...new NoProviderBackend(),
      capabilities: { ...new NoProviderBackend().capabilities, previewUrls: true, snapshotListing: true },
      list: async () => {
        listed.push("list");
        return [];
      },
      listSnapshots: async () => [],
    } as unknown as MachineBackend;
    slot.swap(real);
    expect(slot.backend.capabilities.previewUrls).toBe(true);
    expect(await slot.backend.list()).toEqual([]);
    expect(listed).toEqual(["list"]);
    expect(typeof slot.backend.listSnapshots).toBe("function");
    expect("listSnapshots" in slot.backend).toBe(true);
    expect(slot.current()).toBe(real);
  });

  it("a method taken off the slot before a swap still runs against the module current when it is called", async () => {
    const before = new NoProviderBackend();
    const slot = providerSlot(before);
    const list = slot.backend.list;
    slot.swap({ ...before, list: async () => [{ id: "m1", state: "running", labels: {} }] } as unknown as MachineBackend);
    expect(await list()).toEqual([{ id: "m1", state: "running", labels: {} }]);
  });
});
