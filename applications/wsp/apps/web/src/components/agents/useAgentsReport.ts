// SPDX-License-Identifier: AGPL-3.0-only
// The agents report of one computer or task, read when a page or a panel
// shows it and again on Read again. The last report of each target is kept
// for as long as the window lives, so a computer that stopped answering or a
// task that is paused still draws what stood there when it was last read.
// The host saying the agents there changed reads it again.
import { useCallback, useEffect, useState } from "react";
import type { AgentsReport, AgentsTarget } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { AGENTS_LIST_WORDS } from "./agentsRows.js";

const lastReports = new Map<string, AgentsReport>();

/** Forgets every report this window kept, for a test that starts from a first window. */
export const forgetAgentsReports = (): void => lastReports.clear();

interface ReportState {
  readonly key: string | null;
  readonly report: AgentsReport | null;
  readonly reading: boolean;
  /** The one sentence the host refused the read with, while no report stands in its place. */
  readonly error: string | null;
}

const idle = (key: string | null): ReportState => ({ key, report: key === null ? null : (lastReports.get(key) ?? null), reading: false, error: null });

export function useAgentsReport(target: AgentsTarget | null): ReportState & { refresh: () => void } {
  const api = useStore(s => s.api);
  const key = target === null ? null : JSON.stringify(target);
  const [state, setState] = useState<ReportState>(() => idle(key));
  const [asked, setAsked] = useState(0);
  const shown = state.key === key ? state : idle(key);
  const readable = api?.agentsRead !== undefined;

  useEffect(() => {
    if (key === null || api?.agentsRead === undefined) return;
    let live = true;
    setState(s => ({ ...(s.key === key ? s : idle(key)), reading: true }));
    api.agentsRead(JSON.parse(key) as AgentsTarget).then(
      report => {
        lastReports.set(key, report);
        if (live) setState({ key, report, reading: false, error: null });
      },
      (e: unknown) => {
        if (live) setState(s => ({ ...(s.key === key ? s : idle(key)), reading: false, error: e instanceof Error ? e.message : String(e) }));
      },
    );
    return () => {
      live = false;
    };
  }, [api, key, asked]);

  const refresh = useCallback(() => setAsked(n => n + 1), []);
  // A sign-in, a key or the wsp tools written there changes what the report reads, so it is read again.
  useEffect(() => {
    if (key === null || api?.subscribe === undefined) return;
    return api.subscribe(event => {
      if (event.type !== "agents.changed") return;
      if (event.target === undefined || JSON.stringify(event.target) === key) refresh();
    });
  }, [api, key, refresh]);
  // A client with no such read says so once, rather than standing the bars of a read that never comes.
  return { ...shown, ...(key !== null && api !== null && !readable && shown.report === null ? { error: AGENTS_LIST_WORDS.noReader } : {}), refresh };
}
