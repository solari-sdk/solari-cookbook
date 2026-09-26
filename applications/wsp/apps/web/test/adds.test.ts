// SPDX-License-Identifier: AGPL-3.0-only
// The adds over ssh as the app keeps them: read off the host when the store
// binds, kept current by the steps that ride place.stage, and settled by the
// add's own answer, so the sheet draws the host's job wherever it is opened.
import { afterEach, describe, expect, it } from "vitest";
import { PLACE_LOGIN_REFUSED_KIND, type EventUnion, type PlaceAddJob, type PlaceView } from "@wsp/protocol";
import { DisconnectedError, RequestError, type Api, type SshLogin } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { addFix, addOverSsh, useAdds } from "../src/settings/adds.js";
import { ADD_COMPUTER_WORDS } from "../src/settings/format.js";
import { caps } from "./caps.js";
import { resetSettings, settingsApi, settle } from "./settings-harness.js";

const failed: PlaceAddJob = {
  addId: "a_spoo",
  address: "root@spoo",
  startedAt: "2026-09-25T09:00:00.000Z",
  state: "failed",
  steps: [
    { step: "connect", state: "done", note: "Ubuntu 24.04" },
    { step: "wsp", state: "failed", note: "spoo has no curl or wget on its PATH. Install one of them there, then add again." },
  ],
  said: "spoo has no curl or wget on its PATH.",
  fix: "Install one of them there, then add again.",
};

const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true };

/** A host the store can bind to, answering the adds it holds. */
function bound(over: Partial<Api>): { api: Api; push(e: EventUnion): void } {
  const fake = settingsApi({ listWorkspaces: async () => [], watchStatuses: async () => [], getGolden: async () => undefined, listSessions: async () => [], capabilities: async () => caps(), ...over } as Partial<Api>);
  useStore.getState().bind(fake.api);
  return fake;
}

afterEach(() => {
  resetSettings();
});

/** A places.list answer carrying these adds and no computers. */
const listing = (adds: PlaceAddJob[]) => ({ places: [], adds });

describe("the adds the app reads off the host", () => {
  it("takes the adds off the one places.list a bind reads, following one still running and leaving one that ended to its computer's row", async () => {
    const running: PlaceAddJob = { addId: "a_other", address: "maya@box", startedAt: "2026-09-25T09:01:00.000Z", state: "running", steps: [{ step: "connect", state: "running" }] };
    let asked = 0;
    bound({ placesList: async () => (asked++, listing([failed, running])) } as Partial<Api>);
    await settle();
    expect(asked).toBe(1);
    expect(Object.keys(useAdds.getState().jobs)).toEqual(["a_other"]);
  });

  it("follows an add another window started: its first step sends the app to the host for the job, and later steps land on it", async () => {
    const running: PlaceAddJob = { addId: "a_other", address: "maya@box", startedAt: "2026-09-25T09:01:00.000Z", state: "running", steps: [{ step: "connect", state: "running" }] };
    let held: PlaceAddJob[] = [];
    let asked = 0;
    const { push } = bound({ placesList: async () => (asked++, listing(held)) } as Partial<Api>);
    await settle();
    held = [running];
    push({ type: "place.stage", addId: "a_other", step: "connect", state: "running" } as EventUnion);
    await settle();
    expect(asked).toBe(2);
    expect(useAdds.getState().jobs["a_other"]?.address).toBe("maya@box");
    push({ type: "place.stage", addId: "a_other", step: "connect", state: "done", note: "Debian 12" } as EventUnion);
    push({ type: "place.stage", addId: "a_other", step: "wsp", state: "running" } as EventUnion);
    expect(useAdds.getState().jobs["a_other"]?.steps).toEqual([{ step: "connect", state: "done", note: "Debian 12" }, { step: "wsp", state: "running" }]);
    // The recipe behind a join is the computer's row's to say: no read, no line.
    push({ type: "place.stage", addId: "a_nobody", step: "provision", state: "running", placeId: "p_9" } as EventUnion);
    await settle();
    expect(asked).toBe(2);
  });

  it("keeps the end of an add this window heard a step of, though it ended before the read came back", async () => {
    let held: PlaceAddJob[] = [];
    const { push } = bound({ placesList: async () => listing(held) } as Partial<Api>);
    await settle();
    held = [failed];
    push({ type: "place.stage", addId: "a_spoo", step: "connect", state: "running" } as EventUnion);
    await settle();
    expect(useAdds.getState().jobs["a_spoo"]).toEqual(failed);
  });

  it("reads the host's record again when a step fails, for the fix and the kind a step's note does not carry", async () => {
    const running: PlaceAddJob = { ...failed, state: "running", steps: [{ step: "wsp", state: "running" }], said: undefined, fix: undefined } as PlaceAddJob;
    let held: PlaceAddJob[] = [running];
    const { push } = bound({ placesList: async () => listing(held) } as Partial<Api>);
    await settle();
    held = [failed];
    push({ type: "place.stage", addId: "a_spoo", step: "wsp", state: "failed", note: failed.steps[1]!.note } as EventUnion);
    expect(useAdds.getState().jobs["a_spoo"]?.state).toBe("failed");
    await settle();
    expect(useAdds.getState().jobs["a_spoo"]).toMatchObject({ said: failed.said, fix: failed.fix });
  });

  it("never lets an older read land over a newer one, nor a read take an add's end back", async () => {
    const answers: ((list: ReturnType<typeof listing>) => void)[] = [];
    const running: PlaceAddJob = { ...failed, state: "running", steps: [{ step: "wsp", state: "running" }], said: undefined, fix: undefined } as PlaceAddJob;
    const { push } = bound({ placesList: () => new Promise(ok => answers.push(ok)) } as Partial<Api>);
    await settle();
    expect(answers).toHaveLength(1);
    useAdds.setState({ jobs: { a_spoo: running } });
    push({ type: "place.stage", addId: "a_spoo", step: "wsp", state: "failed", note: failed.steps[1]!.note } as EventUnion);
    expect(answers).toHaveLength(2);
    answers[1]!(listing([failed]));
    await settle();
    expect(useAdds.getState().jobs["a_spoo"]).toEqual(failed);
    answers[0]!(listing([running]));
    await settle();
    expect(useAdds.getState().jobs["a_spoo"]).toEqual(failed);
    push({ type: "place.stage", addId: "a_spoo", step: "wsp", state: "failed", note: failed.steps[1]!.note } as EventUnion);
    answers[2]!(listing([running]));
    await settle();
    expect(useAdds.getState().jobs["a_spoo"]?.state).toBe("failed");
  });

  it("says nothing of its own when the host refuses the read: the places list is the same op, and its refusal is drawn", async () => {
    bound({ placesList: async () => Promise.reject(new RequestError("wsp could not read its places")) } as Partial<Api>);
    await settle();
    expect(useAdds.getState().jobs).toEqual({});
  });

  it("ends an add the host no longer holds as failed, with a sentence, once this window's own request for it is no longer out", async () => {
    let refuse: (e: Error) => void = () => {};
    let held: PlaceAddJob[] = [];
    const { api } = bound({ placesList: async () => listing(held), addComputerOverSsh: () => new Promise<PlaceView>((_ok, no) => (refuse = no)) } as Partial<Api>);
    await settle();
    addOverSsh(api, { address: "root@spoo" });
    const [addId] = Object.keys(useAdds.getState().jobs);
    // Asked and not yet kept by the host: a read that lists nothing leaves it running.
    useStore.getState().setConn("live");
    await settle();
    expect(useAdds.getState().jobs[addId!]?.state).toBe("running");
    refuse(new DisconnectedError("lost"));
    await settle();
    expect(useAdds.getState().jobs[addId!]?.state).toBe("running");
    useStore.getState().bind(settingsApi({ listWorkspaces: async () => [], watchStatuses: async () => [], getGolden: async () => undefined, listSessions: async () => [], capabilities: async () => caps(), placesList: async () => listing(held) } as Partial<Api>).api);
    await settle();
    expect(useAdds.getState().jobs[addId!]).toMatchObject({ state: "failed", said: ADD_COMPUTER_WORDS.hostLost });
    held = [];
  });

  it("replaces the jobs when a newly bound host answers, and never lands the old host's answer after it", async () => {
    let late: (list: ReturnType<typeof listing>) => void = () => {};
    const { api } = bound({ placesList: () => new Promise(ok => (late = ok)), addComputerOverSsh: async () => box } as Partial<Api>);
    addOverSsh(api, { address: "root@hetzner" });
    await settle();
    expect(Object.values(useAdds.getState().jobs).map(j => j.state)).toEqual(["done"]);
    let asked = 0;
    useStore.getState().bind(settingsApi({ listWorkspaces: async () => [], watchStatuses: async () => [], getGolden: async () => undefined, listSessions: async () => [], capabilities: async () => caps(), placesList: async () => (asked++, listing([])) } as Partial<Api>).api);
    await settle();
    expect(asked).toBe(1);
    expect(useAdds.getState().jobs).toEqual({});
    late(listing([{ addId: "a_old", address: "root@old", startedAt: "2026-09-25T09:00:00.000Z", state: "running", steps: [] }]));
    await settle();
    expect(useAdds.getState().jobs).toEqual({});
  });
});

describe("an add this window asks for", () => {
  it("stands as running under the stream it minted before the host answers, then done with the computer it made", async () => {
    let asked: [SshLogin, string] | undefined;
    let answer: (p: PlaceView) => void = () => {};
    const api = settingsApi({ addComputerOverSsh: (login: SshLogin, addId: string) => ((asked = [login, addId]), new Promise<PlaceView>(ok => (answer = ok))) } as Partial<Api>).api;
    addOverSsh(api, { address: "root@65.21.4.12", port: 2222 });
    const addId = asked![1];
    expect(asked![0]).toEqual({ address: "root@65.21.4.12", port: 2222 });
    expect(useAdds.getState().jobs[addId]).toMatchObject({ addId, address: "root@65.21.4.12", sshPort: 2222, state: "running", steps: [] });
    answer(box);
    await settle();
    expect(useAdds.getState().jobs[addId]).toMatchObject({ state: "done", placeId: "p_2" });
  });

  it("fails in the host's two halves on a refusal, and stays running on a lost socket for the next read to settle", async () => {
    let refuse: (e: Error) => void = () => {};
    const api = settingsApi({ addComputerOverSsh: () => new Promise<PlaceView>((_ok, no) => (refuse = no)) } as Partial<Api>).api;
    addOverSsh(api, { address: "root@spoo" });
    const [first] = Object.keys(useAdds.getState().jobs);
    refuse(Object.assign(new RequestError("spoo has no curl or wget on its PATH. Install one of them there, then add again."), { fix: "Install one of them there, then add again." }));
    await settle();
    expect(useAdds.getState().jobs[first!]).toMatchObject({ state: "failed", said: "spoo has no curl or wget on its PATH.", fix: "Install one of them there, then add again." });
    addOverSsh(api, { address: "root@spoo" });
    const second = Object.keys(useAdds.getState().jobs).find(id => id !== first)!;
    refuse(new DisconnectedError("lost"));
    await settle();
    expect(useAdds.getState().jobs[second]?.state).toBe("running");
  });

  it("gives the login fix only to a login the host refused, and the host's own fix over it", () => {
    expect(addFix({ ...failed, fix: undefined, kind: PLACE_LOGIN_REFUSED_KIND })).toBe(ADD_COMPUTER_WORDS.refusedFix);
    expect(addFix({ ...failed, fix: undefined })).toBeUndefined();
    expect(addFix({ ...failed, kind: PLACE_LOGIN_REFUSED_KIND })).toBe(failed.fix);
  });
});
