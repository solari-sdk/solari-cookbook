// SPDX-License-Identifier: AGPL-3.0-only
// The init job's answering as every client of it in the app walks it: the
// screen the host's step stands on, the draft of what that screen has ticked
// and typed, kept on the host as it changes, the image estimate against the
// disk, Continue with its disk check and the typed keys saved first, Back,
// Start over, and the build with the first launch's answer handed over. Every
// Image card's recipe reads this, so a step walked on one computer's card
// reads the same on another's.
import { useCallback, useEffect, useRef, useState } from "react";
import { initDiskOverLine, initImageBytes, wspToolsRowId, type InitAgent, type InitDraft, type InitJob, type InitRoad, type InitScreen } from "@wsp/protocol";
import { errorText } from "../../lib/utils.js";
import { useStore } from "../../protocol/store.js";
import { draftOf, type Draft } from "./RecipeScreen.js";

/** The screen the first launch already answered on this computer, left out of the app's setup. */
const FIRST_LAUNCH_SCREEN = "wsp";

/** What the host kept of a step the person left mid-answer, if anything. */
export const keptAt = (job: InitJob, at: string): InitDraft | undefined => job.drafts?.find(d => d.at === at);

/** Where the job's step stands among the screens the app walks, which are the host's less the one the first launch
 * answered: its index, and the screen there, absent once every shown screen is answered. */
export function recipeAt(job: InitJob): { shown: InitScreen[]; index: number; screen: InitScreen | undefined } {
  const shown = job.screens.filter(s => s.id !== FIRST_LAUNCH_SCREEN);
  const at = job.screens[job.step];
  const index = at === undefined || at.id === FIRST_LAUNCH_SCREEN ? shown.length : shown.findIndex(s => s.id === at.id);
  return { shown, index, screen: shown[index] };
}

/** `on` is the computer whose card walks the job, which a job it starts carries from its first view. */
export function useRecipeJob(on?: string) {
  const api = useStore(s => s.api);
  const saveKeys = useStore(s => s.saveKeys);
  const job = useStore(s => s.initJob);
  const [draft, setDraft] = useState<{ key: string; draft: Draft } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // A new job starts from what the host holds for it, never from the last job's unsent ticks.
  const jobId = job?.id;
  useEffect(() => setDraft(null), [jobId]);
  // What a step has and has not sent goes to the host as it changes, so a close loses nothing. A refused keep is
  // left alone: it costs the person nothing and the step's own Continue is what must be heard.
  const keep = useCallback(
    (at: string, next: Draft): void => {
      void api?.initDraft?.({ at, ticks: [...next.ticks], answers: next.answers }).catch(() => {});
    },
    [api],
  );
  // One press at a time: a second press while the first is still with the host sends nothing, read off a ref so
  // two clicks inside one frame cannot both pass.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const attempt = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      await work();
      return true;
    } catch (e) {
      setRefusal(errorText(e));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  /** A screen as the person has it: the unsent draft, else what the host kept of it, else what stands. */
  const draftAt = (screen: InitScreen): Draft => (draft !== null && draft.key === screen.id ? draft.draft : draftOf(screen, job === null ? undefined : keptAt(job, screen.id)));
  /** The image so far with this screen's draft in it, the protocol's one estimate, against the disk where there is one. */
  const imageAt = (screen: InitScreen, current: Draft): { used: number; total?: number } =>
    job === null ? { used: 0 } : { used: initImageBytes(job, { at: screen.id, ticks: current.ticks }), ...(job.disk !== undefined ? { total: job.disk.total } : {}) };
  /** A change on the screen: held here, and kept on the host unless only a typed key moved, since a key is never drafted
   * and a keystroke in one would push a whole view to every client watching the job. */
  const edit = (screen: InitScreen, current: Draft, next: Draft): void => {
    setDraft({ key: screen.id, draft: next });
    if (next.ticks !== current.ticks || next.answers !== current.answers) keep(screen.id, next);
  };
  /** Continue: refused over the disk; else the typed keys to the key store, the answer to the host, then `then`. */
  const answer = (screen: InitScreen, then?: () => Promise<unknown>): void => {
    const current = draftAt(screen);
    const image = imageAt(screen, current);
    const over = image.total !== undefined ? Math.max(0, image.used - image.total) : 0;
    if (over > 0) {
      setRefusal(initDiskOverLine(over));
      return;
    }
    void attempt(async () => {
      const typed = Object.fromEntries(Object.entries(current.keys).filter(([, v]) => v.trim() !== ""));
      if (Object.keys(typed).length > 0) await saveKeys({ rows: typed });
      await api!.initAnswer!({ screen: screen.id, ticks: [...current.ticks], answers: current.answers });
      setDraft(null);
      await then?.();
    });
  };
  /** Moves the host's step to the shown screen at `i`. */
  const stepTo = (i: number): void => {
    if (job === null) return;
    const target = recipeAt(job).shown[i];
    if (target !== undefined) void attempt(() => api!.initStep!({ at: job.screens.findIndex(s => s.id === target.id) }));
  };
  const startOver = (then: () => void): void =>
    void attempt(async () => {
      await api!.initCancel!();
      then();
    });
  /** Starts the job on the road picked, then `then` once the host has taken it. */
  const startRoad = (pick: { road: InitRoad; harness?: string }, then?: () => void): void => {
    if (api?.initStart === undefined) return;
    void attempt(async () => {
      await api.initStart!({ road: pick.road, ...(pick.harness !== undefined ? { harness: pick.harness } : {}), ...(on !== undefined ? { on } : {}) });
      then?.();
    });
  };
  /** Runs the agent that stopped without the recipe again, on the same harness. */
  const retryAgent = (): void => {
    const harness = job?.thread?.harness;
    if (harness !== undefined) startRoad({ road: "agent", harness });
  };
  /** Starts the build. The first launch's answer for the MCP rows rides with it: the agents here it configured. A
   * stop pressed on the way sends no build after it. */
  const build = async (agents: readonly InitAgent[], o: { on?: string }, stopped: () => boolean = () => false): Promise<void> => {
    const firstLaunch = job?.screens.find(s => s.id === FIRST_LAUNCH_SCREEN);
    if (firstLaunch !== undefined && !stopped()) await api!.initAnswer!({ screen: firstLaunch.id, ticks: agents.filter(a => a.configured).map(a => wspToolsRowId(a.id)).filter(id => firstLaunch.items.some(i => i.id === id)) });
    if (!stopped()) await api!.initBuild!(o);
  };
  return { api, job, draft, setDraft, refusal, setRefusal, busy, keep, attempt, draftAt, imageAt, edit, answer, stepTo, startOver, startRoad, retryAgent, build };
}
