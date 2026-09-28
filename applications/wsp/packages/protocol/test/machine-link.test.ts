// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  BackendFacts,
  DaemonErrorResponse,
  EXEC_BODY_MAX,
  MACHINE_PUT_PART_BYTES,
  MachineLinkRequest,
  MachineShare,
  PlaceView,
  WorkspaceCopy,
  WorkspaceView,
  forkRoom,
  placeDaemonPaths,
} from "../src/index.js";

const GB = 1024 * 1024 * 1024;

describe("the machine ops on a place link", () => {
  it("parses every op the host sends", () => {
    const frames: unknown[] = [
      { id: 1, op: "machine.backend" },
      { id: 2, op: "machine.capacity" },
      { id: 3, op: "machine.checkKey" },
      { id: 4, op: "machine.create", spec: { kind: "sandbox", template: "wsp/dev:template", cpu: 2, memMb: 4096 } },
      { id: 5, op: "machine.get", machineId: "c1" },
      { id: 6, op: "machine.list", labels: { wsp: "1" } },
      { id: 13, op: "machine.exec", machineId: "c1", cmd: "echo hi", timeoutMs: 1000 },
      { id: 15, op: "machine.pause", machineId: "c1" },
      { id: 16, op: "machine.resume", machineId: "c1" },
      { id: 17, op: "machine.kill", machineId: "c1" },
      { id: 18, op: "machine.state", machineId: "c1" },
      { id: 19, op: "machine.describe", machineId: "c1" },
      { id: 20, op: "machine.facts", machineId: "c1" },
      { id: 21, op: "machine.metrics", machineId: "c1" },
      { id: 22, op: "machine.daemonAnswers", machineId: "c1", timeoutMs: 500 },
      { id: 23, op: "machine.previewUrl", machineId: "c1", port: 7070 },
      { id: 24, op: "machine.downloadUrl", machineId: "c1", path: "/root/a" },
      { id: 25, op: "machine.uploadUrl", machineId: "c1", path: "/root/a" },
      { id: 26, op: "machine.putBytes", machineId: "c1", path: "/root/a", uploadId: "u1", seq: 0, last: true, data: "AAAA" },
    ];
    for (const frame of frames) expect(MachineLinkRequest.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
  });

  it("refuses the eight frames a layer store answered: a place keeps no image to save, name or list", () => {
    const gone: unknown[] = [
      { id: 1, op: "machine.snapshot", machineId: "c1", name: "v1", life: { firstLife: true } },
      { id: 2, op: "machine.snapshotJob", job: "3f9a1c2b4d5e6f70" },
      { id: 3, op: "machine.deleteSnapshot", snapshotId: "sha256:aa" },
      { id: 4, op: "machine.listSnapshots" },
      { id: 5, op: "machine.promoteSnapshot", snapshotId: "sha256:aa", name: "v1" },
      { id: 6, op: "machine.getTemplate", templateId: "wsp/dev:template" },
      { id: 7, op: "machine.listTemplates" },
      { id: 8, op: "machine.deleteTemplate", templateId: "wsp/dev:template" },
    ];
    for (const frame of gone) expect(MachineLinkRequest.safeParse(frame).success, JSON.stringify(frame)).toBe(false);
  });

  it("takes a create that brings a project of the computer's own, and refuses one whose paths are not paths", () => {
    const copy = { from: "/wsp/projects/wsp/checkout", at: "/Users/zingzy/wsp" };
    const create = (spec: unknown): boolean => MachineLinkRequest.safeParse({ id: 1, op: "machine.create", spec }).success;
    expect(create({ kind: "sandbox", copy })).toBe(true);
    // A workspace of the computer with no project in it is the same frame without the field.
    expect(create({ kind: "sandbox" })).toBe(true);
    expect(WorkspaceCopy.safeParse(copy).success).toBe(true);
    // Both sides are absolute and plain: a relative path, a path that is not one, and an empty one are refused
    // at the wire rather than quoted in a mount command on the far side.
    // A folder of the computer's bound into the workspace is read by the same rule the copy and the shares are.
    const bind = { source: "/wsp/projects/pr_1/memory", target: "/root/.claude-cfg/projects/-root-wsp/memory" };
    expect(create({ kind: "sandbox", binds: [bind] })).toBe(true);
    expect(create({ kind: "sandbox", binds: [{ ...bind, readOnly: true }] })).toBe(true);
    expect(create({ kind: "sandbox", binds: [{ ...bind, source: "projects/pr_1/memory" }] })).toBe(false);
    expect(create({ kind: "sandbox", binds: [{ ...bind, source: "/wsp/projects/../../root/.ssh" }] })).toBe(false);
    expect(create({ kind: "sandbox", binds: [{ ...bind, target: "/root/../etc" }] })).toBe(false);
    expect(create({ kind: "sandbox", binds: [{ source: bind.source }] })).toBe(false);
    expect(create({ kind: "sandbox", copy: { ...copy, from: "projects/wsp/checkout" } })).toBe(false);
    expect(create({ kind: "sandbox", copy: { ...copy, at: "wsp" } })).toBe(false);
    expect(create({ kind: "sandbox", copy: { ...copy, at: "/Users/zingzy/wsp; rm -rf /" } })).toBe(false);
    expect(create({ kind: "sandbox", copy: { ...copy, from: "" } })).toBe(false);
    expect(create({ kind: "sandbox", copy: { from: copy.from } })).toBe(false);
    // A path that walks up out of itself is refused on both halves: what it resolves to is a folder on the
    // computer, and a bind mount over one of those cannot be taken back.
    expect(create({ kind: "sandbox", copy: { ...copy, at: "/Users/../../etc" } })).toBe(false);
    expect(create({ kind: "sandbox", copy: { ...copy, from: "/wsp/projects/../../root/.ssh" } })).toBe(false);
    expect(create({ kind: "sandbox", copy: { ...copy, at: "/Users/./wsp" } })).toBe(false);
    // A folder whose name begins with a dot is a folder, and half a home is made of them.
    expect(create({ kind: "sandbox", copy: { ...copy, at: "/root/.claude/projects" } })).toBe(true);
  });

  it("takes a create that shares the computer's own logins into the workspace, and refuses a path that is not one", () => {
    const share = { source: "/var/lib/wsp/logins/codex/auth.json", target: "/root/.codex/auth.json" };
    const create = (spec: unknown): boolean => MachineLinkRequest.safeParse({ id: 1, op: "machine.create", spec }).success;
    expect(create({ kind: "sandbox", shares: [share] })).toBe(true);
    // A workspace that shares none is the same frame without the field, and the empty list is no shares either.
    expect(create({ kind: "sandbox" })).toBe(true);
    expect(create({ kind: "sandbox", shares: [] })).toBe(true);
    expect(MachineShare.safeParse(share).success).toBe(true);
    // Both sides are absolute and plain, and neither walks up out of itself: where the file on the computer has
    // to live is the daemon's own wall behind this one, and a bind mount is what cannot be taken back.
    expect(create({ kind: "sandbox", shares: [{ ...share, source: "logins/codex/auth.json" }] })).toBe(false);
    expect(create({ kind: "sandbox", shares: [{ ...share, source: "/var/lib/wsp/logins/../../root/.ssh/id" }] })).toBe(false);
    expect(create({ kind: "sandbox", shares: [{ ...share, target: "/root/../etc/passwd" }] })).toBe(false);
    expect(create({ kind: "sandbox", shares: [{ ...share, target: "" }] })).toBe(false);
    expect(create({ kind: "sandbox", shares: [{ source: share.source }] })).toBe(false);
  });

  it("reads where a computer keeps the logins it shares, and nothing that is not a path", () => {
    const facts = {
      offer: "runtime",
      capabilities: {
        liveCloneForks: false,
        replacesMachine: true,
        previewUrls: false,
        signedUrls: false,
        callbackRelay: false,
        diskSnapshots: true,
        images: true,
        snapshotsAnyLife: false,
        snapshotListing: true,
        templates: true,
        sizes: [],
        kept: false,
        copies: true,
        ownNetwork: true,
      },
      pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
    };
    // A provider shares none, so the field is absent there and present on a computer the person owns.
    expect(BackendFacts.parse(facts).logins).toBeUndefined();
    expect(BackendFacts.parse({ ...facts, logins: "/var/lib/wsp/logins" }).logins).toBe("/var/lib/wsp/logins");
    expect(BackendFacts.safeParse({ ...facts, logins: "logins" }).success).toBe(false);
    expect(BackendFacts.safeParse({ ...facts, logins: "" }).success).toBe(false);
  });

  it("refuses an op it does not carry, a part out of range and a command over the body cap", () => {
    expect(MachineLinkRequest.safeParse({ id: 1, op: "machine.nonsense" }).success).toBe(false);
    expect(MachineLinkRequest.safeParse({ id: 1, op: "machine.putBytes", machineId: "c1", path: "/a", uploadId: "u", seq: -1, last: false, data: "" }).success).toBe(false);
    expect(MachineLinkRequest.safeParse({ id: 1, op: "machine.exec", machineId: "c1", cmd: "x".repeat(EXEC_BODY_MAX + 1) }).success).toBe(false);
  });

  it("carries a refusal's kind and status, and still reads a refusal with neither", () => {
    expect(DaemonErrorResponse.parse({ id: 1, ok: false, error: "no such container", kind: "missing", status: 404 })).toMatchObject({ kind: "missing", status: 404 });
    const bare = DaemonErrorResponse.parse({ id: 1, ok: false, error: "no" });
    expect(bare.kind).toBeUndefined();
    expect(bare.status).toBeUndefined();
  });

  it("sends a file in parts of four mebibytes", () => {
    expect(MACHINE_PUT_PART_BYTES).toBe(4 * 1024 * 1024);
  });

  it("keeps the parts of an upload in wsp's own folder under the login's home", () => {
    expect(placeDaemonPaths("/Users/maya").putDir).toBe("/Users/maya/.wsp/put");
  });
});

describe("how many forks a place takes", () => {
  it("takes the smaller of what the memory and the disk allow", () => {
    // The memory is the smaller here: one fork of 1959 MB fits in 3000, and the disk would take two copies.
    expect(forkRoom({ memRoomMb: 3000, diskFreeBytes: 10 * GB }, 1959, 4.2 * GB)).toBe(1);
    // The disk is the smaller here: the memory would take four forks and the disk holds two more copies.
    expect(forkRoom({ memRoomMb: 8000, diskFreeBytes: 10 * GB }, 2000, 4 * GB)).toBe(2);
  });

  it("reads the memory alone where no image is there to measure by", () => {
    expect(forkRoom({ memRoomMb: 8000, diskFreeBytes: 10 * GB }, 2000, undefined)).toBe(4);
    expect(forkRoom({ memRoomMb: 8000, diskFreeBytes: 10 * GB }, 2000, 0)).toBe(4);
  });

  it("never reads below none", () => {
    expect(forkRoom({ memRoomMb: 0, diskFreeBytes: 0 }, 2000, 4 * GB)).toBe(0);
  });
});

describe("what the views carry about a place", () => {
  const workspace = { id: "ws_1", name: "x", machineId: "c1", phase: "running" as const, golden: "sha256:aa", createdAt: "2026-09-12T00:00:00.000Z", project: { id: "pr_1a2b3c4d", name: "x", path: "/root/x", computer: "here" } };

  it("reads a fork with a place and one without", () => {
    expect(WorkspaceView.parse({ ...workspace, place: "p_ab12cd34" }).place).toBe("p_ab12cd34");
    expect(WorkspaceView.parse(workspace).place).toBeUndefined();
  });

  it("reads a place row with forks and one without", () => {
    const place = { id: "p_ab12cd34", kind: "computer" as const, name: "srv", default: false };
    expect(PlaceView.parse({ ...place, forks: { running: 1, room: 2 } }).forks).toEqual({ running: 1, room: 2 });
    expect(PlaceView.parse(place).forks).toBeUndefined();
  });
});
