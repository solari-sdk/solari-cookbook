// SPDX-License-Identifier: AGPL-3.0-only
// What a record of a machine reached over ssh answers the roads that need a
// daemon: the kind's refusal to a caller, and unsupported on its row. And who
// may start a process on one, which the dial decides: a machine somebody owns
// is somewhere else, and a dial naming the computer wsp runs on is this one.
import { afterEach, describe, expect, it } from "vitest";
import { sshMachineId } from "@wsp/engine";
import { noSshDaemonLine } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeSsh } from "./fake-ssh.js";
import { stubBackend } from "./stub-backend.js";

const MACHINE = sshMachineId({ user: "dev", host: "box", port: 22 });

let rt: Runtime | undefined;

afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

/** A host holding one workspace on a machine somebody owns, with a daemon this host put there recorded on it:
 * the state a deploy leaves behind, and the one a road to that daemon would be opened from. Written into the
 * store by hand, since no create on this host writes a record of this kind. */
async function hostWithOne(also?: { id: string; name: string; machineId: string }): Promise<Runtime> {
  const store = memoryStore();
  await store.put("projects", "pr_1", {
    id: "pr_1",
    name: "box",
    computer: "pl_box",
    source: { kind: "folder" as const, path: "/home/dev/box" },
    path: "/home/dev/box",
    memoryKey: "-home-dev-box",
    memoryDir: "/home/dev/.claude/projects/-home-dev-box/memory",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  await store.put("workspaces", "ws_1a2b3c4d", {
    id: "ws_1a2b3c4d",
    name: "box",
    kind: "ssh",
    project: "pr_1",
    machineId: MACHINE,
    phase: "running",
    golden: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    spec: {},
    size: { cpu: 8, memMb: 16_384 },
    firstLife: true,
    login: { HOME: "/home/dev", PATH: "/usr/bin" },
    daemon: { deployedAt: "2026-09-01T00:00:00.000Z", version: 60 },
  });
  if (also !== undefined) {
    await store.put("workspaces", also.id, {
      id: also.id,
      name: also.name,
      kind: "ssh",
      project: "pr_1",
      machineId: also.machineId,
      phase: "running",
      golden: "",
      createdAt: "2026-09-01T00:00:00.000Z",
      spec: {},
      size: { cpu: 2, memMb: 4_096 },
      firstLife: true,
      login: { HOME: "/root", PATH: "/usr/bin" },
    });
  }
  rt = createRuntime({ backend: stubBackend(), store, adapters: {}, ssh: fakeSsh().wiring });
  return rt;
}

describe("the road to a daemon on a machine reached over ssh", () => {
  it("is refused in the kind's own sentence, and leaves the row unsupported", async () => {
    const rt = await hostWithOne();
    await expect(rt.workspaces.daemonReach("ws_1a2b3c4d")).rejects.toThrow(noSshDaemonLine("box"));
    // Unsupported is the word for a machine there is no way at all to ask.
    const [row] = await rt.status.list({ zombieProbe: false });
    expect(row?.reach.state).toBe("unsupported");
  });
});
