// SPDX-License-Identifier: AGPL-3.0-only
// The Image card on a computer's page: one state each, read off the image
// view, the init job and the frames the store keeps; Copy sends image.build and
// nothing else bills; a refused press lands in the slot in its two halves; a
// sealed frame reads the image again; the ready card starts a task there.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COPY_BUILD_FIX, DEFAULT_PREFERENCES, copyBuildingLine, copyStoppedLine, fmtRate, type GoldenStageEvent, type InitJob, type InitSetup, type PlaceView, type SealedImage, type SealedImageBuilt, type SealedImageCopy, type SealedImageView } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { copyCost, IMAGE_WORDS } from "../src/settings/image.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

const AT = "2026-09-12T11:00:00.000Z";
const HASH = "a".repeat(64);
const IMAGE: SealedImage = {
  name: "default",
  version: 3,
  hash: HASH,
  recipeHash: "recipe-1",
  logins: [{ name: "claude", state: "copied" }],
  sealedAt: "2026-09-12T09:12:00.000Z",
  sealedFrom: "this Mac",
  vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: AT },
  usedBytes: 4.2 * 1024 ** 3,
};
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true, buildsImages: true };
const copyAt = (place: string, hash = HASH): SealedImageCopy => ({ place, version: 1, hash, snapshotId: `snap_${place}`, builtAt: AT, sizeBytes: 4.2 * 1024 ** 3 });
const setup = (over: Partial<InitSetup> = {}): InitSetup => ({ keys: { solari: true }, home: "/Users/dev", agents: [], pricing: null, job: null, ...over }) as InitSetup;
const frame = (place: string, stage: GoldenStageEvent["stage"], detail?: string): GoldenStageEvent => ({ type: "golden.stage", name: "default", stage, place, ...(detail === undefined ? {} : { detail }) });

/** A host holding one image view, which a press or a test moves, and every image.build it was sent. */
function host(view: SealedImageView, o: { build?: (place: string, force: boolean | undefined) => Promise<SealedImageBuilt>; setup?: InitSetup } = {}) {
  const held = { view };
  const builds: { place: string; force: boolean | undefined }[] = [];
  let reads = 0;
  const fake = settingsApi({
    initGet: async () => o.setup ?? setup(),
    image: async () => {
      reads += 1;
      return held.view;
    },
    initStart: async () => ({}) as InitJob,
    imageBuild: async (place: string, force?: boolean) => {
      builds.push({ place, force });
      return (o.build ?? (async () => ({ copy: copyAt(place), built: true })))(place, force);
    },
  } as Partial<Api>);
  return { ...fake, held, builds, reads: () => reads };
}

const card = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-settings-page] [data-settings-card='image']");
const stateRow = (): HTMLElement => card()!.querySelector<HTMLElement>("[data-k='image-state']")!;
const title = (): string => stateRow().querySelector("[data-settings-title]")?.textContent ?? "";
const description = (): string => stateRow().querySelector("[data-settings-description]")?.textContent ?? "";
const cost = (): string[] => [...stateRow().querySelectorAll("[data-k='image-cost'] > span")].map(line => line.textContent ?? "");
const chips = (): string[] => [...stateRow().querySelectorAll("[data-chip]")].map(chip => chip.textContent ?? "");
const press = (): HTMLButtonElement => stateRow().querySelector<HTMLButtonElement>("[data-k='image-press']")!;
const slot = (): string => card()!.querySelector("[data-k='image-refusal']")?.textContent ?? "";

const open = async (api: Api, id: string): Promise<void> => {
  mountSettings({ api, at: { kind: "computer", id } });
  await settle();
};

beforeEach(() => {
  resetSettings();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, places: [here, box, solari], initJob: null, goldenFrames: {} });
});

afterEach(() => cleanup());

describe("the Image card", () => {
  it("heads a joined computer's page with the image on it, and draws no card where no image can stand or before the image is read", async () => {
    await open(host({ image: IMAGE, copies: [copyAt("solari")], projects: [] }).api, "p_2");
    expect(card()?.querySelector("[data-settings-head]")?.textContent).toBe(IMAGE_WORDS.head("hetzner"));
    cleanup();
    resetSettings();
    useStore.setState({ places: [here, box] });
    await open(host({ image: IMAGE, copies: [], projects: [] }).api, "here");
    expect(card()).toBeNull();
    cleanup();
    resetSettings();
    useStore.setState({ places: [here, box] });
    await open(settingsApi({ initGet: async () => setup(), image: () => new Promise<SealedImageView>(() => {}) } as Partial<Api>).api, "p_2");
    expect(card()).toBeNull();
  });

  it("offers to copy the image where no copy stands, with the time and no rate on a computer that bills nothing, and sends image.build on the press alone", async () => {
    const fake = host({ image: IMAGE, copies: [copyAt("solari")], projects: [] });
    await open(fake.api, "p_2");
    expect(title()).toBe(IMAGE_WORDS.state.notHere);
    expect(description()).toBe(IMAGE_WORDS.copyComes(3));
    expect(cost()).toEqual(copyCost(undefined));
    expect(cost()).toEqual(["about ten minutes"]);
    expect(press().textContent).toBe(IMAGE_WORDS.copyHere);
    // Opening the page asked for nothing to be built.
    expect(fake.builds).toEqual([]);
    fireEvent.click(press());
    await settle();
    expect(fake.builds).toEqual([{ place: "p_2", force: undefined }]);
  });

  it("says the rate beside Copy on a cloud that bills", async () => {
    await open(host({ image: IMAGE, copies: [copyAt("hetzner")], projects: [] }).api, "solari");
    expect(card()?.querySelector("[data-settings-head]")?.textContent).toBe(IMAGE_WORDS.head("Solari"));
    expect(cost()).toEqual(copyCost(0.11));
    expect(cost()[1]).toBe(fmtRate(0.11));
  });

  it("offers Copy anyway on a record that holds no sign-ins, saying every one is asked again, and sends force", async () => {
    const { vault: _vault, ...bare } = IMAGE;
    const fake = host({ image: bare, copies: [copyAt("solari")], projects: [] });
    await open(fake.api, "p_2");
    expect(description()).toBe(IMAGE_WORDS.copyAsks(3));
    expect(press().textContent).toBe(IMAGE_WORDS.copyAnyway);
    fireEvent.click(press());
    await settle();
    expect(fake.builds).toEqual([{ place: "p_2", force: true }]);
  });

  it("says every sign-in is asked again before Copy anyway on a record with no sign-ins whose last copy stopped", async () => {
    const { vault: _vault, ...bare } = IMAGE;
    const fake = host({ image: bare, copies: [copyAt("solari")], projects: [] });
    useStore.setState({ goldenFrames: { p_2: [frame("p_2", "failed", "no room on hetzner")] } });
    await open(fake.api, "p_2");
    expect(description()).toBe(copyStoppedLine("no room on hetzner"));
    expect(press().textContent).toBe(IMAGE_WORDS.copyAnyway);
    expect(slot()).toBe(IMAGE_WORDS.copyAsks(3));
    fireEvent.click(press());
    await settle();
    expect(fake.builds).toEqual([{ place: "p_2", force: true }]);
  });

  it("draws a refused press in the slot in its two halves, the fix in the fix ink, and clears it on the next press", async () => {
    let refuse = true;
    const fake = host(
      { image: IMAGE, copies: [copyAt("solari")], projects: [] },
      {
        build: async place => {
          if (refuse) throw new RequestError(`default v3 was sealed before the image record kept the recipe it was built from, so no other place can build it. ${COPY_BUILD_FIX.noRecipe}`, "conflict", COPY_BUILD_FIX.noRecipe);
          return { copy: copyAt(place), built: true };
        },
      },
    );
    await open(fake.api, "p_2");
    // The slot stands before anything is said in it, so a refusal moves nothing under the card.
    expect(card()!.querySelector("[data-k='image-refusal']")).not.toBeNull();
    fireEvent.click(press());
    await settle();
    expect(slot()).toBe(`default v3 was sealed before the image record kept the recipe it was built from, so no other place can build it. ${COPY_BUILD_FIX.noRecipe}`);
    expect(card()!.querySelector("[data-k='image-refusal'] .text-foreground")?.textContent?.trim()).toBe(COPY_BUILD_FIX.noRecipe);
    refuse = false;
    fireEvent.click(press());
    await settle();
    expect(slot()).toBe("");
  });

  it("holds the press while it is on its way, so a second press sends nothing", async () => {
    let finish: (built: SealedImageBuilt) => void = () => {};
    const fake = host({ image: IMAGE, copies: [copyAt("solari")], projects: [] }, { build: () => new Promise(r => (finish = r)) });
    await open(fake.api, "p_2");
    fireEvent.click(press());
    await settle();
    expect(press().disabled).toBe(true);
    fireEvent.click(press());
    expect(fake.builds).toHaveLength(1);
    await act(async () => finish({ copy: copyAt("p_2"), built: true }));
  });

  it("draws a copy building off the frames with no press in it, then reads the image again on the sealed frame and stands ready", async () => {
    const fake = host({ image: IMAGE, copies: [copyAt("solari")], projects: [] });
    await open(fake.api, "p_2");
    act(() => useStore.setState({ goldenFrames: { p_2: [frame("p_2", "creating")] } }));
    expect(title()).toBe(IMAGE_WORDS.state.copying);
    expect(description()).toBe(copyBuildingLine("creating"));
    expect(press()).toBeNull();
    const before = fake.reads();
    fake.held.view = { image: IMAGE, copies: [copyAt("solari"), copyAt("p_2")], projects: [] };
    act(() => {
      useStore.setState({ goldenFrames: { p_2: [frame("p_2", "creating"), frame("p_2", "sealed")] } });
      fake.push(frame("p_2", "sealed"));
    });
    await settle();
    expect(fake.reads()).toBe(before + 1);
    expect(title()).toBe(IMAGE_WORDS.state.ready);
    expect(chips()).toEqual(["v3", "4.2 GB", "1 sign-in", expect.stringMatching(/^built /)]);
  });

  it("says a stopped build in its own words and builds again on Try again", async () => {
    const fake = host({ image: IMAGE, copies: [copyAt("solari")], projects: [] });
    useStore.setState({ goldenFrames: { p_2: [frame("p_2", "creating"), frame("p_2", "failed", "no room on hetzner")] } });
    await open(fake.api, "p_2");
    expect(title()).toBe(IMAGE_WORDS.state.notHere);
    expect(description()).toBe(copyStoppedLine("no room on hetzner"));
    // A second try bills as the first did, so the time and the rate stand beside it too.
    expect(cost()).toEqual(copyCost(undefined));
    expect(press().textContent).toBe(IMAGE_WORDS.tryAgain);
    fireEvent.click(press());
    await settle();
    expect(fake.builds).toEqual([{ place: "p_2", force: undefined }]);
  });

  it("says a copy behind the image as a chip with Copy beside it", async () => {
    const fake = host({ image: IMAGE, copies: [copyAt("solari"), copyAt("p_2", "b".repeat(64))], projects: [] });
    await open(fake.api, "p_2");
    expect(title()).toBe(IMAGE_WORDS.state.stale);
    expect(chips()).toEqual([IMAGE_WORDS.behindChip(3), expect.stringMatching(/^built /)]);
    // The Computers page's chip, glyph and all, not a second chip of the card's own.
    expect([...stateRow().querySelectorAll("[data-chip]")].every(chip => chip.querySelector("svg") !== null)).toBe(true);
    expect(press().textContent).toBe(IMAGE_WORDS.copyHere);
    fireEvent.click(press());
    await settle();
    expect(fake.builds).toEqual([{ place: "p_2", force: undefined }]);
  });

  it("opens the recipe in place from Build your image here where no image exists yet, the state row gone while it stands and back on Close", async () => {
    const fake = settingsApi({ initGet: async () => setup(), image: async () => ({ image: null, copies: [], projects: [] }), initStart: async () => ({}) as InitJob } as Partial<Api>);
    await open(fake.api, "p_2");
    expect(title()).toBe(IMAGE_WORDS.state.nothing);
    expect(description()).toBe(IMAGE_WORDS.chooseAndBuild);
    expect(press().textContent).toBe(IMAGE_WORDS.buildHere);
    expect(press().hasAttribute("data-held")).toBe(false);
    expect(card()!.querySelector("[data-k='edit-image']")).toBeNull();
    fireEvent.click(press());
    await settle();
    expect(card()!.querySelector("[data-k='recipe']")?.getAttribute("data-step")).toBe("choice");
    // The state row answers what now; with the recipe open that answer is on screen, so the row goes, the head stays.
    expect(card()!.querySelector("[data-k='image-state']")).toBeNull();
    expect(card()?.querySelector("[data-settings-head]")?.textContent).toBe(IMAGE_WORDS.head("hetzner"));
    fireEvent.click(card()!.querySelector("[data-k='recipe-close']")!);
    await settle();
    expect(title()).toBe(IMAGE_WORDS.state.nothing);
  });

  it("stands the image's own build running here in the state row's place", async () => {
    const job = { id: "j1", road: "screens", phase: "building", place: { id: "p_2", name: "hetzner" }, progress: { done: 2, total: 9 }, rows: [], screens: [], log: [], step: 0, stoppable: true, keys: {} } as unknown as InitJob;
    useStore.setState({ initJob: job });
    await open(host({ image: null, copies: [], projects: [] }).api, "p_2");
    expect(card()!.querySelector("[data-k='image-state']")).toBeNull();
    expect(card()!.querySelector("[data-k='build']")?.getAttribute("data-step")).toBe("building");
  });

  it("starts a task on a ready computer with the project that lands there picked, and holds the press where none does", async () => {
    const project = (id: string, computer: string) => ({ id, name: id, computer, source: { kind: "folder", path: `/p/${id}` }, path: `/p/${id}`, createdAt: AT }) as never;
    // A task lands on its project's computer, so the project picked is the one recorded on this one; no landing has
    // been read, as none is while Settings stands in the sidebar's place.
    useStore.setState({ projects: [project("pr_mac", "here"), project("pr_box", "p_2")], landings: {} });
    await open(host({ image: IMAGE, copies: [copyAt("solari"), copyAt("p_2")], projects: [] }).api, "p_2");
    expect(title()).toBe(IMAGE_WORDS.state.ready);
    expect(press().textContent).toBe(IMAGE_WORDS.startTask);
    fireEvent.click(press());
    await settle();
    expect(useStore.getState().settingsOpen).toBe(false);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_box]")!.getAttribute("aria-checked")).toBe("true");
    cleanup();
    resetSettings();
    useStore.setState({ places: [here, box, solari], projects: [project("pr_mac", "here")] });
    await open(host({ image: IMAGE, copies: [copyAt("solari"), copyAt("p_2")], projects: [] }).api, "p_2");
    expect(press().hasAttribute("data-held")).toBe(true);
    expect(slot()).toBe(IMAGE_WORDS.startHeld("hetzner"));
  });

  it("reads which project lands on the cloud this host forks on by the host's own rule: one on the cloud starts there, one on this Mac stays a copy here", async () => {
    const project = (id: string, computer: string) => ({ id, name: id, computer, source: { kind: "folder", path: `/p/${id}` }, path: `/p/${id}`, createdAt: AT }) as never;
    const onSolari = (projects: never[]) => {
      useStore.setState({ places: [here, box, solari], projects, landings: {} });
      return host({ image: IMAGE, copies: [copyAt("solari")], projects: [] }, { setup: setup({ forksOn: "solari" }) }).api;
    };
    // A project here is a copy of its folder on this Mac and never forks on the cloud, so Solari's press stays held.
    await open(onSolari([project("pr_mac", "here")]), "solari");
    expect(title()).toBe(IMAGE_WORDS.state.ready);
    expect(press().hasAttribute("data-held")).toBe(true);
    expect(slot()).toBe(IMAGE_WORDS.startHeld("Solari"));
    cleanup();
    resetSettings();
    await open(onSolari([project("pr_mac", "here"), project("pr_cloud", "solari")]), "solari");
    expect(press().hasAttribute("data-held")).toBe(false);
    fireEvent.click(press());
    await settle();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_cloud]")!.getAttribute("aria-checked")).toBe("true");
  });
});
