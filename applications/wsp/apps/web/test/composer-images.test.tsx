// SPDX-License-Identifier: AGPL-3.0-only
// An image into the composer by paste, by drop and by the picker: the
// thumbnail row above the text, the x per image, the caps in words in the one
// line the composer keeps for a refusal, and the bytes on the send. The same
// fixture shape as chat-composer.test.tsx; no live daemon and no host.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGES_AFTER_TURN, noImagesLine, sendRefusal, type EventUnion, type SessionEvent, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerImagesStore } from "../src/components/chat/composerImages.js";
import { CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

let restoreLayout: () => void = () => {};
const urls: string[] = [];
const revoked: string[] = [];
beforeAll(() => {
  restoreLayout = installFakeLayout();
  // jsdom has no object URLs; the composer's thumbnails only need one string per image and one revoke per removal.
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:wsp/${urls.length}`;
    urls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url));
});
afterAll(() => restoreLayout());
beforeEach(() => {
  urls.length = 0;
  revoked.length = 0;
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useComposerImagesStore.setState({ pending: {}, sent: {} });
});
afterEach(() => useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {}, harnesses: [], harnessesByWorkspace: {} }));

const WS = CHAT_WS;
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file whose first bytes are a real PNG head, since the composer types an image off its bytes and not its name. */
function pngFile(name: string, bytes = 1024, fill = 5): File {
  return new File([new Uint8Array([...PNG_HEAD, ...Array.from({ length: bytes - PNG_HEAD.length }, () => fill)])], name, { type: "image/png" });
}

const base64Of = (bytes: number, fill = 5): string => Buffer.from(new Uint8Array([...PNG_HEAD, ...Array.from({ length: bytes - PNG_HEAD.length }, () => fill)])).toString("base64");

function fixtureApi(history: Record<string, SessionEvent[]> = {}, statuses: WorkspaceStatus[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const workspaces = [workspace];
  const api: Api = {
    interruptSession: async () => "accepted",
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    listSessions: async () => [],
    listHarnesses: async () => [TABLE_CATALOG],
    watchStatuses: async () => statuses,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, emit };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, harnesses: [], harnessesByWorkspace: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  await whenAgentsAnswered();
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const surface = (): HTMLElement => document.querySelector<HTMLElement>("[data-chat-composer-surface]")!;
const thumbs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-composer-images] [data-chat-image]")];
const refusalLine = (): string => document.querySelector("[data-composer-refusal]")?.textContent ?? "";

const paste = (files: File[]) => fireEvent.paste(surface(), { clipboardData: { files, items: [], getData: () => "" } });
const drop = (files: File[]) => fireEvent.drop(surface(), { dataTransfer: { files, items: [], types: ["Files"], getData: () => "" } });

describe("an image into the composer", () => {
  it("a pasted PNG becomes one thumbnail above the text, and the text is untouched", async () => {
    const { api } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "what does this show?");
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("shot.png");
    expect(composerEditor().textContent).toBe("what does this show?");
    expect(refusalLine()).toBe("");
  });

  it("a dropped image lands the same way, and the drop is taken from the page rather than opening the file", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void drop([pngFile("dropped.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("dropped.png");
  });

  it("the paperclip beside send opens the file input and what it takes lands the same way", async () => {
    const { api } = fixtureApi();
    await setup(api);
    const input = document.querySelector<HTMLInputElement>("[data-composer-image-input]")!;
    const clicked = vi.spyOn(input, "click");
    const attach = screen.getByRole("button", { name: "Attach" });
    expect(attach.closest('[data-chat-composer-actions="right"]')).not.toBeNull();
    expect(attach.querySelector("svg.lucide-paperclip")).not.toBeNull();
    fireEvent.click(attach);
    expect(clicked).toHaveBeenCalledOnce();
    // The picker only opens the input; what the person chose arrives on its change, which is what this drives.
    act(() => void fireEvent.change(input, { target: { files: [pngFile("picked.png")] } }));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("picked.png");
  });

  it("each thumbnail has its own remove, and removing one leaves the rest and lets go of its url", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([pngFile("one.png"), pngFile("two.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("two.png");
    expect(revoked).toEqual([urls[0]]);
  });

  it("the thumbnail opens the image at full size", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    const thumbSrc = thumbs()[0]!.querySelector("img")!.getAttribute("src");
    fireEvent.click(screen.getByRole("button", { name: "Open image 1 at full size" }));
    // The same bytes, unscaled, in the dialog over the page: the thumbnail is a way in, not a smaller copy.
    await waitFor(() => expect(document.querySelector("[data-slot=dialog-popup] img")).not.toBeNull());
    const full = document.querySelector<HTMLImageElement>("[data-slot=dialog-popup] img")!;
    expect(full.getAttribute("src")).toBe(thumbSrc);
    expect(full.getAttribute("alt")).toBe("shot.png");
    expect(full.className).toContain("object-contain");
  });
});

describe("what the composer will not take at all", () => {
  it("paste and drop answer to the same state the picker does: nothing is taken while a send is blocked", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => useStore.getState().setConn("closed"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement).disabled).toBe(true));
    act(() => void paste([pngFile("shot.png")]));
    act(() => void drop([pngFile("dropped.png")]));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(thumbs()).toHaveLength(0);
    // The line stays the one that says why a send is blocked; nothing about the image is added to it.
    expect(refusalLine()).toBe(sendRefusal("closed"));
  });
});

describe("what the composer refuses, in words, before anything leaves", () => {
  it("a file that is not one of the four types is named in the one line the composer keeps", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    act(() => void paste([new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "notes.pdf", { type: "application/pdf" })]));
    await waitFor(() => expect(refusalLine()).toBe("notes.pdf is not PNG, JPEG, GIF or WebP; a message carries those four"));
    expect(thumbs()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("a 12 MB image is refused with the cap in the sentence, and it is never read whole to refuse it", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([pngFile("huge.png", 12 * 1024 * 1024)]));
    await waitFor(() => expect(refusalLine()).toBe("huge.png is 12 MB, over the 10 MB an image may be"));
    expect(thumbs()).toHaveLength(0);
    // The bytes go to an object URL only once the caps have passed, so no url means the file was never read whole.
    expect(urls).toEqual([]);
  });

  it("a sixth image is refused with both counts and the five already there stay", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste(Array.from({ length: 5 }, (_, i) => pngFile(`n${i}.png`))));
    await waitFor(() => expect(thumbs()).toHaveLength(5));
    act(() => void paste([pngFile("sixth.png")]));
    await waitFor(() => expect(refusalLine()).toBe("only 5 images fit one message; this one carries 6"));
    expect(thumbs()).toHaveLength(5);
  });
});

describe("an agent that reads no image", () => {
  it("is named in the composer's one line, and the person's file is never read", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    act(() =>
      useStore.setState({
        harnessesByWorkspace: {
          [WS]: [{ harness: "claude", label: "Claude Code", source: "harness", version: "2.1.263", models: [], efforts: [], contextWindows: [], permissionModes: [], steers: true, renames: true, images: false }],
        },
      }),
    );
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(refusalLine()).toBe(noImagesLine("claude")));
    expect(thumbs()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });
});

describe("what a tab holds of the images it has sent", () => {
  it("the last ten sends and no more: the oldest let go of their bytes rather than growing with the tab", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    for (let nth = 0; nth < 12; nth++) {
      act(() => void paste([pngFile(`n${nth}.png`, 128)]));
      await waitFor(() => expect(thumbs()).toHaveLength(1));
      await typeInto(composerEditor(), `send ${nth}`);
      await press(composerEditor(), "Enter");
      await waitFor(() => expect(started).toHaveLength(nth + 1));
      // Each send is its own turn, so the next one is not queued behind this one.
      emit({ type: "session.start", workspaceId: WS, sessionId: `sess_${nth}`, turnId: `turn_${nth}`, prompt: `send ${nth}` });
      emit({ type: "session.done", workspaceId: WS, sessionId: `sess_${nth}`, turnId: `turn_${nth}`, result: { status: "completed", text: "ok" } });
      emit({ type: "session.end", workspaceId: WS, sessionId: `sess_${nth}`, turnId: `turn_${nth}`, exitCode: 0, sawResult: true });
    }
    const sent = useComposerImagesStore.getState().sent;
    expect(Object.keys(sent)).toHaveLength(10);
    // The two oldest sends let their bytes go; every image still held keeps its url.
    expect(revoked).toHaveLength(2);
    const held = new Set(Object.values(sent).flat().map(i => i.url));
    for (const url of revoked) expect(held.has(url)).toBe(false);
  });
});

describe("the images on the send", () => {
  it("ride the start as bytes with their type, and the composer opens empty", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "what does this show?");
    act(() => void paste([pngFile("shot.png", 2048, 3)]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments).toEqual([{ mediaType: "image/png", bytes: base64Of(2048, 3), name: "shot.png" }]);
    expect(started[0]!.prompt).toBe("what does this show?");
    await waitFor(() => expect(thumbs()).toHaveLength(0));
  });

  it("the person's own row carries its thumbnails at the click, not a roundtrip later", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "what does this show?");
    act(() => void paste([pngFile("shot.png", 2048, 3)]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    // Nothing came back from the runtime; the row is drawn from the records the send already held.
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-chat-image-row=true]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(row.querySelectorAll("[data-chat-image='shot.png'] img")).toHaveLength(1);
    expect(row.textContent).not.toContain("[image");
  });

  it("a message with no image sends no attachments field at all", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "plain");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments).toBeUndefined();
  });

  it("a message with an image waits for a running turn rather than queueing without its images", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "first");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0001", turnId: "turn_0001", prompt: "first" });
    emit({ type: "session.delta", workspaceId: WS, sessionId: "sess_0001", turnId: "turn_0001", kind: "text", text: "on it" });
    await typeInto(editor, "and this?");
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(editor, "Enter");
    await waitFor(() => expect(refusalLine()).toBe(IMAGES_AFTER_TURN));
    // Nothing was queued and nothing was sent: the words and the images are both still in the composer.
    expect(started).toHaveLength(1);
    expect(thumbs()).toHaveLength(1);
    expect(composerEditor().textContent).toBe("and this?");
  });

  it("a refused send hands the images back rather than losing them", async () => {
    const { api, started } = fixtureApi();
    const refusing: Api = { ...api, startSession: async opts => { started.push(opts); throw new Error("the runtime said no"); } };
    await setup(refusing);
    await typeInto(composerEditor(), "look");
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("shot.png");
  });
});
