// SPDX-License-Identifier: AGPL-3.0-only
// Where the person is: the settings crumbs while Settings is open; else the
// open thread's agent mark, the thread that opened this one where an agent did,
// the workspace's name, a slash and the open thread's title; a creation
// in progress by its name; the words for no selection otherwise, and nothing at
// all while the first run is the centre, since that screen's own title says
// the same emptiness and two sentences about it read as a fault. The thread is
// the one the centre shows. The header carries no state word for a thread that
// is simply working or settled, since the pane under it already shows that; it
// carries the one state a person has to act on, so a prompt is never hidden by
// the header the pane is scrolled under.
import { ProjectGlyph } from "../projects/look.js";
import { agentName } from "@wsp/catalog";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { threadState, threadWordOf, waitingLine } from "@wsp/protocol";
import { useCreation, useFirstRun, useOpenThread, useSelectedId, useSelectedWorkspaceId, useSettingsOpen, useSidebarProjects, useStore, useWorkspace } from "../protocol/store.js";
import { ThreadLink } from "../components/ThreadLink.js";
import { cn } from "../lib/utils.js";
import { SettingsCrumbs } from "../settings/SettingsCrumbs.js";
import { openedBy } from "../sidebar/threadTree.js";

export function ThreadBreadcrumb() {
  const creation = useCreation(useSelectedId());
  const workspaceId = useSelectedWorkspaceId();
  const workspace = useWorkspace(workspaceId);
  const thread = useOpenThread(workspaceId);
  const settingsOpen = useSettingsOpen();
  // The first run is the whole centre, and it is titled: the bar says nothing over it.
  const firstRun = useFirstRun();
  // An opener may run on any workspace, so the whole fleet is read rather than this one's threads.
  const opener = openedBy(useSidebarProjects(), { parentThreadId: thread?.parentThreadId ?? null });
  const name = workspace?.name ?? creation?.name;
  // A project's home names its project, which is where the next task lands.
  const home = useStore(s => (s.projectHome === null ? undefined : s.projects.find(p => p.id === s.projectHome)));
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm" data-thread-breadcrumb>
      {settingsOpen ? (
        <SettingsCrumbs />
      ) : name === undefined ? (
        home !== undefined ? (
          <span className="flex min-w-0 items-center gap-2" data-breadcrumb-project>
            <ProjectGlyph projectId={home.id} />
            <span className="truncate font-medium text-foreground">{home.name}</span>
          </span>
        ) : firstRun ? null : (
          <span className="truncate text-muted-foreground">No task selected</span>
        )
      ) : (
        <>
          {/* The agent the open thread runs, first, so the bar says who is working before where. */}
          {thread !== null && thread.harness !== undefined ? <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-4 shrink-0" /> : null}
          {thread !== null && opener !== undefined ? (
            <>
              <ThreadLink
                data-breadcrumb-opener
                thread={opener.thread}
                title={opener.thread.title}
                className="min-w-0 truncate text-muted-foreground hover:text-foreground"
              />
              <span aria-hidden className="text-muted-foreground/50">/</span>
            </>
          ) : null}
          <span className={thread === null ? "truncate font-medium text-foreground" : "shrink-0 text-muted-foreground"}>{name}</span>
          {thread !== null ? (
            <>
              <span aria-hidden className="text-muted-foreground/50">/</span>
              {/* The thread on screen is the last thing to give way: beside an opener it keeps its whole measure and
                  the opener is what the room is taken from, capped so a long one cannot push the rest off the line. */}
              <span data-breadcrumb-thread className={cn("truncate font-medium text-foreground", opener !== undefined && "max-w-[70%] shrink-0")}>
                {thread.title}
              </span>
              {threadState(thread) === "waiting" ? (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={waitingLine(thread)}>
                  {threadWordOf(thread)}
                </span>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </span>
  );
}
