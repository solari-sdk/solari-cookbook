// SPDX-License-Identifier: AGPL-3.0-only
// The one section row the sidebar has, the head over Forwarded ports: a caps
// mono zone label, the count of what the row hides while it is shut, a
// chevron that shuts the group, room at the right edge for a group action the
// caller places, and the section's own menu on a right-click where the caller
// has one. A row with no group under it to shut is pressed for its own act: it
// draws no chevron and no count and keeps the label. Projects are rows in the
// tree, not zones, so none of them wears this.
import { ChevronDownIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { MICRO_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { ROW_META_CLASS, TOP_ROW_CLASS } from "./rowGrammar.js";

export function SectionRow({
  label,
  count,
  collapsed,
  onToggle,
  onPress,
  action,
  onContextMenu,
  k,
}: {
  label: string;
  /** What the row hides while it is shut; absent on a row with no group under it. */
  count?: number;
  collapsed?: boolean;
  /** Shuts and opens the group; absent on a row that is pressed for its own act. */
  onToggle?: (() => void) | undefined;
  /** The row's own act, where it has one in place of a group to shut. */
  onPress?: (() => void) | undefined;
  action?: ReactNode;
  /** The section's own menu, where the section has one; a row without it keeps the browser's. */
  onContextMenu?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** What a test and a screenshot step name this row by. */
  k?: string;
}) {
  const shut = collapsed === true;
  return (
    <>
      <SidebarMenuButton
        {...(onToggle === undefined ? {} : { "aria-expanded": !shut })}
        aria-label={label}
        {...(k === undefined ? {} : { "data-k": k })}
        className={cn(TOP_ROW_CLASS, action !== undefined && "pe-8")}
        onClick={onToggle ?? onPress}
        {...(onContextMenu === undefined ? {} : { onContextMenu })}
      >
        <span className={MICRO_LABEL}>{label}</span>
        {shut && count !== undefined ? <span className={ROW_META_CLASS}>{count}</span> : null}
        {onToggle === undefined ? null : <ChevronDownIcon aria-hidden className={cn("size-4 transition-transform duration-150", shut && "-rotate-90")} />}
      </SidebarMenuButton>
      {action}
    </>
  );
}
