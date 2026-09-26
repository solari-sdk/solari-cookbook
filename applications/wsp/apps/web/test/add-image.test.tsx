// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer goes on to the image: once a box has joined over ssh or by
// its code, and once a cloud's key is saved, the same Image card the
// computer's page draws stands under the add panel, headed with that
// computer's name. Nothing is built by getting there; a copy is built on its
// press alone, with the time and the rate beside it.
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, fmtRate, placeBuildsNoImageLine, type InitJob, type InitSetup, type PlaceView, type SealedImage, type SealedImageBuilt, type SealedImageCopy, type SealedImageView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useAdds } from "../src/settings/adds.js";
import { ADD_COMPUTER_WORDS } from "../src/settings/format.js";
import { copyCost, IMAGE_WORDS } from "../src/settings/image.js";
import { placeName } from "../src/settings/places.js";
import { mountSettings, pageAt, resetSettings, settingsApi, settle } from "./settings-harness.js";

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
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, rateUsdPerHour: 0.018, takesForks: true, buildsImages: true };
const copyAt = (place: string): SealedImageCopy => ({ place, version: 1, hash: HASH, snapshotId: `snap_${place}`, builtAt: AT, sizeBytes: 4.2 * 1024 ** 3 });
const setupOf = (keys: Record<string, boolean>): InitSetup => ({ keys, home: "/Users/dev", agents: [], pricing: null, job: null }) as InitSetup;
const WITH_IMAGE: SealedImageView = { image: IMAGE, copies: [copyAt("solari")], projects: [] };

/** A host holding one image view, recording every image.build it is sent. */
function host(view: SealedImageView, over: Partial<Api> = {}) {
  const builds: { place: string; force: boolean | undefined }[] = [];
  const fake = settingsApi({
    initGet: async () => setupOf({ solari: false, box: false }),
    image: async () => view,
    imageBuild: async (place: string, force?: boolean): Promise<SealedImageBuilt> => {
      builds.push({ place, force });
      return { copy: copyAt(place), built: true };
    },
    ...over,
  } as Partial<Api>);
  return { ...fake, builds };
}

const road = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-settings-page] [data-k='road-${name}']`);
const card = (within: HTMLElement | null): HTMLElement | null => within?.querySelector<HTMLElement>("[data-settings-card='image']") ?? null;
const head = (within: HTMLElement | null): string | undefined => card(within)?.querySelector("[data-settings-head]")?.textContent ?? undefined;
const stateRow = (within: HTMLElement | null): HTMLElement => card(within)!.querySelector<HTMLElement>("[data-k='image-state']")!;
const title = (within: HTMLElement | null): string => stateRow(within).querySelector("[data-settings-title]")?.textContent ?? "";
const press = (within: HTMLElement | null): HTMLButtonElement => stateRow(within).querySelector<HTMLButtonElement>("[data-k='image-press']")!;
const cost = (within: HTMLElement | null): string[] => [...stateRow(within).querySelectorAll("[data-k='image-cost'] > span")].map(line => line.textContent ?? "");

const openRoad = async (api: Api, name: "ssh" | "cloud" | "code"): Promise<void> => {
  mountSettings({ api, at: { kind: "group", group: "computers" } });
  await settle();
  fireEvent.click(document.querySelector(`[data-add-road='${name}']`)!);
  await settle();
};

/** An add over ssh the host has finished, as the window that asked it keeps it. */
const joinedOverSsh = (place: PlaceView): void => {
  useAdds.setState({ jobs: { a_1: { addId: "a_1", address: `root@${place.name}`, startedAt: AT, state: "done", steps: [], placeId: place.id } }, putAway: null });
};

beforeEach(() => {
  resetSettings();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, places: [here], initJob: null, goldenFrames: {} });
});

afterEach(() => cleanup());

describe("Add a computer goes on to the image", () => {
  it("draws the Image card under a box that joined over ssh, headed with its name, and builds nothing until Copy is pressed", async () => {
    useStore.setState({ places: [here, box] });
    joinedOverSsh(box);
    const fake = host(WITH_IMAGE);
    await openRoad(fake.api, "ssh");
    const ssh = road("ssh");
    expect(ssh?.querySelector("[data-k='joined']")).not.toBeNull();
    expect(head(ssh)).toBe(IMAGE_WORDS.head("hetzner"));
    expect(title(ssh)).toBe(IMAGE_WORDS.state.notHere);
    expect(press(ssh).textContent).toBe(IMAGE_WORDS.copyHere);
    expect(cost(ssh)).toEqual(copyCost(undefined));
    expect(fake.builds).toEqual([]);
    fireEvent.click(press(ssh));
    await settle();
    expect(fake.builds).toEqual([{ place: "p_2", force: undefined }]);
  });

  it("puts the card away with Add another", async () => {
    useStore.setState({ places: [here, box] });
    joinedOverSsh(box);
    await openRoad(host(WITH_IMAGE).api, "ssh");
    expect(card(road("ssh"))).not.toBeNull();
    fireEvent.click([...road("ssh")!.querySelectorAll("[data-k='joined'] button")].find(b => b.textContent === ADD_COMPUTER_WORDS.another)!);
    await settle();
    expect(card(road("ssh"))).toBeNull();
  });

  it("draws the card under a computer that joined by its code", async () => {
    const fake = host(WITH_IMAGE, { mintJoin: async () => ({ joins: [{ url: "http://10.0.0.2:4640", line: "wsp join http://10.0.0.2:4640 --code abc" }], expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Partial<Api>);
    await openRoad(fake.api, "code");
    expect(card(road("code"))).toBeNull();
    act(() => useStore.setState({ places: [here, box] }));
    await settle();
    const code = road("code");
    expect(code?.querySelector("[data-k='joined']")).not.toBeNull();
    expect(head(code)).toBe(IMAGE_WORDS.head("hetzner"));
    expect(press(code).textContent).toBe(IMAGE_WORDS.copyHere);
    expect(fake.builds).toEqual([]);
  });

  it("says where no image exists yet that the image is built here, and its press opens the recipe under the panel", async () => {
    useStore.setState({ places: [here, box] });
    joinedOverSsh(box);
    await openRoad(host({ image: null, copies: [], projects: [] }, { initStart: async () => ({}) as InitJob }).api, "ssh");
    const ssh = road("ssh");
    expect(title(ssh)).toBe(IMAGE_WORDS.state.nothing);
    expect(press(ssh).hasAttribute("data-held")).toBe(false);
    fireEvent.click(press(ssh));
    await settle();
    expect(card(ssh)?.querySelector("[data-k='recipe']")?.getAttribute("data-step")).toBe("choice");
  });

  it("says in one line that a joined computer takes no copy, in place of a card", async () => {
    const bare: PlaceView = { ...box, buildsImages: false };
    useStore.setState({ places: [here, bare] });
    joinedOverSsh(bare);
    await openRoad(host(WITH_IMAGE).api, "ssh");
    const ssh = road("ssh");
    expect(card(ssh)).toBeNull();
    expect(ssh?.querySelector("[data-k='no-image-here']")?.textContent).toBe(placeBuildsNoImageLine("hetzner"));
  });

  it("draws the card for a cloud once its key is saved, with the rate beside Copy, and bills nothing for the save", async () => {
    let places: PlaceView[] = [here];
    const fake = host(WITH_IMAGE, {
      initKeys: async () => {
        places = [here, ascii];
        return setupOf({ solari: false, box: true });
      },
      placesList: async () => ({ places, adds: [] }),
    } as unknown as Partial<Api>);
    await openRoad(fake.api, "cloud");
    const cloud = road("cloud");
    expect(card(cloud)).toBeNull();
    const boxKey = cloud!.querySelector("[data-provider='box']")!;
    fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
    fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
    await settle();
    expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keySaved);
    // One name for the cloud: the key block's, which the card's head and the cloud's own page read too.
    expect(boxKey.querySelector("[data-k='provider-name']")?.textContent).toBe("Box by ASCII");
    expect(head(cloud)).toBe(IMAGE_WORDS.head("Box by ASCII"));
    expect(placeName(ascii)).toBe("Box by ASCII");
    expect(press(cloud).textContent).toBe(IMAGE_WORDS.copyHere);
    expect(cost(cloud)).toEqual(copyCost(0.018));
    expect(cost(cloud)[1]).toBe(fmtRate(0.018));
    expect(fake.builds).toEqual([]);
    fireEvent.click(press(cloud));
    await settle();
    expect(fake.builds).toEqual([{ place: "box", force: undefined }]);
  });

  it("draws no card for a key the host already held when the page opened, since nothing was added", async () => {
    useStore.setState({ places: [here, ascii] });
    await openRoad(host(WITH_IMAGE, { initGet: async () => setupOf({ solari: false, box: true }) } as Partial<Api>).api, "cloud");
    expect(card(road("cloud"))).toBeNull();
  });

  it("says under a key the host already held where that cloud's image stands, one line whose chevron opens the cloud's page", async () => {
    useStore.setState({ places: [here, ascii] });
    await openRoad(host(WITH_IMAGE, { initGet: async () => setupOf({ solari: false, box: true }) } as Partial<Api>).api, "cloud");
    const boxKey = road("cloud")!.querySelector("[data-provider='box']")!;
    const line = boxKey.querySelector<HTMLButtonElement>("[data-k='held-image']");
    expect(line?.textContent).toBe(`${IMAGE_WORDS.head("Box by ASCII")}${IMAGE_WORDS.state.notHere}`);
    expect(line?.querySelector("svg")).not.toBeNull();
    // Solari's key is not held, so it says nothing of an image.
    expect(road("cloud")!.querySelector("[data-provider='solari'] [data-k='held-image']")).toBeNull();
    fireEvent.click(line!);
    await settle();
    expect(pageAt()).toBe("computer:box");
  });

  it("says the held key's image is ready where the cloud holds the current copy", async () => {
    useStore.setState({ places: [here, ascii] });
    const view: SealedImageView = { ...WITH_IMAGE, copies: [{ ...copyAt("box"), version: IMAGE.version }] };
    await openRoad(host(view, { initGet: async () => setupOf({ solari: false, box: true }) } as Partial<Api>).api, "cloud");
    expect(road("cloud")!.querySelector("[data-provider='box'] [data-k='held-image']")?.textContent).toBe(`${IMAGE_WORDS.head("Box by ASCII")}${IMAGE_WORDS.state.ready}`);
  });
});
