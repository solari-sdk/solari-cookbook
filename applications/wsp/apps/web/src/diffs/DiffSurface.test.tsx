// SPDX-License-Identifier: AGPL-3.0-only
// A comment on a diff line reaching the same thread's composer. The code view
// is stood in by a button that hands the pane one comment, since the real one
// draws its annotations inside the Pierre viewer, and the tooltip skin by its
// text.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: (props: {
    reviewComments: ReadonlyArray<{ id: string }>;
    onAddReviewComment: (comment: unknown) => void;
  }) => (
    <div data-code-view data-comments={props.reviewComments.length}>
      <button
        type="button"
        data-comment-on-a-line
        onClick={() =>
          props.onAddReviewComment({
            id: `c${props.reviewComments.length + 1}`,
            sectionId: "s",
            sectionTitle: "Working tree",
            filePath: "src/a.ts",
            startIndex: 0,
            endIndex: 0,
            rangeLabel: "+1",
            text: "name this one",
            diff: "@@ -1,1 +1,1 @@\n+two",
            fenceLanguage: "diff",
          })
        }
      />
    </div>
  ),
}));
vi.mock("../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => cloneElement(element, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

import { DAEMON_VERSION, type WorkspaceView } from "@wsp/protocol";
import { useComposerDraftStore } from "../components/chat/composerDraftStore";
import { useRootStore } from "../files/root";
import { provideDaemonHello, provideDaemonWire } from "../files/wire";
import { useStore } from "../protocol/store";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../terminal/link";
import { reviewCommentsQuote } from "../reviewCommentContext";
import { DiffSurface } from "./DiffSurface";
import { useDiffStore } from "./store";
import { SEND_TO_THREAD } from "./words";

const WS = "ws_a";
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m_ws_a",
  project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};

const patch = ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-one", "+two", ""].join("\n");
const DIFF = { base: null, files: [{ path: "src/a.ts", patch }], truncated: false };
const STATUS = { branch: { oid: "abc", head: "agent/pricing-page", ahead: 1, behind: 0 }, entries: [], root: "/root" };

const wire = {
  request: async (op: string) => (op === "git.diff" ? DIFF : op === "git.status" ? STATUS : {}),
  onEvent: () => () => {},
} as unknown as Parameters<typeof provideDaemonWire>[1];

beforeEach(() => {
  useDiffStore.setState({ scopeByWorkspaceId: {}, renderMode: "stacked" });
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useRootStore.setState({ byWorkspaceId: {} });
  useStore.setState({ workspaces: [workspace], statuses: {}, places: [] });
  provideDaemonHello(WS, { root: "/root", version: DAEMON_VERSION });
  provideDaemonWire(WS, wire);
});

afterEach(() => {
  cleanup();
  provideDaemonWire(WS, null);
});

const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));

describe("a comment on a diff line", () => {
  it("is not offered until one is written", async () => {
    render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(document.querySelector("[data-code-view]")).not.toBeNull());
    expect(screen.queryByText(SEND_TO_THREAD)).toBeNull();
  });

  it("goes to the selected thread's composer as quoted context, under what is already typed, and leaves the pane", async () => {
    useComposerDraftStore.getState().setDraft(WS, { prompt: "have a look", cursor: 11 });
    render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(document.querySelector("[data-comment-on-a-line]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-comment-on-a-line]")!);
    fireEvent.click(document.querySelector("[data-comment-on-a-line]")!);
    await waitFor(() => expect(document.querySelector("[data-code-view]")?.getAttribute("data-comments")).toBe("2"));

    fireEvent.click(screen.getByText(SEND_TO_THREAD));
    await settle();
    const draft = useComposerDraftStore.getState().drafts[WS]!;
    expect(draft.prompt.startsWith("have a look\n\n")).toBe(true);
    expect(draft.prompt).toContain("src/a.ts +1");
    expect(draft.prompt).toContain("name this one");
    expect(draft.prompt).toContain("@@ -1,1 +1,1 @@");
    expect(draft.cursor).toBe(draft.prompt.length);
    // Two comments, one block, in the order they were written.
    expect(draft.prompt.split("src/a.ts +1")).toHaveLength(3);
    // The pane keeps none: what is in the composer is what the person edits and sends.
    expect(document.querySelector("[data-code-view]")?.getAttribute("data-comments")).toBe("0");
    expect(screen.queryByText(SEND_TO_THREAD)).toBeNull();
  });

  it("is the quote the one word table builds, never a second spelling", async () => {
    render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(document.querySelector("[data-comment-on-a-line]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-comment-on-a-line]")!);
    await waitFor(() => expect(screen.queryByText(SEND_TO_THREAD)).not.toBeNull());
    fireEvent.click(screen.getByText(SEND_TO_THREAD));
    await settle();
    const quoted = reviewCommentsQuote([
      { id: "c1", sectionId: "s", sectionTitle: "Working tree", filePath: "src/a.ts", startIndex: 0, endIndex: 0, rangeLabel: "+1", text: "name this one", diff: "@@ -1,1 +1,1 @@\n+two", fenceLanguage: "diff" },
    ]);
    expect(useComposerDraftStore.getState().drafts[WS]!.prompt).toBe(`${quoted}\n\n`);
  });
});

describe("the Diff header's branch", () => {
  it("is asked again when the link changes its word, so a read made before the link was up is not the header's last word", async () => {
    // The wire is handed out before the link's first status lands, and the panel reopens the panes it had, so a
    // Diff pane restored at load reads over a link that is not up yet. Asked once, that failure stood as the
    // header's word until a scope change, a folder change or a refresh by hand.
    let up = false;
    const late = {
      request: async (op: string) => {
        if (!up) throw new Error("daemon unreachable");
        return op === "git.diff" ? DIFF : op === "git.status" ? STATUS : {};
      },
      onEvent: () => () => {},
    } as unknown as TerminalWire;
    provideDaemonWire(WS, late);
    const terminals = new WorkspaceTerminals(late);
    provideTerminals(WS, terminals);

    render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(document.querySelector("[data-diff-repo-state]")?.getAttribute("data-diff-repo-state")).toBe("refused"));
    up = true;
    act(() => terminals.feedStatus("live"));
    await waitFor(() => expect(document.querySelector("[data-diff-repo-state]")?.getAttribute("data-diff-repo-state")).toBe("repo"));
    expect(document.querySelector("[data-diff-repo]")?.getAttribute("data-diff-repo")).toBe("/root");
    expect(document.querySelector("[data-diff-repo-state]")?.textContent).toBe("agent/pricing-page");
    provideTerminals(WS, null);
  });

  it("keeps its room while a comment is held, where the path leaves the header", async () => {
    render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(document.querySelector("[data-comment-on-a-line]")).not.toBeNull());
    expect(document.querySelector("[data-folder-crumbs]")).not.toBeNull();
    fireEvent.click(document.querySelector("[data-comment-on-a-line]")!);
    await waitFor(() => expect(screen.queryByText(SEND_TO_THREAD)).not.toBeNull());
    expect(document.querySelector("[data-folder-crumbs]")).toBeNull();
    expect(document.querySelector("[data-diff-repo-state]")?.textContent).toBe("agent/pricing-page");
  });
});
