// SPDX-License-Identifier: AGPL-3.0-only
import { useStore } from "../protocol/store.js";
import { useSettingsStore } from "./settingsStore.js";

/** One project's page in Settings, where its glyph and hue are picked: the switcher's gear and the row's menu both. */
export function openProjectSettings(projectId: string): void {
  useSettingsStore.getState().go({ kind: "project", id: projectId });
  useStore.getState().openSettings();
}

/** A computer's page in Settings with its Image card's recipe open: every Edit image outside that card. */
export function openImageRecipe(placeId: string): void {
  useSettingsStore.getState().go({ kind: "computer", id: placeId });
  useSettingsStore.getState().askRecipe(placeId);
  useStore.getState().openSettings();
}
