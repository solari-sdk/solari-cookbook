// SPDX-License-Identifier: AGPL-3.0-only
// The golden's recipe can arrive with the prepare instead of the runtime: a
// host serving the app builds the golden the init job asks for on the one
// runtime it already has, and the seal reads the recipe that prepare carried.
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";

describe("a golden recipe named per call", () => {
  it("a runtime wired without a recipe refuses a bare prepare, prepares from the recipe the call names, and seals with that recipe's smoke", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "h1" });
    await expect(rt.golden.prepare({ name: "default" })).rejects.toThrow(/no golden recipe/);
    const builder = await rt.golden.prepare({ name: "default", recipe: { setup: "echo setup-from-call", smoke: "echo smoke-from-call" } });
    expect(backend.machines[0]!.execLog.some(c => c.includes("echo setup-from-call"))).toBe(true);
    const { version } = await rt.golden.seal(builder.id);
    expect(version.smoke.cmd).toBe("echo smoke-from-call");
    expect(version.version).toBe(1);
  });

  it("a recipe the runtime was wired with still answers a prepare that names none", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "h1", goldenRecipe: { setup: "echo wired", smoke: "echo wired-smoke" } });
    const builder = await rt.golden.prepare({ name: "default" });
    expect(backend.machines[0]!.execLog.some(c => c.includes("echo wired"))).toBe(true);
    expect((await rt.golden.seal(builder.id)).version.smoke.cmd).toBe("echo wired-smoke");
  });
});
