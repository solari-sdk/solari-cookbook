// SPDX-License-Identifier: AGPL-3.0-only
// The sign-ins and writes one list takes on its target: each row's sign-in
// as it stands, fed by the host's steps for a watched run, the paste for a
// token or key, and the line for the person's terminal; the wsp tools being
// written into an agent's config. A signed-in run leaves its row, since the
// report read again after it says so; a cancelled one stops on the host and
// leaves its row at once. A new target starts from nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentsSignInEvent, AgentsTarget } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import type { AgentActs, SignInFlow, SignInStart } from "./agentsRows.js";
import { agentRowId } from "./kinds/agents.js";

interface Running {
  readonly signInId?: string;
  readonly stop?: () => void;
  readonly off?: () => void;
}

const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useAgentActs(target: AgentsTarget | null): AgentActs | undefined {
  const api = useStore(s => s.api);
  const targetKey = target === null ? null : JSON.stringify(target);
  const [flows, setFlows] = useState<{ targetKey: string | null; of: Record<string, SignInFlow> }>({ targetKey, of: {} });
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const running = useRef(new Map<string, Running>());
  // The run each row's steps belong to: a step or a start answered for a run that was cancelled or replaced is dropped.
  const runs = useRef(new Map<string, object>());
  const current = useRef(targetKey);
  useEffect(() => {
    current.current = targetKey;
    setFlows(f => (f.targetKey === targetKey ? f : { targetKey, of: {} }));
    const held = running.current;
    return () => {
      for (const run of held.values()) run.stop?.();
      held.clear();
    };
  }, [targetKey]);
  const shown = flows.targetKey === targetKey ? flows.of : {};

  const put = useCallback(
    (rowId: string, next: ((was: SignInFlow | undefined) => SignInFlow) | undefined): void =>
      setFlows(f => {
        if (current.current !== targetKey) return f;
        const of: Record<string, SignInFlow> = { ...(f.targetKey === targetKey ? f.of : {}) };
        if (next === undefined) delete of[rowId];
        else of[rowId] = next(of[rowId]);
        return { targetKey, of };
      }),
    [targetKey],
  );

  const start = useCallback(
    (rowId: string, begin: SignInStart): void => {
      if (targetKey === null) return;
      if (begin.kind === "terminal") return;
      if (begin.kind === "copy") return put(rowId, () => ({ kind: "copy", line: begin.line, ...(begin.why !== undefined ? { why: begin.why } : {}) }));
      if (begin.kind === "vault") return put(rowId, () => ({ kind: "vault", agent: begin.agent, word: begin.word, ...(begin.mint !== undefined ? { mint: begin.mint } : {}) }));
      if (api?.agentsSignIn === undefined) return;
      running.current.get(rowId)?.stop?.();
      const run = {};
      runs.current.set(rowId, run);
      // What the flow reserves room for rides every step, so its height holds whatever state the host reports.
      const finish = { ...(begin.finish === undefined ? {} : { finish: begin.finish }), ...(begin.pastes === true ? { pastes: true } : {}) };
      put(rowId, () => ({ kind: "run", state: "running", ...finish }));
      const step = (e: AgentsSignInEvent): void => {
        if (runs.current.get(rowId) !== run) return;
        if (e.state === "signed-in") {
          running.current.get(rowId)?.off?.();
          running.current.delete(rowId);
          return put(rowId, undefined);
        }
        const state = e.state;
        if (state === "failed") {
          running.current.get(rowId)?.off?.();
          running.current.delete(rowId);
        }
        put(rowId, was => ({
          kind: "run",
          state,
          ...finish,
          ...(e.url !== undefined ? { url: e.url } : was?.kind === "run" && was.url !== undefined ? { url: was.url } : {}),
          ...(e.code !== undefined ? { code: e.code } : {}),
          ...(e.paste !== undefined ? { paste: e.paste } : was?.kind === "run" && was.paste !== undefined ? { paste: was.paste } : {}),
          ...(e.said !== undefined ? { said: e.said } : {}),
        }));
      };
      api.agentsSignIn(JSON.parse(targetKey) as AgentsTarget, begin.agent, begin.server, step).then(
        handle => {
          if (current.current !== targetKey || runs.current.get(rowId) !== run) return handle.stop();
          running.current.set(rowId, handle);
        },
        (e: unknown) => {
          if (runs.current.get(rowId) === run) put(rowId, () => ({ kind: "run", state: "failed", ...finish, said: said(e) }));
        },
      );
    },
    [api, targetKey, put],
  );

  const cancel = useCallback(
    (rowId: string): void => {
      runs.current.delete(rowId);
      running.current.get(rowId)?.stop?.();
      running.current.delete(rowId);
      put(rowId, undefined);
    },
    [put],
  );

  const code = useCallback(
    (rowId: string, typed: string): void => {
      const signInId = running.current.get(rowId)?.signInId;
      if (signInId === undefined || api?.agentsSignInCode === undefined) return;
      api.agentsSignInCode(signInId, typed).catch((e: unknown) => put(rowId, was => ({ ...(was?.kind === "run" ? was : { kind: "run" as const }), state: "failed", said: said(e) })));
    },
    [api, put],
  );

  const save = useCallback(
    (rowId: string, key: string): void => {
      const flow = shown[rowId];
      if (flow?.kind !== "vault" || api?.agentsKey === undefined) return;
      put(rowId, () => ({ ...flow, saving: true }));
      api.agentsKey(flow.agent, key).then(
        () => put(rowId, undefined),
        (e: unknown) => {
          const { saving: _saving, ...rest } = flow;
          put(rowId, () => ({ ...rest, refused: said(e) }));
        },
      );
    },
    [api, put, shown],
  );

  const addTools = useCallback(
    (agent: string): void => {
      if (targetKey === null || api?.agentsAddTools === undefined) return;
      setAdding(a => new Set([...a, agent]));
      const done = (): void => setAdding(a => new Set([...a].filter(x => x !== agent)));
      api.agentsAddTools(JSON.parse(targetKey) as AgentsTarget, agent).then(done, (e: unknown) => {
        done();
        put(agentRowId(agent), () => ({ kind: "run", state: "failed", said: said(e) }));
      });
    },
    [api, targetKey, put],
  );

  if (targetKey === null || api === null) return undefined;
  return { flowOf: rowId => shown[rowId], start, cancel, code, save, addTools, adding: agent => adding.has(agent) };
}
