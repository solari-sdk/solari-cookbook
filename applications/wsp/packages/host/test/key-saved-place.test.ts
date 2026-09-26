// SPDX-License-Identifier: AGPL-3.0-only
// A provider key saved from the app, the road the init job's keys step takes,
// makes that provider a computer on the host that saved it and on every later
// read of the same home, whichever provider the key is for.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goldenRecipe, makeRuntime, optsFor, swapProvider } from "../src/cli.js";
import { envFileFor, savedEnv, writeEnvFile } from "../src/env-keys.js";
import { placeWiring } from "../src/places.js";
import { providerKeySet } from "../src/providers.js";
import type { Runtime } from "@wsp/runtime";

const homes: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A host serving this state file as a fresh run reads it: the provider picked out of the .env beside it alone. */
function hostOn(statePath: string): Runtime {
  const { providerEnv } = optsFor({ state: statePath }, {});
  const rt = makeRuntime({}, statePath, goldenRecipe({}), providerEnv, undefined, undefined, placeWiring(statePath));
  runtimes.push(rt);
  return rt;
}

/** What the keys step does once the provider took the key: write it beside the state, then swap the saved record in. */
function saveKey(rt: Runtime, statePath: string, provider: string, key: string): void {
  const { providerEnv } = optsFor({ state: statePath }, {});
  writeEnvFile(envFileFor(statePath), providerKeySet(providerEnv, key, provider)!);
  swapProvider(rt, savedEnv(statePath));
}

const computers = async (rt: Runtime): Promise<string[]> => (await rt.places!.list(0)).filter(p => p.kind === "provider").map(p => p.id);

function freshState(): string {
  const home = mkdtempSync(join(tmpdir(), "wsp-key-saved-place-"));
  homes.push(home);
  return join(home, "state.json");
}

describe("a provider key saved from the app", () => {
  for (const [provider, key] of [
    ["box", "ascii_live_fake"],
    ["solari", "slr_live_fake"],
  ] as const) {
    it(`makes ${provider} a computer on the host that saved it and on a fresh read of the same home`, async () => {
      const statePath = freshState();
      const rt = hostOn(statePath);
      expect(await computers(rt)).toEqual([]);
      saveKey(rt, statePath, provider, key);
      expect(await computers(rt)).toEqual([provider]);
      expect(await computers(hostOn(statePath))).toEqual([provider]);
    });
  }

  it("makes both providers computers once both keys are saved", async () => {
    const statePath = freshState();
    const rt = hostOn(statePath);
    saveKey(rt, statePath, "box", "ascii_live_fake");
    saveKey(rt, statePath, "solari", "slr_live_fake");
    expect((await computers(rt)).sort()).toEqual(["box", "solari"]);
    expect((await computers(hostOn(statePath))).sort()).toEqual(["box", "solari"]);
  });
});
