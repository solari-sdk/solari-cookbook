// SPDX-License-Identifier: AGPL-3.0-only
// The agent catalog a composer fixture serves, and the wait every fixture owes
// it. The composer resolves the model, effort, context window and access every
// start rides out of the workspace's catalog, so until one has landed the box
// is held and no key press starts a turn: a fixture that serves none is a
// fixture whose composer never opens. One row and one wait here rather than one
// per test file, so a field added to a catalog is added once.
import { waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { HarnessCatalog } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";

/** The runtime's own table row, which is what answers a workspace before any binary on its machine has. */
export const TABLE_CATALOG: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "table",
  version: null,
  models: [],
  efforts: [],
  contextWindows: [],
  permissionModes: [],
  steers: false,
  renames: false,
  images: false,
  screenCommands: [],
};

/** Waits until the store holds an agent the composer can send to. */
export async function whenAgentsAnswered(): Promise<void> {
  await waitFor(() => expect(useStore.getState().harnesses.length).toBeGreaterThan(0));
}
