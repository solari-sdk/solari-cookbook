// SPDX-License-Identifier: AGPL-3.0-only
// A host started without its provider key serves. The records it holds are a
// provider's, and nothing can be asked about their machines until the key is
// back, so each is left at the word it was left with and every road on one
// answers the sentence that names what is missing. A host that failed at the
// first such record instead served no app port at all, and every verb read
// "no wsp host is serving" rather than the sentence about the provider.
import { describe, expect, it } from "vitest";
import { NoProviderBackend } from "@wsp/engine";
import { NO_PROVIDER_LINE } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";

/** A state a host with a provider wrote: one running cloud workspace, read again by a host with no key. */
async function keyless(): Promise<{ store: Store; workspaceId: string }> {
  const store = memoryStore();
  const first = createRuntime({ backend: stubBackend(), store, adapters: {} });
  const ws = await createOn(first, { golden: "snap_g", name: "first" });
  await first.close();
  return { store, workspaceId: ws.id };
}

describe("a host started without its provider", () => {
  it("serves, keeps every cloud record listed at the word it was left with, and answers the provider's sentence on each", async () => {
    const { store, workspaceId } = await keyless();
    const rt = createRuntime({ backend: new NoProviderBackend(), store, adapters: {} });

    // The lists and the meter read the records this host holds, so a record dropped here is one nobody can see.
    expect(await rt.workspaces.list()).toMatchObject([{ id: workspaceId, name: "first", phase: "running", kind: "cloud" }]);
    expect(await rt.workspaces.resolve("first")).toMatchObject({ id: workspaceId });
    // Every road on that record says the one thing that is true about it: the key is what is missing.
    await expect(rt.workspaces.nap(workspaceId)).rejects.toThrow(NO_PROVIDER_LINE);
    // The record is left exactly as it was: nothing is called gone for want of a key.
    expect(await store.get("workspaces", workspaceId)).toMatchObject({ id: workspaceId, phase: "running" });
    await rt.close();
  });

  it("reads a builder another host left as it is, rather than failing the whole start on it", async () => {
    const { store } = await keyless();
    await store.put("builders", "m_b1", { id: "m_b1", kind: "sandbox", createdAt: new Date().toISOString(), firstLife: true, baseTemplate: "t", setupSha: "s" });
    const rt = createRuntime({ backend: new NoProviderBackend(), store, adapters: {} });
    await rt.workspaces.list();
    // Still there for the host that has the key: a record nothing could be asked about is never dropped.
    expect(await store.get("builders", "m_b1")).toMatchObject({ id: "m_b1" });
    await rt.close();
  });
});
