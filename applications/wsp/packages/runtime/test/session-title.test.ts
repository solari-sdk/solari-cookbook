// SPDX-License-Identifier: AGPL-3.0-only
// The adapter here answers the store read and the store write the way the real
// ones do: one shell line to the machine, its stdout the harness's own title or
// what became of the name. What is under test is the runtime's side of it,
// which asks the harness for a name when a thread's first turn starts, reads
// the store at a turn's end and on a refresh, names the session on the machine
// when a client renames the thread, and keeps the answer on the rows a thread
// is folded from.
import { randomUUID } from "node:crypto";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { createCodexAdapter } from "@wsp/adapter-codex";
import { THREAD_AGENTS, type ThreadAgent } from "@wsp/catalog";
import { ExecFailedError, MachineUnreachableError, type Machine } from "@wsp/engine";
import { EMPTY_TITLE_LINE, foldThreads, keepsRename, machineUnreachableLine, signInRefusalLine, type AdapterEvent, type TitleTurn, type TurnResult } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { machineExecStream } from "../src/machine-exec.js";
import { SESSION_TITLE_REFRESH_MAX, SESSION_TITLE_TTL_MS, createRuntime, type HarnessAdapter, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";

const SESSION = "33333333-3333-4333-8333-333333333333";
const TITLE_COMMAND = "wsp-title-read";
const RENAME_COMMAND = "wsp-title-write";

/**
 * An adapter whose turn runs to its end on its own, and which reads its title with one line to the machine. A
 * resumed start announces the id it was given, as both real adapters do; `rekeys` mints its own local id beside it,
 * the way the codex adapter does, so two rows can share one harness session, and `announces: false` is a turn that
 * died before its harness ever named a session, as a launch that never reached the machine does.
 */
function titledAdapter(
  options: {
    keepsTitles?: boolean;
    keepsNames?: boolean;
    rekeys?: boolean;
    announces?: boolean;
    reader?: HarnessAdapter["sessionTitle"];
    /** What the harness answers when asked to name a thread; absent means a harness that cannot be asked at all. */
    maker?: HarnessAdapter["titleFor"];
    /** What the turn replies; the title question is asked of it. */
    reply?: string;
    /** Held open, the turn runs until the test lets it end. */
    hold?: () => Promise<void>;
    /** What an interrupt does to a turn held open. A real harness ends the turn when the host interrupts it, which
     * is what a delete does to every thread on the workspace before the machine goes. */
    endsOnInterrupt?: boolean;
    /** Every start's options, so a test can read what the launch carried. */
    starts?: HarnessStartOptions[];
  } = {},
): HarnessAdapterFactory {
  const reader: HarnessAdapter["sessionTitle"] =
    options.reader ??
    ((sessionId, exec) => exec(`${TITLE_COMMAND} ${sessionId}`).then(stdout => (stdout.trim() === "" ? null : stdout.trim())));
  // The three answers a real store's line gives, off the same stdout the real parsers read.
  const writer: HarnessAdapter["renameSession"] = (sessionId, title, exec) =>
    exec(`${RENAME_COMMAND} ${sessionId} ${title}`).then(stdout => {
      const said = stdout.trim();
      if (said === "written") return { kind: "written" };
      if (said === "no-session") return { kind: "no-session" };
      return { kind: "failed", error: said };
    });
  return () => ({
    steers: false,
    ...(options.keepsTitles === false ? {} : { sessionTitle: reader }),
    ...(options.maker !== undefined ? { titleFor: options.maker } : {}),
    ...(options.keepsNames === true ? { renameSession: writer } : {}),
    start: o => {
      options.starts?.push(o);
      const sessionId = o.resume ?? SESSION;
      const result: TurnResult = { status: "completed", text: options.reply ?? "ok" };
      const emit = (e: AdapterEvent): void => o.onEvent(e);
      let interrupted!: () => void;
      const ended = new Promise<void>(resolve => {
        interrupted = resolve;
      });
      const finished = (async () => {
        if (options.announces !== false) emit({ type: "session.start", sessionId });
        await (options.endsOnInterrupt === true && options.hold !== undefined ? Promise.race([options.hold(), ended]) : options.hold?.());
        emit({ type: "turn.done", sessionId, result });
        emit({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: options.rekeys === true ? randomUUID() : sessionId, finished, interrupt: async () => interrupted() };
    },
  });
}

/** A promise the test opens when it likes: a turn held open, or a title question the harness has not answered yet. */
function gate<T>(): { open: (value: T) => void; wait: Promise<T> } {
  let open!: (value: T) => void;
  const wait = new Promise<T>(resolve => {
    open = resolve;
  });
  return { open, wait };
}

/** A backend whose guest answers the title command with `titled()` and nothing else, counting the reads. With
 * `wrote`, it answers the write command too, in the words a real store's line prints: `written`, `no-session`, or
 * anything else, which is the machine's own line for a write that did not land. */
function titledBackend(titled: () => string | null, wrote?: (title: string) => string) {
  const backend = stubBackend();
  const reads: string[] = [];
  const writes: string[] = [];
  const inner = backend.execImpl;
  backend.execImpl = (m, cmd) => {
    if (cmd.startsWith(RENAME_COMMAND)) {
      writes.push(cmd);
      const title = cmd.slice(`${RENAME_COMMAND} `.length).split(" ").slice(1).join(" ");
      return { exitCode: 0, stdout: wrote?.(title) ?? "", stderr: "" };
    }
    if (!cmd.startsWith(TITLE_COMMAND)) return inner(m, cmd);
    reads.push(cmd);
    return { exitCode: 0, stdout: titled() ?? "", stderr: "" };
  };
  return { backend, reads, writes };
}

const titleOf = async (rt: ReturnType<typeof createRuntime>, workspaceId: string): Promise<string> =>
  foldThreads(await rt.sessions.list(workspaceId))[0]!.title;

describe("the harness's own title on a thread", () => {
  it("is read from the harness's store when the turn ends and is what every client folds the thread by", async () => {
    const { backend, reads } = titledBackend(() => "Building the server");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server, and its tests" })).finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    expect(reads).toEqual([`${TITLE_COMMAND} ${SESSION}`]);
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
  });

  it("follows a rename made inside the harness: the refresh past the window reads it, the listing after shows it", async () => {
    let named = "Building the server";
    const { backend } = titledBackend(() => named);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    expect(await titleOf(rt, ws.id)).toBe("Building the server");

    named = "the sidebar's own name";
    // Inside the window nothing is read at all.
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
    advance(SESSION_TITLE_TTL_MS + 1);
    // Past it the read goes out, but a row that already carries a title is answered from the index rather than
    // waited on, so a wedged guest cannot empty the listing; the rename is on the row by the listing after.
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle === "the sidebar's own name");
    expect(await titleOf(rt, ws.id)).toBe("the sidebar's own name");
  });

  it("costs one read per session per window however often a client refreshes", async () => {
    const { backend, reads } = titledBackend(() => "Building the server");
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => reads.length === 1);
    for (let i = 0; i < 5; i++) await rt.sessions.list(ws.id);
    expect(reads).toHaveLength(1);
    advance(SESSION_TITLE_TTL_MS + 1);
    await rt.sessions.list(ws.id);
    expect(reads).toHaveLength(2);
  });

  it("keeps the title it last read while the machine naps, and asks nothing of a machine that is not running", async () => {
    let named: string | null = "Building the server";
    const { backend, reads } = titledBackend(() => named);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => reads.length === 1);
    await rt.workspaces.nap(ws.id);
    named = null;
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
    expect(reads).toHaveLength(1);
  });

  it("outlives the process: a host that started again reads the title back off the session index", async () => {
    let named: string | null = "Building the server";
    const { backend, reads } = titledBackend(() => named);
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: titledAdapter() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    // The row's own document, which is what the next process reads the index back out of.
    const stored = async (): Promise<string | undefined> =>
      ((await store.get("sessions", ws.id)) as { sessions: { harnessTitle?: string }[] } | undefined)?.sessions[0]?.harnessTitle;
    await until(async () => (await stored()) === "Building the server");
    expect(reads).toHaveLength(1);

    named = null;
    const again = createRuntime({ backend, store, adapters: { claude: titledAdapter() } });
    expect(await titleOf(again, ws.id)).toBe("Building the server");
  });

  it("fails one row's title, never the listing, when the adapter refuses the id on the calling stack", async () => {
    // The real codex reader, whose command guard throws where it is built: a row keyed to something that is not a
    // plain slug must cost that row's title and nothing else. Review round 1, should-fix 1.
    const codex = createCodexAdapter({ exec: () => { throw new Error("no turns here"); }, home: "/root/.codex", login: "codex login" });
    const { backend } = titledBackend(() => null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ reader: codex.sessionTitle }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    try {
      await (await rt.sessions.start(ws.id, { prompt: "make a server", resume: "-not-a-slug" })).finished;
      const rows = await rt.sessions.list(ws.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty("harnessTitle");
      expect(await titleOf(rt, ws.id)).toBe("make a server");
      // The reason is said once per read, at the start and at the end of the turn, not once per refresh.
      await rt.sessions.list(ws.id);
      expect(warn.mock.calls.filter(([line]) => String(line).includes("plain slug"))).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks about the newest sessions only, and never more than the cap in one refresh", async () => {
    // The store answers nothing throughout, so no row ever carries a title and the refresh below waits on every
    // read it starts: the count and the ids are the refresh's own.
    const { backend, reads } = titledBackend(() => null);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const ids = [...Array(SESSION_TITLE_REFRESH_MAX + 1).keys()].map(i => `s-${String(i).padStart(2, "0")}`);
    for (const id of ids) {
      advance(1_000);
      // A row's startedAt is the wall clock, which the pick sorts on, so the turns are spaced in it and not only
      // in the runtime's own clock.
      await new Promise(r => setTimeout(r, 2));
      await (await rt.sessions.start(ws.id, { prompt: `turn ${id}`, resume: id })).finished;
    }
    await until(async () => reads.length >= ids.length);
    // One listing inside the window, which waits on every read still in flight from a turn's end.
    await rt.sessions.list(ws.id);

    reads.length = 0;
    advance(SESSION_TITLE_TTL_MS + 1);
    await rt.sessions.list(ws.id);
    expect(reads.map(cmd => cmd.split(" ")[1]!).sort()).toEqual(ids.slice(1).sort());
  });

  it("asks once per harness session however many of a thread's turns carry it", async () => {
    const { backend, reads } = titledBackend(() => null);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ rekeys: true }) }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server", resume: SESSION })).finished;
    advance(1_000);
    await (await rt.sessions.start(ws.id, { prompt: "and tests", resume: SESSION })).finished;
    // Two rows, one harness session: the adapter minted its own local id per turn, as the codex one does.
    expect((await rt.sessions.list(ws.id)).filter(v => v.claudeSessionId === SESSION)).toHaveLength(2);

    reads.length = 0;
    advance(SESSION_TITLE_TTL_MS + 1);
    await rt.sessions.list(ws.id);
    expect(reads).toEqual([`${TITLE_COMMAND} ${SESSION}`]);
  });

  it("leaves the opening turn's words alone for a harness that keeps no title, and asks its machine nothing", async () => {
    const { backend, reads } = titledBackend(() => "never asked");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsTitles: false }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server\nand its tests" })).finished;
    expect(await titleOf(rt, ws.id)).toBe("make a server");
    expect((await rt.sessions.list(ws.id))[0]).not.toHaveProperty("harnessTitle");
    expect(reads).toEqual([]);
  });

  it("keeps the opening turn's words when the store has no title for the session, and asks again rather than caching the miss forever", async () => {
    let named: string | null = null;
    const { backend, reads } = titledBackend(() => named);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => reads.length === 1);
    expect(await titleOf(rt, ws.id)).toBe("make a server");
    named = "Building the server";
    advance(SESSION_TITLE_TTL_MS + 1);
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
  });
});

describe("a title read that fails", () => {
  /** A guest whose store read fails with what `fail()` throws while it returns something, and answers `named` otherwise. */
  function failingBackend(fail: () => Error | undefined, named = "Building the server") {
    const backend = stubBackend();
    const reads: string[] = [];
    const inner = backend.execImpl;
    backend.execImpl = (m, cmd) => {
      if (!cmd.startsWith(TITLE_COMMAND)) return inner(m, cmd);
      reads.push(cmd);
      const e = fail();
      if (e !== undefined) throw e;
      return { exitCode: 0, stdout: named, stderr: "" };
    };
    return { backend, reads };
  }
  const titleLines = (warn: { mock: { calls: unknown[][] } }): string[] => warn.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("no title for session"));

  it("says once, with the provider's status, that a machine the provider cannot reach gave no title, and reads nothing more while the mark stands", async () => {
    const { backend, reads } = failingBackend(() => new MachineUnreachableError("m1", "Sandbox is not reachable", 503, machineUnreachableLine("Sandbox is not reachable")));
    const { clock, advance } = fakeClock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
      await until(() => titleLines(warn).length === 1);
      for (let i = 0; i < 3; i++) {
        advance(SESSION_TITLE_TTL_MS + 1);
        await rt.sessions.list(ws.id);
      }
      await new Promise(r => setTimeout(r, 20));
      expect(titleLines(warn)).toEqual([`no title for session ${SESSION.slice(0, 8)} on ${ws.id}: 503 Sandbox is not reachable`]);
      expect(reads).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("says once that a machine the provider cannot run commands on gave no title, with the status, and reads nothing more while the mark stands", async () => {
    const { backend, reads } = failingBackend(() => new ExecFailedError("m1", "exec failed", 502));
    const { clock, advance } = fakeClock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
      await until(() => titleLines(warn).length === 1);
      for (let i = 0; i < 3; i++) {
        advance(SESSION_TITLE_TTL_MS + 1);
        await rt.sessions.list(ws.id);
      }
      await new Promise(r => setTimeout(r, 20));
      expect(titleLines(warn)).toEqual([`no title for session ${SESSION.slice(0, 8)} on ${ws.id}: 502 exec failed`]);
      expect(reads).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("says a store read that keeps failing for another reason once, until a read answers", async () => {
    let failing = true;
    const { backend, reads } = failingBackend(() => (failing ? new Error("timed out after 15000 ms") : undefined));
    const { clock, advance } = fakeClock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const line = `no title for session ${SESSION.slice(0, 8)} on ${ws.id}: timed out after 15000 ms`;
      await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
      await until(() => titleLines(warn).length === 1);
      for (let i = 0; i < 3; i++) {
        advance(SESSION_TITLE_TTL_MS + 1);
        await rt.sessions.list(ws.id);
      }
      expect(reads).toHaveLength(4);
      expect(titleLines(warn)).toEqual([line]);
      failing = false;
      advance(SESSION_TITLE_TTL_MS + 1);
      await rt.sessions.list(ws.id);
      await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle === "Building the server");
      failing = true;
      advance(SESSION_TITLE_TTL_MS + 1);
      await rt.sessions.list(ws.id);
      await until(() => titleLines(warn).length === 2);
      expect(titleLines(warn)).toEqual([line, line]);
      expect(reads).toHaveLength(6);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the title the harness makes for a thread", () => {
  const OPENING = "make a server, and its tests";

  it("asks the harness once when the turn starts, from the opening turn alone and on the cheapest model its catalog lists, so the seed goes before the turn ends", async () => {
    const turn = gate<void>();
    const answer = gate<string | null>();
    const asked: TitleTurn[] = [];
    const { backend } = titledBackend(() => null);
    const { clock } = fakeClock();
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: {
        claude: titledAdapter({
          reply: "the server is up on 3000",
          hold: () => turn.wait,
          maker: t => {
            asked.push(t);
            return answer.wait;
          },
        }),
      },
      clock,
    });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: OPENING });
    // The question goes out at the start, with no reply to carry; the seed stands only while the harness thinks.
    await until(() => asked.length === 1);
    expect(asked).toEqual([{ opening: OPENING, model: "claude-haiku-4-5-20251001" }]);
    expect(await titleOf(rt, ws.id)).toBe(OPENING);

    answer.open("Seed thread titles here");
    await until(async () => (await rt.sessions.list(ws.id))[0]?.titleSource === "auto");
    expect(await titleOf(rt, ws.id)).toBe("Seed thread titles here");
    expect((await rt.sessions.list(ws.id))[0]?.status).toBe("running");

    turn.open();
    await handle.finished;
    await new Promise(r => setTimeout(r, 5));
    expect(asked).toHaveLength(1);
    expect(await titleOf(rt, ws.id)).toBe("Seed thread titles here");
  });

  it("asks nothing for a turn whose harness never named a session, since its start never came to anything", async () => {
    const asked: unknown[] = [];
    const { backend } = titledBackend(() => null);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ announces: false, maker: async t => (asked.push(t), "Seed thread titles here") }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
    await new Promise(r => setTimeout(r, 5));
    expect(asked).toEqual([]);
    expect(await titleOf(rt, ws.id)).toBe(OPENING);
  });

  it("writes the name it made into the harness's own store, so the harness's own list says the same", async () => {
    const { backend, writes } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true, maker: async () => "Seed thread titles here" }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
    await until(async () => writes.length === 1);
    expect(writes).toEqual([`${RENAME_COMMAND} ${SESSION} Seed thread titles here`]);
  });

  it("never replaces what the harness itself calls the session, which is the person's, and does not ask for a title at all", async () => {
    const asked: unknown[] = [];
    const { backend } = titledBackend(() => "the sidebar's own name");
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: titledAdapter({ maker: async t => (asked.push(t), "Seed thread titles here") }) },
    });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    expect(await titleOf(rt, ws.id)).toBe("the sidebar's own name");
    // What the harness's own store calls a session is the person's, whether they typed it or the harness made it.
    expect((await rt.sessions.list(ws.id))[0]?.titleSource).toBe("person");
    expect(asked).toEqual([]);
  });

  it("asks for a name when the store's title is only the opening words, as codex writes them when a thread starts", async () => {
    // The codex CLI names a thread from its opening words the moment it starts, so that title is the seed under
    // another roof, not a person's name; the head of the opening words is what a longer brief leaves in the column.
    for (const stored of [OPENING, "make a server"]) {
      const asked: unknown[] = [];
      const { backend } = titledBackend(() => stored);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ maker: async t => (asked.push(t), "Seed thread titles here") }) } });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
      await until(async () => (await rt.sessions.list(ws.id))[0]?.titleSource === "auto");
      expect(asked, stored).toHaveLength(1);
      expect(await titleOf(rt, ws.id)).toBe("Seed thread titles here");
    }
  });

  it("keeps the name it made when the store still answers with the opening words, since a seed is no news to a named row", async () => {
    // Codex's title column keeps the opening words until the name lands in its own column, and a refresh that reads it
    // meanwhile, or after a write the store refused, may not take the made name away.
    const { backend, reads } = titledBackend(() => OPENING);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ maker: async () => "Seed thread titles here" }) }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.titleSource === "auto");
    const before = reads.length;
    advance(SESSION_TITLE_TTL_MS + 1);
    await rt.sessions.list(ws.id);
    await until(() => reads.length > before);
    await rt.sessions.list(ws.id);
    expect(await titleOf(rt, ws.id)).toBe("Seed thread titles here");
    expect((await rt.sessions.list(ws.id))[0]?.titleSource).toBe("auto");
  });

  it("throws away an answer that lands after a rename: the person's name stands", async () => {
    const answer = gate<string | null>();
    let named: string | null = null;
    const { backend } = titledBackend(() => named);
    const { clock, advance } = fakeClock();
    let asks = 0;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ maker: () => (asks += 1, answer.wait) }) }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
    await until(async () => asks === 1);
    // The harness is thinking about a title; meanwhile the person renames the session inside the harness itself.
    named = "the sidebar's own name";
    advance(SESSION_TITLE_TTL_MS + 1);
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle === "the sidebar's own name");

    answer.open("Seed thread titles here");
    await until(async () => (await rt.sessions.list(ws.id)).length === 1);
    expect(await titleOf(rt, ws.id)).toBe("the sidebar's own name");
    expect((await rt.sessions.list(ws.id))[0]?.titleSource).toBe("person");
  });

  it("keeps the opening words when the harness answers with something that is not a title, and asks nothing more", async () => {
    // The real claude reader parses the answer, so what is under test is the whole road: an answer that explains
    // itself over two lines is refused where it is read and the thread is left as it was.
    const claude = createClaudeAdapter({
      exec: () => {
        throw new Error("no turns here");
      },
      configDir: "/root/.claude-cfg",
    });
    const backend = stubBackend();
    const inner = backend.execImpl;
    const answers: string[] = [];
    backend.execImpl = (m, cmd) => {
      if (!cmd.includes("claude -p")) return inner(m, cmd);
      answers.push(cmd);
      return { exitCode: 0, stdout: '{"type":"result","is_error":false,"result":"Sure! Here is a title:\\nThread titles through the harness"}', stderr: "" };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsTitles: false, maker: claude.titleFor }) } });
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
      await until(async () => answers.length === 1);
      expect(await titleOf(rt, ws.id)).toBe(OPENING);
      expect((await rt.sessions.list(ws.id))[0]).not.toHaveProperty("titleSource");
      expect(warn.mock.calls.filter(([line]) => String(line).includes("keeps its opening words"))).toHaveLength(1);

      // A second turn on the same thread does not ask again: nothing retries in a loop.
      await (await rt.sessions.start(ws.id, { prompt: "and now the tests", resume: SESSION })).finished;
      await new Promise(r => setTimeout(r, 5));
      expect(answers).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the name it made through the thread's later turns, which the fold titles by", async () => {
    const { backend } = titledBackend(() => null);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ rekeys: true, maker: async () => "Seed thread titles here" }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: OPENING })).finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.titleSource === "auto");
    await (await rt.sessions.start(ws.id, { prompt: "and now the tests", resume: SESSION })).finished;
    expect(await titleOf(rt, ws.id)).toBe("Seed thread titles here");
  });

  it("names a thread the start named, at the launch and in the harness's store, and asks for no title of its own", async () => {
    const starts: HarnessStartOptions[] = [];
    const asked: unknown[] = [];
    const turn = gate<void>();
    const { backend, writes } = titledBackend(() => null, () => "written");
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: titledAdapter({ starts, keepsNames: true, hold: () => turn.wait, maker: async t => (asked.push(t), "Seed thread titles here") }) },
    });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: OPENING, title: " Ticket 411 review\nand its branch " });
    // The name stands from the first second, before any turn has ended.
    expect(await titleOf(rt, ws.id)).toBe("Ticket 411 review");
    expect((await rt.sessions.list(ws.id))[0]?.titleSource).toBe("person");
    expect(starts[0]?.title).toBe("Ticket 411 review");
    await until(async () => writes.length === 1);
    expect(writes).toEqual([`${RENAME_COMMAND} ${SESSION} Ticket 411 review`]);

    turn.open();
    await handle.finished;
    await new Promise(r => setTimeout(r, 5));
    expect(asked).toEqual([]);
    expect(await titleOf(rt, ws.id)).toBe("Ticket 411 review");
  });

  it("refuses a start named with nothing at all", async () => {
    const { backend } = titledBackend(() => null);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await expect(rt.sessions.start(ws.id, { prompt: OPENING, title: "  \n " })).rejects.toThrow(EMPTY_TITLE_LINE);
  });
});

describe("naming a thread from wsp", () => {
  it("writes the name into the harness's own store and keeps it on every row of the thread", async () => {
    let named: string | null = null;
    const { backend, writes } = titledBackend(() => named, title => {
      named = title;
      return "written";
    });
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true, rekeys: true }) }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server", resume: SESSION })).finished;
    advance(1_000);
    const second = await rt.sessions.start(ws.id, { prompt: "and tests", resume: SESSION });
    await second.finished;

    expect(await rt.sessions.rename(second.id, "the name he typed in wsp")).toEqual({ outcome: "renamed" });
    expect(writes).toEqual([`${RENAME_COMMAND} ${SESSION} the name he typed in wsp`]);
    const rows = (await rt.sessions.list(ws.id)).filter(v => v.claudeSessionId === SESSION);
    expect(rows).toHaveLength(2);
    expect(rows.map(v => v.harnessTitle)).toEqual(["the name he typed in wsp", "the name he typed in wsp"]);
    expect(await titleOf(rt, ws.id)).toBe("the name he typed in wsp");
    // The harness's own store is where the name now lives, so the next read past the window brings it back.
    advance(SESSION_TITLE_TTL_MS + 1);
    expect(await titleOf(rt, ws.id)).toBe("the name he typed in wsp");
  });

  it("outlives the process: the name is on the session index the next host reads back", async () => {
    const store = memoryStore();
    const { backend } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store, adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await rt.sessions.rename(session.id, "the name");
    expect(((await store.get("sessions", ws.id)) as { sessions: { harnessTitle?: string }[] }).sessions[0]?.harnessTitle).toBe("the name");
  });

  it("answers unsupported for a harness that keeps no name of a person's, and asks its machine nothing", async () => {
    const { backend, writes } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    expect(await rt.sessions.rename(session.id, "the name")).toEqual({ outcome: "unsupported" });
    expect(writes).toEqual([]);
    expect(await titleOf(rt, ws.id)).toBe("make a server");
  });

  it("answers no-session when the store took nothing, and the row keeps the title it had", async () => {
    const { backend } = titledBackend(() => "Building the server", () => "no-session");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    expect(await rt.sessions.rename(session.id, "the name")).toEqual({ outcome: "no-session" });
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
  });

  it("answers failed with the machine's own line when the store refused the write, and the row keeps the title it had", async () => {
    const { backend } = titledBackend(() => "Building the server", () => "database is locked");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    // Not no-session: a store that refused the write said nothing about which sessions it has.
    expect(await rt.sessions.rename(session.id, "the name")).toEqual({ outcome: "failed", error: "database is locked" });
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
  });

  it("answers no-session for a thread whose harness never named a session, and asks the machine nothing", async () => {
    const { backend, writes } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true, announces: false }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    // The turn ended without a session.start, so the row carries no harness id and the store is keyed by nothing.
    expect((await rt.sessions.list(ws.id))[0]).not.toHaveProperty("claudeSessionId");
    expect(await rt.sessions.rename(session.id, "the name")).toEqual({ outcome: "no-session" });
    expect(writes).toEqual([]);
    expect(await titleOf(rt, ws.id)).toBe("make a server");
  });

  it("answers not-found for a session this runtime does not hold", async () => {
    const { backend } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    await createOn(rt, { golden: "snap_g", name: "a" });
    expect(await rt.sessions.rename("no-such-session", "the name")).toEqual({ outcome: "not-found" });
  });

  it("refuses a name that is nothing but space, before it asks anything of the machine", async () => {
    const { backend, writes } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await expect(rt.sessions.rename(session.id, "   ")).rejects.toThrow(EMPTY_TITLE_LINE);
    expect(writes).toEqual([]);
  });

  it("refuses while the machine is not up, since the name goes into a store on it", async () => {
    const { backend, writes } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await rt.workspaces.nap(ws.id);
    await expect(rt.sessions.rename(session.id, "the name")).rejects.toThrow("wake it to rename");
    expect(writes).toEqual([]);
  });

  it("names the session the harness announced, whatever the runtime calls the row", async () => {
    const { backend, writes } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true, rekeys: true }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server", resume: SESSION });
    await session.finished;
    expect(session.id).not.toBe(SESSION);
    await rt.sessions.rename(session.id, "the name");
    expect(writes).toEqual([`${RENAME_COMMAND} ${SESSION} the name`]);
  });
});

describe("the agents whose store keeps a name", () => {
  it("rides on the harness's catalog row from its adapter, as steers does, and is written nowhere else", async () => {
    const { backend } = titledBackend(() => null, () => "written");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: HARNESS_ADAPTERS });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const rows = await rt.harnesses.list(ws.id);
    expect(rows.map(c => c.harness).sort()).toEqual([...THREAD_AGENTS].sort());
    const machine = { id: "m_1" } as unknown as Machine;
    for (const row of rows) {
      const adapter = HARNESS_ADAPTERS[row.harness as ThreadAgent]({ machine, workspaceId: ws.id, execStream: machineExecStream(machine), home: () => "/root/.state", env: {}, signInRefusal: signInRefusalLine({ kind: "cloud" }), vault: {}, loginStands: () => false });
      expect(row.renames, row.harness).toBe(adapter.renameSession !== undefined);
      expect(keepsRename(row), row.harness).toBe(true);
    }
    // Without a machine the runtime's table answers, which is no answer: a client still offers the rename.
    for (const row of await rt.harnesses.list()) {
      expect(row.source).toBe("table");
      expect(keepsRename(row), row.harness).toBe(true);
    }
  });

  it("a rename of the workspace leaves a running turn alone: it ends with its reply, on the same thread, under the new name", async () => {
    const turn = gate<void>();
    const { backend } = titledBackend(() => null);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ reply: "the server is up on 3000", hold: () => turn.wait }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "make a server, and its tests" });

    // The thread is addressed by id inside, so the name it runs under is the record's alone.
    expect(await rt.workspaces.rename(ws.id, "the name he typed")).toMatchObject({ id: ws.id, name: "the name he typed" });
    const [running] = await rt.sessions.list(ws.id);
    expect(running).toMatchObject({ workspaceId: ws.id, status: "running" });

    turn.open();
    expect(await handle.finished).toMatchObject({ status: "completed", text: "the server is up on 3000" });
    const [ended] = await rt.sessions.list(ws.id);
    expect(ended).toMatchObject({ id: running!.id, workspaceId: ws.id, status: "completed" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.killed).toBe(false);
  });

  it("an adapter that carries no write says so on its row, and a client reads that as a no", async () => {
    const { backend } = titledBackend(() => null);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const [row] = await rt.harnesses.list(ws.id);
    expect(row).toMatchObject({ harness: "claude", renames: false, source: "table" });
    // The row came from the table, so it is no answer yet; the same row from the machine is a no.
    expect(keepsRename(row!)).toBe(true);
    expect(keepsRename({ ...row!, source: "harness" })).toBe(false);
  });
});

describe("a turn the host ended for its machine going away", () => {
  it("asks that machine for no title, so a delete writes no line about a read that could not land", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turn = gate<void>();
    const { backend, reads } = titledBackend(() => "Building the server");
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: titledAdapter({ hold: () => turn.wait, endsOnInterrupt: true }) } });
    // Read off the stored index rather than the listing: a listing of its own asks the harness for the titles it
    // is missing, and what this case is about is the read the turn's own ending starts.
    const rows = async (): Promise<{ status: string }[]> => ((await store.get("sessions", ws.id)) as { sessions: { status: string }[] } | undefined)?.sessions ?? [];
    let ws!: { id: string };
    try {
      ws = await createOn(rt, { golden: "snap_g", name: "a" });
      await rt.sessions.start(ws.id, { prompt: "build it" });
      await until(async () => (await rows())[0]?.status === "running");

      // The machine is taken down after the threads on it are ended, and that window is where the read used to
      // land: the record is still live here, so the title would be asked of a machine on its way out.
      const machine = backend.machines[0]!;
      const kill = gate<void>();
      const killed = machine.kill.bind(machine);
      machine.kill = async () => {
        await kill.wait;
        await killed();
      };
      // The one read a turn pays for at its start, which is the harness's own name for the session: what this
      // case counts is every read after the delete began.
      await until(async () => reads.length === 1);
      const asked = reads.length;
      const deleted = rt.workspaces.delete(ws.id);
      await until(async () => (await rows())[0]?.status !== "running");
      // A window wide enough for the read the turn's ending would have started, with the record still live and
      // the machine still there to answer it.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(reads).toHaveLength(asked);
      kill.open();
      await deleted;

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(reads).toHaveLength(asked);
      expect(machine.execLog.filter(cmd => cmd.startsWith(TITLE_COMMAND))).toHaveLength(asked);
      expect(warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes("no title for session"))).toEqual([]);
    } finally {
      turn.open();
      warn.mockRestore();
      await rt.close();
    }
  });
});
