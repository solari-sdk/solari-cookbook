// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { copyBuildingLine, copyStoppedLine, type GoldenStageEvent, type InitJob, type PlaceView, type SealedImage, type SealedImageCopy, type SealedImageView } from "@wsp/protocol";
import { builtWhen } from "./image.js";
import { imageChips, imageState, type ImageState } from "./imageState.js";

const NOW = Date.parse("2026-09-25T14:30:00.000Z");
const AT = "2026-09-25T14:02:00.000Z";
const HASH = "a".repeat(64);
const texts = (chips: readonly { text: string }[]): string[] => chips.map(chip => chip.text);

const box: PlaceView = { id: "box", kind: "provider", name: "box", default: false, takesForks: true, buildsImages: true };
const srv: PlaceView = { id: "p_1", kind: "computer", name: "srv", default: false, takesForks: true, buildsImages: true };
const here: PlaceView = { id: "here", kind: "computer", name: "This Mac", default: true, takesForks: false, buildsImages: false };

const image: SealedImage = {
  name: "default",
  version: 3,
  hash: HASH,
  recipeHash: "r",
  recipe: {
    version: 1,
    at: AT,
    histories: [],
    rows: [
      { id: "claude", kind: "agent", on: true, source: { kind: "installed", paths: [], bin: true } },
      { id: "codex", kind: "agent", on: true, source: { kind: "installed", paths: [], bin: true } },
      { id: "rg", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } },
    ],
  },
  logins: [{ name: "claude", state: "copied" }],
  sealedAt: AT,
  sealedFrom: "this Mac",
  vault: { sha256: "b".repeat(64), bytes: 10, paths: 1, held: ["/root/.claude"], takenAt: AT },
  usedBytes: 4.2 * 1024 ** 3,
  place: "solari",
};
const copyAt = (place: string, hash: string = HASH): SealedImageCopy => ({ place, version: 1, hash, snapshotId: `snap_${place}`, builtAt: AT, sizeBytes: 3 * 1024 ** 3 });
const viewWith = (...copies: SealedImageCopy[]): SealedImageView => ({ image, copies: [copyAt("solari"), ...copies], projects: [] });
const frame = (stage: GoldenStageEvent["stage"], place: string, detail?: string): GoldenStageEvent => ({ type: "golden.stage", name: "default", stage, place, ...(detail !== undefined ? { detail } : {}) });
const job = (phase: InitJob["phase"], place: { id: string; name: string } | undefined, error?: string): InitJob =>
  ({ id: "j", road: "screens", phase, keys: {}, step: 0, stoppable: false, screens: [], rows: [], progress: { done: 0, total: 0 }, log: [], ...(place !== undefined ? { place } : {}), ...(error !== undefined ? { error } : {}) }) as unknown as InitJob;

const read = (place: PlaceView, o: { view?: SealedImageView | null; job?: InitJob | null; frames?: Record<string, readonly GoldenStageEvent[]> } = {}): ImageState | undefined =>
  imageState(place, { view: o.view === undefined ? viewWith() : o.view, job: o.job ?? null, frames: o.frames ?? {} });

describe("one reading of a computer's image", () => {
  it("has nothing to say about a place that cannot hold the image, whatever else it carries", () => {
    expect(read(here)).toBeUndefined();
    expect(read({ ...here, build: copyStoppedLine("no such op"), buildStopped: true }, { frames: { here: [frame("failed", "here", "no such op")] } })).toBeUndefined();
  });

  it("reads what the row and the frames say where the host has not said whether the place can hold the image, and nothing with neither", () => {
    const { buildsImages: _said, ...linked } = srv;
    expect(read(linked, { view: viewWith(copyAt("p_1")) })).toBeUndefined();
    expect(read({ ...linked, build: copyStoppedLine("no such op"), buildStopped: true }, { frames: { p_1: [frame("failed", "p_1", "no such op")] } })).toEqual({ kind: "stopped", said: copyStoppedLine("no such op") });
    expect(read({ ...linked, build: copyStoppedLine("no such op"), buildStopped: true })).toEqual({ kind: "stopped", said: copyStoppedLine("no such op") });
    expect(read(linked, { frames: { p_1: [frame("creating", "p_1")] } })).toEqual({ kind: "copying", line: copyBuildingLine("creating") });
  });

  it("reads none where no copy stands and nothing builds, whether or not the image exists elsewhere", () => {
    expect(read(box)).toEqual({ kind: "none" });
    expect(read(box, { view: null })).toEqual({ kind: "none" });
    expect(read(box, { view: { image: null, copies: [], projects: [] } })).toEqual({ kind: "none" });
  });

  it("reads ready on a copy built from the image as it is, and stale on one built from an older record", () => {
    expect(read(box, { view: viewWith(copyAt("box")) })).toEqual({ kind: "ready", image, copy: copyAt("box") });
    expect(read(box, { view: viewWith(copyAt("box", "c".repeat(64))) })).toEqual({ kind: "stale", image, copy: copyAt("box", "c".repeat(64)) });
  });

  it("never reads stale where the record has nothing to judge its copies by", () => {
    const { vault: _vault, ...unvaulted } = image;
    const view = { image: unvaulted, copies: [copyAt("box", "c".repeat(64))], projects: [] };
    expect(read(box, { view })?.kind).toBe("ready");
  });

  it("matches a copy filed under the place's name as well as its id", () => {
    expect(read(srv, { view: viewWith(copyAt("srv")) })?.kind).toBe("ready");
  });

  it("reads copying off the frames of a build there, in the row's own words, and stopped off a failed one", () => {
    const frames = { box: [frame("creating", "box"), frame("installing-tools", "box")] };
    expect(read(box, { frames })).toEqual({ kind: "copying", line: copyBuildingLine("installing-tools") });
    expect(read(box, { frames: { box: [...frames.box, frame("failed", "box", "no room at box today")] } })).toEqual({ kind: "stopped", said: copyStoppedLine("no room at box today") });
  });

  it("a build there reads over the copy it will replace, and a sealed one gives way to the copies", () => {
    const stale = viewWith(copyAt("box", "c".repeat(64)));
    expect(read(box, { view: stale, frames: { box: [frame("snapshotting", "box")] } })?.kind).toBe("copying");
    expect(read(box, { view: viewWith(copyAt("box")), frames: { box: [frame("snapshotting", "box"), frame("sealed", "box")] } })?.kind).toBe("ready");
  });

  it("reads the row's own build words when no frame has been seen, as after the window opens mid-build", () => {
    expect(read({ ...box, build: copyBuildingLine("creating") })).toEqual({ kind: "copying", line: copyBuildingLine("creating") });
    expect(read({ ...box, build: copyStoppedLine("gone"), buildStopped: true })).toEqual({ kind: "stopped", said: copyStoppedLine("gone") });
  });

  it("reads frames by the place's id alone, so a computer named after a provider never reads that provider's build", () => {
    expect(read(srv, { frames: { p_1: [frame("creating", "p_1")] } })?.kind).toBe("copying");
    const namedBox: PlaceView = { ...srv, name: "box" };
    expect(read(namedBox, { frames: { box: [frame("creating", "box")] } })).toEqual({ kind: "none" });
  });

  it("a failed frame outranks a row still read as building", () => {
    const frames = { box: [frame("creating", "box"), frame("failed", "box", "no room at box today")] };
    expect(read({ ...box, build: copyBuildingLine("creating") }, { frames })).toEqual({ kind: "stopped", said: copyStoppedLine("no room at box today") });
  });

  it("reads building while the image's own build runs on this place, and never on another", () => {
    const running = job("signing-in", { id: "box", name: "box" });
    expect(read(box, { view: null, job: running })).toEqual({ kind: "building", job: running });
    expect(read(srv, { view: null, job: running })).toEqual({ kind: "none" });
    expect(read(box, { view: null, job: job("building", undefined) })).toEqual({ kind: "none" });
  });

  it("reads a first build that stopped here as stopped, and leaves a standing image readable after a rebuild stopped", () => {
    const failed = job("failed", { id: "box", name: "box" }, "the provider refused the key");
    expect(read(box, { view: null, job: failed })).toEqual({ kind: "stopped", said: "the provider refused the key" });
    expect(read(box, { view: viewWith(copyAt("box")), job: failed })?.kind).toBe("ready");
    expect(read(box, { view: null, job: job("cancelled", { id: "box", name: "box" }) })).toEqual({ kind: "none" });
  });
});

describe("the chips a state is drawn with", () => {
  it("a ready copy: the version, the size, the sign-ins it holds and when it was built", () => {
    expect(texts(imageChips({ kind: "ready", image, copy: copyAt("box") }, NOW))).toEqual(["v3", "4.2 GB", "1 sign-in", `built ${builtWhen(AT, NOW)}`]);
  });

  it("a stale copy says which version it is behind and when it was built", () => {
    expect(texts(imageChips({ kind: "stale", image, copy: copyAt("box", "c".repeat(64)) }, NOW))).toEqual(["behind your image v3", `built ${builtWhen(AT, NOW)}`]);
  });

  it("every chip carries its own glyph, as a computer's chips on the Computers page do", () => {
    const chips = [...imageChips({ kind: "ready", image, copy: copyAt("box") }, NOW), ...imageChips({ kind: "stale", image, copy: copyAt("box", "c".repeat(64)) }, NOW)];
    expect(chips.every(chip => chip.icon !== undefined)).toBe(true);
  });

  it("a state with no copy standing has no chips", () => {
    expect(imageChips({ kind: "none" }, NOW)).toEqual([]);
    expect(imageChips({ kind: "copying", line: "x" }, NOW)).toEqual([]);
  });
});
