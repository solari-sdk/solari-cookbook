// SPDX-License-Identifier: AGPL-3.0-only
// The servers road of one target: a server added from the form, which keeps
// its own values and hears the host's answer, and one entry's rows removed or
// turned off or on, one ask per agent it is set up for, keyed by the entry. A
// write's answer is the report read again when the host says the agents there
// changed, so only what runs and why the host refused is kept here; a new
// target starts from nothing, and an answer for an old one is dropped.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsTarget, McpRow, ServerAsk } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { errorText } from "../../lib/utils.js";
import { rowTarget, type ServerActs } from "./agentsRows.js";

interface Held {
  readonly targetKey: string | null;
  readonly busy: Readonly<Record<string, true>>;
  readonly refused: Readonly<Record<string, string>>;
}

const fresh = (targetKey: string | null): Held => ({ targetKey, busy: {}, refused: {} });

const askOf = (row: McpRow): ServerAsk => ({ agent: row.agent, name: row.name, scope: row.scope });

export function useServerActs(target: AgentsTarget | null): ServerActs | undefined {
  const api = useStore(s => s.api);
  const targetKey = target === null ? null : JSON.stringify(target);
  const [held, setHeld] = useState<Held>(() => fresh(targetKey));
  const current = useRef(targetKey);
  useEffect(() => {
    current.current = targetKey;
  }, [targetKey]);
  const shown = held.targetKey === targetKey ? held : fresh(targetKey);

  const put = useCallback(
    (part: "busy" | "refused", key: string, value: string | true | undefined, forKey: string | null): void =>
      setHeld(h => {
        if (current.current !== forKey) return h;
        const base = h.targetKey === forKey ? h : fresh(forKey);
        const next = { ...base[part] } as Record<string, unknown>;
        if (value === undefined) delete next[key];
        else next[key] = value;
        return { ...base, [part]: next };
      }),
    [],
  );

  return useMemo<ServerActs | undefined>(() => {
    if (api === null || api.serversAdd === undefined || targetKey === null) return undefined;
    const at = JSON.parse(targetKey) as AgentsTarget;
    /** One entry's asks, one agent after another: busy while they run, the first refusal kept until the next try. */
    const write = (key: string, rows: readonly McpRow[], ask: (row: McpRow) => Promise<unknown> | undefined): void => {
      put("refused", key, undefined, targetKey);
      put("busy", key, true, targetKey);
      void (async () => {
        try {
          for (const row of rows) await ask(row);
        } catch (e) {
          put("refused", key, errorText(e), targetKey);
        } finally {
          put("busy", key, undefined, targetKey);
        }
      })();
    };
    return {
      add: (ask, project) => api.serversAdd!(rowTarget(at, project), ask),
      remove: (key, rows) => write(key, rows, row => api.serversRemove?.(rowTarget(at, row.project), askOf(row))),
      toggle: (key, rows, on) => write(key, rows, row => api.serversToggle?.(rowTarget(at, row.project), askOf(row), on)),
      busyOf: key => shown.busy[key] === true,
      refusedOf: key => shown.refused[key],
    };
  }, [api, put, shown, targetKey]);
}
