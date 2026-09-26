// SPDX-License-Identifier: AGPL-3.0-only
// Bringing work back: the two frames the runtime sends down a workspace's own
// daemon channel, which base each carries, and what a machine with no
// signed-in command line for the git host answers with.
import { describe, expect, it, afterEach } from "vitest";
import { branchUnreadRefusal, noGitCredentialLine, noHostCliLine, noParentWorkspaceLine, onBaseRefusal, type DaemonFrame, type DaemonResponse } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { daemonTokenFor } from "../src/daemon-token.js";
import { memoryStore } from "../src/store.js";
import { createOn, projectOn, stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);

/** A daemon that records every frame and answers each op the way one on a machine would. */
function fakeDaemon(answers: Partial<Record<string, (frame: Record<string, unknown>) => DaemonResponse>> = {}): {
  open: (o: DaemonChannelOptions) => Promise<DaemonChannel>;
  frames: Record<string, unknown>[];
  dials: DaemonChannelOptions[];
  closed: number;
} {
  const frames: Record<string, unknown>[] = [];
  const dials: DaemonChannelOptions[] = [];
  const state = { closed: 0 };
  const push = (frame: Record<string, unknown>): DaemonResponse => ({
    id: 1,
    ok: true,
    branch: "pricing-page",
    base: String(frame["base"] ?? ""),
    remote: "origin",
    ahead: 2,
    uncommitted: 1,
    stat: [" src/page.tsx | 4 ++--"],
  });
  const pr = (): DaemonResponse => ({ id: 1, ok: true, pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com" }, created: true });
  return {
    frames,
    dials,
    get closed() {
      return state.closed;
    },
    open: async o => {
      dials.push(o);
      return {
        send: async (frame: DaemonFrame) => {
          const held = frame as unknown as Record<string, unknown>;
          frames.push(held);
          const own = answers[String(held["op"])];
          if (own !== undefined) return own(held);
          return String(held["op"]) === "git.push" ? push(held) : pr();
        },
        close: () => {
          state.closed += 1;
        },
        // Nothing here ends of its own: the runtime's own road closes the channel when the work it opened it for is over.
        closed: new Promise(() => {}),
      };
    },
  };
}

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

/** A runtime whose one workspace has a daemon answering, as a fork on a box does. */
async function withWorkspace(daemon: ReturnType<typeof fakeDaemon>, base?: string): Promise<{ backend: StubBackend; id: string; projectId: string }> {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open });
  const project = await projectOn(rt, undefined, undefined, base === undefined ? undefined : { base });
  const ws = await createOn(rt, { project: project.id, golden: "snap_g", name: "pricing page" });
  backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
  return { backend, id: ws.id, projectId: project.id };
}

describe("workspaces.bringBack", () => {
  it("a workspace with no parent pushes and opens the pull request against the project's own base, on one dial that is closed after", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon, "main");
    const back = await rt!.workspaces.bringBack({ workspaceId: id, title: "the pricing page", body: "what it does" });
    expect(daemon.frames).toEqual([
      { op: "git.push", cwd: "/root/stub-1", base: "main" },
      { op: "git.pr", cwd: "/root/stub-1", base: "main", title: "the pricing page", body: "what it does" },
    ]);
    expect(back).toEqual({
      branch: "pricing-page",
      base: "main",
      ahead: 2,
      uncommitted: 1,
      stat: [" src/page.tsx | 4 ++--"],
      pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com" },
    });
    expect(daemon.dials.map(({ url, token }) => ({ url, token }))).toEqual([{ url: "http://127.0.0.1:7070", token: daemonTokenFor(DAEMON_TOKEN, "m1") }]);
    expect(daemon.closed).toBe(1);
  });

  it("a project that named no base leaves it to the checkout, which reads its own", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon);
    await rt!.workspaces.bringBack({ workspaceId: id });
    expect(daemon.frames.map(f => f["base"])).toEqual([undefined, undefined]);
  });

  it("a branch only the parent's own copy holds is no base: the child starts and lands where the project does", async () => {
    const daemon = fakeDaemon();
    const { backend, id, projectId } = await withWorkspace(daemon, "main");
    // On a branch, with nothing tracking it: nothing on the remote for a clone to start from or a pull request to
    // aim at, so the project's own base is what both read.
    backend.execImpl = (m, cmd) => (cmd.includes("rev-parse --abbrev-ref HEAD") ? { exitCode: 0, stdout: "only-here\n\n", stderr: "" } : tokenGuest(m, cmd));
    const child = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "second look", parent: id });
    expect(child.parentWorkspaceId).toBe(id);
    expect(backend.machines[1]!.execLog.find(cmd => cmd.includes("git clone"))).toContain("--branch main");
    backend.machines[1]!.previewUrl = async () => ({ url: "http://127.0.0.1:7071", token: "e", expiresAt: Date.now() + 3_600_000 });
    await rt!.workspaces.bringBack({ workspaceId: child.id });
    expect(daemon.frames.map(f => f["base"])).toEqual(["main", "main"]);
  });

  it("a parent that did not say which branch it is on stops the fork, and no child is made", async () => {
    const daemon = fakeDaemon();
    const { backend, id, projectId } = await withWorkspace(daemon, "main");
    // The machine is there and the read is not: what a stopped machine, a shell that failed and the read's own
    // bound all come back as. A child started at the project's base here would land its work at the project's base.
    backend.execImpl = (m, cmd) => {
      if (!cmd.includes("rev-parse --abbrev-ref HEAD")) return tokenGuest(m, cmd);
      throw new Error("machine is paused");
    };
    const refused = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "second look", parent: id }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe(branchUnreadRefusal("pricing page", "machine is paused"));
    expect((await rt!.workspaces.list()).map(w => w.name)).toEqual(["pricing page"]);
  });

  it("a child whose parent went to sleep after the fork brings back against the branch it was forked from", async () => {
    const daemon = fakeDaemon();
    const { backend, id, projectId } = await withWorkspace(daemon, "main");
    backend.execImpl = (m, cmd) => (cmd.includes("rev-parse --abbrev-ref HEAD") ? { exitCode: 0, stdout: "pricing-page\norigin/pricing-page\n", stderr: "" } : tokenGuest(m, cmd));
    const child = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "second look", parent: id });
    backend.machines[1]!.previewUrl = async () => ({ url: "http://127.0.0.1:7071", token: "e", expiresAt: Date.now() + 3_600_000 });
    const readsOfTheParent = (): number => backend.machines[0]!.execLog.filter(cmd => cmd.includes("rev-parse --abbrev-ref HEAD")).length;
    expect(readsOfTheParent()).toBe(1);
    // The parent naps, and every command on it would now answer with what a stopped machine answers. The child's
    // work still goes back into the branch it was cut from, and nothing asks that machine anything.
    await rt!.workspaces.nap(id);
    backend.execImpl = (m, cmd) => {
      if (m.id === backend.machines[0]!.id) throw new Error("machine is paused");
      return tokenGuest(m, cmd);
    };
    const back = await rt!.workspaces.bringBack({ workspaceId: child.id });
    expect(back.base).toBe("pricing-page");
    expect(daemon.frames.map(f => f["base"])).toEqual(["pricing-page", "pricing-page"]);
    expect(readsOfTheParent()).toBe(1);
  });

  it("a create naming a parent this host does not hold is refused, not landed as a root", async () => {
    const daemon = fakeDaemon();
    const { projectId } = await withWorkspace(daemon, "main");
    const refused = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "orphan", parent: "ws_nobody" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe(noParentWorkspaceLine("ws_nobody"));
    expect((await rt!.workspaces.list()).map(w => w.name)).toEqual(["pricing page"]);
  });

  it("a child workspace measures against the branch its parent was on at the fork, whatever the parent does after", async () => {
    const daemon = fakeDaemon();
    const { backend, id, projectId } = await withWorkspace(daemon, "main");
    // The parent is on a branch the remote has, which is what makes it a branch a child can start from.
    backend.execImpl = (m, cmd) => (cmd.includes("rev-parse --abbrev-ref HEAD") ? { exitCode: 0, stdout: "pricing-page\norigin/pricing-page\n", stderr: "" } : tokenGuest(m, cmd));
    const child = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "pricing page copy", parent: id });
    expect(child.parentWorkspaceId).toBe(id);
    expect(child.project.id).toBe(projectId);
    // The child starts where its parent stands, not where the project does: the clone inside it takes that branch.
    expect(backend.machines[1]!.execLog.find(cmd => cmd.includes("git clone"))).toContain("--branch pricing-page");
    backend.machines[1]!.previewUrl = async () => ({ url: "http://127.0.0.1:7071", token: "e", expiresAt: Date.now() + 3_600_000 });
    // The parent switches branches after the fork; the child's work still belongs on the branch it was cut from.
    backend.execImpl = (m, cmd) => (cmd.includes("rev-parse --abbrev-ref HEAD") ? { exitCode: 0, stdout: "somewhere-else\norigin/somewhere-else\n", stderr: "" } : tokenGuest(m, cmd));
    await rt!.workspaces.bringBack({ workspaceId: child.id });
    expect(daemon.frames.map(f => f["base"])).toEqual(["pricing-page", "pricing-page"]);
  });

  it("a refusal from the push is the caller's error, and nothing is asked about a pull request after it", async () => {
    const daemon = fakeDaemon({ "git.push": () => ({ id: 1, ok: false, error: onBaseRefusal("main") }) });
    const { id } = await withWorkspace(daemon, "main");
    await expect(rt!.workspaces.bringBack({ workspaceId: id })).rejects.toThrow(onBaseRefusal("main"));
    expect(daemon.frames.map(f => f["op"])).toEqual(["git.push"]);
    // The dial is closed however the work ends, so a refusal leaves no socket on the machine.
    expect(daemon.closed).toBe(1);
  });

  it("a machine with no command line for the git host still pushes, and the sentence comes back as the note", async () => {
    const note = noHostCliLine("github.com");
    const daemon = fakeDaemon({ "git.pr": () => ({ id: 1, ok: false, error: note, code: "no-host-cli" }) });
    const { id } = await withWorkspace(daemon, "main");
    const back = await rt!.workspaces.bringBack({ workspaceId: id });
    expect(back.note).toBe(note);
    expect(back.pr).toBeUndefined();
    expect(back.branch).toBe("pricing-page");
    expect(back.ahead).toBe(2);
  });

  it("any other refusal of the pull request comes back beside the push, since the branch has landed by then", async () => {
    const said = "gh said: could not create pull request";
    const daemon = fakeDaemon({ "git.pr": () => ({ id: 1, ok: false, error: said }) });
    const { id } = await withWorkspace(daemon, "main");
    const back = await rt!.workspaces.bringBack({ workspaceId: id });
    expect(back.refused).toBe(said);
    expect(back.note).toBeUndefined();
    expect(back.pr).toBeUndefined();
    // The push's own fields are the answer's first half, whatever the pull request half then said.
    expect({ branch: back.branch, base: back.base, ahead: back.ahead, uncommitted: back.uncommitted, stat: back.stat }).toEqual({
      branch: "pricing-page",
      base: "main",
      ahead: 2,
      uncommitted: 1,
      stat: [" src/page.tsx | 4 ++--"],
    });
  });

  it("a push refused for want of a credential is the whole verb's refusal, since nothing landed", async () => {
    const said = noGitCredentialLine("github.com", "sign gh in on it with gh auth login, then gh auth setup-git");
    const daemon = fakeDaemon({ "git.push": () => ({ id: 1, ok: false, error: said }) });
    const { id } = await withWorkspace(daemon, "main");
    await expect(rt!.workspaces.bringBack({ workspaceId: id })).rejects.toThrow(said);
    expect(daemon.frames.map(f => f["op"])).toEqual(["git.push"]);
  });
});
