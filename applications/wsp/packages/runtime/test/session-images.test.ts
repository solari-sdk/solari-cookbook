// SPDX-License-Identifier: AGPL-3.0-only
// What a message's images come to on each of the two roads an adapter can
// declare, and what a message with an image to an agent that declares neither
// comes to. Nothing here is a cloud: the backend is the in-process stub, whose
// upload URLs point at a loopback server that records every body, so the file
// road can be read byte for byte.
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { imagePathIn, noImagesLine, sendRefusal, threadImagesDir, turnImagesDir, type AdapterEvent, type AttachmentRoad, type TurnImage, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** One adapter that records what it was started with, on whichever road the case is about; no road at all when the
 * case is an agent that reads no image. */
function recording(road?: AttachmentRoad): { factory: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    ...(road !== undefined ? { attachments: road } : {}),
    start: (options: HarnessStartOptions) => {
      starts.push(options);
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId: SESSION_ID },
          { type: "turn.done", sessionId: SESSION_ID, result },
          { type: "session.end", sessionId: SESSION_ID, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) options.onEvent(e);
        return result;
      })();
      return { localId: SESSION_ID, finished, interrupt: async () => {} };
    },
  });
  return { factory, starts };
}

/** A path as shellQuote writes it into the guest command, so an exec can be looked for by its whole line. */
const quoted = (path: string): string => `'${path}'`;

/** Waits for something the runtime does after a turn settles, which is not awaited by the caller's handle. */
async function until(ready: () => boolean, tries = 200): Promise<void> {
  for (let nth = 0; nth < tries && !ready(); nth++) await new Promise(resolve => setTimeout(resolve, 5));
  if (!ready()) throw new Error("the runtime never did it");
}

const bytesOf = (fill: number, size = 64): string => Buffer.alloc(size, fill).toString("base64");
const png = (fill = 1, size = 64) => ({ mediaType: "image/png", bytes: bytesOf(fill, size) });

/** An adapter whose every turn fails, so the road a turn takes off the machine can be read for that ending too. */
function failing(road: AttachmentRoad): { factory: HarnessAdapterFactory } {
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    attachments: road,
    start: (options: HarnessStartOptions) => {
      const result: TurnResult = { status: "failed", error: "the harness died" };
      const finished = (async () => {
        options.onEvent({ type: "turn.done", sessionId: SESSION_ID, result });
        options.onEvent({ type: "session.end", sessionId: SESSION_ID, exitCode: 1, sawResult: false });
        return result;
      })();
      return { localId: SESSION_ID, finished, interrupt: async () => {} };
    },
  });
  return { factory };
}

/** Every file in the tars the machine was sent, by path, so the file road can be read as the guest would read it. */
function landedFiles(puts: StubBackend["puts"]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const put of puts) {
    const tar = gunzipSync(put.body);
    for (let at = 0; at + 512 <= tar.length; ) {
      const name = tar.toString("utf8", at, at + 100).replace(/\0.*$/, "");
      if (name === "") break;
      const size = Number.parseInt(tar.toString("utf8", at + 124, at + 135).replace(/\0.*$/, "").trim() || "0", 8);
      files.set(`/${name}`, tar.subarray(at + 512, at + 512 + size));
      at += 512 + Math.ceil(size / 512) * 512;
    }
  }
  return files;
}

/** A workspace on the stub, with what the machine was already sent and told at create marked off: a create lands the
 * daemon, so what an image costs is only ever what came after. */
async function workspaceOn(adapters: Record<string, HarnessAdapterFactory>, backend = stubBackend()) {
  const rt = createRuntime({ backend, store: memoryStore(), adapters });
  const ws = await createOn(rt, { golden: "snap_g", name: "shots" });
  const mark = { puts: backend.puts.length, execs: backend.machines[0]!.execLog.length };
  const since = () => ({ puts: backend.puts.slice(mark.puts), execs: backend.machines[0]!.execLog.slice(mark.execs) });
  return { rt, ws, backend, since };
}

describe("an image on the inline road", () => {
  it("reaches the adapter as bytes with its type, and nothing lands on the machine", async () => {
    const claude = recording("inline");
    const { rt, ws, since } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "what does this show?", attachments: [png(7)] })).finished;
    expect(claude.starts).toHaveLength(1);
    expect(claude.starts[0]!.images).toEqual([{ mediaType: "image/png", bytes: bytesOf(7) }]);
    // Nothing was written to the guest for it: an inline harness reads no file.
    expect(since().puts).toHaveLength(0);
    expect(since().execs.some(cmd => cmd.includes("/images"))).toBe(false);
  });

  it("carries every image of the message, in the order the person added them", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "these two", attachments: [png(1), { mediaType: "image/webp", bytes: bytesOf(2) }] })).finished;
    expect(claude.starts[0]!.images?.map(i => i.mediaType)).toEqual(["image/png", "image/webp"]);
    expect(claude.starts[0]!.images?.map(i => i.bytes)).toEqual([bytesOf(1), bytesOf(2)]);
  });

  it("a message with no image hands the adapter none, so a turn without one is the turn it always was", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "no image" })).finished;
    expect(claude.starts[0]!.images).toBeUndefined();
  });
});

describe("an image on the file road", () => {
  it("lands in this send's own folder under the thread's, and the adapter is handed the path", async () => {
    const codex = recording("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, { harness: "codex", prompt: "what is this?", attachments: [png(9)], requestId: "req_a" });
    await handle.finished;
    const threadId = handle.view().threadId!;
    const path = imagePathIn(turnImagesDir(threadId, "req_a", "unused"), 0, "image/png");
    expect(path).toBe(`/root/.wsp/threads/${threadId}/images/req_a/1.png`);
    // The send's folder is under the thread's, so removing the thread removes every send's images with it.
    expect(path.startsWith(`${threadImagesDir(threadId)}/`)).toBe(true);
    // The adapter reads a path, and the path it reads holds the bytes the person sent.
    expect(codex.starts[0]!.images?.map((i: TurnImage) => i.path)).toEqual([path]);
    expect(landedFiles(since().puts).get(path)).toEqual(Buffer.alloc(64, 9));
  });

  it("names its folder for itself when the send carried no request id, since two sends must never share a path", async () => {
    const codex = recording("file");
    const { rt, ws } = await workspaceOn({ codex: codex.factory });
    const one = await rt.sessions.start(ws.id, { harness: "codex", prompt: "first", attachments: [png(1)] });
    await one.finished;
    const threadId = one.view().threadId!;
    await (await rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "second", attachments: [png(2)] })).finished;
    const dirs = codex.starts.map(start => start.images![0]!.path!.replace(/\/[^/]+$/, ""));
    expect(dirs[0]).not.toBe(dirs[1]);
    for (const dir of dirs) expect(dir.startsWith(`${threadImagesDir(threadId)}/`)).toBe(true);
  });

  it("a request id shaped like a path of its own does not become one; the folder is named for this send instead", async () => {
    const codex = recording("file");
    const { rt, ws } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, { harness: "codex", prompt: "sneaky", attachments: [png(1)], requestId: "../../../../etc/cron.d" });
    await handle.finished;
    const path = codex.starts[0]!.images![0]!.path!;
    expect(path.startsWith(`${threadImagesDir(handle.view().threadId!)}/`)).toBe(true);
    expect(path).not.toContain("..");
  });

  it("names each image by its place in the message and its own type", async () => {
    const codex = recording("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, {
      harness: "codex",
      prompt: "these three",
      requestId: "req_a",
      attachments: [png(1), { mediaType: "image/jpeg", bytes: bytesOf(2) }, { mediaType: "image/webp", bytes: bytesOf(3) }],
    });
    await handle.finished;
    const threadId = handle.view().threadId!;
    expect(codex.starts[0]!.images?.map((i: TurnImage) => i.path)).toEqual([
      `/root/.wsp/threads/${threadId}/images/req_a/1.png`,
      `/root/.wsp/threads/${threadId}/images/req_a/2.jpg`,
      `/root/.wsp/threads/${threadId}/images/req_a/3.webp`,
    ]);
    expect([...landedFiles(since().puts).keys()].filter(p => p.includes("/images/"))).toHaveLength(3);
  });

  it("takes the send's folder off the machine when its turn ends, so a screenshot does not outlive the turn it was sent for", async () => {
    const codex = recording("file");
    const { rt, ws, backend, since } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, { harness: "codex", prompt: "first", attachments: [png(1)], requestId: "req_a" });
    await handle.finished;
    const threadId = handle.view().threadId!;
    const dir = turnImagesDir(threadId, "req_a", "unused");
    await until(() => backend.machines[0]!.execLog.includes(`rm -rf ${quoted(dir)}`));
    // Twenty text turns after it, nothing of that send is still there and no other folder was touched.
    for (let nth = 0; nth < 3; nth++) await (await rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: `text ${nth}` })).finished;
    expect(since().execs.filter(cmd => cmd.startsWith("rm -rf ") && cmd.includes("/images/"))).toEqual([`rm -rf ${quoted(dir)}`]);
  });

  it("takes the folder off however the turn ended, a failed one as well as a completed one", async () => {
    const codex = failing("file");
    const { rt, ws, backend } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, { harness: "codex", prompt: "boom", attachments: [png(1)], requestId: "req_a" });
    await handle.finished.catch(() => {});
    const dir = turnImagesDir(handle.view().threadId!, "req_a", "unused");
    await until(() => backend.machines[0]!.execLog.includes(`rm -rf ${quoted(dir)}`));
  });

  it("a turn that carried no image asks the machine to remove nothing", async () => {
    const codex = recording("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    await (await rt.sessions.start(ws.id, { harness: "codex", prompt: "no image" })).finished;
    expect(since().execs.filter(cmd => cmd.startsWith("rm -rf "))).toEqual([]);
  });

  it("a message with no image asks the machine for nothing", async () => {
    const codex = recording("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    await (await rt.sessions.start(ws.id, { harness: "codex", prompt: "no image" })).finished;
    expect(since().puts).toHaveLength(0);
    expect(codex.starts[0]!.images).toBeUndefined();
  });
});

describe("two sends with images on one thread", () => {
  /** An adapter whose turns end only when the case says so, so a second send is really waiting behind the first. */
  function heldAdapter(road: AttachmentRoad): { factory: HarnessAdapterFactory; starts: HarnessStartOptions[]; end: (nth: number) => void } {
    const starts: HarnessStartOptions[] = [];
    const ends: ((result: TurnResult) => void)[] = [];
    const factory: HarnessAdapterFactory = () => ({
      steers: false,
      attachments: road,
      start: (options: HarnessStartOptions) => {
        starts.push(options);
        options.onEvent({ type: "session.start", sessionId: SESSION_ID });
        const finished = new Promise<TurnResult>(resolve => {
          ends.push(result => {
            options.onEvent({ type: "turn.done", sessionId: SESSION_ID, result });
            options.onEvent({ type: "session.end", sessionId: SESSION_ID, exitCode: 0, sawResult: true });
            resolve(result);
          });
        });
        return { localId: SESSION_ID, finished, interrupt: async () => {} };
      },
    });
    return { factory, starts, end: nth => ends[nth]!({ status: "completed", text: "done" }) };
  }

  it("neither is handed the other's picture: two sends that wake together land in folders of their own", async () => {
    const codex = heldAdapter("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    const first = await rt.sessions.start(ws.id, { harness: "codex", prompt: "A", attachments: [png(0xaa)], requestId: "req_a" });
    const threadId = first.view().threadId!;
    // Both wait behind the running turn and both wake in the one drain when it ends, so both land before either is
    // registered: the window the wait loop cannot close, and the one a shared folder loses a picture in.
    const b = rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "B", attachments: [png(0xbb)], requestId: "req_b" });
    const c = rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "C", attachments: [png(0xcc)], requestId: "req_c" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(codex.starts).toHaveLength(1);
    codex.end(0);
    await b;
    expect(codex.starts).toHaveLength(2);
    // The turn that is running holds its own bytes at its own path, whichever of the two won the race.
    const running = codex.starts[1]!;
    const files = landedFiles(since().puts);
    const fill = running.prompt === "B" ? 0xbb : 0xcc;
    expect(files.get(running.images![0]!.path!)).toEqual(Buffer.alloc(64, fill));
    codex.end(1);
    await c;
    const waited = codex.starts[2]!;
    // And so does the one that waited: its folder was never written over while it sat in the queue.
    expect(waited.images![0]!.path).not.toBe(running.images![0]!.path);
    expect(landedFiles(since().puts).get(waited.images![0]!.path!)).toEqual(Buffer.alloc(64, waited.prompt === "B" ? 0xbb : 0xcc));
    codex.end(2);
  });

  it("each takes only its own folder off the machine when its turn ends", async () => {
    const codex = heldAdapter("file");
    const { rt, ws, backend } = await workspaceOn({ codex: codex.factory });
    const first = await rt.sessions.start(ws.id, { harness: "codex", prompt: "A", attachments: [png(1)], requestId: "req_a" });
    const threadId = first.view().threadId!;
    const dirOf = (requestId: string): string => turnImagesDir(threadId, requestId, "unused");
    const second = rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "B", attachments: [png(2)], requestId: "req_b" });
    await new Promise(resolve => setTimeout(resolve, 20));
    codex.end(0);
    await second;
    await until(() => backend.machines[0]!.execLog.includes(`rm -rf ${quoted(dirOf("req_a"))}`));
    // The turn still running keeps its folder; only the one that ended lost its.
    expect(backend.machines[0]!.execLog).not.toContain(`rm -rf ${quoted(dirOf("req_b"))}`);
    codex.end(1);
    await until(() => backend.machines[0]!.execLog.includes(`rm -rf ${quoted(dirOf("req_b"))}`));
  });
});

describe("a send that landed its images and is then refused", () => {
  /** An adapter whose turn replies and then lingers: turn.done lands, so the row reads replied, but the process has
   * not exited and finished is still pending, which is the state a send into that thread queues behind. */
  function lingering(road: AttachmentRoad, steers = false): { factory: HarnessAdapterFactory; starts: HarnessStartOptions[]; steered: string[]; reply: () => void; exit: () => void } {
    const starts: HarnessStartOptions[] = [];
    const steered: string[] = [];
    let replied: (() => void) | undefined;
    let exited: (() => void) | undefined;
    const factory: HarnessAdapterFactory = () => ({
      steers,
      attachments: road,
      start: (options: HarnessStartOptions) => {
        starts.push(options);
        options.onEvent({ type: "session.start", sessionId: SESSION_ID });
        const result: TurnResult = { status: "completed", text: "done" };
        const finished = new Promise<TurnResult>(resolve => {
          replied = () => options.onEvent({ type: "turn.done", sessionId: SESSION_ID, result });
          exited = () => {
            options.onEvent({ type: "session.end", sessionId: SESSION_ID, exitCode: 0, sawResult: true });
            resolve(result);
          };
        });
        return {
          localId: SESSION_ID,
          finished,
          interrupt: async () => {},
          ...(steers ? { steer: async (prompt: string) => (steered.push(prompt), "accepted" as const) } : {}),
        };
      },
    });
    return { factory, starts, steered, reply: () => replied!(), exit: () => exited!() };
  }

  /** A machine whose untar can be held, so a send's images are on it while the turn that refuses the send opens: the
   * refusal has to come after the landing, which is the window this is about. Armed only after the workspace is
   * created, since a create lands the daemon the same way. */
  function heldLanding(): { backend: StubBackend; arm: () => void; release: () => void } {
    const backend = stubBackend();
    let armed = false;
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => (release = resolve));
    const plain = backend.execImpl;
    backend.execImpl = async (m, cmd) => {
      if (armed && cmd.includes("tar xzf")) await held;
      return plain(m, cmd);
    };
    return { backend, arm: () => (armed = true), release: () => release!() };
  }

  it("takes its folder off the machine when the workspace naps under it, since no turn will ever do it", async () => {
    const codex = lingering("file");
    const { backend, arm, release } = heldLanding();
    const { rt, ws } = await workspaceOn({ codex: codex.factory }, backend);
    arm();
    const first = await rt.sessions.start(ws.id, { harness: "codex", prompt: "A" });
    const threadId = first.view().threadId!;
    const dirOf = (requestId: string): string => turnImagesDir(threadId, requestId, "unused");
    // B queues behind A, wakes when A's process exits, and is landing its images when the workspace naps.
    const second = rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "B", attachments: [png(0xbb)], requestId: "req_b" });
    codex.reply();
    codex.exit();
    await first.finished;
    await until(() => backend.machines[0]!.execLog.some(cmd => cmd.includes("tar xzf")));
    // The nap leaves nothing on this machine for B to run as: B is refused once its own images have landed.
    await rt.workspaces.nap(ws.id);
    release();
    await expect(second).rejects.toThrow(sendRefusal("paused")!);
    // B's images were on the machine before the refusal was known, and B has no turn to take them off, so B does.
    await until(() => backend.machines[0]!.execLog.includes(`rm -rf ${quoted(dirOf("req_b"))}`));
  });

  it("a refused send that carried no image asks the machine for nothing", async () => {
    const codex = lingering("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    const first = await rt.sessions.start(ws.id, { harness: "codex", prompt: "A" });
    const threadId = first.view().threadId!;
    const second = rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "B" });
    await rt.workspaces.nap(ws.id);
    codex.exit();
    await expect(second).rejects.toThrow(sendRefusal("paused")!);
    expect(since().execs.filter(cmd => cmd.startsWith("rm -rf "))).toEqual([]);
  });

  it("no turn opens under a send that is landing its images: a send that arrives then waits for it and runs after it, as the thread's next turn", async () => {
    const claude = lingering("file", true);
    const { backend, arm, release } = heldLanding();
    const { rt, ws } = await workspaceOn({ claude: claude.factory }, backend);
    arm();
    const first = await rt.sessions.start(ws.id, { prompt: "A" });
    const threadId = first.view().threadId!;
    claude.reply();
    claude.exit();
    await first.finished;
    // B lands into a thread with nothing running; the thread is B's from that moment, so C finds it taken.
    const second = rt.sessions.start(ws.id, { thread: threadId, prompt: "B", attachments: [png(0xbb)], requestId: "req_b" });
    await until(() => backend.machines[0]!.execLog.some(cmd => cmd.includes("tar xzf")));
    let opened = false;
    const third = rt.sessions.start(ws.id, { thread: threadId, prompt: "C" }).then(t => ((opened = true), t));
    await new Promise(r => setTimeout(r, 50));
    expect(opened).toBe(false);
    expect(claude.starts.map(s => s.prompt)).toEqual(["A"]);
    release();
    const b = await second;
    expect(b.outcome).toBe("started");
    expect(claude.starts.map(s => [s.prompt, s.resume])).toEqual([["A", undefined], ["B", SESSION_ID]]);
    // C reached the running turn B opened and steered into it.
    expect((await third).outcome).toBe("steered");
    expect(claude.steered).toEqual(["C"]);
    claude.reply();
    claude.exit();
    await b.finished;
  });
});

describe("an agent that reads no image", () => {
  it("refuses in that agent's name, before the machine is asked for anything", async () => {
    const gemini = recording();
    const { rt, ws, since } = await workspaceOn({ gemini: gemini.factory });
    await expect(rt.sessions.start(ws.id, { harness: "gemini", prompt: "look", attachments: [png()] })).rejects.toThrow(noImagesLine("gemini"));
    expect(gemini.starts).toHaveLength(0);
    expect(since().puts).toHaveLength(0);
    expect(since().execs).toEqual([]);
  });

  it("takes the same message without an image, since only the image was the trouble", async () => {
    const gemini = recording();
    const { rt, ws } = await workspaceOn({ gemini: gemini.factory });
    await (await rt.sessions.start(ws.id, { harness: "gemini", prompt: "look" })).finished;
    expect(gemini.starts).toHaveLength(1);
  });
});

describe("the caps, checked again before the machine is asked", () => {
  it("a 12 MB image is refused with the cap in the sentence and nothing is started", async () => {
    const claude = recording("inline");
    const { rt, ws, since } = await workspaceOn({ claude: claude.factory });
    await expect(
      rt.sessions.start(ws.id, { prompt: "big one", attachments: [{ mediaType: "image/png", bytes: bytesOf(1, 12 * 1024 * 1024) }] }),
    ).rejects.toThrow("over the 10 MB an image may be");
    expect(claude.starts).toHaveLength(0);
    expect(since().puts).toHaveLength(0);
  });

  it("six images are refused with both counts", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await expect(rt.sessions.start(ws.id, { prompt: "six", attachments: Array.from({ length: 6 }, (_, i) => png(i)) })).rejects.toThrow(
      "only 5 images fit one message; this one carries 6",
    );
    expect(claude.starts).toHaveLength(0);
  });
});

describe("what the transcript keeps of a message's images", () => {
  it("the records, never the pixels, so a transcript costs the same however large the image was", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "what is this?", attachments: [{ ...png(4, 1_258_291), name: "shot.png" }] })).finished;
    const events = await rt.sessions.history(ws.id);
    const start = events.find(e => e.type === "session.start")!;
    expect(start.attachments).toEqual([{ mediaType: "image/png", bytes: 1_258_291, name: "shot.png" }]);
    expect(JSON.stringify(events)).not.toContain(bytesOf(4, 1_258_291));
  });

  it("a turn without an image carries no records at all", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "plain" })).finished;
    expect((await rt.sessions.history(ws.id)).find(e => e.type === "session.start")!.attachments).toBeUndefined();
  });
});

describe("what the catalog says about an agent's images", () => {
  it("is the adapter's answer on the machine, one row per agent", async () => {
    const { rt, ws } = await workspaceOn({ claude: recording("inline").factory, codex: recording("file").factory, gemini: recording().factory });
    const rows = await rt.harnesses.list(ws.id);
    expect(Object.fromEntries(rows.filter(r => ["claude", "codex", "gemini"].includes(r.harness)).map(r => [r.harness, r.images]))).toEqual({
      claude: true,
      codex: true,
      gemini: false,
    });
  });
});
