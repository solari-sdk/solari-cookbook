// SPDX-License-Identifier: AGPL-3.0-only
// One thread's row under its workspace, one line at every depth, and the row a
// send in flight stands as until the runtime writes its own. The agent's mark
// leads it, the title takes the line, and one slot at the right edge holds the
// state while the thread is one a person acts on ("Needs you", "Working",
// "Failed") and the time otherwise. No dot for any state: the state is the
// word. The project and the branch are not on the row, since the tree over it
// names both; the agent, the project and who opened the thread ride the row's
// hover text. A working title takes the sidebar's foreground and a settled one
// its muted ink, so the rows a person is waiting on stand out from the shelf.
// Renaming turns the title into the sidebar's one name box in the
// same slot, opened from the menu or by a double-click on the title, so the
// row keeps its height and its grammar while a name is typed.
import type { MouseEvent } from "react";
import { agentName } from "@wsp/catalog";
import { THREAD_WORDS } from "../actions/format.js";
import { threadIndicator } from "../adapt/index.js";
import type { Launch, SidebarThreadSnapshot } from "../adapt/index.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";
import { RowNameInput } from "./RowNameInput.js";
import { ONE_LINE_ROW_CLASS, ROW_LEAD_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, threadRowId } from "./rowGrammar.js";
import { isThreadWorking } from "./Sidebar.logic.js";
import { provenanceLabel, threadMetaWords, threadStateWord } from "./workspaceRows.js";

/** The one slot at the row's right edge: its own width, so a time takes no more room than it needs. */
const SLOT_CLASS = "shrink-0 text-right";

export function ThreadRow({
  thread,
  time,
  runs,
  under,
  depth,
  active,
  renaming,
  saving,
  onSelect,
  onContextMenu,
  onRename,
  onRenameCancel,
  onRenameOpen,
}: {
  thread: SidebarThreadSnapshot;
  time: string;
  /** The workspace this thread runs in and where that workspace runs, which a spawned row names in place of the project. */
  runs: { readonly workspace: string; readonly where: string };
  /** The workspace whose rows this one is drawn under: the row names its own only where the two differ. */
  under: string;
  /** How many levels of the tree stand over this row, for the tests that read the tree's shape. */
  depth: number;
  active: boolean;
  /** The name is being typed on this row: the title slot holds the input instead of the text. */
  renaming: boolean;
  /** That name is on its way to the machine: the field stays exactly as it is and takes no second Enter. */
  saving: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onRename: (title: string) => void;
  onRenameCancel: () => void;
  /** Opens the box on this row, as the menu's Rename does; absent where the rename is refused, so the title is text alone. */
  onRenameOpen?: (() => void) | undefined;
}) {
  const state = threadStateWord(thread);
  // The Idle header can be shut, so the row carries the difference itself, in the title's colour.
  const idle = !isThreadWorking(thread);
  const label = provenanceLabel(thread, threadMetaWords(thread, runs, under));
  return (
    <SidebarMenuButton
      size="sm"
      // An input may not sit inside a button, so a row being renamed is a plain box with the same grammar.
      render={renaming ? <div /> : <button type="button" />}
      isActive={active}
      data-sidebar-row
      data-row-id={threadRowId(thread.id)}
      data-depth={depth}
      title={label}
      className={cn(ONE_LINE_ROW_CLASS, "w-full")}
      {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
    >
      <span aria-hidden className={ROW_LEAD_CLASS}>
        <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px]" />
      </span>
      {renaming ? (
        <RowNameInput name={thread.title} label={THREAD_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
      ) : (
        <span
          data-thread-title
          className={cn("min-w-0 flex-1 truncate", idle ? "text-sidebar-muted-foreground" : "text-sidebar-foreground")}
          onDoubleClick={onRenameOpen === undefined ? undefined : event => {
            event.stopPropagation();
            onRenameOpen();
          }}
        >
          {thread.title}
        </span>
      )}
      {state === null ? (
        <span data-thread-time className={cn(ROW_META_CLASS, SLOT_CLASS)}>
          {time}
        </span>
      ) : (
        <span data-thread-state className={cn(ROW_PROSE_CLASS, SLOT_CLASS)}>
          {state}
        </span>
      )}
    </SidebarMenuButton>
  );
}

/** The word a send in flight wears: it is working by the fact of having been sent, read through the tables the
 * runtime's own rows are read through, so the two rows cannot say different things about the same thread. */
const LAUNCH_WORD = threadStateWord({ status: "running", asking: null, indicator: threadIndicator({ status: "running" }) });

/** The send the runtime has written no row for yet, in the thread row's own grammar: the mark, the message as the
 * title and the working word in the slot. Not a button: the thread it stands for has no id to select until the
 * runtime answers, and the transcript the person is looking at is already this thread. */
export function ThreadLaunchRow({ launch, depth }: { launch: Launch; depth: number }) {
  return (
    <SidebarMenuButton size="sm" render={<div />} data-thread-launch data-depth={depth} className={cn(ONE_LINE_ROW_CLASS, "w-full")}>
      <span aria-hidden className={ROW_LEAD_CLASS}>
        <HarnessMark harness={launch.harness} label={agentName(launch.harness)} className="size-[13px]" />
      </span>
      <span data-thread-title className="min-w-0 flex-1 truncate text-sidebar-foreground">
        {launch.title}
      </span>
      <span data-thread-state className={cn(ROW_PROSE_CLASS, SLOT_CLASS)}>
        {LAUNCH_WORD}
      </span>
    </SidebarMenuButton>
  );
}
