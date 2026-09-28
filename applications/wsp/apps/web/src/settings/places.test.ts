// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, JOINED_COMPUTER, PLACE_BLOCKED_WORD, absentComputer, placeDaemonBehind, type PlaceProvision, type PlaceView, type SealedImageCopy, type WorkspaceView } from "@wsp/protocol";
import { copyOn } from "./image.js";
import { NOTHING_HELD, PLACE_KIND_WORDS, PROJECT_PICK_WORDS, copiesWord, outcomeWord, placeName, placeOf, placeStateWord, placeWorkspaceCounts, removeSentence, removeTitle, whereSegments } from "./places.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const here: PlaceView = { id: "here", kind: "computer", name: "This Mac", default: false, shape: { cpu: 8, memMb: 16 * 1024 }, diskFreeBytes: 210 * 1024 ** 3, engine: "none", present: true, takesForks: false };
const hetzner: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "hetzner",
  default: true,
  shape: { cpu: 2, memMb: 4 * 1024 },
  diskFreeBytes: 38 * 1024 ** 3,
  engine: "docker",
  present: true,
  takesForks: true,
  joinedAt: ago(60 * 60 * 1000),
  lastSeenAt: ago(3_000),
};
const laptop: PlaceView = { ...hetzner, id: "p_2", name: "old-macbook", default: false, shape: { cpu: 4, memMb: 8 * 1024 }, diskFreeBytes: 91 * 1024 ** 3, engine: "none", present: false, lastSeenAt: ago(2 * 60 * 60 * 1000) };
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, shape: { cpu: 2, memMb: 4 * 1024 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018, takesForks: true };

describe("what the section computes beyond the table's own cells", () => {
  it("reads a provider row under the name a person knows it by", () => {
    expect(placeName(ascii)).toBe("Box by ASCII");
    expect(placeName(hetzner)).toBe("hetzner");
  });

  it("calls the computer the host runs on by what it is, not by its hostname", () => {
    expect(placeName({ ...here, name: "zingzys-macbook-pro.local" }, true)).toBe("This Mac");
    expect(placeName({ ...here, name: "zingzys-macbook-pro.local" })).toBe("zingzys-macbook-pro.local");
  });
});

describe("the remove sentence", () => {
  it("names what comes off a computer that holds workspaces, and what leaves this Mac", () => {
    expect(removeTitle(hetzner)).toBe("Remove hetzner?");
    expect(removeSentence(hetzner, { workspaces: [{ name: "spoo-fix", state: "Running", threads: 2 }] }, 4.2 * 1024 ** 3)).toBe(
      "wsp and its task come off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is. The task's record and 2 threads leave this Mac.",
    );
  });

  it("says workspaces and records in the plural above one", () => {
    expect(removeSentence(hetzner, { workspaces: [{ name: "a", state: "Running", threads: 2 }, { name: "b", state: "Running", threads: 1 }] }, 4.2 * 1024 ** 3)).toBe(
      "wsp and its 2 tasks come off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is. The tasks' records and 3 threads leave this Mac.",
    );
  });

  it("drops the second sentence for a computer that holds none", () => {
    expect(removeSentence(hetzner, NOTHING_HELD, 4.2 * 1024 ** 3)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is.");
  });

  it("leaves the size out where nothing has measured the image", () => {
    expect(removeSentence(hetzner, NOTHING_HELD)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image stays where it is.");
  });

  it("says what becomes of the copy of the image, since every computer that joined runs workspaces and holds one", () => {
    // What Remove promises about four gigabytes of somebody's disk is what the sweep does: it walks wsp's own
    // folder and the unit, and never the store the copy sits in, so the copy stays.
    expect(removeSentence(hetzner, NOTHING_HELD, 4.2 * 1024 ** 3)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is.");
  });

  it("says a provider's workspaces are deleted there and its key forgotten here", () => {
    expect(removeSentence(ascii, { workspaces: [{ name: "api", state: "Running", threads: 3 }, { name: "web", state: "Running", threads: 2 }] })).toBe(
      "Its 2 tasks are deleted at Box by ASCII and the key is forgotten on this Mac. Their records and 5 threads leave this Mac.",
    );
  });

  it("adds when an offline computer is swept", () => {
    expect(removeSentence(laptop, NOTHING_HELD)).toBe(
      "wsp comes off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. It is offline; what is on it is swept the next time it connects.",
    );
  });
});

describe("the rows the New workspace dialog offers, and what each says", () => {
  const copy = (place: string, version: number): SealedImageCopy => ({ place, version, snapshotId: `snap_${place}`, builtAt: ago(60_000) });

  it("offers every computer and provider that takes a workspace, never the computer the app runs on", () => {
    // This computer runs Docker here: it can hold copies of the image, and it is still never somewhere to put
    // another workspace, since its local mode is already the one it can be.
    expect(whereSegments([{ ...here, engine: "docker" }, hetzner, laptop, ascii]).map(p => p.id)).toEqual(["p_1", "p_2", "box"]);
  });

  it("offers nothing at all where this computer is the only row there is", () => {
    expect(whereSegments([{ ...here, engine: "docker" }])).toEqual([]);
  });

  it("says there is no project to make a workspace of yet, and the line that records one", () => {
    expect(PROJECT_PICK_WORDS.noneYet).toBe("No projects yet, and a task is a copy of one.");
    expect(PROJECT_PICK_WORDS.addOne).toBe("Record one with wsp add <folder> here, or wsp add <url> --on <computer> there.");
  });

  it("reads a copy by the word it names its place with, the id or the name alike", () => {
    expect(copyOn([copy("p_1", 2)], hetzner)?.version).toBe(2);
    expect(copyOn([copy("hetzner", 2)], hetzner)?.version).toBe(2);
    expect(copyOn([copy("old-macbook", 2)], hetzner)).toBeUndefined();
  });
});

describe("which row a workspace stands on", () => {
  const on = (id: string, kind: WorkspaceView["kind"], machineId: string, place?: string): WorkspaceView => ({
    id,
    name: id,
    kind,
    machineId,
    phase: "running",
    golden: "",
    createdAt: ago(0),
    project: { id: "pr_1", name: "api", path: "/root/api", computer: place ?? "default" },
    ...(place === undefined ? {} : { place }),
  });

  it("puts a fork on a joined computer on that computer's row", () => {
    expect(placeOf([here, hetzner, ascii], on("ws_a", "cloud", "ctr_1", "p_1"))?.id).toBe("p_1");
  });

  it("puts what runs here on the first row, and a fork at the provider", () => {
    expect(placeOf([here, hetzner, ascii], on("ws_b", "local", "local"))?.id).toBe("here");
    expect(placeOf([here, hetzner, ascii], on("ws_c", "cloud", "fk_1"))?.id).toBe("box");
  });

  it("places nothing where the list holds no row for it", () => {
    expect(placeOf([here], on("ws_d", "cloud", "fk_1"))).toBeUndefined();
    expect(placeOf([here, ascii], on("ws_e", "cloud", "ctr_1", "p_gone"))).toBeUndefined();
  });

  it("counts what stands on each row off the workspace list: this computer's own, the forks at a provider, the forks on a joined computer", () => {
    const places = [here, hetzner, ascii];
    const workspaces = [on("ws_a", "local", "local"), on("ws_b", "cloud", "fk_1"), on("ws_c", "cloud", "fk_2"), on("ws_d", "cloud", "ctr_1", "p_1")];
    expect(placeWorkspaceCounts(places, workspaces)).toEqual({ here: 1, box: 2, p_1: 1 });
  });

  it("leaves a row nothing stands on out, and counts nothing for a workspace no row holds", () => {
    expect(placeWorkspaceCounts([here, hetzner], [on("ws_a", "local", "local")])).toEqual({ here: 1 });
    expect(placeWorkspaceCounts([here], [on("ws_b", "cloud", "ctr_1", "p_gone")])).toEqual({});
  });
});

describe("the one word the slot beside a row's name carries", () => {
  it("says a computer runs an older daemon than this wsp deploys, in the protocol's own word", () => {
    const behind = { ...hetzner, daemonVersion: DAEMON_VERSION - 5 };
    expect(placeStateWord(behind, null)).toBe(`daemon ${DAEMON_VERSION - 5}, host ${DAEMON_VERSION}`);
    // The same word wsp places prints in its BEHIND column, read off the protocol by both.
    expect(placeStateWord(behind, null)).toBe(placeDaemonBehind(behind));
  });

  it("says a computer that is not answering first, since nothing can be put on a computer that is off", () => {
    const away = absentComputer("hetzner", 32 * 60 * 1000);
    expect(placeStateWord({ ...hetzner, daemonVersion: DAEMON_VERSION - 5, present: false }, away)).toBe(away.away);
  });

  it("says a computer that cannot run workspaces can't run threads first, before not answering and before behind", () => {
    const blocked = { ...hetzner, daemonVersion: DAEMON_VERSION - 5, blocked: "hetzner cannot run wsp workspaces: it mounts cgroup v1 at /sys/fs/cgroup" };
    expect(placeStateWord(blocked, null)).toBe(PLACE_BLOCKED_WORD);
    const away = absentComputer("hetzner", 32 * 60 * 1000);
    expect(placeStateWord({ ...blocked, present: false }, away)).toBe(PLACE_BLOCKED_WORD);
  });

  it("says nothing of a computer that is answering on this wsp's own daemon, or one that has never reported", () => {
    expect(placeStateWord({ ...hetzner, daemonVersion: DAEMON_VERSION }, null)).toBe("");
    expect(placeStateWord(hetzner, null)).toBe("");
    expect(placeStateWord(ascii, null)).toBe("");
  });
});

describe("the word for a row's kind", () => {
  it("names a cloud row cloud where a row's kind is read in a sentence, and a computer of the person's own by what it is", () => {
    expect(PLACE_KIND_WORDS.provider).toBe("cloud");
    expect(PLACE_KIND_WORDS.computer).toBe(JOINED_COMPUTER);
  });

  it("says how a computer makes a copy in the word it reported, and says so when it makes none", () => {
    expect(copiesWord({ ...hetzner, copies: "reflink" }, false)).toBe("reflink");
    expect(copiesWord({ ...hetzner, copies: "snapshot" }, false)).toBe("snapshot");
    // A computer that has not said carries no word rather than a guess, and neither does the computer the app runs
    // on, whose own row says what its copies share instead.
    expect(copiesWord(hetzner, false)).toBe("");
    expect(copiesWord(here, true)).toBe("");
    expect(copiesWord({ ...hetzner, takesForks: false }, false)).toBe("copies nothing");
  });

  it("shows a present row's own note, which is where a tool answered from outside the directories its road links into", () => {
    const note = "node answers from /usr/bin/node, outside where its own installer puts it (/usr/local/bin)";
    expect(outcomeWord({ id: "tools/brew/node", label: "node", outcome: "present", note })).toBe(`already there: ${note}`);
    // A present row with nothing to add is the word alone, and an installed row's note is the road's own: the row
    // already says it installed, so the landing's "already on the machine" never reaches a line here.
    expect(outcomeWord({ id: "tools/brew/gh", label: "gh", outcome: "present" })).toBe("already there");
    expect(outcomeWord({ id: "tools/brew/gh", label: "gh", outcome: "installed", note: "already on the machine" })).toBe("installed");
  });

  it("reads the recipe's word in the state slot after the computer's silence and before the daemon behind", () => {
    const running: PlaceProvision = { state: "running", addId: "a_1", recipeAt: "x", startedAt: "x", rows: [], at: { label: "uv", index: 3, of: 7 } };
    const behind = { ...hetzner, daemonVersion: 1 };
    expect(placeStateWord({ ...hetzner, provision: running }, null)).toBe("setting up 3/7: uv");
    // A computer that is not answering says that first: nothing can be put on a computer that is off.
    expect(placeStateWord({ ...laptop, provision: running }, absentComputer("old-macbook", null))).toBe("no answer");
    // With no job on it, the slot reads what it always did.
    expect(placeStateWord(behind, null)).toBe(placeDaemonBehind(behind));
    expect(placeStateWord(hetzner, null)).toBe("");
  });
});
