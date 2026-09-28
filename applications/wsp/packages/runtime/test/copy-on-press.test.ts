// SPDX-License-Identifier: AGPL-3.0-only
// A copy of the image at another place is built when someone asks for it and
// never behind a seal: a cut leaves the other copies stale until the next ask, a
// workspace created there while one builds joins that build, a build that
// stopped leaves its reason on the row, a rebuild goes to the image's own place
// whatever place was named, and the place the first image is sealed on becomes
// the default when nothing is marked.
import { describe, expect, it } from "vitest";
import { NoProviderBackend, type MachineSpec } from "@wsp/engine";
import { COPY_BUILD_FIX, HERE_PLACE_ID, copyStoppedLine, type GoldenStageEvent, type PlaceView } from "@wsp/protocol";
import { copyKey, createRuntime, type PlaceBackends } from "../src/runtime.js";
import { goldenHead } from "../src/index.js";
import { PlaceProvisioningError, newPlaceKeyPair, type PlaceWiring } from "../src/places.js";
import { memoryStore } from "../src/store.js";
import { COPY_RECIPE, dfOk, recipeWith } from "./image-fixtures.js";
import { stubBackend, type StubBackend, createOn } from "./stub-backend.js";
import { until } from "./until.js";

/** Three providers over three stubs, as the host's table hands them down: the stand-in this host forks on and
 * seals at, and two more it holds a key for, each marking its snapshot ids so which place's copy a fork names is
 * read off the id; beside them a provider that forks nothing. The door is wired so a create names its place and
 * the rows are read the way wsp places and the app read them. */
function providers() {
  const fake = stubBackend("fake");
  const solari = stubBackend("solari");
  const box = stubBackend("box");
  for (const b of [fake, solari, box]) b.execImpl = dfOk;
  const none = new NoProviderBackend();
  const at: Record<string, StubBackend | NoProviderBackend> = { fake, solari, box, none };
  const places: PlaceBackends = { wired: "fake", backend: p => at[p], list: () => Object.keys(at) };
  const wiring: PlaceWiring = { hostKey: newPlaceKeyPair(), provider: () => ({ id: "fake", rateUsdPerHour: 0 }), here: () => ({ name: "this-mac" }), hostName: () => "this-mac" };
  // How often this computer was read for a copy's recipe: once per build that ran, never for one that did not.
  const composed = { count: 0 };
  const store = memoryStore();
  const rt = createRuntime({
    backend: fake,
    store,
    adapters: {},
    goldenRecipe: recipeWith(),
    copyRecipe: () => {
      composed.count += 1;
      return COPY_RECIPE;
    },
    hostId: "h1",
    places,
    placeLinks: wiring,
  });
  const frames: { stage: string; place?: string }[] = [];
  const sent: GoldenStageEvent[] = [];
  rt.events.on("golden.stage", e => {
    if (e.type !== "golden.stage") return;
    frames.push({ stage: e.stage, ...(e.place !== undefined ? { place: e.place } : {}) });
    sent.push(e);
  });
  const rows = async (): Promise<PlaceView[]> => rt.places!.list(Date.now());
  const row = async (id: string): Promise<PlaceView> => (await rows()).find(p => p.id === id)!;
  const marked = async (): Promise<string | undefined> => (await rows()).find(p => p.default)?.id;
  const current = async (place: string): Promise<boolean> => {
    const view = await rt.image.get();
    return view.copies.some(c => c.place === place && c.hash === view.image!.hash);
  };
  const seal = async (o: { recipeHash?: string; place?: string } = {}) => {
    const b = await rt.golden.prepare({ ...(o.recipeHash !== undefined ? { recipe: recipeWith({ recipeHash: o.recipeHash }) } : {}), ...(o.place !== undefined ? { place: o.place } : {}) });
    return rt.golden.seal(b.id);
  };
  const head = async (): Promise<string> => goldenHead(await rt.golden.get())!.snapshotId;
  return { fake, solari, box, rt, store, composed, frames, sent, row, marked, current, seal, head };
}

/** Holds a stub's creates until released: a build blocked on its first machine, so what happens beside it is read
 * at a moment of the test's choosing. */
function held(stub: StubBackend): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>(r => (release = r));
  const create = stub.create.bind(stub);
  stub.create = async (spec: MachineSpec) => {
    await gate;
    return create(spec);
  };
  return release;
}

/** Long enough for a build started behind a seal to have made its first machine on a stub. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 100));

describe("a copy of the image is built on a press", () => {
  it("a seal builds no copy anywhere else; a press builds one; a cut leaves it stale and builds nothing until the next press", async () => {
    const { fake, solari, box, rt, frames, composed, current, seal } = providers();
    await seal();
    await settle();
    expect([fake.snapshots.length, solari.snapshots.length, box.snapshots.length]).toEqual([1, 0, 0]);
    expect(frames.some(f => f.place !== undefined)).toBe(false);
    expect(composed.count).toBe(0);
    expect((await rt.image.build({ place: "solari" })).built).toBe(true);
    expect(await current("solari")).toBe(true);
    await seal({ recipeHash: "h2" });
    await settle();
    expect(await current("solari")).toBe(false);
    expect([fake.snapshots.length, solari.snapshots.length, box.snapshots.length]).toEqual([2, 1, 0]);
    expect(composed.count).toBe(1);
    expect((await rt.image.build({ place: "solari" })).built).toBe(true);
    expect(await current("solari")).toBe(true);
    await rt.close();
  });

  it("a workspace created on a place whose copy is building joins the build, forks the copy it seals and starts no second one; the row reads the build's stage while it runs and nothing after", async () => {
    const { solari, rt, frames, row, seal, head, composed } = providers();
    await seal();
    const release = held(solari);
    const building = rt.image.build({ place: "solari" });
    await until(() => frames.some(f => f.place === "solari"));
    expect((await row("solari")).build).toBe("copying your image: creating the machine");
    // The create and a second keep both arrive while the builder is still being made.
    const creating = createOn(rt, { golden: await head(), name: "x", on: "solari" });
    void rt.image.keepCurrent("solari");
    release();
    const made = await creating;
    await building;
    const copy = (await rt.image.get()).copies.find(c => c.place === "solari")!;
    expect(made.golden).toBe(copy.snapshotId);
    expect(solari.machines.at(-1)!.spec.fromSnapshot).toBe(copy.snapshotId);
    expect(solari.snapshots).toHaveLength(1);
    expect((await row("solari")).build).toBeUndefined();
    expect(composed.count).toBe(1);
    await rt.close();
  });

  it("a build kept current that stopped leaves its reason on the place's row and no copy there; the next build there takes the row over", async () => {
    const { solari, rt, row, seal, current, sent } = providers();
    const create = solari.create.bind(solari);
    solari.create = async () => {
      throw Object.assign(new Error("no room at solari today"), { kind: "conflict" });
    };
    await seal();
    await rt.image.keepCurrent("solari");
    expect((await row("solari")).build).toContain(copyStoppedLine());
    expect((await row("solari")).build).toContain("no room at solari today");
    expect(sent.filter(e => e.place === "solari" && e.stage === "failed")).toHaveLength(1);
    expect((await rt.image.get()).copies.map(c => c.place)).toEqual(["fake"]);
    solari.create = create;
    const { built } = await rt.image.build({ place: "solari" });
    expect(built).toBe(true);
    expect(await current("solari")).toBe(true);
    expect((await row("solari")).build).toBeUndefined();
    await rt.close();
  });

  it("a copy kept current whose build began on one record and sealed after the cut to the next is stamped with the record it was built from, reads stale, and is built again; the next fork there takes the new copy", async () => {
    const { solari, rt, store, frames, current, seal, head } = providers();
    await seal();
    const v1 = (await rt.image.get()).image!.hash;
    const release = held(solari);
    const keeping = rt.image.keepCurrent("solari");
    await until(() => frames.some(f => f.place === "solari"));
    // The cut lands while the copy is still being built from v1.
    await seal({ recipeHash: "h2" });
    const v2 = (await rt.image.get()).image!.hash;
    expect(v2).not.toBe(v1);
    release();
    await keeping;
    expect(await current("solari")).toBe(true);
    // The first copy carries the hash it was built from, the second the record's now: two builds, not one relabelled.
    const manifest = (await store.get("goldens", copyKey("solari", "default"))) as { versions: { imageHash?: string }[] };
    expect(manifest.versions.map(v => v.imageHash)).toEqual([v1, v2]);
    expect(solari.snapshots).toHaveLength(2);
    const made = await createOn(rt, { golden: await head(), name: "x", on: "solari" });
    const copy = (await rt.image.get()).copies.find(c => c.place === "solari")!;
    expect(copy.hash).toBe(v2);
    expect(made.golden).toBe(copy.snapshotId);
    await rt.close();
  });

  it("each row says whether it can hold the image, and a build that stopped there says it stopped rather than only in words", async () => {
    const { solari, rt, row, seal, sent } = providers();
    expect([(await row("solari")).buildsImages, (await row("box")).buildsImages, (await row("none")).buildsImages, (await row(HERE_PLACE_ID)).buildsImages]).toEqual([true, true, false, false]);
    await seal();
    let refuse: () => void = () => {};
    const gate = new Promise<void>(r => (refuse = r));
    solari.create = async () => {
      await gate;
      throw Object.assign(new Error("no room at solari today"), { kind: "conflict" });
    };
    const building = rt.image.build({ place: "solari" }).catch(() => undefined);
    await until(async () => (await row("solari")).build !== undefined);
    expect((await row("solari")).buildStopped).toBeUndefined();
    refuse();
    await building;
    expect((await row("solari")).buildStopped).toBe(true);
    expect((await row("solari")).build).toContain("no room at solari today");
    // Said on the bus as the build's own stop, so the app's frames end on it too.
    expect(sent.filter(e => e.place === "solari").at(-1)).toMatchObject({ stage: "failed", detail: "no room at solari today" });
    await rt.close();
  });

  it("any failure after a building frame ends the frames with a stop, once, on a press and on a build kept current alike", async () => {
    const { solari, rt, row, seal, sent } = providers();
    await seal();
    solari.create = async () => {
      throw new PlaceProvisioningError("the recipe on solari is still running");
    };
    await rt.image.build({ place: "solari" }).catch(() => undefined);
    expect((await row("solari")).buildStopped).toBe(true);
    expect(sent.filter(e => e.place === "solari").at(-1)).toMatchObject({ stage: "failed", detail: "the recipe on solari is still running" });
    await rt.image.keepCurrent("solari");
    expect((await row("solari")).buildStopped).toBe(true);
    expect(sent.filter(e => e.place === "solari" && e.stage === "failed")).toHaveLength(2);
    await rt.close();
  });

  it("a host with no sealed image keeps nothing current, and a place that forks nothing owes no copy: nothing composed, nothing built, nothing on the row", async () => {
    const { solari, rt, row, composed, seal } = providers();
    await rt.image.keepCurrent("solari");
    expect([solari.machines.length, composed.count]).toEqual([0, 0]);
    expect((await row("solari")).build).toBeUndefined();
    await seal();
    await rt.image.keepCurrent("none");
    expect((await row("none")).build).toBeUndefined();
    expect(composed.count).toBe(0);
    await rt.close();
  });
});

describe("where a rebuild goes", () => {
  it("a first build goes to the place named; once a record stands every build goes to its place, named or not", async () => {
    const { solari, rt, seal } = providers();
    expect((await rt.golden.buildPlace("solari")).place).toBe("solari");
    await seal({ place: "solari" });
    for (const word of ["box", "fake", undefined]) {
      const at = await rt.golden.buildPlace(word);
      expect([at.place, at.backend]).toEqual(["solari", solari]);
    }
    await rt.close();
  });

  it("a record sealed at the provider this host forks on keeps its rebuilds there", async () => {
    const { fake, rt, seal } = providers();
    await seal();
    expect((await rt.image.get()).image!.place).toBe("fake");
    const at = await rt.golden.buildPlace("solari");
    expect([at.place, at.backend]).toEqual(["fake", fake]);
    await rt.close();
  });
});

describe("the image's home on every road", () => {
  it("a prepare that names no place, or another place, builds at the image's own place once a record stands", async () => {
    const { solari, rt, seal } = providers();
    await seal({ place: "solari" });
    await seal();
    expect((await rt.image.get()).image!.place).toBe("solari");
    await seal({ place: "box" });
    expect((await rt.image.get()).image!.place).toBe("solari");
    expect(solari.snapshots).toHaveLength(3);
    await rt.close();
  });
});

describe("the default place at the image's seal", () => {
  it("with nothing marked, the place the image is sealed on becomes the default", async () => {
    const { rt, marked, seal } = providers();
    expect(await marked()).toBe(HERE_PLACE_ID);
    await seal({ place: "solari" });
    expect(await marked()).toBe("solari");
    await rt.close();
  });

  it("a mark that lands while the seal reads the default wins", async () => {
    const { rt, marked } = providers();
    const sealing = rt.places!.markDefaultIfNone("solari");
    await rt.places!.markUsed("box");
    await sealing;
    expect(await marked()).toBe("box");
    await rt.close();
  });

  it("an image of another name never takes the default, and a default that cannot be written fails no seal", async () => {
    const { rt, store, marked } = providers();
    const b = await rt.golden.prepare({ name: "other", place: "solari" });
    await rt.golden.seal(b.id);
    expect(await marked()).toBe(HERE_PLACE_ID);
    const put = store.put.bind(store);
    store.put = async (collection, key, value) => {
      if (collection === "place-default") throw new Error("disk full");
      return put(collection, key, value);
    };
    const c = await rt.golden.prepare({ place: "solari" });
    await expect(rt.golden.seal(c.id)).resolves.toBeDefined();
    expect((await rt.image.get()).image!.place).toBe("solari");
    await rt.close();
  });

  it("a place already marked stays the default, and a copy's seal marks nothing", async () => {
    const { rt, store, marked, seal } = providers();
    await rt.places!.markUsed("box");
    await seal({ place: "solari" });
    expect(await marked()).toBe("box");
    await store.delete("place-default", "default");
    expect(await marked()).toBe(HERE_PLACE_ID);
    await rt.image.build({ place: "box" });
    expect(await marked()).toBe(HERE_PLACE_ID);
    await rt.close();
  });
});

describe("a fork at a place that holds no copy of the image", () => {
  /** Every line the creates on this runtime said, in order, by the workspace's name. */
  function said(rt: ReturnType<typeof providers>["rt"]): { name: string; message: string }[] {
    const lines: { name: string; message: string }[] = [];
    rt.events.on("workspace.creating", e => {
      if (e.type === "workspace.creating") lines.push({ name: e.name, message: e.message });
    });
    return lines;
  }

  it("builds the copy there first, saying so with the time and the rate before anything boots, then forks the copy", async () => {
    const { box, rt, seal, head, composed } = providers();
    await seal();
    const lines = said(rt);
    const made = await createOn(rt, { golden: await head(), name: "x", on: "box" });
    const copy = (await rt.image.get()).copies.find(c => c.place === "box")!;
    expect(copy).toBeDefined();
    expect(made.golden).toBe(copy.snapshotId);
    expect(box.machines.at(-1)!.spec.fromSnapshot).toBe(copy.snapshotId);
    expect(composed.count).toBe(1);
    expect(lines.filter(l => l.name === "x")[0]!.message).toBe("building your image on box first, about ten minutes, billed at $0.11/hr while it builds, then x forks from it");
    await rt.close();
  });

  it("at a place that charges nothing the line says no rate", async () => {
    const { box, rt, seal, head } = providers();
    Object.assign(box.pricing, { rateUsdPerHour: () => 0 });
    await seal();
    const lines = said(rt);
    await createOn(rt, { golden: await head(), name: "x", on: "box" });
    expect(lines.filter(l => l.name === "x")[0]!.message).toBe("building your image on box first, about ten minutes, then x forks from it");
    await rt.close();
  });

  it("two forks at once build one copy, and a copy a cut left behind is built again before the next fork", async () => {
    const { box, rt, seal, head, composed } = providers();
    await seal();
    const [a, b] = await Promise.all([createOn(rt, { golden: await head(), name: "a", on: "box" }), createOn(rt, { golden: await head(), name: "b", on: "box" })]);
    expect(a.golden).toBe(b.golden);
    expect([box.snapshots.length, composed.count]).toEqual([1, 1]);
    await seal({ recipeHash: "h2" });
    const lines = said(rt);
    const c = await createOn(rt, { golden: await head(), name: "c", on: "box" });
    expect([box.snapshots.length, composed.count]).toEqual([2, 2]);
    expect(c.golden).toBe((await rt.image.get()).copies.find(x => x.place === "box")!.snapshotId);
    expect(lines.filter(l => l.name === "c")[0]!.message).toMatch(/^building your image on box first/);
    await rt.close();
  });

  it("a record holding no sign-ins is refused at the fork as the build refuses it, never forced, and nothing is said about a build", async () => {
    const { box, rt, store, seal, head } = providers();
    await seal();
    const record = (await store.get("images", "default")) as Record<string, unknown>;
    delete record["vault"];
    await store.put("images", "default", record);
    const lines = said(rt);
    await expect(createOn(rt, { golden: await head(), name: "x", on: "box" })).rejects.toMatchObject({ message: expect.stringContaining("holds no sign-ins"), fix: COPY_BUILD_FIX.noVault });
    expect(box.snapshots).toHaveLength(0);
    expect(lines.filter(l => l.name === "x").some(l => l.message.includes("building your image"))).toBe(false);
    await rt.close();
  });

  it("a fork that meets a copy already building there says it waits on that build, and forks its copy", async () => {
    const { box, rt, seal, head, frames } = providers();
    await seal();
    const release = held(box);
    const building = rt.image.build({ place: "box" });
    await until(() => frames.some(f => f.place === "box"));
    const lines = said(rt);
    const creating = createOn(rt, { golden: await head(), name: "x", on: "box" });
    await until(() => lines.some(l => l.name === "x"));
    expect(lines.filter(l => l.name === "x")[0]!.message).toMatch(/^building your image on box first/);
    release();
    const made = await creating;
    expect(made.golden).toBe((await building).copy.snapshotId);
    expect(box.snapshots).toHaveLength(1);
    await rt.close();
  });

  it("a place already standing on the image forks at once and says nothing about a build", async () => {
    const { rt, seal, head } = providers();
    await seal();
    await rt.image.build({ place: "box" });
    const lines = said(rt);
    await createOn(rt, { golden: await head(), name: "x", on: "box" });
    expect(lines.filter(l => l.name === "x").some(l => l.message.includes("building your image"))).toBe(false);
    await rt.close();
  });
});
