// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_AS_ENV, FAKE_RECORDS_ENV, FAKE_ROOT_ENV } from "@wsp/protocol";
import { BoxBackend, FakeBackend, LocalBackend, NoProviderBackend, SolariBackend, SshBackend, landsBytes, type MachineBackend } from "@wsp/engine";
import { goldenRecipe, makeRuntime, optsFor, providerSlotOf, swapProvider } from "../src/cli.js";
import { keysOf } from "../src/env-keys.js";
import { BOX_KEY_ENV, PROVIDER_ENV, PROVIDER_MODULES, SOLARI_KEY_ENV, isPlace, placeIdOf, placeProviders, providerBackendFor, providerEnvNames, providerEnvWith, providerEnvWithKey, providerKeyEnvs, providerKeyRow, providerKeyRows, providerKeySet, providerModule, providerPlaces, wiredProviderId, type ProviderModule } from "../src/providers.js";

/** A computer's environment as the rows read it: the provider key rides in it under the row's own variable, which
 * is where every layer a key is read through puts it. */
const pick = (keys: Record<string, string> = {}, env: Record<string, string | undefined> = {}) => ({
  ...env,
  ...(keys["solari"] !== undefined ? { [SOLARI_KEY_ENV]: keys["solari"] } : {}),
});

describe("provider modules", () => {
  it("takes the module the keys name and nothing else when nothing is said", () => {
    expect(providerModule(pick()).id).toBe("none");
    expect(providerBackendFor(pick())).toBeInstanceOf(NoProviderBackend);
    expect(providerModule(pick({ solari: "sk-ant-x" })).id).toBe("solari");
    expect(providerBackendFor(pick({ solari: "sk-x" }))).toBeInstanceOf(SolariBackend);
  });

  it("a word on the command line stands in front of the environment the host started with", () => {
    expect(providerEnvWith({ provider: "box" }, { WSP_PROVIDER: "solari" })).toMatchObject({ WSP_PROVIDER: "box" });
    // No word typed leaves every variable the host started with where it was.
    expect(providerEnvWith({}, { [FAKE_AS_ENV]: "solari" })).toMatchObject({ [FAKE_AS_ENV]: "solari" });
  });

  it("takes Box when a person names it, key or no key, and hands the backend the key the environment holds", () => {
    expect(providerModule(pick({}, { WSP_PROVIDER: "box" })).id).toBe("box");
    expect(providerModule(pick({ solari: "sk-x" }, { WSP_PROVIDER: "box", BOX_API_KEY: "box_x" })).id).toBe("box");
    expect(providerBackendFor(pick({}, { WSP_PROVIDER: "box", BOX_API_KEY: "box_x" }))).toBeInstanceOf(BoxBackend);
    expect(providerBackendFor(pick({}, { WSP_PROVIDER: "box", BOX_API_KEY: "box_x" })).capabilities).toMatchObject({ pauseMode: "disk", previewUrls: true });
  });

  it("takes the module that answers out of memory when a harness names it, and never otherwise", async () => {
    // Named alone, whatever this computer holds: a fixture is served under it on a computer with a real key saved.
    expect(providerModule(pick({ solari: "sk-ant-x" }, { WSP_PROVIDER: "fake" })).id).toBe("fake");
    expect(providerModule(pick({}, { WSP_PROVIDER: "" })).id).toBe("none");
    const backend = providerBackendFor(pick({}, { WSP_PROVIDER: "fake" }));
    expect(backend).toBeInstanceOf(FakeBackend);
    // A fixture names its machines before any process has held them, so a machine this backend never minted is
    // answered for rather than refused. Which state it comes up in is the records file's to say, below.
    const awake = await backend.get("fk_c0ffee");
    expect([awake.id, await awake.state()]).toEqual(["fk_c0ffee", "running"]);
    // Nothing lands on it, which is what keeps the daemon deploy off a machine that has no guest behind it.
    expect(landsBytes(backend.capabilities, awake)).toBe(false);
  });

  it("seeds its fleet from a records file a harness names, and gives those machines no guest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-standin-records-"));
    const records = join(dir, "records.json");
    // A harness that photographs screens rather than driving them seeds the fleet and wires no folder: a fixture's
    // sleeping fork used to say so in its machine's id, which is the word `wsp workspaces` prints in its own
    // MACHINE column, and a tester read fk_slr_2.paused there beside a STATE column saying Running.
    writeFileSync(records, JSON.stringify({ machines: { fk_asleep: { state: "paused", shape: { cpu: 2, memMb: 4096, diskGb: 20 }, labels: {} } }, snapshots: [] }));
    const backend = providerBackendFor(pick({}, { WSP_PROVIDER: "fake", [FAKE_RECORDS_ENV]: records }));
    expect(await (await backend.get("fk_asleep")).state()).toBe("paused");
    // No folder, so no guest, and nothing runs on any of them.
    expect(backend.capabilities.previewUrls).toBe(false);
    expect(landsBytes(backend.capabilities, await backend.get("fk_asleep"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("every row is reachable and the last one answers for any computer", () => {
    expect(PROVIDER_MODULES.map(m => m.id)).toEqual(["box", "fake", "solari", "none"]);
    expect(PROVIDER_MODULES.at(-1)!.selects(pick())).toBe(true);
  });

  it("every registered backend, and the two kinds outside the registry, declares a pause mode and a lifecycle together or neither, and says on its own whether it copies a disk and replaces a machine", () => {
    // Built the way the host builds them, with fake picks: a key that looks fake, a daemon nothing dials.
    const built = PROVIDER_MODULES.map(m => [m.id, m.build(pick({ solari: "sk-ant-x" }, { BOX_API_KEY: "box_x" }))] as const);
    const all: readonly (readonly [string, MachineBackend])[] = [...built, ["local", new LocalBackend({ root: "/tmp/wsp-providers" })], ["ssh", new SshBackend()]];
    const modes = Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.pauseMode]));
    expect(modes).toEqual({ box: "disk", solari: "memory", fake: "memory", none: undefined, local: undefined, ssh: undefined });
    for (const [, b] of all) expect(b.capabilities.pauseMode === undefined || ["memory", "disk"].includes(b.capabilities.pauseMode)).toBe(true);
    // The runtime reads the budgets only where a pause exists, so the two are declared together or not at all.
    for (const [id, b] of all) expect([id, b.lifecycle !== undefined]).toEqual([id, b.capabilities.pauseMode !== undefined]);
    // Which providers copy a machine's disk into an image, the one fact the snapshot verb reads: a fork that boots
    // cold is still snapshotted, so this row is its own and never liveCloneForks.
    expect(Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.diskSnapshots]))).toEqual({ box: true, solari: true, fake: true, none: false, local: false, ssh: false });
    // Which life a copy may be taken from is each provider's own row: Solari refuses a machine that was resumed,
    // and a box's named snapshot reads the disk as it stands.
    expect(Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.snapshotsAnyLife]))).toEqual({ box: true, solari: false, fake: true, none: false, local: false, ssh: false });
    // Which providers stand a fresh machine in for one a workspace is on, the fact the rebuild and the image move
    // read. Each verb has its own row here, so a provider added tomorrow answers for every road rather than being
    // read off a neighbour's flag.
    expect(Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.replacesMachine]))).toEqual({ box: true, solari: true, fake: true, none: false, local: false, ssh: false });
    for (const [, b] of all) if (b.lifecycle !== undefined) {
      expect(b.lifecycle.budgets.wakeAttempts).toBeGreaterThanOrEqual(1);
      expect(b.lifecycle.budgets.daemonAnswersMs).toBeGreaterThan(0);
    }
  });

  it("the words wsp up and wsp init take land in what the run picks its provider out of", () => {
    expect(optsFor({ state: "/tmp/wsp-providers/state.json", provider: "box" }).providerEnv).toMatchObject({ WSP_PROVIDER: "box" });
  });

  it("a host told which provider to fork on holds that module, and a key saved later swaps inside the same words", async () => {
    const rt = makeRuntime({}, "/tmp/wsp-providers/state.json", goldenRecipe({}), { WSP_PROVIDER: "box", [BOX_KEY_ENV]: "box_x" });
    try {
      const held = providerSlotOf(rt)!.current();
      // A box: a nap that keeps the disk alone, a tokened route per port, a named snapshot of the disk as it
      // stands, a fresh box that stands in for one a workspace is on, and sizes to offer, so the fork roads are open.
      expect(held.capabilities).toMatchObject({ previewUrls: true, pauseMode: "disk", liveCloneForks: false, diskSnapshots: true, images: true, replacesMachine: true });
      expect(held.capabilities.sizes.length).toBeGreaterThan(0);
      // A cloud key saved later opens that cloud as a place and leaves the words alone: the host forks where it
      // was told to, not where the newest key points.
      swapProvider(rt, { [SOLARI_KEY_ENV]: "slr_live_fake" });
      expect(providerSlotOf(rt)!.current().capabilities.pauseMode).toBe("disk");
    } finally {
      await rt.close();
    }
  });

  it("a key is checked against its own provider, whatever this computer forks on", () => {
    // The words a run picks a provider out of are not the words a typed key is checked under: a person typing a
    // cloud key on a computer that forks containers is asking about the key.
    expect(providerModule(pick({ solari: "slr_live_fake" })).id).toBe("solari");
    expect(providerModule(providerEnvWithKey({}, "slr_live_fake")).id).toBe("solari");
    // A run wired to another provider puts the key it is typed to that provider, not to the row a key alone wires.
    expect(providerModule(providerEnvWithKey({ WSP_PROVIDER: "box" }, "box_fake")).id).toBe("box");
  });

  it("a key saved for a provider by name goes under that row's variable and leaves the wired provider alone", () => {
    // The app's Connect a provider names which provider the key is for, so a person connecting one provider on a
    // computer set up for another is not silently saving their key under the other one's variable.
    expect(providerKeySet({}, "ascii_live_fake", "box")).toEqual({ [BOX_KEY_ENV]: "ascii_live_fake" });
    expect(providerKeySet({ [SOLARI_KEY_ENV]: "slr_live_held" }, "ascii_live_fake", "box")).toEqual({ [BOX_KEY_ENV]: "ascii_live_fake" });
    // The key opens that provider as a place and moves nothing: what this computer forks on is where it was, so a
    // second key does not carry every workspace made after it to another provider.
    const after = { [SOLARI_KEY_ENV]: "slr_live_held", ...providerKeySet({ [SOLARI_KEY_ENV]: "slr_live_held" }, "ascii_live_fake", "box")! };
    expect(providerModule(after).id).toBe("solari");
    expect(placeProviders(after).map(m => m.id)).toEqual(["box", "solari"]);
    expect(providerModule(providerEnvWithKey({}, "ascii_live_fake", "box")).id).toBe("box");
    expect(providerBackendFor(providerEnvWithKey({}, "ascii_live_fake", "box"))).toBeInstanceOf(BoxBackend);
    // With no provider named the key is the wired row's, and the word for it is left as it stands.
    expect(providerKeySet({}, "slr_live_fake")).toEqual({ [SOLARI_KEY_ENV]: "slr_live_fake" });
    // A row that takes no key, and a word no row answers to, take nothing.
    expect(providerKeySet({}, "x", "fake")).toBeUndefined();
    expect(providerKeySet({}, "x", "nowhere")).toBeUndefined();
  });

  it("every provider a key can be saved for is read off the table, each under the variable its own row names", () => {
    expect(providerKeyRows()).toEqual({ box: BOX_KEY_ENV, solari: SOLARI_KEY_ENV });
  });

  it("the variables a service carries are the rows' own, so a provider added brings its variable with it", () => {
    expect(providerEnvNames()).toEqual(["WSP_PROVIDER", FAKE_AS_ENV, FAKE_ROOT_ENV, FAKE_RECORDS_ENV]);
    // The row a provider is added as: the list follows it, and nothing else has to be remembered for the unit its
    // host is installed as to be given the variable that selects it. Keys are not among them: a unit file carries
    // no key, and the host reads its own off the same files at every start.
    const fly: ProviderModule = { id: "fly", envNames: ["WSP_PROVIDER", "FLY_REGION"], keyEnv: "FLY_API_TOKEN", selects: env => env["FLY_API_TOKEN"] !== undefined, build: () => new NoProviderBackend() };
    expect(providerEnvNames([...PROVIDER_MODULES, fly])).toEqual(["WSP_PROVIDER", FAKE_AS_ENV, FAKE_ROOT_ENV, FAKE_RECORDS_ENV, "FLY_REGION"]);
    expect(providerEnvNames()).not.toContain(BOX_KEY_ENV);
    // What a row selects on is what it names: a row reading a variable it never listed would be carried by neither.
    for (const m of PROVIDER_MODULES) for (const name of m.envNames) expect(providerEnvNames()).toContain(name);
  });

  it("the pick rides the same layers as the keys: the word wsp add wrote in a file is read, the shell and the line in front of it", () => {
    const beside = { WSP_PROVIDER: "box" };
    // The layers as a host reads them: the environment it started in, its folder's .env, then the file beside its
    // state. A word written into that file is the pick, which is what wsp add's own sentence promises.
    expect(providerEnvWith({}, {}, [{}, {}, beside])[PROVIDER_ENV]).toBe("box");
    expect(wiredProviderId(providerEnvWith({}, {}, [{}, {}, beside]))).toBe("box");
    // The shell wins over the file, and the word typed on the line wins over both.
    expect(providerEnvWith({}, { WSP_PROVIDER: "solari" }, [{ WSP_PROVIDER: "solari" }, {}, beside])[PROVIDER_ENV]).toBe("solari");
    expect(providerEnvWith({ provider: "solari" }, {}, [{}, {}, beside])[PROVIDER_ENV]).toBe("solari");
    // A stand-in's own variables are the run's to name and are never taken out of a file.
    expect(providerEnvWith({}, {}, [{}, {}, { [FAKE_AS_ENV]: "solari" }])[FAKE_AS_ENV]).toBeUndefined();
    // An empty line is no pick, as it is no key.
    expect(providerEnvWith({}, {}, [{}, {}, { WSP_PROVIDER: "" }])[PROVIDER_ENV]).toBeUndefined();
  });

  it("the environment a provider is picked out of carries every registered row's key, taken from the first layer that holds it", () => {
    const layers: Record<string, string>[] = [{ WSP_PROVIDER: "box" }, { [BOX_KEY_ENV]: "from-cwd", [SOLARI_KEY_ENV]: "" }, { [BOX_KEY_ENV]: "from-home", [SOLARI_KEY_ENV]: "solari-from-home" }];
    const env = providerEnvWith({}, layers[0]!, layers);
    // Every variable a row declares, and each from the first layer with something in it: an empty line is no key.
    expect(providerKeyEnvs().every(name => name in env || layers.every(l => (l[name] ?? "") === ""))).toBe(true);
    expect([env[BOX_KEY_ENV], env[SOLARI_KEY_ENV]]).toEqual(["from-cwd", "solari-from-home"]);
    // A row added tomorrow is filled by the same three layers with nothing else edited.
    expect(providerKeyEnvs([...PROVIDER_MODULES, { id: "fly", envNames: [], keyEnv: "FLY_API_TOKEN", selects: () => false, build: () => new NoProviderBackend() }])).toContain("FLY_API_TOKEN");
    // Nothing provider-shaped is left on the keys a record answers with: those are the agents' keys alone.
    expect(keysOf({ [SOLARI_KEY_ENV]: "slr_live_fake", [BOX_KEY_ENV]: "box_fake", ANTHROPIC_API_KEY: "sk-ant-x-fake" })).toEqual({ anthropic: "sk-ant-x-fake" });
  });

  it("a row that reads a key declares the words its screen is titled with, and a row that reads none declares neither", () => {
    // What the key screen is titled and what it says to set are the row's own, declared together: a row with a
    // variable and no words for it would open a screen titled with a shell variable.
    expect(PROVIDER_MODULES.map(m => [m.id, m.keyEnv, m.keyName])).toEqual([
      ["box", BOX_KEY_ENV, "Box API key"],
      ["fake", undefined, undefined],
      ["solari", SOLARI_KEY_ENV, "Solari API key"],
      ["none", undefined, undefined],
    ]);
    for (const m of PROVIDER_MODULES) expect([m.id, m.keyEnv === undefined]).toEqual([m.id, m.keyName === undefined]);
  });

  it("the places a copy of the image can be built at are the providers this computer is set up for, each once", () => {
    // Named without its key is not added: a computer nobody had typed a key on listed the row anyway, which New
    // workspace then priced at the wired provider's rates.
    expect(placeProviders({ WSP_PROVIDER: "box" }).map(m => m.id)).not.toContain("box");
    // A row that is no place at all, and the one that stands for no provider: neither is offered.
    expect(placeProviders({}).map(m => m.id)).not.toContain("fake");
    expect(placeProviders({}).map(m => m.id)).not.toContain("none");
    // A row that reads a key is a place once that key is here, and not before: a row nobody could reach is not one.
    expect(placeProviders({}).map(m => m.id)).not.toContain("solari");
    expect(placeProviders({ [SOLARI_KEY_ENV]: "slr_live_fake" }).map(m => m.id)).toContain("solari");
    expect(placeProviders({}).map(m => m.id)).not.toContain("box");
    expect(placeProviders({ [BOX_KEY_ENV]: "box_fake" }).map(m => m.id)).toContain("box");
    // Each row once, in the table's own order.
    const ids = placeProviders({ [SOLARI_KEY_ENV]: "slr_live_fake", [BOX_KEY_ENV]: "box_fake" }).map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(PROVIDER_MODULES.filter(m => ids.includes(m.id)).map(m => m.id));
  });

  it("the table a host builds copies through answers the wired place with the runtime's own backend and every other with its module's", () => {
    const wired = { id: "box" };
    const env: Record<string, string> = { WSP_PROVIDER: "box", [BOX_KEY_ENV]: "box_fake", [SOLARI_KEY_ENV]: "slr_live_fake" };
    const own = new BoxBackend({ apiKey: "box_fake" });
    const places = providerPlaces(
      () => wired.id,
      own,
      () => env,
    );
    expect(places.wired).toBe("box");
    expect(places.backend("box")).toBe(own);
    expect(places.backend("solari")).toBeInstanceOf(SolariBackend);
    // One backend per place for the host's life: a module holding machines in memory must not be made afresh.
    expect(places.backend("solari")).toBe(places.backend("solari"));
    expect(places.backend("fake")).toBeUndefined();
    expect(places.list()).toEqual(["box", "solari"]);

    // A key rotated while the host serves is read by the row that holds it: the backend built on the old one is not
    // handed out again, which is what the swap promises for the wired place and has to promise for the others.
    const onOldKey = places.backend("solari");
    env[SOLARI_KEY_ENV] = "slr_live_fake_rotated";
    const onNewKey = places.backend("solari");
    expect(onNewKey).not.toBe(onOldKey);
    expect(onNewKey).toBe(places.backend("solari"));

    // A key saved while the host serves moves the wired place; the runtime's own backend follows it there.
    wired.id = "solari";
    expect(places.wired).toBe("solari");
    expect(places.backend("solari")).toBe(own);
    expect(places.backend("box")).toBeInstanceOf(BoxBackend);
    expect(places.list()).toEqual(["solari", "box"]);
  });

  it("lists only the places a person can name, and still answers for a host whose own module is none of them", () => {
    // The module a host with no key starts on is no place: naming it in a refusal would offer a place to build at
    // that nobody can add. Its own roads still resolve, since the wired row is answered before the list is read.
    const own = new NoProviderBackend();
    const places = providerPlaces(
      () => "none",
      own,
      () => ({}),
    );
    // Nothing added and no key here: no place at all, rather than a row on a computer nobody set up for it.
    expect(places.list()).toEqual([]);
    expect(places.backend("none")).toBe(own);
    expect(places.backend("solari")).toBeUndefined();
  });

  it("makes a stand-in a place under the cloud it stands in for, so a harness's screens have somewhere to create", () => {
    const fixture = { WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "solari" };
    // Nothing held a key for the cloud a fixture's machines are at, so Settings drew no provider row, New
    // workspace offered nowhere to create and the list a fork stood on did not hold the fork's own cloud.
    expect(placeProviders(fixture).map(m => placeIdOf(m, fixture))).toContain("solari");
    expect(isPlace(providerModule(fixture), fixture)).toBe(true);
    // A stand-in standing in for nothing is still a place nobody owns.
    expect(isPlace(providerModule({ WSP_PROVIDER: "fake" }), { WSP_PROVIDER: "fake" })).toBe(false);
    // The place resolves to the stand-in itself, so nothing about a fixture ever dials the cloud it wears.
    const own = new FakeBackend();
    const places = providerPlaces(() => "solari", own, () => fixture);
    expect(places.list()[0]).toBe("solari");
    expect(places.backend("solari")).toBe(own);
    expect(places.backend("fake")).toBeUndefined();
    // A computer that also holds a key for that cloud reads one row, not the same word twice.
    const both = { ...fixture, [SOLARI_KEY_ENV]: "slr_live_fake" };
    expect(providerPlaces(() => "solari", own, () => both).list().filter(id => id === "solari")).toEqual(["solari"]);
  });

  it("the row a key typed here is put to is the picked one, or the one a key alone would wire", () => {
    // Wired to a provider that reads a key: that row's variable, whatever else this computer holds.
    expect(providerKeyRow({ WSP_PROVIDER: "box" })?.keyEnv).toBe(BOX_KEY_ENV);
    expect(providerKeyRow({ WSP_PROVIDER: "box", [SOLARI_KEY_ENV]: "slr_live_fake" })?.keyEnv).toBe(BOX_KEY_ENV);
    // Wired to nothing: the cloud a key alone wires, which is what wsp init offers on a computer set up for none.
    expect(providerKeyRow({})?.keyEnv).toBe(SOLARI_KEY_ENV);
    // Wired to a provider that reads no key: nothing to ask for.
    expect(providerKeyRow({ WSP_PROVIDER: "fake" })).toBeUndefined();
  });

  it("stamps a stand-in's machines with the provider it stands in for, so no row reads the stand-in's own word", () => {
    // A harness serving a fixture of one cloud's machines says which cloud, and every row about those machines
    // reads it: a tester met "fake" where a person reads which provider they are paying.
    expect(wiredProviderId({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "solari" })).toBe("solari");
    expect(wiredProviderId({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "box" })).toBe("box");
    // The row is still the stand-in: nothing dials that cloud, and the word alone would have.
    expect(providerModule({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "solari" }).id).toBe("fake");
    expect(providerBackendFor({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "solari" })).toBeInstanceOf(FakeBackend);
    // Every other row is the word it says it is, and a stand-in that stands in for nobody is its own word too.
    expect(wiredProviderId({ WSP_PROVIDER: "fake" })).toBe("fake");
    expect(wiredProviderId({ WSP_PROVIDER: "box" })).toBe("box");
    expect(wiredProviderId({})).toBe("none");
    // It travels with the row, so a host a service starts carries it the way it carries the provider's own word.
    expect(providerEnvNames()).toContain(FAKE_AS_ENV);
  });
});