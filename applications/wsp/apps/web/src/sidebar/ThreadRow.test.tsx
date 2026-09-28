// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { threadIndicator } from "../adapt/index.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import { ThreadRow } from "./ThreadRow.js";

const thread = (over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot => {
  const base = { id: "th_1", threadId: "th_1", sessionId: "s_1", workspaceId: "ws_a", title: "fix the port list", status: "running" as const, ran: true, startedAt: "2026-09-17T00:00:00.000Z", endedAt: null, harness: "claude", startedBy: "person" as const, project: "spoo", parentThreadId: null, asking: null, costUsd: null };
  const merged = { ...base, ...over };
  return { ...merged, indicator: threadIndicator({ status: merged.status, ...(merged.asking === null ? {} : { asking: merged.asking }) }) };
};

function mount(over: Partial<SidebarThreadSnapshot> = {}) {
  return render(
    <SidebarProvider defaultOpen>
      <ThreadRow
        thread={thread(over)}
        time="3m"
        runs={{ workspace: "pricing page", where: "this Mac" }}
        under="pricing page"
        depth={2}
        active={false}
        renaming={false}
        saving={false}
        onSelect={() => {}}
        onContextMenu={() => {}}
        onRename={() => {}}
        onRenameCancel={() => {}}
      />
    </SidebarProvider>,
  );
}

const row = (): HTMLElement => document.querySelector<HTMLElement>("[data-sidebar-row]")!;
const state = (): string | null => document.querySelector("[data-thread-state]")?.textContent ?? null;
const time = (): string | null => document.querySelector("[data-thread-time]")?.textContent ?? null;
/** Any dot the row might draw: a round span, which is what a status dot was. */
const dots = (): number => document.querySelectorAll("[data-sidebar-row] .rounded-full, [data-sidebar-row] [class*=animate-status]").length;

afterEach(cleanup);

describe("a thread row's one line", () => {
  it("carries the state as one mono word in the slot and no dot, whatever the state, and the time only once the thread rests", () => {
    mount();
    expect(state()).toBe("Working");
    expect(time()).toBeNull();
    expect(dots()).toBe(0);
    cleanup();
    mount({ asking: "Write out.txt in root (2 B)" });
    expect(state()).toBe("Needs you");
    expect(dots()).toBe(0);
    cleanup();
    mount({ status: "failed" });
    expect(state()).toBe("Failed");
    expect(dots()).toBe(0);
    cleanup();
    mount({ status: "completed" });
    expect(state()).toBeNull();
    expect(time()).toBe("3m");
    expect(dots()).toBe(0);
  });

  it("is the mark, the title and the slot, nothing else on its face: the project, the agent and who opened it ride the hover text", () => {
    mount();
    expect(row().textContent).toBe("fix the port listWorking");
    expect(row().getAttribute("title")).toBe("Claude Code, spoo, you");
    expect(row().dataset["depth"]).toBe("2");
    const lead = row().firstElementChild!;
    expect(lead.getAttribute("aria-hidden")).toBe("true");
    expect(lead.querySelector("[data-harness-mark=claude]")).not.toBeNull();
    expect(lead.nextElementSibling!.hasAttribute("data-thread-title")).toBe(true);
    expect(screen.getByTitle("Claude Code, spoo, you")).toBe(row());
  });

  it("a row an agent opened says Working too, and its hover text names the workspace it runs in and where", () => {
    mount({ parentThreadId: "th_lead", startedBy: "agent", workspaceId: "ws_b" });
    expect(state()).toBe("Working");
    expect(row().getAttribute("title")).toBe("Claude Code, this Mac");
  });

  it("the state word reads at the prose tier and the time at the whisper, both in the row's mono", () => {
    mount();
    expect(document.querySelector("[data-thread-state]")!.className).toContain("text-[var(--sidebar-prose)]");
    expect(document.querySelector("[data-thread-state]")!.className).toContain("font-mono");
    cleanup();
    mount({ status: "completed" });
    expect(document.querySelector("[data-thread-time]")!.className).toContain("text-[var(--top-row-meta)]");
    expect(document.querySelector("[data-thread-time]")!.className).not.toContain("w-[3ch]");
  });
});
