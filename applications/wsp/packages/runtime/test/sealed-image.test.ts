// SPDX-License-Identifier: AGPL-3.0-only
// The image the host owns and the copy each place holds of it: what a seal
// records, what a state file written before places boots as, and what a build
// at a second place does and refuses.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NoProviderBackend, imageHash, tarOf } from "@wsp/engine";
import { COPY_BUILD_FIX, NO_BUILD_PLACE_LINE, NO_PROVIDER_LINE, RUNTIME_OPS, THREAD_OPS, SealedImageView, buildPlaceAskLine, placeBuildsNoImageLine, placeForksNothingPickLine, sealedCopyLine, vaultUnlistedRefusal, type Recipe, type RecipeDigest, type SealedImage } from "@wsp/protocol";
import { copyKey, createRuntime, wiredPlace, type PlaceBackends, type Runtime } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { COPY_RECIPE, EMPTY_TGZ_SHA, SMALL, dfOk, digestOf, importOf, recipeWith } from "./image-fixtures.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

function started(o: { places?: (wired: StubBackend) => PlaceBackends; store?: Store } = {}) {
  const backend = stubBackend();
  backend.execImpl = dfOk;
  const store = o.store ?? memoryStore();
  const places = o.places?.(backend);
  // How often this computer was read for a copy's recipe: the runtime asks only once a build is going to run, so a
  // refusal that composed nothing is proved by the count standing still.
  const composed = { count: 0 };
  const copyRecipe = () => {
    composed.count += 1;
    return COPY_RECIPE;
  };
  const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), copyRecipe, hostId: "h1", ...(places !== undefined ? { places } : {}) });
  return { backend, store, rt, composed };
}

/** Two places over one runtime: the wired stub and one more named `solari`. */
function twoPlaces() {
  const other = stubBackend();
  other.execImpl = dfOk;
  const places = (wired: StubBackend): PlaceBackends => ({
    wired: "box",
    backend: place => (place === "box" ? wired : place === "solari" ? other : undefined),
    list: () => ["box", "solari"],
  });
  return { other, places };
}

/** A record on the store as a seal left it, with the archive its builder handed back: what a second place reads
 * before it boots anything. */
async function recorded(store: Store, o: { held?: string[]; tar: Buffer; version?: number; place?: string }): Promise<void> {
  const version = o.version ?? 1;
  const vault = {
    sha256: createHash("sha256").update(o.tar).digest("hex"),
    bytes: o.tar.length,
    paths: 1,
    ...(o.held !== undefined ? { held: o.held } : {}),
    takenAt: "2026-09-01T00:00:00.000Z",
  };
  await store.put("images", "default", { name: "default", version, hash: "a".repeat(64), recipeHash: "h1", recipe: SMALL, pins: [], logins: [], sealedAt: "2026-09-01T00:00:00.000Z", sealedFrom: "h1", vault, place: o.place ?? "box" });
  await store.putBlob("image-vaults", `default@v${version}`, o.tar);
}

describe("the image record a seal writes", () => {
  it("a seal through a recipe with vault paths writes the record, its hash and the vault blob, and stamps the hash on the version", async () => {
    const { store, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const image = (await store.get("images", "default")) as { hash: string; recipeHash: string; recipe: Recipe; vault: { sha256: string; paths: number; held?: string[] } };
    expect(image).toMatchObject({ name: "default", version: 1, recipeHash: "h1", recipe: SMALL, sealedFrom: "h1" });
    expect(image.vault).toMatchObject({ sha256: EMPTY_TGZ_SHA, paths: 1, held: ["/etc/profile.d/wsp-secrets.sh"] });
    expect(image.hash).toBe(imageHash("h1", EMPTY_TGZ_SHA, []));
    expect(version.imageHash).toBe(image.hash);
    expect(await store.getBlob("image-vaults", "default@v1")).toBeDefined();
    const view = await rt.image.get();
    expect(view.image).toMatchObject({ hash: image.hash });
    expect(view.copies).toEqual([expect.objectContaining({ place: "default", version: 1, hash: image.hash, snapshotId: version.snapshotId })]);
    await rt.close();
  });

  it("a seal at the wired provider files that provider as the image's home, so a rebuild after the provider is swapped is refused rather than sent to the new one", async () => {
    let id = "solari";
    const { store, rt, backend } = started({ places: wired => wiredPlace(() => id, wired) });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    expect(((await store.get("images", "default")) as SealedImage).place).toBe("solari");
    const machines = backend.machines.length;
    id = "ascii";
    await expect(rt.golden.prepare()).rejects.toThrow(/solari/);
    expect(backend.machines.length).toBe(machines);
    await rt.close();
  });

  it("a builder made at the wired provider is sealed only there, so a provider swapped in mid-build is never filed as the image's home", async () => {
    let id = "solari";
    const { store, rt } = started({ places: wired => wiredPlace(() => id, wired) });
    const b = await rt.golden.prepare();
    id = "ascii";
    await expect(rt.golden.seal(b.id)).rejects.toThrow(/solari/);
    expect(await store.get("images", "default")).toBeUndefined();
    await rt.close();
  });

  it("a seal that names no vault paths records the image with none, and its hash differs from one that held a vault", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith({ vault: false }), hostId: "h1" });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const image = (await store.get("images", "default")) as { hash: string; vault?: unknown };
    expect(image.vault).toBeUndefined();
    expect(image.hash).toBe(imageHash("h1", undefined, []));
    expect(await store.getBlob("image-vaults", "default@v1")).toBeUndefined();
    await rt.close();
  });

  it("a seal records the pins the builder's digest carries beside the recipe, keyed by the catalog id where the catalog carries the tool, in id order with each row's road, and the hash covers them", async () => {
    const pinned: RecipeDigest = {
      ticks: [{ id: "tools/npm/wrangler", version: "4.1.0", road: "npm", pin: { tag: "4.1.0" } }, { id: "agents/codex" }, { id: "tools/catalog/tmux", road: "apt", pin: { tag: "3.3a-3", latest: true } }],
      files: [],
    };
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: { ...recipeWith(), import: { ...importOf("h1"), recipe: pinned } }, hostId: "h1" });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const image = (await store.get("images", "default")) as SealedImage;
    // The npm row this computer had and the catalog's bare row another computer would plan are one tool: the pin is filed under its catalog id.
    const pins = [{ id: "tmux", tag: "3.3a-3", latest: true as const, road: "apt" }, { id: "wrangler", tag: "4.1.0", road: "npm" }];
    expect(image.pins).toEqual(pins);
    expect(image.hash).toBe(imageHash("h1", EMPTY_TGZ_SHA, pins));
    // The same recipe and vault sealed with no pin read is another image.
    expect(image.hash).not.toBe(imageHash("h1", EMPTY_TGZ_SHA, []));
    expect((await rt.image.get()).image?.pins).toEqual(pins);
    await rt.close();
  });

  it("image.get on a store that has never sealed answers no image, no copy and no project", async () => {
    const { rt } = started();
    expect(await rt.image.get()).toEqual({ image: null, copies: [], projects: [] });
    await rt.close();
  });

  it("a host whose provider cannot fork files nothing: the bare key stays and the golden is still there when a key is saved", async () => {
    const store = memoryStore();
    const version = { version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } };
    await store.put("goldens", "default", { head: 1, versions: [version] });
    await store.put("golden-recipes", "default@v1", digestOf("old"));
    // A host started with no provider key: the module it is wired with forks nothing and names no place a copy
    // could belong to.
    const none = new NoProviderBackend();
    const noKey = createRuntime({ backend: none, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: wiredPlace("none", none) });
    expect(await noKey.golden.get()).toMatchObject({ head: 1 });
    expect(await store.keys("goldens")).toEqual(["default"]);
    expect((await noKey.image.get()).copies.map(c => c.place)).toEqual(["none"]);
    await noKey.close();

    // The key is saved and the host restarts on a module that forks: only now is the copy filed under its place.
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const wired = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: wiredPlace("solari", backend) });
    expect(await wired.golden.get()).toMatchObject({ head: 1 });
    expect(await store.keys("goldens")).toEqual([copyKey("solari", "default")]);
    expect(await store.keys("golden-recipes")).toEqual([copyKey("solari", "default@v1")]);
    await wired.close();
  });

  it("the bare key is dropped only after the new one is written and read back, so a half-migrated store settles on one key", async () => {
    const store = memoryStore();
    const manifest = { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] };
    // A boot that wrote the new key and died before the delete: both keys stand.
    await store.put("goldens", "default", manifest);
    await store.put("goldens", copyKey("default", "default"), manifest);
    const { rt, store: held } = started({ store });
    expect(await rt.golden.get()).toMatchObject({ head: 1 });
    expect(await held.keys("goldens")).toEqual([copyKey("default", "default")]);
    await rt.close();

    // A store whose put does not land keeps the bare key rather than losing the copy with it.
    const lossy = memoryStore();
    await lossy.put("goldens", "default", manifest);
    const dropping = { ...lossy, put: async (collection: string, id: string, value: unknown) => (collection === "goldens" && id.includes("/") ? undefined : lossy.put(collection, id, value)) };
    const over = createRuntime({ backend: stubBackend(), store: dropping, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1" });
    expect(await over.golden.get()).toMatchObject({ head: 1 });
    expect(await lossy.keys("goldens")).toEqual(["default"]);
    await over.close();
  });

  it("a state file written before places boots with its manifest and recipe under the wired place, the bare keys gone, and reads as one copy of a record with no vault", async () => {
    const store = memoryStore();
    const version = { version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, logins: [{ name: "codex", state: "signed-in" as const }] };
    await store.put("goldens", "default", { head: 1, versions: [version] });
    await store.put("golden-recipes", "default@v1", digestOf("old"));
    const { rt } = started({ store });
    const view = await rt.image.get();
    expect(await store.keys("goldens")).toEqual([copyKey("default", "default")]);
    expect(await store.keys("golden-recipes")).toEqual([copyKey("default", "default@v1")]);
    expect(view.image).toMatchObject({ name: "default", version: 1, logins: [{ name: "codex", state: "signed-in" }] });
    expect(view.image!.vault).toBeUndefined();
    expect(view.image!.recipe).toBeUndefined();
    expect(view.copies).toEqual([expect.objectContaining({ place: "default", version: 1, snapshotId: "snap_old" })]);
    expect(view.copies[0]!.hash).toBeUndefined();
    expect(await rt.golden.get()).toMatchObject({ head: 1 });
    await rt.close();
  });
});

describe("building the image at a second place", () => {
  /** The image sealed at the provider this host forks on, and its copy built at solari on a press. */
  async function sealedAtWired() {
    const { other, places } = twoPlaces();
    const { backend, store, rt, composed } = started({ places });
    const frames: { stage: string; place?: string }[] = [];
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push({ stage: e.stage, ...(e.place !== undefined ? { place: e.place } : {}) });
    });
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const madeAtWired = backend.machines.length;
    const record = (await store.get("images", "default")) as SealedImage;
    await rt.image.build({ place: "solari" });
    return { backend, other, store, rt, version, record, frames, composed, madeAtWired };
  }

  it("a copy built at solari: a builder there, the record's vault landed on it, every line naming the place, and the copy filed at the record's hash", async () => {
    const { backend, other, rt, record, frames, composed, madeAtWired } = await sealedAtWired();
    // This computer was read once for the copy's recipe, and the wired provider made nothing after its own seal.
    expect(composed.count).toBe(1);
    expect(backend.machines.length).toBe(madeAtWired);
    expect(other.puts.some(p => createHash("sha256").update(p.body).digest("hex") === EMPTY_TGZ_SHA)).toBe(true);
    // The seal's own frames name no place; the copy's all name solari, and every stage of a build is among them:
    // the builder made, the vault landed, the snapshot taken, the copy sealed.
    expect(frames.filter(f => f.place === undefined).map(f => f.stage)).toContain("sealed");
    const named = frames.filter(f => f.place !== undefined);
    expect(named.every(f => f.place === "solari")).toBe(true);
    for (const stage of ["creating", "uploading-files", "ready", "snapshotting", "sealed"]) expect(named.map(f => f.stage)).toContain(stage);
    // One image, two copies, one hash.
    const view = await rt.image.get();
    expect(view.copies.map(c => [c.place, c.version, c.hash])).toEqual([
      ["box", 1, record.hash],
      ["solari", 1, record.hash],
    ]);
    await rt.close();
  });

  it("a copy build never runs a sign-in stage and takes no second vault off its own builder", async () => {
    const { other, store, rt } = await sealedAtWired();
    // The one probe a copy's builder answers is the seal's guard, over the paths no image may hold; nothing reads
    // a vault off it, since the vault it lands is the record's own.
    const probes = other.machines.flatMap(m => m.execLog).filter(c => c.startsWith("for p in "));
    expect(probes.every(c => c.includes("/root/.claude-cfg/.credentials.json"))).toBe(true);
    expect(probes.some(c => c.includes("/etc/profile.d/wsp-secrets.sh"))).toBe(false);
    const image = (await store.get("images", "default")) as { version: number };
    expect(image.version).toBe(1);
    expect(await store.getBlob("image-vaults", "default@v1")).toBeDefined();
    expect(await store.getBlob("image-vaults", "default@v2")).toBeUndefined();
    await rt.close();
  });

  it("a place standing on the record is answered with its copy and builds nothing, on the build line and on the road that keeps a place current alike", async () => {
    const { other, rt, composed } = await sealedAtWired();
    const made = other.machines.length;
    const asked = composed.count;
    const standing = (await rt.image.get()).copies.find(c => c.place === "solari");
    expect(await rt.image.build({ place: "solari" })).toEqual({ copy: standing, built: false });
    await rt.image.keepCurrent("solari");
    // Nothing was forked and this computer was never read for a recipe the build would not have used.
    expect(other.machines.length).toBe(made);
    expect(composed.count).toBe(asked);
    await rt.close();
  });

  it("the place the image's own seal stands at is answered with the copy it holds, and a place this host has never heard of is refused before anything boots", async () => {
    const { backend, other, rt, composed } = await sealedAtWired();
    const made = [backend.machines.length, other.machines.length];
    const asked = composed.count;
    expect(await rt.image.build({ place: "box" })).toMatchObject({ built: false, copy: { place: "box", version: 1 } });
    await expect(rt.image.build({ place: "nowhere" })).rejects.toMatchObject({ kind: "missing" });
    expect([backend.machines.length, other.machines.length]).toEqual(made);
    expect(composed.count).toBe(asked);
    await rt.close();
  });

  it("a place that forks nothing and copies no disk takes no copy of the image, and is refused before anything boots", async () => {
    const none = new NoProviderBackend();
    const places = (wired: StubBackend): PlaceBackends => ({
      wired: "box",
      backend: place => (place === "box" ? wired : place === "here" ? none : undefined),
      list: () => ["box", "here"],
    });
    const { rt, composed } = started({ places });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    await expect(rt.image.build({ place: "here" })).rejects.toMatchObject({ kind: "conflict", message: expect.stringContaining(placeBuildsNoImageLine("here")) });
    expect(composed.count).toBe(0);
    expect((await rt.image.get()).copies.map(c => c.place)).toEqual(["box"]);
    await rt.close();
  });

  it("a record with no vault is refused unless force, and with force the copy is recorded and holds no sign-ins", async () => {
    const { other, places } = twoPlaces();
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ vault: false }), copyRecipe: () => COPY_RECIPE, hostId: "h1", places: places(backend) });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    await expect(rt.image.build({ place: "solari" })).rejects.toMatchObject({ kind: "conflict" });
    expect(other.machines.length).toBe(0);
    const frames: string[] = [];
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`);
    });
    const { copy } = await rt.image.build({ place: "solari", force: true });
    expect(copy.place).toBe("solari");
    expect((await rt.image.get()).image!.vault).toBeUndefined();
    expect(frames.some(f => f.includes("sign-ins"))).toBe(false);
    await rt.close();
  });

  it("every refusal a copy build meets before anything boots carries its fix apart from what happened", async () => {
    const fixOf = async (build: Promise<unknown>): Promise<{ kind?: string; fix?: string; message: string }> => build.then(() => ({ message: "built" }), (e: Error & { kind?: string; fix?: string }) => e);
    const none = new NoProviderBackend();
    const withHere = (wired: StubBackend): PlaceBackends => ({ wired: "box", backend: place => (place === "box" ? wired : place === "here" ? none : undefined), list: () => ["box", "here"] });

    const empty = started({ places: withHere });
    expect(await fixOf(empty.rt.image.build({ place: "box" }))).toMatchObject({ kind: "conflict", fix: COPY_BUILD_FIX.noImage });
    const b = await empty.rt.golden.prepare();
    await empty.rt.golden.seal(b.id);
    const cannot = await fixOf(empty.rt.image.build({ place: "here" }));
    expect(cannot).toMatchObject({ kind: "conflict", fix: COPY_BUILD_FIX.noCopy });
    expect(cannot.message).toBe(`${placeBuildsNoImageLine("here")}. ${COPY_BUILD_FIX.noCopy}`);
    await empty.rt.close();

    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 }, imageHash: "c".repeat(64) }] });
    const backfilled = started({ store, places: twoPlaces().places });
    expect(await fixOf(backfilled.rt.image.build({ place: "solari" }))).toMatchObject({ kind: "conflict", fix: COPY_BUILD_FIX.noRecipe });
    await backfilled.rt.close();

    const { other, places } = twoPlaces();
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ vault: false }), copyRecipe: () => COPY_RECIPE, hostId: "h1", places: places(backend) });
    const sealed = await rt.golden.prepare();
    await rt.golden.seal(sealed.id);
    const noVault = await fixOf(rt.image.build({ place: "solari" }));
    expect(noVault).toMatchObject({ kind: "conflict", fix: COPY_BUILD_FIX.noVault });
    // What happened names no flag; the fix is read on a terminal alone, since the card sends force before the host
    // could refuse, so it names the one the terminal takes.
    expect(noVault.message.slice(0, -COPY_BUILD_FIX.noVault.length)).not.toMatch(/force/);
    expect(COPY_BUILD_FIX.noVault).toContain("--force");
    expect(other.machines.length).toBe(0);
    await rt.close();
  });

  it("a backfilled record judges no copy: it was read back off that copy and has nothing to judge it by", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 }, imageHash: "c".repeat(64) }] });
    const { rt } = started({ store });
    const view = await rt.image.get();
    expect(view.image!.vault).toBeUndefined();
    expect(sealedCopyLine(view.image!, view.copies[0]!)).not.toContain("stale");
    expect(sealedCopyLine(view.image!, view.copies[0]!)).not.toContain("current");
    await rt.close();
  });

  it("a state file the boot has not migrated is read as the wired place's copy and never as another place's", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] });
    const { other, places } = twoPlaces();
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: places(backend) });
    const view = await rt.image.get();
    expect(view.copies.map(c => c.place)).toEqual(["box"]);
    expect(other.machines.length).toBe(0);
    await rt.close();
  });

  it("a copy reads the archive against the paths the seal asked for, and one carrying a foreign member boots no builder", async () => {
    const { other, places } = twoPlaces();
    const store = memoryStore();
    await recorded(store, { held: ["/root/.codex/auth.json"], tar: tarOf([{ path: "etc/cron.d/x", mode: 0o644, content: "* * * * * root sh" }]) });
    const { rt, composed } = started({ store, places });
    await expect(rt.image.build({ place: "solari" })).rejects.toMatchObject({ kind: "conflict", message: expect.stringContaining("etc/cron.d/x") });
    expect(other.machines.length).toBe(0);
    expect(other.puts).toHaveLength(0);
    expect(composed.count).toBe(0);
    await rt.close();
  });

  it("a record whose vault kept no path list is refused in its own sentence, never the one for a blob this computer lost", async () => {
    const { other, places } = twoPlaces();
    const store = memoryStore();
    await recorded(store, { tar: tarOf([{ path: "root/.codex/auth.json", mode: 0o600, content: "{}" }]) });
    const { rt } = started({ store, places });
    await expect(rt.image.build({ place: "solari" })).rejects.toMatchObject({ kind: "conflict", message: vaultUnlistedRefusal("default", 1) });
    expect(other.machines.length).toBe(0);
    await rt.close();
  });

  it("an archive whose every member is under the asked paths builds the copy", async () => {
    const { other, places } = twoPlaces();
    const store = memoryStore();
    await recorded(store, { held: ["/root/.codex/auth.json"], tar: tarOf([{ path: "root/.codex/auth.json", mode: 0o600, content: "{}" }]) });
    const { rt } = started({ store, places });
    expect(await rt.image.build({ place: "solari" })).toMatchObject({ built: true, copy: { place: "solari" } });
    expect(other.machines.length).toBeGreaterThan(0);
    await rt.close();
  });

  it("a record with no small recipe cannot be built anywhere else", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] });
    const { other, places } = twoPlaces();
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: places(backend) });
    await expect(rt.image.build({ place: "solari" })).rejects.toMatchObject({ kind: "conflict" });
    expect(other.machines.length).toBe(0);
    await rt.close();
  });
});

describe("a version's sign-ins live as long as the version and no longer", () => {
  it("the seal that replaces a version takes that version's blob, whether or not the cut kept its snapshot", async () => {
    const { store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    expect(await store.getBlob("image-vaults", "default@v1")).toBeDefined();
    await rt.golden.upgrade({ delta: { import: importOf("h2"), retired: [], retiredOnImage: [] }, keepPrevious: true });
    expect(await rt.golden.get()).toMatchObject({ head: 2 });
    expect(await store.getBlob("image-vaults", "default@v1")).toBeUndefined();
    expect(await store.getBlob("image-vaults", "default@v2")).toBeDefined();
    await rt.close();
  });

  it("prune reads a copy place's own version numbers and takes no blob: the record's sign-ins are the record's", async () => {
    // The blob is keyed by the record's name and version, and a manifest counts the versions of the place it sits
    // at. Here the record was sealed at another place and stands at v2, while the manifest at the place this host
    // forks on counts four rebuilds of its own copy; a prune that dropped blobs by those numbers would take the
    // live record's sign-ins and leave every later copy build asking for a blob this host itself removed.
    const store = memoryStore();
    const backend = stubBackend();
    const versions = [1, 2, 3, 4].map(n => ({
      version: n,
      snapshotId: `snap_golden-v${n}`,
      baseTemplate: "base",
      setupSha: `sha${n}`,
      createdAt: `2026-08-${10 + n}T00:00:00.000Z`,
      smoke: { cmd: "true", exitCode: 0 },
      ...(n > 1 ? { parentSnapshotId: `snap_golden-v${n - 1}` } : {}),
    }));
    await store.put("goldens", copyKey("default", "default"), { head: 4, versions });
    for (const n of [1, 2, 3, 4]) {
      backend.snapshots.push({ id: `snap_golden-v${n}`, sizeBytes: (7 + n) * 1e9, createdAt: versions[n - 1]!.createdAt });
      await store.put("golden-recipes", copyKey("default", `default@v${n}`), { ticks: [], files: [] });
    }
    await recorded(store, { held: ["/root/.codex/auth.json"], tar: tarOf([{ path: "root/.codex/auth.json", mode: 0o600, content: "{}" }]), version: 2, place: "spoo" });
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "box:h1" });
    expect((await rt.golden.prune()).dropped.map(v => v.version)).toEqual([1, 2]);
    expect(await store.getBlob("image-vaults", "default@v2")).toBeDefined();
    expect(((await store.get("images", "default")) as SealedImage).version).toBe(2);
    await rt.close();
  });
});

describe("the image over the protocol", () => {
  let srv: Awaited<ReturnType<typeof serveRuntime>> | undefined;
  let rt: Runtime | undefined;

  it("the three ops are the host's and no thread's, and image.get answers a view the protocol parses", async () => {
    for (const op of ["image.get", "image.build", "image.export"]) {
      expect(RUNTIME_OPS).toContain(op);
      expect(THREAD_OPS).not.toContain(op);
    }
    const started = stubBackend();
    started.execImpl = dfOk;
    rt = createRuntime({ backend: started, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), hostId: "h1" });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const got = await c.request("image.get", {});
    expect(got.ok).toBe(true);
    const view = SealedImageView.parse(got["view"]);
    expect(view.image!.version).toBe(1);
    expect(view.copies).toHaveLength(1);

    // A passphrase under the minimum never reaches the runtime: the frame itself is refused.
    const short = await c.request("image.export", { dest: "/tmp/never-written", passphrase: "short" });
    expect(short.ok).toBe(false);
    c.close();
    await srv.close();
    srv = undefined;
    await rt.close();
    rt = undefined;
  });
});

describe("the image's own seal at a place that is not the provider this host forks on", () => {
  it("makes the builder there, writes the record naming that place, files the copy under it, reads the golden's manifest and recipe from there, and the provider this host forks on gets its copy when asked", async () => {
    const { other, places } = twoPlaces();
    const { backend, store, rt } = started({ places });
    const frames: { stage: string; place?: string }[] = [];
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push({ stage: e.stage, ...(e.place !== undefined ? { place: e.place } : {}) });
    });
    const b = await rt.golden.prepare({ place: "solari" });
    const { version } = await rt.golden.seal(b.id);
    expect(other.machines.length).toBeGreaterThan(0);
    const image = (await store.get("images", "default")) as SealedImage;
    expect(image).toMatchObject({ name: "default", version: 1, place: "solari", recipeHash: "h1", recipe: SMALL });
    expect(image.vault).toBeDefined();
    expect(await store.getBlob("image-vaults", "default@v1")).toBeDefined();
    const manifest = await rt.golden.get();
    expect(manifest?.head).toBe(1);
    expect(manifest?.versions[0]?.snapshotId).toBe(version.snapshotId);
    expect(await rt.golden.recipe()).toEqual(digestOf("h1"));
    // The image's own build names no place on its frames, wherever it runs: that is how the app tells it from a
    // copy's.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(f => f.place === undefined)).toBe(true);
    expect(backend.machines).toEqual([]);
    // The provider this host forks on gets its copy when asked, from the record, and the record stays where it was
    // sealed.
    await rt.image.build({ place: "box" });
    expect(backend.machines.length).toBeGreaterThan(0);
    expect(frames.filter(f => f.place !== undefined).every(f => f.place === "box")).toBe(true);
    expect((await store.get("images", "default")) as SealedImage).toMatchObject({ version: 1, place: "solari" });
    expect((await store.keys("goldens")).sort()).toEqual([copyKey("box", "default"), copyKey("solari", "default")]);
    expect((await rt.image.get()).copies.map(c => [c.place, c.hash])).toEqual([
      ["box", image.hash],
      ["solari", image.hash],
    ]);
    await rt.close();
  });
});

describe("where an image build goes", () => {
  const forking = (rows: Record<string, StubBackend | NoProviderBackend>, wired: string): PlaceBackends => ({
    wired,
    backend: place => rows[place],
    list: () => Object.keys(rows),
  });

  it("the place named, by its own id and backend; the provider this host forks on when nothing is named; a refusal for a word nothing here answers to", async () => {
    const { other, places } = twoPlaces();
    const { backend, rt } = started({ places });
    const named = await rt.golden.buildPlace("solari");
    expect([named.place, named.name, named.backend]).toEqual(["solari", "solari", other]);
    const unnamed = await rt.golden.buildPlace();
    expect([unnamed.place, unnamed.name, unnamed.backend]).toEqual(["box", "box", backend]);
    await expect(rt.golden.buildPlace("nowhere")).rejects.toMatchObject({ kind: "missing", message: expect.stringContaining("no place named nowhere") });
    await rt.close();
  });

  it("a place that forks nothing is refused by name, and with no place that runs workspaces the one sentence says so", async () => {
    const none = new NoProviderBackend();
    const rt = createRuntime({ backend: none, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: forking({ none }, "none") });
    await expect(rt.golden.buildPlace("none")).rejects.toThrow(/none forks no machines/);
    await expect(rt.golden.buildPlace()).rejects.toThrow(NO_BUILD_PLACE_LINE);
    await rt.close();
  });

  it("a fork is gated on the place it lands on: a place that forks nothing names the places that do, or the one no-provider sentence when none does", async () => {
    const none = new NoProviderBackend();
    const solari = stubBackend();
    const rt = createRuntime({ backend: none, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: forking({ none, solari }, "none") });
    await expect(rt.workspaces.landing({ project: (await projectOn(rt, "none")).id })).rejects.toThrow(placeForksNothingPickLine("none", ["solari"]));
    await expect(createOn(rt, { on: "none", golden: "snap_x", name: "x" })).rejects.toThrow(placeForksNothingPickLine("none", ["solari"]));
    expect(solari.machines).toEqual([]);
    await rt.close();
    const alone = createRuntime({ backend: none, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: forking({ none }, "none") });
    await expect(alone.workspaces.landing({ project: (await projectOn(alone, "none")).id })).rejects.toThrow(NO_PROVIDER_LINE);
    await expect(createOn(alone, { on: "none", golden: "snap_x", name: "x" })).rejects.toThrow(NO_PROVIDER_LINE);
    await alone.close();
  });

  it("with the default place forking nothing, the one other place that runs workspaces is where the build goes, and two of them are a question rather than a guess", async () => {
    const none = new NoProviderBackend();
    const solari = stubBackend();
    const one = createRuntime({ backend: none, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: forking({ none, solari }, "none") });
    const picked = await one.golden.buildPlace();
    expect([picked.place, picked.backend]).toEqual(["solari", solari]);
    await one.close();
    const box = stubBackend();
    const two = createRuntime({ backend: none, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: forking({ none, solari, box }, "none") });
    await expect(two.golden.buildPlace()).rejects.toThrow(buildPlaceAskLine(["solari", "box"]));
    await two.close();
  });
});
