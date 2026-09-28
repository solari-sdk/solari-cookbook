// Adapted from pingdotgg/t3code apps/web/src/components/chat/ComposerCommandMenu.tsx at 57a66608 (MIT).
// Differs from upstream: the path, built-in slash command and skill item arms
// are removed with their icons, badges, loading copy and the resolvedTheme
// prop (no file search, pickers or skills catalog on the wire); the one arm
// left names its harness by string; and the one flat list became the groups
// composerCommandGroups reads off the announcement, each under the heading the
// palette gives its own, since a hundred and thirty names in one run are a
// list nobody reads. Nothing matching draws no menu at all rather than an
// empty state: the composer's own slot already holds the one line saying that
// name reached nothing, and two readings of it are one too many.
import { memo, useLayoutEffect, useRef } from "react";

import { type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "../../lib/utils";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import type { ComposerCommandGroup } from "./composerCommandGroups";
import type { ProviderSlashCommand } from "./adapt";
import { ComposerBanner } from "./ComposerBanner";

export type ComposerCommandItem = {
  id: string;
  type: "provider-slash-command";
  harness: string;
  command: ProviderSlashCommand;
  label: string;
  description: string;
};

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  groups: ReadonlyArray<ComposerCommandGroup>;
  triggerKind: ComposerTriggerKind | null;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <ComposerBanner.Surface
        ref={listRef}
        className="w-full overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        <CommandList className="max-h-72 scroll-pb-6">
          {props.groups.map((group) => (
            <CommandGroup key={group.value} data-composer-command-group={group.value}>
              {/* The kit's own heading, padded to sit over the rows below it, which carry a step more than the palette's. */}
              <CommandGroupLabel className="px-3">{group.label}</CommandGroupLabel>
              {group.items.map((item) => (
                <ComposerCommandMenuItem
                  key={item.id}
                  item={item}
                  triggerKind={props.triggerKind}
                  isActive={props.activeItemId === item.id}
                  onHighlight={props.onHighlightedItemChange}
                  onSelect={props.onSelect}
                />
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </ComposerBanner.Surface>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-3 rounded-lg px-3 py-2! hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {/* The name yields the row's far half to a description only where there is one to read; a command a plugin
            named itself in is long, and in a narrow window it was cut short of a half the row left empty. */}
        <span
          className={cn(
            "min-w-0 truncate font-sans text-xs font-medium",
            props.item.description !== "" && "max-w-[45%] shrink-0",
          )}
        >
          {props.item.label}
        </span>
        {props.item.description !== "" ? (
          <span className="min-w-0 max-w-[48ch] flex-1 truncate text-left text-secondary-label text-xs">
            {props.item.description}
          </span>
        ) : null}
      </span>
    </CommandItem>
  );
});
