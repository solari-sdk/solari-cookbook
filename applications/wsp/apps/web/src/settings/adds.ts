// SPDX-License-Identifier: AGPL-3.0-only
// The adds over ssh as the host keeps them: read off places.list whenever the
// store binds, kept current by the steps that ride place.stage, and settled
// by an add's own answer in the window that asked. The sheet draws the job
// from here, so another page or a second window reads the same install; how a
// finished add ended stays on the form only in a window that watched it run,
// and the computer's row keeps the fact everywhere else.
import { create } from "zustand";
import { PLACE_LOGIN_REFUSED_KIND, withPlaceStage, type PlaceAddJob, type PlaceStageEvent } from "@wsp/protocol";
import type { Api, SshLogin } from "../protocol/client.js";
import { failureOf } from "../protocol/failure.js";
import { ADD_COMPUTER_WORDS } from "./format.js";

/** The ssh fields as the person typed them. */
export interface SshDraft {
  user: string;
  host: string;
  port: string;
}

interface AddsState {
  jobs: Record<string, PlaceAddJob>;
  /** The finished add the person put away with Add another: the form stands empty over it. */
  putAway: string | null;
  /** What this window typed and has not sent: never the host's, and no add from elsewhere writes it. */
  draft: SshDraft | null;
  /** The adds whose request from this window is still out: the host may not list one yet, and has not lost it. */
  asking: readonly string[];
  /** The adds this window heard a step of, so each was running while it watched. */
  heard: readonly string[];
  /** The host the jobs were last read off: a read from another replaces them rather than merging over them. */
  readOff: Api | null;
}

export const useAdds = create<AddsState>(() => ({ jobs: {}, putAway: null, draft: null, asking: [], heard: [], readOff: null }));

const put = (job: PlaceAddJob): void => useAdds.setState(s => ({ jobs: { ...s.jobs, [job.addId]: job } }));

/** The page's jobs after a read: the host's word on every add it lists, an add it no longer holds ended rather
 * than left running, and one that ended before this window saw it left to its computer's row. */
function readInto(s: AddsState, list: readonly PlaceAddJob[], fresh: boolean): Record<string, PlaceAddJob> {
  const listed = new Map(list.map(job => [job.addId, job]));
  const next: Record<string, PlaceAddJob> = {};
  for (const [addId, mine] of Object.entries(s.jobs)) {
    const theirs = listed.get(addId);
    // A read that left before an add ended never takes the end back.
    if (theirs !== undefined) next[addId] = theirs.state === "running" && mine.state !== "running" ? mine : theirs;
    else if (s.asking.includes(addId)) next[addId] = mine;
    else if (mine.state === "running") next[addId] = { ...mine, state: "failed", said: ADD_COMPUTER_WORDS.hostLost };
    else if (!fresh) next[addId] = mine;
  }
  for (const job of list) if (next[job.addId] === undefined && (job.state === "running" || s.heard.includes(job.addId))) next[job.addId] = job;
  return next;
}

/** Stamps every read asked, so only the newest lands: an older one may predate what asked for the newer. */
let newest = 0;

/** Takes the adds off a places.list already asked of that host. */
export function takeAdds(api: Api, asked: Promise<PlaceAddJob[]>): void {
  const stamp = ++newest;
  void asked.then(
    list => {
      if (stamp === newest) useAdds.setState(s => ({ jobs: readInto(s, list, s.readOff !== api), readOff: api }));
    },
    // The adds ride places.list, whose refusal the Computers page already draws and says.
    () => undefined,
  );
}

export function readAdds(api: Api): void {
  const asked = api.placesList?.();
  if (asked !== undefined) takeAdds(api, asked.then(read => read.adds));
}

/** One step onto its job. A stream this app has not seen is an add another window started, read off the host; a
 * failed step is read again for the fix and the kind its one-line note does not carry. */
export function applyAddStage(api: Api | null, e: PlaceStageEvent): void {
  if (e.step === "provision") return;
  if (!useAdds.getState().heard.includes(e.addId)) useAdds.setState(s => ({ heard: [...s.heard, e.addId] }));
  const job = useAdds.getState().jobs[e.addId];
  if (job !== undefined) put(withPlaceStage(job, e));
  if (api !== null && (job === undefined || e.state === "failed")) readAdds(api);
}

const mintAddId = (): string => `a_${[...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("")}`;

/** Asks the host to add a computer over ssh under a stream minted here, since its steps arrive before the answer. A
 * lost socket leaves the job running: the host goes on installing, and the read on reconnect says how it ended.
 * Asking clears the draft: what was typed is on the job now. */
export function addOverSsh(api: Api, login: SshLogin): void {
  if (api.addComputerOverSsh === undefined) return;
  const addId = mintAddId();
  useAdds.setState(s => ({
    jobs: { ...s.jobs, [addId]: { addId, address: login.address, ...(login.port === undefined ? {} : { sshPort: login.port }), startedAt: new Date().toISOString(), state: "running", steps: [] } },
    asking: [...s.asking, addId],
    draft: null,
  }));
  const settle = (next: (job: PlaceAddJob) => PlaceAddJob): void =>
    useAdds.setState(s => {
      const job = s.jobs[addId];
      return { asking: s.asking.filter(id => id !== addId), ...(job === undefined ? {} : { jobs: { ...s.jobs, [addId]: next(job) } }) };
    });
  api.addComputerOverSsh(login, addId).then(
    place => settle(job => ({ ...job, state: "done", placeId: place.id })),
    (e: unknown) => {
      const failure = failureOf(e);
      settle(job => (failure.disconnected ? job : { ...job, state: "failed", said: failure.said, ...(failure.fix === undefined ? {} : { fix: failure.fix }), ...(failure.kind === undefined ? {} : { kind: failure.kind }) }));
    },
  );
}

/** The fix under a failed add: the host's own, else the login fix for a login ssh refused, else none. */
export const addFix = (job: PlaceAddJob): string | undefined => job.fix ?? (job.kind === PLACE_LOGIN_REFUSED_KIND ? ADD_COMPUTER_WORDS.refusedFix : undefined);

/** The add the sheet draws: the one this app heard of last, unless the person put it away. Read by the order jobs
 * arrived in, not their stamps: an add asked here is stamped by this clock and one read off the host by its own. */
export function useShownAdd(): PlaceAddJob | undefined {
  return useAdds(s => {
    const newest = Object.values(s.jobs).at(-1);
    return newest?.addId === s.putAway ? undefined : newest;
  });
}
