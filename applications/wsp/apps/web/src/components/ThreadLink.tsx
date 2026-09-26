// SPDX-License-Identifier: AGPL-3.0-only
// One thread named as the way to it, wherever a surface points at a thread
// other than the one it is drawing: the transcript's row for a thread this one
// opened, and the header's name for the thread that opened this one. The href
// is the page's own address, so it can be copied or opened in a second window,
// and the click selects the thread here rather than reloading the page. A
// thread the runtime stamped no id on has no address, the reading that refuses
// its copy-link action too, so it is its name in plain text.
import type { HTMLAttributes } from "react";
import { threadLink } from "../actions/threadActions.js";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";

export function ThreadLink({
  thread,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "children" | "onClick"> & { thread: Pick<SidebarThreadSnapshot, "threadId" | "workspaceId" | "title"> }) {
  const select = useStore(s => s.select);
  if (thread.threadId === null) {
    return (
      <span {...rest} className={className}>
        {thread.title}
      </span>
    );
  }
  return (
    <a
      {...rest}
      href={threadLink(thread, thread.threadId)}
      className={cn("underline-offset-2 hover:underline", className)}
      onClick={event => {
        event.preventDefault();
        select(thread.workspaceId, thread.threadId);
      }}
    >
      {thread.title}
    </a>
  );
}
