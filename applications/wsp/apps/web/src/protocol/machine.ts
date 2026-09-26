// SPDX-License-Identifier: AGPL-3.0-only
// Machine surface protocol hooks: the workspace's cost series, the runtime's
// history with the live ticks folded onto it.
import { useCallback, useEffect, useState } from "react";
import { appendCostPoint, type WorkspaceCostEvent } from "@wsp/protocol";
import { useProtocolEvents, useStore } from "./store.js";

/** The runtime's history with the ticks that landed while it was in flight folded on after it. */
function seeded(history: WorkspaceCostEvent[], live: readonly WorkspaceCostEvent[]): WorkspaceCostEvent[] {
  const last = history[history.length - 1];
  const after = last === undefined ? live : live.filter(p => p.at > last.at);
  return after.reduce(appendCostPoint, history);
}

/** The workspace's accrued cost since metering began: its history once fetched, every live tick after.
 * Rate-constant runs fold to their ends, so a day of ticks stays a handful of points. */
export function useCostSeries(id: string | null): WorkspaceCostEvent[] {
  const api = useStore(s => s.api);
  const [series, setSeries] = useState<WorkspaceCostEvent[]>([]);

  useEffect(() => {
    setSeries([]);
    if (id === null || api?.costHistory === undefined) return;
    let current = true;
    api
      .costHistory(id)
      .then(history => {
        if (current) setSeries(live => seeded(history, live));
      })
      .catch((e: unknown) => console.warn("cost history unavailable; the chart begins at the first live tick", e));
    return () => {
      current = false;
    };
  }, [api, id]);

  useProtocolEvents(
    useCallback(
      e => {
        if (e.type !== "workspace.cost" || e.workspaceId !== id) return;
        setSeries(s => appendCostPoint(s, e));
      },
      [id],
    ),
  );
  return series;
}
