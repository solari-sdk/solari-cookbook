// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { PLACE_CONNECTS, PLACE_INSTALL, PLACES_WORDS, REPORTED_WORD, ROW_LINE_MAX, START_DAEMON_WORD, absentComputer, absentRoad, awayMsOf, backUrl, linkedOver, daemonSilent, imageCopyStaysLine, lastKnown, ownDaemonDown, placeAddSheetWord, placeDialLine, placeDialRoad, placeNoDialLine, placeOwnedPaths, workspacePlace, workspaceState } from "../src/index.js";

describe("the one state of a computer that is not answering", () => {
  const now = Date.parse("2026-09-12T13:30:00.000Z");
  const reading = absentComputer("old-laptop", awayMsOf({ lastSeenAt: "2026-09-12T12:52:00.000Z" }, now));

  it("says the same thing in every slot that has to hold it", () => {
    expect(reading.word).toBe("Unreachable");
    // The table's slot stands beside three fact columns and holds one word; how long it has been is on the row's
    // title and in its detail's Answered row, which is where the figure already was.
    expect(reading.away).toBe("no answer");
    expect(reading.line).toBe("no answer 38 min, is it on?");
    expect(reading.said).toBe("old-laptop is not answering");
    expect(reading.will).toBe("it connects on its own when it is on");
    expect(reading.sentence).toBe("old-laptop is not answering; it connects on its own when it is on");
  });

  it("writes the row's line under the cap the row cuts at, so the half that says what to do is never the half that goes", () => {
    for (const ms of [0, 59 * 60_000, 23 * 3_600_000, 400 * 86_400_000, null]) {
      expect(absentComputer("old-laptop", ms).line.length).toBeLessThanOrEqual(ROW_LINE_MAX);
    }
  });

  it("says nothing about how long it has been when this host never heard from it", () => {
    expect(awayMsOf({}, now)).toBeNull();
    expect(absentComputer("old-laptop", null).away).toBe("no answer");
    expect(absentComputer("old-laptop", null).line).toBe("no answer, is it on?");
  });

  it("states the silence and asks, and never claims the computer is off, which this host cannot know", () => {
    // A computer that is on and simply not answering reads the same line, so the line may not diagnose: the host
    // knows the silence and that the computer dials in by itself, and nothing else.
    for (const ms of [0, 38 * 60_000, 23 * 3_600_000, null]) {
      const line = absentComputer("hetzner", ms).line;
      expect(line).not.toContain("turn it on");
      expect(line).not.toContain("switch");
      expect(line.startsWith("no answer")).toBe(true);
    }
  });

  it("names the computer a fork stands on, and nothing for a workspace that stands on no place", () => {
    expect(workspacePlace({ place: "p_oldlaptop" })).toBe("p_oldlaptop");
    expect(workspacePlace({})).toBeUndefined();
  });

  it("folds a computer that answers nothing into the state word every surface reads", () => {
    expect(workspaceState({ phase: "running", reach: "unreachable" })).toBe("unreachable");
  });
});

describe("the one state of this computer's own daemon while it is not running", () => {
  const reading = ownDaemonDown("this Mac");

  it("says the same thing in every slot that has to hold it, and the ticket's sentence where there is room", () => {
    expect(reading.said).toBe("this Mac's daemon is not running");
    expect(reading.sentence).toBe("this Mac's daemon is not running");
    expect(reading.word).toBe("No daemon");
    expect(reading.away).toBe("no daemon");
    expect(reading.line).toBe("daemon not running, start it");
  });

  it("never says Unreachable about the computer the app is drawn on", () => {
    for (const slot of [reading.word, reading.away, reading.line, reading.said, reading.sentence]) {
      expect(slot.toLowerCase()).not.toContain("unreachable");
    }
  });

  it("writes the row's line under the cap the row cuts at", () => {
    expect(reading.line.length).toBeLessThanOrEqual(ROW_LINE_MAX);
  });

  it("carries the button instead of a second sentence, since the host holds the process and can start another", () => {
    expect(reading.start).toBe(START_DAEMON_WORD);
    expect(reading.will).toBeUndefined();
    // A computer this host only waits for has no such road, and says what happens next instead.
    expect(absentComputer("old-laptop", null).start).toBeUndefined();
    expect(absentComputer("old-laptop", null).will).toBe("it connects on its own when it is on");
  });

  it("reads one daemon that is not running off either silence a probe of this computer can find", () => {
    expect(daemonSilent("unreachable")).toBe(true);
    expect(daemonSilent("no-daemon")).toBe(true);
    for (const answering of ["reachable", "slow", "napping", "gone", "unsupported", "zombie"] as const) expect(daemonSilent(answering)).toBe(false);
    expect(daemonSilent(null)).toBe(false);
    expect(daemonSilent(undefined)).toBe(false);
  });
});

describe("what this host knows about reaching a computer that is not answering", () => {
  const awayMs = 32 * 60_000;

  it("names the login it dials on the ssh road, dates the silence and puts the last refusal at the end", () => {
    const road = absentRoad({ name: "vps", road: { ssh: "root@65.21.4.12" }, awayMs, dialled: { answered: false, said: "ssh: connect to host 65.21.4.12 port 22: Connection refused" } });
    // The spec's row detail, one string: the address and the road it is.
    expect(road.address).toBe("root@65.21.4.12 over ssh");
    expect(road.answered).toBe("32 min ago");
    expect(road.refused).toBe("ssh: connect to host 65.21.4.12 port 22: Connection refused");
    expect(road.sentence).toBe("wsp logs in to vps at root@65.21.4.12 over ssh; it last answered 32 min ago. The last try said: ssh: connect to host 65.21.4.12 port 22: Connection refused");
  });

  it("names the address a computer that joined with a code dialled in from, since that is the only one there is", () => {
    const road = absentRoad({ name: "old-laptop", road: { from: "192.168.1.34" }, awayMs: 36 * 60_000 });
    expect(road.address).toBe("192.168.1.34 dials in");
    expect(road.refused).toBeNull();
    expect(road.sentence).toBe("wsp waits for old-laptop to dial in, last from 192.168.1.34; it last answered 36 min ago.");
  });

  it("says a box on the ssh dial-back dials back over ssh, and never that it dials in from this computer's loopback", () => {
    const road = absentRoad({ name: "spoo", road: { ssh: "root@spoo", from: "127.0.0.1", back: { boxPort: 4640 } }, awayMs });
    expect(road.address).toBe("root@spoo over ssh");
    expect(road.dialsBack).toBe("dials back over ssh (127.0.0.1:4640 on spoo)");
    expect(road.sentence).toBe("wsp logs in to spoo at root@spoo over ssh, and spoo dials back over ssh (127.0.0.1:4640 on spoo); it last answered 32 min ago.");
    const bare = absentRoad({ name: "spoo", road: { from: "127.0.0.1", back: { boxPort: 4640 } }, awayMs });
    expect(bare.address).toBeNull();
    expect(bare.sentence).toBe("spoo dials back over ssh (127.0.0.1:4640 on spoo); it last answered 32 min ago.");
    for (const said of [road.sentence, bare.sentence, road.address, bare.address]) expect(said ?? "").not.toContain("127.0.0.1 dials in");
    expect(bare.sentence).not.toContain("last from 127.0.0.1");
    expect(absentRoad({ name: "vps", road: { ssh: "root@65.21.4.12", from: "65.21.4.12" }, awayMs }).dialsBack).toBeNull();
  });

  it("names the road a link came in on off the address it dialled: over ssh for the forward on its own loopback", () => {
    const handed = ["http://192.168.1.20:4640", "https://h645d7f8a8d48cbd6.example"];
    expect(backUrl(4640)).toBe("http://127.0.0.1:4640");
    expect(linkedOver("http://127.0.0.1:4640", { boxPort: 4640 }, handed)).toBe("over ssh");
    expect(linkedOver("http://192.168.1.20:4640", undefined, handed)).toBe("at http://192.168.1.20:4640");
    expect(linkedOver("https://h645d7f8a8d48cbd6.example", { boxPort: 4640 }, handed)).toBe("at https://h645d7f8a8d48cbd6.example");
    // The box writes the address it dialled, so one this host never handed out is not said in this host's voice.
    expect(linkedOver("http://127.0.0.1:4720", { boxPort: 4640 }, handed)).toBeUndefined();
    expect(linkedOver("https://whatever-it-likes.example/" + "a".repeat(8000), undefined, handed)).toBeUndefined();
  });

  it("says so plainly on a computer this host has no address for and has never heard from", () => {
    const road = absentRoad({ name: "old-laptop", awayMs: null });
    expect(road.address).toBeNull();
    expect(road.answered).toBe("not since it joined");
    expect(road.sentence).toBe("wsp waits for old-laptop to dial in; it has not answered since it joined.");
  });

  it("keeps a refusal off the reading when the last dial answered", () => {
    expect(absentRoad({ name: "vps", awayMs, dialled: { answered: true, roundTripMs: 14 } }).refused).toBeNull();
  });

  it("marks a fact the computer has stopped answering for as the reading it is, never as one still coming", () => {
    expect(lastKnown("Debian 12", awayMs)).toBe("Debian 12, last seen 32 min ago");
    // Nothing to date it against leaves the fact as it stands rather than inventing a span.
    expect(lastKnown("Debian 12", null)).toBe("Debian 12");
    // A figure that grows while the computer is up is dated by the report it was read in, not by the silence: the
    // two spans differ by however long the link was held after that report.
    expect(lastKnown("4h 12m", 3 * 3_600_000, REPORTED_WORD)).toBe("4h 12m, reported 3 h ago");
  });
});

describe("what one dial of a computer answers", () => {
  it("reads a frame the link carried as the computer itself answering, with how long it took", () => {
    expect(placeDialLine({ name: "vps", linked: true, dialled: { answered: true, roundTripMs: 14 } })).toBe("vps answered in 14 ms.");
  });

  it("reads an ssh login that answered while the link is down as the computer being on and the agent not calling home", () => {
    const line = placeDialLine({ name: "vps", road: { ssh: "root@65.21.4.12" }, linked: false, dialled: { answered: true, roundTripMs: 412 } });
    expect(line).toBe("root@65.21.4.12 answered over ssh in 412 ms, so the computer is on; the agent on it is not dialling this host.");
  });

  it("hands back the road's own sentence when nothing answered, rather than a wsp-shaped one over it", () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    expect(placeDialLine({ name: "vps", road: { ssh: "root@65.21.4.12" }, linked: false, dialled: { answered: false, said } })).toBe(said);
  });

  it("says there is no road at all on a computer that joined by typing a code", () => {
    expect(placeNoDialLine("old-laptop")).toContain("joined by typing a code");
  });

  it("reads the road a dial would take, and none at all where the only thing left is to switch the computer on", () => {
    // Holding its link: the frame rides the link, whatever else the row carries.
    expect(placeDialRoad({ present: true })).toBe("link");
    expect(placeDialRoad({ present: true, road: { ssh: "root@65.21.4.12" } })).toBe("link");
    // Down, and installed over ssh: the login is the road, and the button says so rather than saying try now.
    expect(placeDialRoad({ present: false, road: { ssh: "root@65.21.4.12" } })).toBe("ssh");
    // Joined by typing a code: an address it dialled in from is no road back to it, and neither is an empty login.
    expect(placeDialRoad({ present: false, road: { from: "192.168.1.34" } })).toBeUndefined();
    expect(placeDialRoad({ present: false, road: { ssh: "" } })).toBeUndefined();
    expect(placeDialRoad({})).toBeUndefined();
  });
});

describe("what the two screens say wsp puts on a computer", () => {
  it("writes the ssh road's install lines from the one list, folder, weight and whose service it is included", () => {
    expect(placeAddSheetWord("wsp", "running")).toBe("installing wsp under ~/.wsp");
    expect(PLACE_INSTALL.weight).toBe("about 40 MB");
    expect(placeAddSheetWord("service", "running")).toBe("starting the agent as a user service");
  });

  it("calls the command beside wsp's files what it does, on the way in and on the way out, and never a shim", () => {
    expect(PLACE_INSTALL.taken.opener).toContain("opens sign-in pages in your browser");
    for (const said of [PLACES_WORDS.remove.leaveTakes, PLACE_INSTALL.taken.opener, PLACE_INSTALL.openerLine, placeAddSheetWord("wsp", "running"), placeAddSheetWord("service", "running")]) {
      expect(said).not.toContain("shim");
    }
  });

  it("writes what Remove takes off from the same list, so neither screen can hold a word the other lost", () => {
    // Every one of the three, in the sentence, off the list rather than spelled again beside it.
    for (const said of Object.values(PLACE_INSTALL.taken)) expect(PLACES_WORDS.remove.leaveTakes).toContain(said);
    expect(PLACES_WORDS.remove.leaveTakes).toBe(
      `It takes off ${PLACE_INSTALL.taken.service}, ${PLACE_INSTALL.taken.files}, and ${PLACE_INSTALL.taken.opener}. Your work folder stays, and ${imageCopyStaysLine()}.`,
    );
  });

  it("tells a person the copy of their image stays where it is when wsp comes off", () => {
    // placeOwnedPaths is what a sweep walks, at the terminal and over the link alike, and the workspace store the
    // copy sits in is not on it.
    expect(placeOwnedPaths("/home/maya").some(path => path.includes("var/lib"))).toBe(false);
    expect(PLACES_WORDS.remove.leaveTakes).toContain(imageCopyStaysLine());
    expect(PLACES_WORDS.remove.leaveTakes).not.toContain("Docker");
  });
});

describe("what the sheet that adds a computer says about reaching it and about a closed lid", () => {
  it("says how a computer that is not on this network reaches this Mac, in the clause both roads say it in", () => {
    // The spec's own header sentence, carried on to the half a box in somebody else's rack needs: a sentence that
    // stopped at the network told that person wsp was not for them. The sign-in is named in the words the Account
    // row names it by, and no road between is given a noun.
    expect(PLACE_CONNECTS).toBe("connects to this Mac over your network, or from outside it once you sign in");
    expect(PLACES_WORDS.sheet.description).toBe(
      "A computer you own runs workspaces for your wsp. It connects to this Mac over your network, or from outside it once you sign in. You open nothing on it.",
    );
    // Connects, never dials: a first-time person does not know what dialling a Mac is.
    for (const said of [PLACES_WORDS.sheet.description, PLACES_WORDS.sheet.whileAsleep]) expect(said).not.toMatch(/dial/i);
  });

  it("answers what a closed lid does to work already running there, which is the whole reason for a second computer", () => {
    expect(PLACES_WORDS.sheet.whileAsleep).toBe("Threads there keep running while this Mac sleeps; new ones start when it wakes.");
  });
});
