// SPDX-License-Identifier: AGPL-3.0-only
// The wire and the words for a workspace that is a copy of a project folder:
// the two capability flags a computer declares about copies, the cell a row
// says about shared ports, the road word, and the two path rules a copy's
// folder is named by.
import { describe, expect, it } from "vitest";
import {
  Capabilities,
  CopyAsk,
  CopyReport,
  ProjectCopy,
  WorkspaceView,
  copyPathFor,
  CopyRoad,
  CopyVerbRoad,
  COPY_WORD,
  folderSlug,
  IN_PLACE_ROAD,
  inPlaceRecordLine,
  madeOfWord,
  portsWord,
  thisComputer,
} from "../src/index.js";

/** A computer that copies and shares its ports, which is what this Mac is. */
const here = { copies: true, ownNetwork: false } as const;

const flags = {
  liveCloneForks: false,
  replacesMachine: false,
  previewUrls: false,
  signedUrls: false,
  callbackRelay: false,
  diskSnapshots: false,
  images: false,
  snapshotsAnyLife: false,
  snapshotListing: false,
  templates: false,
  sizes: [],
  kept: true,
  copies: true,
  ownNetwork: false,
};

const report = {
  road: "clonefile",
  path: "/Users/dev/repo-pricing-page",
  base: "1".repeat(40),
  branch: "main",
  fetched: true,
  carried: "deps-and-config",
  excluded: [".next"],
  bytes: 6_400_000_000,
  ms: 4900,
};

describe("the two flags a computer declares about copies", () => {
  it("are both required, so a backend that declares neither is refused rather than read as false", () => {
    expect(Capabilities.safeParse(flags).success).toBe(true);
    const { copies, ...withoutCopies } = flags;
    expect(copies).toBe(true);
    expect(Capabilities.safeParse(withoutCopies).success).toBe(false);
    const { ownNetwork, ...withoutNetwork } = flags;
    expect(ownNetwork).toBe(false);
    expect(Capabilities.safeParse(withoutNetwork).success).toBe(false);
  });
});

describe("what a row says about a copy's network", () => {
  it("is its own network, the computer's ports with the copy's port base, or those ports alone, and nothing where the computer copies nothing", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(portsWord({ copies: false, ownNetwork: true }, undefined, platform)).toBe("own network");
      expect(portsWord(here, 3100, platform)).toBe(`shares ${thisComputer(platform)}'s ports, PORT 3100`);
      expect(portsWord(here, undefined, platform)).toBe(`shares ${thisComputer(platform)}'s ports`);
      expect(portsWord({ copies: false, ownNetwork: false }, undefined, platform)).toBe("");
    }
  });

  it("gives a copy with its own network that word whatever road made it, since the ports inside one are its own", () => {
    expect(portsWord({ copies: true, ownNetwork: true }, 3100, "darwin")).toBe("own network");
  });
});

describe("what a row says a workspace is made of", () => {
  it("is a copy for both roads, the one word the first-run screen reads before any road is taken", () => {
    expect(madeOfWord("clonefile")).toBe("a copy");
    expect(madeOfWord("worktree")).toBe("a copy");
    expect(COPY_WORD).toBe("a copy");
  });

  it("has no road for a folder worked in place: a record does not parse the word, the verb's report still does, and the boot sentence names the record", () => {
    expect(CopyRoad.options).toEqual(["clonefile", "worktree"]);
    expect(CopyRoad.safeParse(IN_PLACE_ROAD).success).toBe(false);
    expect(ProjectCopy.safeParse({ road: IN_PLACE_ROAD, path: "/Users/dev/repo", source: "/Users/dev/repo", base: "", branch: "", carried: "nothing" }).success).toBe(false);
    // The daemon's copy verb keeps the word on its wire, so the contract with a daemon already out there stands.
    expect(CopyVerbRoad.parse(IN_PLACE_ROAD)).toBe("in-place");
    expect(CopyReport.safeParse({ ...report, road: IN_PLACE_ROAD }).success).toBe(true);
    expect(inPlaceRecordLine("ws_1a2b3c4d", "/Users/dev/repo")).toBe(
      'workspace ws_1a2b3c4d was recorded as /Users/dev/repo worked in place, and every workspace here is a copy now: it is not served, wsp new "<what you are working on>" makes a copy of the project, and the record goes when the state file is moved aside',
    );
  });
});

describe("what the copy verb is asked for and what it answers", () => {
  it("takes the report the verb prints, with the reason a road was passed over as the one optional field", () => {
    expect(CopyReport.parse(report).fellBack).toBeUndefined();
    expect(CopyReport.parse({ ...report, fellBack: "the folder is 21.0 GB and a clone above 20.0 GB is not taken" }).fellBack).toContain("20.0 GB");
    // A road nothing here has, and a size that is not a whole count of bytes, are both refused.
    expect(CopyReport.safeParse({ ...report, road: "rsync" }).success).toBe(false);
    expect(CopyReport.safeParse({ ...report, bytes: 1.5 }).success).toBe(false);
    expect(CopyReport.safeParse({ ...report, carried: "everything" }).success).toBe(false);
  });

  it("carries the exclusions and the size line on the ask, and leaves the road to the verb when nobody named one", () => {
    const ask = CopyAsk.parse({ from: "/a", to: "/b", exclude: [".next"], sizeLineBytes: 1024 });
    expect(ask.road).toBeUndefined();
    expect(ask.base).toBeUndefined();
    expect(CopyAsk.safeParse({ from: "/a", to: "/b", sizeLineBytes: 1024 }).success).toBe(false);
  });

  it("is kept on the record as the road, the path, what it stands on and the folder it came from", () => {
    const copy = ProjectCopy.parse({ ...report, source: "/Users/dev/repo" });
    expect(copy).toEqual({
      road: "clonefile",
      path: "/Users/dev/repo-pricing-page",
      base: "1".repeat(40),
      branch: "main",
      carried: "deps-and-config",
      source: "/Users/dev/repo",
    });
    // What the verb measured is the verb's; the record keeps what a row and a delete need.
    expect("ms" in copy).toBe(false);
    expect("bytes" in copy).toBe(false);
  });

  it("rides the workspace's own view beside the port its apps bind", () => {
    const view = WorkspaceView.parse({
      id: "ws_1",
      name: "pricing page",
      machineId: "local",
      phase: "running",
      kind: "local",
      golden: "",
      createdAt: "2026-09-17T00:00:00.000Z",
      project: { id: "pr_1", name: "repo", path: "/Users/dev/repo", computer: "here" },
      copy: ProjectCopy.parse({ ...report, source: "/Users/dev/repo" }),
      portBase: 3100,
    });
    expect(view.copy?.road).toBe("clonefile");
    expect(view.portBase).toBe(3100);
    // A port base is a port, so nothing under one parses.
    expect(WorkspaceView.safeParse({ ...view, portBase: 0 }).success).toBe(false);
  });
});

describe("where a copy's folder lands and what it is called", () => {
  it("is a sibling of the folder under the work's own name", () => {
    expect(copyPathFor("/Users/dev/spoo-landing", "pricing-page")).toBe("/Users/dev/spoo-landing-pricing-page");
    expect(copyPathFor("/Users/dev/spoo-landing/", "qr-codes")).toBe("/Users/dev/spoo-landing-qr-codes");
  });

  it("turns a piece of work's name into a folder name and never into nothing", () => {
    expect(folderSlug("pricing page copy")).toBe("pricing-page-copy");
    expect(folderSlug("  QR codes: round 2!  ")).toBe("qr-codes-round-2");
    expect(folderSlug("...")).toBe("work");
    expect(folderSlug("")).toBe("work");
    // Cut short enough to stay typeable, and never left ending in a dash.
    const long = folderSlug("a".repeat(60));
    expect(long).toHaveLength(40);
    expect(folderSlug(`${"b".repeat(39)} tail`)).toBe("b".repeat(39));
  });
});
