// SPDX-License-Identifier: AGPL-3.0-only
// Where Settings is open and what its search field holds: a small store
// beside the right panel's, read by the settings sidebar, the page, the
// breadcrumb and the header's Restore defaults. The open page is kept in this
// browser's storage, never on the host's record, so Settings reopens where it
// was closed in this window and a browser tab on the same host keeps its own.
// The host's reads the pages draw from live here too, so one reader in the
// page serves the sidebar's search as well.
import type { AccountView, DeviceView, InitSetup, PlaceSpend, PlaceView, ProjectView, SealedImageView, TerminalConfig } from "@wsp/protocol";
import { create } from "zustand";
import { isSettingsGroupId, type SettingsGroupId } from "./groupIds.js";

/** A page of Settings: a group, a computer's own page or a project's. */
export type SettingsAt = { readonly kind: "group"; readonly group: SettingsGroupId } | { readonly kind: "computer"; readonly id: string } | { readonly kind: "project"; readonly id: string };

/** The page a fresh window opens on. */
export const FIRST_PAGE: SettingsAt = { kind: "group", group: "appearance" };
const AT_KEY = "wsp:settings-at";

/** The one word for a page, worn by the page root as `data-settings-at` and by the sidebar's rows as their id. */
export function atId(at: SettingsAt): string {
  return at.kind === "group" ? at.group : `${at.kind}:${at.id}`;
}

export const sameAt = (a: SettingsAt, b: SettingsAt): boolean => atId(a) === atId(b);

/** The group a page belongs to: its own for a group page, Computers for a computer's, Projects for a project's. */
export const groupOf = (at: SettingsAt): SettingsGroupId => (at.kind === "group" ? at.group : at.kind === "computer" ? "computers" : "projects");

/** A page read back off storage, or nothing for a word that names no page. */
export function parseAt(raw: string | null): SettingsAt | null {
  if (raw === null) return null;
  const [kind, id] = raw.includes(":") ? [raw.slice(0, raw.indexOf(":")), raw.slice(raw.indexOf(":") + 1)] : [raw, ""];
  if ((kind === "computer" || kind === "project") && id !== "") return { kind, id };
  return isSettingsGroupId(raw) ? { kind: "group", group: raw } : null;
}

/** A remembered page whose noun is gone falls back to its group, checked against the lists on read. */
export function resolveAt(at: SettingsAt, places: ReadonlyArray<Pick<PlaceView, "id">>, projects: ReadonlyArray<Pick<ProjectView, "id">>): SettingsAt {
  if (at.kind === "computer" && !places.some(place => place.id === at.id)) return { kind: "group", group: "computers" };
  if (at.kind === "project" && !projects.some(project => project.id === at.id)) return { kind: "group", group: "projects" };
  return at;
}

const readStored = (): SettingsAt => {
  try {
    return parseAt(window.localStorage.getItem(AT_KEY)) ?? FIRST_PAGE;
  } catch {
    return FIRST_PAGE;
  }
};

/** What the pages draw from the host, read once by the page and kept here for the sidebar's search. `null` is a
 * read not yet answered or refused; a refusal is its own flag where the page says a sentence for it. */
export interface SettingsReads {
  readonly setup: InitSetup | null;
  readonly file: TerminalConfig | null;
  readonly account: AccountView | null;
  readonly devices: ReadonlyArray<DeviceView> | null;
  readonly devicesRefused: boolean;
  readonly image: SealedImageView | null;
  readonly spend: ReadonlyArray<PlaceSpend>;
}

export const NO_READS: SettingsReads = { setup: null, file: null, account: null, devices: null, devicesRefused: false, image: null, spend: [] };

interface SettingsState {
  readonly at: SettingsAt;
  readonly search: string;
  readonly reads: SettingsReads;
  /** The Add a project sheet asked for from the Projects page, keyed by the ask so a second one is a fresh sheet. */
  readonly addProjectAt: number | null;
  /** How many times the devices list has been asked for again, which the read effect follows. */
  readonly devicesAsked: number;
  /** The computer whose image build a card is drawing now, which is where that build's waits are said. */
  readonly buildShown: string | null;
  /** The computer whose Image card opens its recipe when it is drawn: an Edit image pressed outside that card. Moving
   * to another page drops it, so an ask no card took never opens a recipe later. */
  readonly recipeAsked: string | null;
  go(at: SettingsAt): void;
  setSearch(search: string): void;
  setReads(patch: Partial<SettingsReads>): void;
  openAddProject(): void;
  closeAddProject(): void;
  rereadDevices(): void;
  showBuild(placeId: string): void;
  hideBuild(placeId: string): void;
  askRecipe(placeId: string | null): void;
}

export const useSettingsStore = create<SettingsState>(set => ({
  at: typeof window === "undefined" ? FIRST_PAGE : readStored(),
  search: "",
  reads: NO_READS,
  addProjectAt: null,
  devicesAsked: 0,
  buildShown: null,
  recipeAsked: null,
  go(at) {
    set({ at, search: "", recipeAsked: null });
    try {
      window.localStorage.setItem(AT_KEY, atId(at));
    } catch {
      // A browser that refuses storage keeps the page for this window alone.
    }
  },
  setSearch(search) {
    set({ search });
  },
  setReads(patch) {
    set(s => ({ reads: { ...s.reads, ...patch } }));
  },
  openAddProject() {
    set({ addProjectAt: Date.now() });
  },
  closeAddProject() {
    set({ addProjectAt: null });
  },
  rereadDevices() {
    set(s => ({ devicesAsked: s.devicesAsked + 1 }));
  },
  showBuild(placeId) {
    set({ buildShown: placeId });
  },
  hideBuild(placeId) {
    set(s => (s.buildShown === placeId ? { buildShown: null } : {}));
  },
  askRecipe(placeId) {
    set({ recipeAsked: placeId });
  },
}));
