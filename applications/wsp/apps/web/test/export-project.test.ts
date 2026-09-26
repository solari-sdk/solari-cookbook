// SPDX-License-Identifier: AGPL-3.0-only
// The export dialog's pure parts: which events belong to one export, the
// agent rows the workspace's threads give it and the request their ticks
// become, the destination a picked parent folder gives, the landed line, each
// agent's words, the refusal a caught error becomes with the tone the status
// line gives it, and what the one slot says out of a refusal, a landed line, a
// step and the idle words. The progress line is the protocol's, tested there.
import { describe, expect, it } from "vitest";
import type { ProjectAgentResult, ProjectExportEvent, ProjectExportResult, SessionView } from "@wsp/protocol";
import { agentRows, agentsRequest, exportLandedLine, isExportOf, pickedDest } from "../src/sidebar/exportProject.js";
import { RequestError } from "../src/protocol/client.js";
import { agentOutcome, agentOutcomes, refusalOf, refusalTone, slotWords } from "../src/sidebar/projectTrip.js";

const ev = (over: Partial<ProjectExportEvent>): ProjectExportEvent => ({
  type: "project.export",
  workspaceId: "ws_a",
  source: "/root/proj",
  dest: "/Users/me/code/proj",
  stage: "packing",
  message: "Packing /root/proj on the machine.",
  elapsedMs: 10,
  ...over,
});

const row = (id: string, harness: string, over: Partial<SessionView> = {}): SessionView => ({ id, workspaceId: "ws_a", harness, status: "completed", ...over });

describe("which events are this export's", () => {
  it("matches the workspace and the destination as sent, and nothing else", () => {
    expect(isExportOf(ev({}), "ws_a", "/Users/me/code/proj")).toBe(true);
    expect(isExportOf(ev({ workspaceId: "ws_b" }), "ws_a", "/Users/me/code/proj")).toBe(false);
    expect(isExportOf(ev({ dest: "/Users/me/code/other" }), "ws_a", "/Users/me/code/proj")).toBe(false);
  });
});

describe("agent rows from the workspace's threads", () => {
  it("is one row per harness in first-seen order, none without threads", () => {
    expect(agentRows(undefined)).toEqual([]);
    expect(agentRows([])).toEqual([]);
    expect(agentRows([row("s1", "claude"), row("s2", "codex"), row("s3", "claude"), row("s4", "gemini")])).toEqual(["claude", "codex", "gemini"]);
  });

  it("asks for no agents while every row is ticked, so every agent with sessions comes home, and names the ticked ones otherwise", () => {
    const rows = ["claude", "codex", "gemini"];
    expect(agentsRequest(rows, new Set(rows))).toBeUndefined();
    expect(agentsRequest([], new Set())).toBeUndefined();
    expect(agentsRequest(rows, new Set(["gemini", "claude"]))).toEqual(["claude", "gemini"]);
    expect(agentsRequest(rows, new Set())).toEqual([]);
  });
});

describe("the destination a picked folder gives", () => {
  it("lands the folder inside the picked one under its own name, whatever the slashes", () => {
    expect(pickedDest("/Users/me/code", "/root/proj")).toBe("/Users/me/code/proj");
    expect(pickedDest("/Users/me/code/", "/root/proj/")).toBe("/Users/me/code/proj");
    expect(pickedDest("/", "/root/proj")).toBe("/proj");
  });
});

describe("agent outcome words", () => {
  const agent = (over: Partial<ProjectAgentResult>): ProjectAgentResult => ({ agent: "claude", files: 3, bytes: 900, outcome: "moved", ...over });

  it("names each agent and what became of its sessions in one set of words, with the rollouts skipped and no counts", () => {
    expect(agentOutcomes([agent({ sessions: 2 })])).toBe("Claude Code moved");
    expect(agentOutcomes([agent({ agent: "codex", outcome: "transcript-only", sessions: 1, skipped: 2 })])).toBe("Codex transcripts landed, not yet listed, 2 rollouts skipped");
    expect(agentOutcomes([agent({ agent: "gemini", outcome: "nothing", files: 0, bytes: 0 })])).toBe("Gemini CLI nothing to bring");
    expect(agentOutcomes([agent({ agent: "zed", outcome: "carried" })])).toBe("zed carried unchanged");
    expect(agentOutcomes([agent({ agent: "zed", outcome: "failed", error: "state.db locked" })])).toBe("zed failed: state.db locked");
    expect(agentOutcomes([agent({ agent: "zed", outcome: "failed" })])).toBe("zed failed: no reason given");
    expect(agentOutcomes([agent({ sessions: 1 }), agent({ agent: "codex", outcome: "nothing" })])).toBe("Claude Code moved, Codex nothing to bring");
  });

  it("gives a row's end the same words as the landed line", () => {
    expect(agentOutcome(agent({ outcome: "transcript-only", skipped: 1 }))).toBe("transcripts landed, not yet listed, 1 rollout skipped");
    expect(agentOutcome(agent({ outcome: "nothing" }))).toBe("nothing to bring");
    expect(agentOutcome(agent({ outcome: "failed", error: "locked" }))).toBe("failed: locked");
  });
});

describe("a refusal from a caught error", () => {
  it("knows the one refusal with a follow-up, an existing destination, and reads any other error's words", () => {
    expect(refusalOf(new RequestError("/x exists with 3 files", "exists"))).toEqual({ message: "/x exists with 3 files", exists: true });
    expect(refusalOf(new RequestError("/x is not a folder", "invalid"))).toEqual({ message: "/x is not a folder", exists: false });
    expect(refusalOf(new Error("the machine went away"))).toEqual({ message: "the machine went away", exists: false });
    expect(refusalOf("socket closed")).toEqual({ message: "socket closed", exists: false });
  });

  it("colours the status line: quiet with none, caution for one asking a replace, error for any other", () => {
    expect(refusalTone(null)).toBe("quiet");
    expect(refusalTone({ message: "/x exists", exists: true })).toBe("caution");
    expect(refusalTone({ message: "/x is not a folder", exists: false })).toBe("error");
  });
});

describe("the landed line", () => {
  const result: ProjectExportResult = { dest: "/Users/me/code/proj", files: 11, bytes: 2_900, excluded: [], agents: [] };

  it("names the folder on this Mac once, leaving the caches and each agent's outcome to their rows, and says when the machine had no sessions", () => {
    expect(exportLandedLine(result, "/root/proj")).toBe("proj is at /Users/me/code/proj on this Mac; no agent sessions for it on the task.");
    expect(exportLandedLine({ ...result, excluded: ["node_modules"] }, "/root/proj/")).toBe("proj is at /Users/me/code/proj on this Mac; no agent sessions for it on the task.");
    expect(exportLandedLine({ ...result, excluded: ["node_modules", "dist"], agents: [{ agent: "claude", files: 2, bytes: 100, outcome: "moved", sessions: 2 }] }, "/root/proj")).toBe("proj is at /Users/me/code/proj on this Mac.");
  });
});

describe("what the one slot says", () => {
  const progress = { line: "Downloading the folder, 3 KB", fraction: 0.5 };

  it("reads the refusal in its tone first, then the landed line quietly, then the step in mono, else the idle words quietly", () => {
    expect(slotWords({ refusal: { message: "/x exists", exists: true }, landed: "proj is at /x.", progress, idle: "" })).toEqual({ words: "/x exists", tone: "caution" });
    expect(slotWords({ refusal: { message: "/x is not a folder", exists: false }, landed: null, progress: null, idle: "" })).toEqual({ words: "/x is not a folder", tone: "error" });
    expect(slotWords({ refusal: null, landed: "proj is at /x.", progress, idle: "" })).toEqual({ words: "proj is at /x.", tone: "quiet" });
    expect(slotWords({ refusal: null, landed: null, progress, idle: "Reading the folder." })).toEqual({ words: "Downloading the folder, 3 KB", tone: "step" });
    expect(slotWords({ refusal: null, landed: null, progress: null, idle: "Reading the folder." })).toEqual({ words: "Reading the folder.", tone: "quiet" });
    expect(slotWords({ refusal: null, landed: null, progress: null, idle: "" })).toEqual({ words: "", tone: "quiet" });
  });
});
