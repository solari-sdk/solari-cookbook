// SPDX-License-Identifier: AGPL-3.0-only
// The skills road of one target: each skill's SKILL.md read for its preview
// when its detail opens, skills.sh searched and a skill read off it for its
// preview before install, both by the host, and the installs, turns and
// removes, each keyed by what it acts on. A write's answer is the report
// read again when the host says the agents there changed, so only what runs
// and why the host refused is kept here. A new target starts from nothing,
// and an answer that lands after the target changed is dropped.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsTarget, SkillRow } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { errorText } from "../../lib/utils.js";
import { rowTarget, skillKey, type DocState, type SkillActs, type SkillPicks, type SkillSearch } from "./agentsRows.js";

interface Held {
  readonly targetKey: string | null;
  readonly previews: Readonly<Record<string, DocState>>;
  readonly remote: Readonly<Record<string, DocState>>;
  readonly searches: Readonly<Record<string, SkillSearch>>;
  readonly picks: Readonly<Record<string, SkillPicks>>;
  readonly busy: Readonly<Record<string, true>>;
  readonly refused: Readonly<Record<string, string>>;
}

type Part = "previews" | "remote" | "searches" | "picks" | "busy" | "refused";

const fresh = (targetKey: string | null): Held => ({ targetKey, previews: {}, remote: {}, searches: {}, picks: {}, busy: {}, refused: {} });

export function useSkillActs(target: AgentsTarget | null): SkillActs | undefined {
  const api = useStore(s => s.api);
  const targetKey = target === null ? null : JSON.stringify(target);
  const [held, setHeld] = useState<Held>(() => fresh(targetKey));
  const current = useRef(targetKey);
  useEffect(() => {
    current.current = targetKey;
  }, [targetKey]);
  const shown = held.targetKey === targetKey ? held : fresh(targetKey);
  // What was already asked of which target, read synchronously so a second render asks nothing twice.
  const asked = useRef(new Set<string>());

  const put = useCallback(
    <K extends Part>(part: K, key: string, value: Held[K][string] | undefined, forKey: string | null = targetKey): void =>
      setHeld(h => {
        if (current.current !== forKey) return h;
        const base = h.targetKey === forKey ? h : fresh(forKey);
        const next = { ...base[part] } as Record<string, unknown>;
        if (value === undefined) delete next[key];
        else next[key] = value;
        return { ...base, [part]: next };
      }),
    [targetKey],
  );

  const readable = api?.skillsPreview !== undefined && targetKey !== null;
  const acts = useMemo<SkillActs | undefined>(() => {
    if (!readable || api === null) return undefined;
    const at = JSON.parse(targetKey) as AgentsTarget;
    const once = (what: string, run: () => void): void => {
      const key = `${targetKey}\0${what}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      run();
    };
    /** One write: busy while it runs, its refusal kept until the next try. */
    const write = (key: string, run: () => Promise<unknown> | undefined): void => {
      const going = run();
      if (going === undefined) return;
      put("refused", key, undefined);
      put("busy", key, true);
      going.then(
        () => put("busy", key, undefined),
        (e: unknown) => {
          put("busy", key, undefined);
          put("refused", key, errorText(e));
        },
      );
    };
    return {
      previewOf: row => shown.previews[skillKey(row)],
      loadPreview: (row: SkillRow) =>
        once(`preview ${skillKey(row)}`, () => {
          const key = skillKey(row);
          put("previews", key, { reading: true });
          api.skillsPreview!(rowTarget(at, row.project), row.name, row.scope === "project").then(
            preview => put("previews", key, { reading: false, preview }),
            (e: unknown) => put("previews", key, { reading: false, error: errorText(e) }),
          );
        }),
      remoteOf: id => shown.remote[id],
      loadRemote: id =>
        once(`remote ${id}`, () => {
          if (api.skillsGet === undefined) return;
          put("remote", id, { reading: true });
          api.skillsGet(id).then(
            preview => put("remote", id, { reading: false, preview }),
            (e: unknown) => put("remote", id, { reading: false, error: errorText(e) }),
          );
        }),
      searchOf: q => shown.searches[q.trim()],
      search: q => {
        const query = q.trim();
        if (query === "" || api.skillsSearch === undefined) return;
        once(`search ${query}`, () => {
          put("searches", query, { reading: true });
          api.skillsSearch!(query).then(
            hits => put("searches", query, { reading: false, hits }),
            (e: unknown) => {
              // A refused search is asked again when the person types it again.
              asked.current.delete(`${targetKey}\0search ${query}`);
              put("searches", query, { reading: false, error: errorText(e) });
            },
          );
        });
      },
      picksOf: id => shown.picks[id],
      setPicks: (id, picks) => put("picks", id, picks),
      toggle: (row, on) => write(skillKey(row), () => api.skillsToggle?.(rowTarget(at, row.project), row.name, row.scope === "project", on)),
      remove: row => write(skillKey(row), () => api.skillsRemove?.(rowTarget(at, row.project), row.name, row.scope === "project")),
      add: (id, agents, project) => write(id, () => api.skillsAdd?.(rowTarget(at, project), id, agents, project !== undefined)),
      busyOf: key => shown.busy[key] === true,
      refusedOf: key => shown.refused[key],
    };
  }, [api, put, readable, shown, targetKey]);
  return acts;
}
