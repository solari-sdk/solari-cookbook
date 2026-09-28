// SPDX-License-Identifier: AGPL-3.0-only
// One card per target, built from the same snapshot the sidebar draws: a
// workspace card carries its name and its top thread, a thread card the
// thread's title and where it came from, as its row's hover text reads.
// Nothing here decides an order or a thread of its own.
import type { SidebarProjectSnapshot } from "../../adapt/index.js";
import { topSidebarThread } from "../../sidebar/Sidebar.logic.js";
import { provenanceLabel, threadMetaWords, whereWord } from "../../sidebar/workspaceRows.js";
import type { SwitchTarget } from "../../shell/workspaceSwitcher.js";

export interface SwitcherCard {
  readonly workspaceId: string;
  /** The thread the card lands on, where the walk is over threads. */
  readonly threadId: string | null;
  readonly name: string;
  readonly threadTitle: string | null;
  /** A picture of the page as the shell last took it; absent in a browser tab, which cannot take one, and on a
   * thread card, whose threads all share one page. */
  readonly image: string | null;
}

export interface SwitcherCardsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  /** The targets the overlay froze when it opened; a workspace or thread that has since gone leaves no card. */
  readonly targets: ReadonlyArray<SwitchTarget>;
  readonly images: Readonly<Record<string, string>>;
  /** The workspace the person is on, whose card names the thread the sidebar pins rather than its top one. */
  readonly currentId: string | null;
  /** The thread pinned in the sidebar, which belongs to the current workspace alone. */
  readonly pinnedThreadId: string | null;
}

export function buildSwitcherCards(input: SwitcherCardsInput): SwitcherCard[] {
  const byId = new Map(input.projects.map(project => [project.id, project]));
  return input.targets.flatMap(({ workspaceId, threadId }): SwitcherCard[] => {
    const project = byId.get(workspaceId);
    if (project === undefined) return [];
    if (threadId !== null) {
      const thread = project.threads.find(t => t.threadId === threadId);
      if (thread === undefined) return [];
      // The card says what the row says under the same thread: the agent, then its project and who opened it, or
      // the workspace and where it runs on a thread another thread's agent opened.
      const words = threadMetaWords(thread, { workspace: project.displayName, where: whereWord(project) }, project.displayName);
      return [{ workspaceId, threadId, name: thread.title, threadTitle: provenanceLabel(thread, words), image: null }];
    }
    const current = workspaceId === input.currentId;
    const pinned = current && input.pinnedThreadId !== null ? project.threads.find(t => t.id === input.pinnedThreadId) : undefined;
    const thread = pinned ?? topSidebarThread(project.threads);
    return [
      {
        workspaceId,
        threadId: null,
        name: project.displayName,
        threadTitle: thread?.title ?? null,
        image: input.images[workspaceId] ?? null,
      },
    ];
  });
}
