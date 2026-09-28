// Adapted from pingdotgg/t3code apps/web/src/components/CommandPalette.logic.ts at 57a66608 (MIT).
// Kept: the item, group and view shapes, the ranked filter and the root
// grouping. Left out: the overlay-mode reducer (one mode here), the project
// and thread item builders (bound to their router and settings), directory
// browsing and the file picker. The filter's effect helpers became plain
// array code; contract types come from keybindingTypes.ts.
import { type ReactNode } from "react";
import type { KeybindingCommand } from "../../keybindingTypes.js";
import { normalizeSearchText } from "../../lib/utils.js";

export { normalizeSearchText } from "../../lib/utils.js";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const ADDON_ICON_CLASS = "size-4";

export interface CommandPaletteThreadContentMatch {
  readonly source: "user" | "assistant";
  readonly snippet: string;
  readonly query: string;
}

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly threadContentMatch?: CommandPaletteThreadContentMatch;
  readonly timestamp?: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  /** Optional content rendered inline before the title text. */
  readonly titleLeadingContent?: ReactNode;
  /** Optional content rendered inline after the title text (before the timestamp). */
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

function rankSearchFieldMatch(
  field: string,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const normalizedField = normalizeSearchText(field);
  if (
    normalizedField.length === 0 ||
    !queryTokens.every((token) => normalizedField.includes(token))
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  if (normalizedField.includes(normalizedQuery)) {
    return 1;
  }
  return 0;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery, queryTokens);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }

  return 0;
}

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  settingsSearchItems?: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }
  const queryTokens = normalizedQuery.split(" ");

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Tasks",
        items: input.projectSearchItems,
      });
    }
    if (input.settingsSearchItems && input.settingsSearchItems.length > 0) {
      searchableGroups.push({
        value: "settings-search",
        label: "Settings",
        items: input.settingsSearchItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
  }

  return searchableGroups.flatMap((group) => {
    const items = group.items
      .flatMap((item, index) => {
        const haystack = normalizeSearchText(item.searchTerms.join(" "));
        if (!queryTokens.every((token) => haystack.includes(token))) {
          return [];
        }
        return [{ item, index, rank: rankCommandPaletteItemMatch(item, normalizedQuery, queryTokens) }];
      })
      .sort((left, right) => right.rank - left.rank || left.index - right.index)
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

export type CommandPaletteMode = "root" | "submenu";

export function getCommandPaletteMode(input: { currentView: CommandPaletteView | null }): CommandPaletteMode {
  return input.currentView ? "submenu" : "root";
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

export function getCommandPaletteInputPlaceholder(mode: CommandPaletteMode): string {
  switch (mode) {
    case "root":
      return "Search commands, tasks, and threads...";
    case "submenu":
      return "Search...";
  }
}
