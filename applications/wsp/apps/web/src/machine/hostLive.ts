// SPDX-License-Identifier: AGPL-3.0-only
// The Live rows of the workspace that is this computer. Its figures are read
// in the host process and pushed on the socket this page already holds, so
// they arrive whether or not this computer's daemon ever started: nothing
// about cpu, memory or disk needs a port, a token or a pty. Which workspaces
// take this road is the kind table's to say, and the terminal wiring reads the
// same table before it asks a daemon for the same thing, so no workspace is
// sampled twice.
import { readingRoad, workspaceKind } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import type { useStore } from "../protocol/store.js";
import { getLive } from "./live.js";

/** Keeps the host's readings flowing for every workspace whose kind reads them here, for as long as the page is
 * mounted. A subscription dies with the socket that made it, so a socket that comes back is asked again. */
export function wireHostLive(store: typeof useStore): () => void {
  /** The workspaces this page has asked the socket it holds now about. */
  const asked = new Set<string>();
  let offSamples: (() => void) | null = null;
  /** The transport the readings are being taken off, so a page that binds another is listened to on that one. */
  let bound: Api | null = null;

  const sync = (): void => {
    const { api, workspaces, conn } = store.getState();
    if (api?.watchSys === undefined || api.onSysSample === undefined) return;
    if (api !== bound) {
      offSamples?.();
      bound = api;
      asked.clear();
      offSamples = api.onSysSample(e => getLive(e.workspaceId).feedSample(e.sample));
    }
    const here = workspaces.filter(w => readingRoad(workspaceKind(w), "metrics") === "host");
    if (conn !== "live") {
      // The readings ride this socket: one that is not live is a row whose newest figure is the last one before it went.
      for (const id of asked) getLive(id).feedReach("unreachable");
      asked.clear();
      return;
    }
    for (const w of here) {
      if (asked.has(w.id)) continue;
      asked.add(w.id);
      void api.watchSys(w.id).then(
        () => getLive(w.id).feedReach("live"),
        () => {
          asked.delete(w.id);
          getLive(w.id).feedReach("unreachable");
        },
      );
    }
  };

  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    offSamples?.();
    offSamples = null;
    for (const id of asked) getLive(id).feedReach("unreachable");
    asked.clear();
  };
}
