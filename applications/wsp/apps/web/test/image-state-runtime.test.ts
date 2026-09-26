// SPDX-License-Identifier: AGPL-3.0-only
// The image card's state read off a real runtime's frames and rows, over stub
// providers: what the host sends when a build stops is what the card reads.
import { describe, expect, it } from "vitest";
import { copyStoppedLine, type GoldenStageEvent } from "@wsp/protocol";
import { createRuntime, memoryStore, newPlaceKeyPair, type PlaceBackends, type PlaceWiring } from "@wsp/runtime";
import { imageState } from "../src/settings/imageState.js";
import { COPY_RECIPE, dfOk, recipeWith } from "../../../packages/runtime/test/image-fixtures.js";
import { stubBackend } from "../../../packages/runtime/test/stub-backend.js";
import { until } from "../../../packages/runtime/test/until.js";

describe("the image card over a real runtime", () => {
  it("a builder the provider refused after a press reads stopped, not copying", async () => {
    const fake = stubBackend("fake");
    const solari = stubBackend("solari");
    for (const b of [fake, solari]) b.execImpl = dfOk;
    const at = { fake, solari };
    const places: PlaceBackends = { wired: "fake", backend: p => at[p as keyof typeof at], list: () => Object.keys(at) };
    const wiring: PlaceWiring = { hostKey: newPlaceKeyPair(), provider: () => ({ id: "fake", rateUsdPerHour: 0 }), here: () => ({ name: "this-mac" }), hostName: () => "this-mac" };
    const rt = createRuntime({ backend: fake, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), copyRecipe: () => COPY_RECIPE, hostId: "h1", places, placeLinks: wiring });
    const frames: Record<string, GoldenStageEvent[]> = {};
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage" && e.place !== undefined) (frames[e.place] ??= []).push(e);
    });
    const b = await rt.golden.prepare({});
    await rt.golden.seal(b.id);

    let refuse: () => void = () => {};
    const gate = new Promise<void>(r => (refuse = r));
    solari.create = async () => {
      await gate;
      throw Object.assign(new Error("no room at solari today"), { kind: "conflict" });
    };
    const building = rt.image.build({ place: "solari" }).catch(() => undefined);
    await until(() => (frames["solari"]?.length ?? 0) > 0);
    refuse();
    await building;

    const row = (await rt.places!.list(Date.now())).find(p => p.id === "solari")!;
    expect(imageState(row, { view: await rt.image.get(), job: null, frames })).toEqual({ kind: "stopped", said: copyStoppedLine("no room at solari today") });
    await rt.close();
  });
});
