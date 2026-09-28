// SPDX-License-Identifier: AGPL-3.0-only
// A saved key reaches the runtime's provider slot and builds nothing there, since
// a copy bills and is built on a press; a runtime made without a slot says so
// instead of taking the key and doing nothing with it.
import { createRuntime, memoryStore } from "@wsp/runtime";
import { describe, expect, it } from "vitest";
import { makeRuntime, providerSlotOf, swapProvider } from "../src/cli.js";
import { SOLARI_KEY_ENV } from "../src/providers.js";
import { stubBackend } from "./stub-backend.js";

describe("the provider slot behind a host's runtime", () => {
  it("makeRuntime wires a slot a saved key swaps the module in; a runtime from elsewhere refuses the swap in one line", async () => {
    const rt = makeRuntime({}, "/tmp/wsp-provider-swap/state.json");
    try {
      expect(providerSlotOf(rt)?.current().capabilities.previewUrls).toBe(false);
      // The key is up: the provider is a place, and no copy is built behind the save.
      const kept: string[] = [];
      rt.image.keepCurrent = async place => {
        kept.push(place);
      };
      swapProvider(rt, { [SOLARI_KEY_ENV]: "slr_live_fake" });
      expect(providerSlotOf(rt)?.current().capabilities.previewUrls).toBe(true);
      expect(kept).toEqual([]);
    } finally {
      await rt.close();
    }
    const bare = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    try {
      expect(() => swapProvider(bare, { [SOLARI_KEY_ENV]: "slr_live_fake" })).toThrow(/no provider slot/);
    } finally {
      await bare.close();
    }
  });
});
