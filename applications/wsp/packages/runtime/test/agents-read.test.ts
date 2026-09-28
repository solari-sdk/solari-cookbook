// SPDX-License-Identifier: AGPL-3.0-only
import type { Machine } from "@wsp/engine";
import { noSuchAgentsProjectRefusal, sharedAgentsProjectRefusal, nappingAgentsRefusal, nappingServersRefusal, nappingSignInRefusal, nappingSkillsRefusal, nappingToolsRefusal, noSignInRefusal, type AgentsTarget, type WorkspacePhase } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { NO_AGENTS_READER, agentsReads, pageReachOf, projectOf, type AgentsActs, type AgentsOn, type AgentsRead, type AgentsWorkspace, type ServerToolsAsk, type SignInAsk, type ServersActs, type SignInForward, type SkillsActs } from "../src/agents-read.js";
import type { PlaceDoor } from "../src/places.js";
import { until } from "./until.js";

const LANDING = { id: "pr_landing", name: "landing", path: "/root/landing" };

const READ = { home: "/root", user: "root", agents: [], skills: [], servers: [], refused: [] };

function reads(phase: { now: WorkspacePhase }, local = false): { asked: AgentsOn[]; tools: ServerToolsAsk[]; api: ReturnType<typeof agentsReads<undefined>> } {
  const asked: AgentsOn[] = [];
  const tools: ServerToolsAsk[] = [];
  const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
  const api = agentsReads<undefined>({
    reader: { read: async on => (asked.push(on), READ), tools: async (on, ask) => (asked.push(on), tools.push(ask), { auth: "open", tools: [], readAt: "2026-09-24T12:00:00.000Z" }) },
    places: () => undefined,
    workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: phase.now, local, machine, project: LANDING }),
    channel: async () => {
      throw new Error("no channel on this road");
    },
    changed: () => undefined,
    now: () => Date.parse("2026-09-24T12:00:00Z"),
  });
  return { asked, tools, api };
}

describe("the agents in a workspace", () => {
  it("are read off its machine with its project, and a napping one answers the last report marked stale without being asked", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { asked, api } = reads(phase);
    const first = await api.read({ workspaceId: "ws_1" });
    expect(first).toMatchObject({ target: { workspaceId: "ws_1" }, readAt: "2026-09-24T12:00:00.000Z", ...READ });
    expect(asked).toEqual([{ kind: "machine", machine: expect.anything(), projects: [LANDING] }]);
    phase.now = "napping";
    expect(await api.read({ workspaceId: "ws_1" })).toEqual({ ...first, stale: "napping" });
    expect(asked).toHaveLength(1);
  });

  it("refuses a napping one it never read while it ran, and reads a workspace on this computer as this computer with its project", async () => {
    await expect(reads({ now: "napping" }).api.read({ workspaceId: "ws_2" })).rejects.toThrow(nappingAgentsRefusal("landing"));
    const here = reads({ now: "running" }, true);
    await here.api.read({ workspaceId: "ws_3" });
    expect(here.asked).toEqual([{ kind: "here", projects: [LANDING] }]);
  });

  it("say on the report where a page that returns to localhost reaches, off the one rule the sign-in plans by", async () => {
    const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
    const on = (local: boolean, relayed: boolean) =>
      agentsReads<undefined>({
        reader: { read: async () => READ, tools: async () => ({ auth: "open", readAt: "2026-09-24T12:00:00.000Z" }) },
        places: () => undefined,
        workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: "running", local, machine, project: LANDING }),
        channel: async () => {
          throw new Error("no channel on this road");
        },
        changed: () => undefined,
        relayed: () => relayed,
        now: () => Date.parse("2026-09-24T12:00:00Z"),
      });
    expect((await on(true, false).read({ workspaceId: "ws_1" })).reach).toBe("here");
    expect((await on(false, true).read({ workspaceId: "ws_1" })).reach).toBe("relay");
    expect((await on(false, false).read({ workspaceId: "ws_1" })).reach).toBe("none");
    expect((await on(false, false).read({ placeId: "here" })).reach).toBe("here");
    expect([pageReachOf({ kind: "here" }), pageReachOf({ kind: "machine", machine, relayed: true }), pageReachOf({ kind: "machine", machine }), pageReachOf({ kind: "box", machine, login: {} }), pageReachOf({ kind: "box", machine, login: {}, relayed: true })]).toEqual(["here", "relay", "none", "none", "relay"]);
  });

  it("forgets a workspace's last report once the workspace is removed, so nothing holds it for the host's life", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { api } = reads(phase);
    await api.read({ workspaceId: "ws_4" });
    api.forget("ws_4");
    phase.now = "napping";
    await expect(api.read({ workspaceId: "ws_4" })).rejects.toThrow(nappingAgentsRefusal("landing"));
  });

  it("start a server for its tools on the workspace's own machine, keyed by the target, and never on a napping one", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { asked, tools, api } = reads(phase);
    expect(await api.tools({ workspaceId: "ws_5" }, { agent: "claude", name: "airtable" })).toEqual({ auth: "open", tools: [], readAt: "2026-09-24T12:00:00.000Z" });
    expect(asked).toEqual([{ kind: "machine", machine: expect.anything(), projects: [LANDING] }]);
    expect(tools).toEqual([{ key: JSON.stringify({ workspaceId: "ws_5" }), agent: "claude", name: "airtable" }]);
    phase.now = "napping";
    await expect(api.tools({ workspaceId: "ws_5" }, { agent: "claude", name: "airtable" })).rejects.toThrow(nappingToolsRefusal("landing"));
    expect(asked).toHaveLength(1);
  });
});

describe("the sign-ins on a computer or a workspace", () => {
  /** A channel whose frames are kept and whose events this test pushes. */
  function channel() {
    const frames: Record<string, unknown>[] = [];
    let push: (e: Record<string, unknown>) => void = () => {};
    let end: () => void = () => {};
    const closed = new Promise<{ code: number; reason: string }>(r => (end = () => r({ code: 1000, reason: "" })));
    let shut = 0;
    return {
      frames,
      push: (e: Record<string, unknown>) => push(e),
      get shut() {
        return shut;
      },
      open: async (onEvent: (e: Record<string, unknown>) => void) => {
        push = onEvent;
        return {
          send: async (frame: Record<string, unknown>) => (frames.push(frame), { ok: true, ptyId: "pty_1" }),
          close: () => void (shut++, end()),
          closed,
        } as never;
      },
    };
  }

  /** One joined computer, spoo, as the place door lists it, with nothing reported yet. */
  const spoo = (): PlaceDoor =>
    ({
      list: async () => [{ id: "pl_1", name: "spoo", kind: "computer" }],
      reportOf: async () => undefined,
      signInsAt: () => undefined,
      loginLanded: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }) as unknown as PlaceDoor;

  function acting(phase: { now: WorkspacePhase }, relayed?: boolean, places?: PlaceDoor, read: AgentsRead = READ, changed: (AgentsTarget | undefined)[] = []) {
    const ch = channel();
    const planned: { on: AgentsOn; ask: SignInAsk }[] = [];
    const handed: (SignInForward | undefined)[] = [];
    const codes: string[] = [];
    let finish: () => void = () => {};
    const acts: AgentsActs = {
      signInLine: async () => ({ command: "codex login --device-auth" }),
      signIn: async (on, ask) => {
        planned.push({ on, ask });
        if (ask.agent === "opencode") throw new Error("opencode asks you to pick");
        return async run => {
          handed.push(run.forward);
          // What the host's watched pty does: a frame down the link, an event back up, the code writer handed over.
          await run.link.op("pty.create", {});
          run.link.onEvent(e => run.emit({ state: "waiting", url: String(e["url"]) }));
          run.typing(async code => void codes.push(code));
          await Promise.race([new Promise<void>(r => (finish = r)), run.stop]);
          run.typing(undefined);
          run.emit({ state: "signed-in" });
        };
      },
      key: async () => undefined,
      addTools: async () => ({ file: "~/.codex/config.toml" }),
    };
    const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
    const forgot: string[] = [];
    const logged: string[] = [];
    const api = agentsReads<undefined>({
      reader: { read: async () => read, tools: async () => ({ auth: "open", readAt: "2026-09-24T12:00:00.000Z" }), forget: key => void forgot.push(key) },
      log: line => void logged.push(line),
      ...(relayed === undefined ? {} : { relayed: () => relayed }),
      acts,
      places: () => places,
      workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: phase.now, local: false, machine, project: LANDING }),
      channel: async (_target, onEvent) => ch.open(onEvent),
      changed: target => void changed.push(target),
      now: () => Date.parse("2026-09-24T12:00:00Z"),
    });
    return { api, ch, planned, handed, changed, codes, forgot, logged, finish: () => finish() };
  }

  it("tell the host a workspace's callback port is forwarded from here where the relay does, and nothing where it does not", async () => {
    for (const relayed of [true, false]) {
      const t = acting({ now: "running" }, relayed);
      const { leave } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "claude", server: "notion" }, () => {});
      expect(t.planned[0]!.on).toEqual({ kind: "machine", machine: expect.anything(), projects: [LANDING], ...(relayed ? { relayed: true } : {}) });
      leave();
    }
  });

  it("tell the host a joined computer is relayed once the host's relay holds a link to it, and hand each server sign-in a forward of its own that closes when it ends", async () => {
    const t = acting({ now: "running" }, undefined, spoo());
    const target = { placeId: "pl_1" };
    const first = await t.api.signIn(target, { agent: "codex", server: "notion" }, () => {});
    await tick();
    expect(t.planned[0]!.on).not.toHaveProperty("relayed");
    expect(t.handed).toEqual([undefined]);
    expect((await t.api.read(target)).reach).toBe("none");
    t.api.signInStop(first.signInId);
    await tick();
    const opened: SignInForward[] = [];
    const closed: SignInForward[] = [];
    const asked: unknown[] = [];
    const ours = (at: AgentsTarget): boolean => (asked.push(at), "placeId" in at && at.placeId === "pl_1");
    const unregister = t.api.forwards({
      reaches: ours,
      open: at => {
        if (!ours(at)) return undefined;
        const forward: SignInForward = { arm: async () => true, deliver: async () => undefined, close: () => void closed.push(forward) };
        opened.push(forward);
        return forward;
      },
    });
    expect((await t.api.read(target)).reach).toBe("relay");
    expect(opened).toEqual([]);
    const second = await t.api.signIn(target, { agent: "codex", server: "notion" }, () => {});
    await tick();
    expect(t.planned[1]!.on).toMatchObject({ kind: "box", relayed: true });
    expect(opened).toHaveLength(1);
    expect(t.handed[1]).toBe(opened[0]);
    expect(asked).toContainEqual(target);
    expect(closed).toEqual([]);
    t.api.signInStop(second.signInId);
    await tick();
    expect(closed).toEqual([opened[0]]);
    // A tool's own login types its code on the terminal, so it is handed no forward to arm or to carry a pasted address.
    const login = await t.api.signIn(target, { agent: "codex" }, () => {});
    await tick();
    expect(t.handed[2]).toBeUndefined();
    expect(opened).toHaveLength(1);
    t.api.signInStop(login.signInId);
    await tick();
    unregister();
    await t.api.signIn(target, { agent: "codex", server: "notion" }, () => {});
    await tick();
    expect(t.planned[3]!.on).not.toHaveProperty("relayed");
  });

  it("report none for a joined computer whose lines go to another login, as the sign-in plans it, relay or not", async () => {
    const t = acting({ now: "running" }, undefined, spoo(), { ...READ, home: "/home/ada", user: "ada", runAs: "ada" });
    t.api.forwards({ reaches: () => true, open: () => undefined });
    const report = await t.api.read({ placeId: "pl_1" });
    expect(report.reach).toBe("none");
    expect(report).not.toHaveProperty("runAs");
    expect(pageReachOf({ kind: "box", machine: {} as never, login: {}, relayed: true }, "ada")).toBe("none");
  });

  it("drop what the reader kept for the target before saying it changed, and log each sign-in's start and end without its page or code", async () => {
    const t = acting({ now: "running" });
    const { signInId } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "claude", server: "notion" }, () => {});
    await tick();
    t.ch.push({ url: "https://mcp.notion.com/authorize?code=SECRETCODE&state=x" });
    await t.api.signInCode(signInId, "SECRETCODE");
    t.finish();
    await tick();
    expect(t.forgot).toEqual([JSON.stringify({ workspaceId: "ws_1" })]);
    expect(t.changed).toEqual([{ workspaceId: "ws_1" }]);
    expect(t.logged).toEqual([`sign-in ${signInId} started: claude, server notion, on workspace ws_1`, `sign-in ${signInId} ended: claude, server notion, on workspace ws_1: signed-in`]);
    const stopped = await t.api.signIn({ placeId: "here" }, { agent: "codex" }, () => {});
    t.api.signInStop(stopped.signInId);
    await tick();
    expect(t.logged.at(-1)).toBe(`sign-in ${stopped.signInId} ended: codex, on computer here: stopped`);
    const refused = acting({ now: "running" });
    await expect(refused.api.signIn({ workspaceId: "ws_1" }, { agent: "opencode" }, () => {})).rejects.toThrow(/asks you to pick/);
    expect(refused.logged).toEqual(["sign-in refused: opencode, on workspace ws_1: opencode asks you to pick"]);
    expect(JSON.stringify([t.logged, refused.logged])).not.toContain("SECRETCODE");
  });

  it("log a sign-in's names with every control character taken out, so no name forges a line of the host's log", async () => {
    const t = acting({ now: "running" });
    await expect(t.api.signIn({ workspaceId: "ws_1" }, { agent: "opencode", server: "x\nsign-in si_forged ended: \x1b[2Kok\r" }, () => {})).rejects.toThrow(/asks you to pick/);
    expect(t.logged).toEqual(["sign-in refused: opencode, server xsign-in si_forged ended: [2Kok, on workspace ws_1: opencode asks you to pick"]);
  });

  it("run what the host planned over the target's own channel, push each step under the sign-in's id, take a code by that id and say the agents changed at the end", async () => {
    const t = acting({ now: "running" });
    const seen: Record<string, unknown>[] = [];
    const { signInId } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void seen.push(e));
    expect(signInId).toMatch(/^si_[0-9a-f]{12}$/);
    expect(t.planned).toEqual([{ on: { kind: "machine", machine: expect.anything(), projects: [LANDING] }, ask: { agent: "codex" } }]);
    await tick();
    expect(t.ch.frames).toEqual([{ op: "pty.create" }]);
    t.ch.push({ url: "https://auth.openai.com/codex/device" });
    await t.api.signInCode(signInId, "ABCD-1234");
    expect(t.codes).toEqual(["ABCD-1234"]);
    t.finish();
    await tick();
    expect(seen).toEqual([
      { type: "agents.signIn", signInId, state: "waiting", url: "https://auth.openai.com/codex/device" },
      { type: "agents.signIn", signInId, state: "signed-in" },
    ]);
    expect(t.ch.shut).toBe(1);
    expect(t.changed).toEqual([{ workspaceId: "ws_1" }]);
    // Once it is over its code writer is gone with it.
    await expect(t.api.signInCode(signInId, "ABCD-1234")).rejects.toThrow(noSignInRefusal);
  });

  it("note an agent's landed login on a joined computer before saying its agents changed, and nothing for a server's or a workspace's", async () => {
    const landed: string[] = [];
    const changed: (AgentsTarget | undefined)[] = [];
    const door = {
      ...spoo(),
      loginLanded: async (placeId: string, agent: string) => {
        await tick();
        landed.push(`${placeId} ${agent} after ${changed.length} changes`);
      },
    } as unknown as PlaceDoor;
    const t = acting({ now: "running" }, undefined, door, READ, changed);
    const finished = async (target: AgentsTarget, ask: SignInAsk): Promise<void> => {
      const before = changed.length;
      await t.api.signIn(target, ask, () => {});
      await tick();
      t.finish();
      await until(() => changed.length > before);
    };
    await finished({ placeId: "pl_1" }, { agent: "codex" });
    await finished({ placeId: "pl_1" }, { agent: "claude", server: "linear" });
    await finished({ workspaceId: "ws_1" }, { agent: "codex" });
    expect(landed).toEqual(["pl_1 codex after 0 changes"]);
    expect(changed).toEqual([{ placeId: "pl_1" }, { placeId: "pl_1" }, { workspaceId: "ws_1" }]);
  });

  it("refuse a sign-in the host will not plan before any channel opens, never wake a napping workspace, and stop one whose asker went", async () => {
    const t = acting({ now: "running" });
    await expect(t.api.signIn({ workspaceId: "ws_1" }, { agent: "opencode" }, () => {})).rejects.toThrow(/asks you to pick/);
    expect(t.ch.frames).toEqual([]);
    const napping = acting({ now: "napping" });
    await expect(napping.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, () => {})).rejects.toThrow(nappingSignInRefusal("landing"));
    expect(napping.planned).toEqual([]);
    const seen: Record<string, unknown>[] = [];
    const { leave } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void seen.push(e));
    leave();
    await tick();
    expect(t.ch.shut).toBe(1);
  });

  it("run one sign-in per agent or server on a target: a second start joins the running one, which ends once nobody follows it", async () => {
    const t = acting({ now: "running" });
    const a: Record<string, unknown>[] = [];
    const b: Record<string, unknown>[] = [];
    const [first, second] = await Promise.all([
      t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void a.push(e)),
      t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void b.push(e)),
    ]);
    expect(second.signInId).toBe(first.signInId);
    expect(t.planned).toHaveLength(1);
    await tick();
    t.ch.push({ url: "https://auth.openai.com/codex/device" });
    // One who joins late is shown where it stands.
    const c: Record<string, unknown>[] = [];
    const third = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void c.push(e));
    expect(third.signInId).toBe(first.signInId);
    expect(c).toEqual([{ type: "agents.signIn", signInId: first.signInId, state: "waiting", url: "https://auth.openai.com/codex/device" }]);
    expect([a, b].map(x => x.length)).toEqual([1, 1]);
    // Another server, or another target, is a sign-in of its own.
    const other = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "claude", server: "notion" }, () => {});
    expect(other.signInId).not.toBe(first.signInId);
    other.leave();
    first.leave();
    second.leave();
    await tick();
    expect(t.ch.shut).toBe(1);
    third.leave();
    await tick();
    expect(t.ch.shut).toBe(2);
  });

  it("stop a sign-in by its id for everyone following it, so the next start runs fresh, and refuse an id that is not running", async () => {
    const t = acting({ now: "running" });
    const seen: Record<string, unknown>[] = [];
    const first = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void seen.push(e));
    const joined = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, () => {});
    t.api.signInStop(first.signInId);
    const fresh = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, () => {});
    expect(fresh.signInId).not.toBe(first.signInId);
    expect(t.planned).toHaveLength(2);
    await tick();
    expect(t.ch.shut).toBe(1);
    expect(seen.at(-1)).toMatchObject({ signInId: first.signInId, state: "signed-in" });
    expect(() => t.api.signInStop(first.signInId)).toThrow(noSignInRefusal);
    joined.leave();
    fresh.leave();
  });

  it("hand a key and the wsp tools to the host, and say what changed: every report for a key, the one target for the tools", async () => {
    const t = acting({ now: "running" });
    await t.api.key("claude", "sk-ant-oat01-x");
    expect(await t.api.addTools({ placeId: "here" }, "codex")).toEqual({ file: "~/.codex/config.toml" });
    expect(t.changed).toEqual([undefined, { placeId: "here" }]);
    expect(await t.api.signInLine({ placeId: "here" }, { agent: "codex" })).toEqual({ command: "codex login --device-auth" });
  });
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));

describe("the skills on a computer or a workspace", () => {
  function skills(phase: { now: WorkspacePhase }): { asked: [string, unknown, unknown][]; changed: (AgentsTarget | undefined)[]; api: ReturnType<typeof agentsReads<undefined>> } {
    const asked: [string, unknown, unknown][] = [];
    const changed: (AgentsTarget | undefined)[] = [];
    const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
    const acts: SkillsActs = {
      search: async (q, limit) => (asked.push(["search", q, limit]), [{ id: "a/b/pdf", source: "a/b", skillId: "pdf", name: "pdf", installs: 3 }]),
      get: async skill => (asked.push(["get", skill, undefined]), { text: "# pdf", size: 5 }),
      preview: async (on, ask) => (asked.push(["preview", on, ask]), { text: "# pdf", size: 5 }),
      add: async (on, ask) => (asked.push(["add", on, ask]), { path: "~/.agents/skills/pdf", agents: [] }),
      remove: async (on, ask) => {
        asked.push(["remove", on, ask]);
        throw new Error("rm failed");
      },
      toggle: async (on, ask) => (asked.push(["toggle", on, ask]), { paths: ["~/.agents/skills/pdf"] }),
    };
    const api = agentsReads<undefined>({
      reader: undefined,
      places: () => undefined,
      workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: phase.now, local: false, machine, project: LANDING }),
      skills: acts,
      channel: async () => {
        throw new Error("no channel on this road");
      },
      changed: target => void changed.push(target),
      now: () => Date.parse("2026-09-24T12:00:00Z"),
    });
    return { asked, changed, api };
  }

  it("searches with twenty hits unless told otherwise, and reads a skills.sh skill with no target", async () => {
    const { asked, api } = skills({ now: "running" });
    expect(await api.skillsSearch("pdf")).toHaveLength(1);
    await api.skillsSearch("pdf", 5);
    expect(await api.skillsGet("a/b/pdf")).toEqual({ text: "# pdf", size: 5 });
    expect(asked).toEqual([["search", "pdf", 20], ["search", "pdf", 5], ["get", "a/b/pdf", undefined]]);
  });

  it("changes a skill on the workspace's own machine and says the report there changed, whether the write held or not", async () => {
    const { asked, changed, api } = skills({ now: "running" });
    const target = { workspaceId: "ws_1" };
    await api.skillsAdd(target, { skill: "a/b/pdf", project: true });
    await api.skillsToggle(target, { name: "pdf", on: false });
    await expect(api.skillsRemove(target, { name: "pdf" })).rejects.toThrow("rm failed");
    expect(await api.skillsPreview(target, { name: "pdf" })).toEqual({ text: "# pdf", size: 5 });
    expect(asked.map(([what, on]) => [what, (on as AgentsOn).kind])).toEqual([["add", "machine"], ["toggle", "machine"], ["remove", "machine"], ["preview", "machine"]]);
    expect(changed).toEqual([target, target, target]);
  });

  it("never touches a napping workspace's skills", async () => {
    const { asked, changed, api } = skills({ now: "napping" });
    const target = { workspaceId: "ws_1" };
    for (const act of [() => api.skillsAdd(target, { skill: "a/b/pdf" }), () => api.skillsToggle(target, { name: "pdf", on: false }), () => api.skillsRemove(target, { name: "pdf" }), () => api.skillsPreview(target, { name: "pdf" })]) {
      await expect(act()).rejects.toThrow(nappingSkillsRefusal("landing"));
    }
    expect(asked).toEqual([]);
    expect(changed).toEqual([]);
  });
});

describe("the MCP servers written on a computer or a workspace", () => {
  function servers(phase: { now: WorkspacePhase }): { asked: [string, unknown, unknown][]; changed: (AgentsTarget | undefined)[]; api: ReturnType<typeof agentsReads<undefined>> } {
    const asked: [string, unknown, unknown][] = [];
    const changed: (AgentsTarget | undefined)[] = [];
    const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
    const acts: ServersActs = {
      add: async (on, ask) => (asked.push(["add", on, ask]), { file: "~/.claude.json" }),
      remove: async (on, ask) => {
        asked.push(["remove", on, ask]);
        throw new Error("the file changed");
      },
      toggle: async (on, ask) => (asked.push(["toggle", on, ask]), { file: "~/.codex/config.toml" }),
    };
    const api = agentsReads<undefined>({
      reader: undefined,
      places: () => undefined,
      workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: phase.now, local: false, machine, project: LANDING }),
      servers: acts,
      channel: async () => {
        throw new Error("no channel on this road");
      },
      changed: target => void changed.push(target),
      now: () => Date.parse("2026-09-24T12:00:00Z"),
    });
    return { asked, changed, api };
  }

  it("changes a server on the workspace's own machine and says the report there changed, whether the write held or not", async () => {
    const { asked, changed, api } = servers({ now: "running" });
    const target = { workspaceId: "ws_1" };
    expect(await api.serversAdd(target, { agent: "claude", name: "acme", command: "npx", env: { A: "sk-x" } })).toEqual({ file: "~/.claude.json" });
    expect(await api.serversToggle(target, { agent: "codex", name: "acme", on: false })).toEqual({ file: "~/.codex/config.toml" });
    await expect(api.serversRemove(target, { agent: "claude", name: "acme", scope: "project" })).rejects.toThrow("the file changed");
    expect(asked.map(([what, on, ask]) => [what, (on as AgentsOn).kind, ask])).toEqual([
      ["add", "machine", { agent: "claude", name: "acme", command: "npx", env: { A: "sk-x" } }],
      ["toggle", "machine", { agent: "codex", name: "acme", on: false }],
      ["remove", "machine", { agent: "claude", name: "acme", scope: "project" }],
    ]);
    expect(changed).toEqual([target, target, target]);
  });

  it("never touches a napping workspace's servers, and refuses on a runtime wired without the acts", async () => {
    const { asked, changed, api } = servers({ now: "napping" });
    const target = { workspaceId: "ws_1" };
    for (const act of [() => api.serversAdd(target, { agent: "claude", name: "acme", command: "npx" }), () => api.serversToggle(target, { agent: "codex", name: "acme", on: true }), () => api.serversRemove(target, { agent: "claude", name: "acme" })]) {
      await expect(act()).rejects.toThrow(nappingServersRefusal("landing"));
    }
    expect(asked).toEqual([]);
    expect(changed).toEqual([]);
    const bare = agentsReads<undefined>({ reader: undefined, places: () => undefined, workspace: async () => { throw new Error("no workspace"); }, channel: async () => { throw new Error("no channel"); }, changed: () => {}, now: () => 0 });
    await expect(bare.serversAdd({ placeId: "here" }, { agent: "claude", name: "acme", command: "npx" })).rejects.toThrow(NO_AGENTS_READER);
  });
});

describe("the projects a computer's report covers", () => {
  const SPOO = { id: "pr_spoo", name: "spoo", path: "/home/ada/spoo" };
  const WWW = { id: "pr_www", name: "www", path: "/home/ada/www" };
  const door = {
    list: async () => [{ id: "pl_1", name: "box", kind: "computer" }],
    reportOf: async () => undefined,
    signInsAt: () => undefined,
    loginLanded: async () => {},
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  } as unknown as PlaceDoor;
  function computer(held: Record<string, readonly (typeof SPOO)[]> = { pl_1: [SPOO, WWW], here: [WWW] }) {
    const read: AgentsOn[] = [];
    const acted: AgentsOn[] = [];
    const changed: (AgentsTarget | undefined)[] = [];
    const skills = { remove: async (on: AgentsOn) => (acted.push(on), { removed: [] }) } as unknown as SkillsActs;
    const api = agentsReads<undefined>({
      reader: { read: async on => (read.push(on), READ), tools: async on => (acted.push(on), { auth: "open", readAt: "2026-09-25T12:00:00.000Z" }) },
      skills,
      places: () => door,
      projects: async placeId => held[placeId] ?? [],
      workspace: async () => {
        throw new Error("no workspace");
      },
      channel: async () => {
        throw new Error("no channel");
      },
      changed: target => void changed.push(target),
      now: () => Date.parse("2026-09-25T12:00:00Z"),
    });
    return { api, read, acted, changed };
  }

  it("a read of a computer covers every project this host holds on it, and of this one its own", async () => {
    const c = computer();
    await c.api.read({ placeId: "pl_1" });
    await c.api.read({ placeId: "here" });
    expect(c.read.map(on => [on.kind, on.projects])).toEqual([
      ["box", [SPOO, WWW]],
      ["here", [WWW]],
    ]);
  });

  it("an act names one project by id and works in that one alone; one the computer does not hold is refused; the change is the computer's", async () => {
    const c = computer();
    await c.api.skillsRemove({ placeId: "pl_1", project: "pr_www" }, { name: "deploy", project: true });
    await c.api.tools({ placeId: "pl_1", project: "pr_spoo" }, { agent: "claude", name: "db" });
    await c.api.tools({ placeId: "pl_1" }, { agent: "claude", name: "notion" });
    expect(c.acted.map(on => on.projects)).toEqual([[WWW], [SPOO], undefined]);
    expect(c.acted.map(on => projectOf(on))).toEqual(["/home/ada/www", "/home/ada/spoo", undefined]);
    expect(c.changed).toEqual([{ placeId: "pl_1" }]);
    await expect(c.api.read({ placeId: "pl_1", project: "pr_gone" })).rejects.toThrow(noSuchAgentsProjectRefusal("pr_gone", "box"));
    await expect(c.api.skillsRemove({ placeId: "here", project: "pr_spoo" }, { name: "deploy", project: true })).rejects.toThrow(noSuchAgentsProjectRefusal("pr_spoo", "this computer"));
  });

  it("names a project by its id or by its name, and a name two projects there share is refused naming the way out", async () => {
    const c = computer({ pl_1: [SPOO, WWW, { id: "pr_www2", name: "www", path: "/home/ada/www2" }], here: [SPOO] });
    await c.api.skillsRemove({ placeId: "here", project: "spoo" }, { name: "deploy", project: true });
    await c.api.skillsRemove({ placeId: "pl_1", project: "pr_www2" }, { name: "deploy", project: true });
    expect(c.acted.map(on => projectOf(on))).toEqual(["/home/ada/spoo", "/home/ada/www2"]);
    await expect(c.api.skillsRemove({ placeId: "pl_1", project: "www" }, { name: "deploy", project: true })).rejects.toThrow(sharedAgentsProjectRefusal("www", "box"));
  });
});
