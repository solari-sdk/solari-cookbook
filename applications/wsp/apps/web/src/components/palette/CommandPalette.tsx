// SPDX-License-Identifier: AGPL-3.0-only
// The palette container: one dialog over the copied content and results,
// items from the store's workspaces and sessions, opened through the bus.
// The workspace rows come from the workspace registry, so they run what the
// sidebar's buttons and menus run.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { isLocalWorkspace } from "@wsp/protocol";
import { useWorkspaceVerbs } from "../../actions/verbs.js";
import { isCommandPaletteOpen, onOpenCommandPalette } from "../../commandPaletteBus.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../../keybindingDefaults.js";
import type { ResolvedKeybindingsConfig } from "../../keybindingTypes.js";
import { noticeFailure } from "../../notices/store.js";
import { useSelectedWorkspaceId, useSidebarProjects, useStore } from "../../protocol/store.js";
import { useRightPanelStore } from "../../rightPanelStore.js";
import { cycleThreadInSpace, goToAdjacentWorkspace, goToWorkspace } from "../../shell/shellCommands.js";
import { requestAddProject, requestNewWorkspace } from "../../shell/shellRequests.js";
import { CommandDialog, CommandDialogPopup } from "../ui/command.js";
import { useSidebar } from "../ui/sidebar.js";
import {
  buildRootGroups,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic.js";
import { CommandPaletteContent } from "./CommandPaletteContent.js";
import { CommandPaletteResults } from "./CommandPaletteResults.js";
import { buildPaletteItems, type PaletteHandlers } from "./paletteItems.js";

const NO_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];

export function CommandPalette({ keybindings = DEFAULT_RESOLVED_KEYBINDINGS }: { keybindings?: ResolvedKeybindingsConfig }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const { toggleSidebar } = useSidebar();
  const api = useStore(s => s.api);
  const workspaces = useStore(s => s.workspaces);
  const places = useStore(s => s.places);
  const select = useStore(s => s.select);
  const openSettings = useStore(s => s.openSettings);
  const openAddComputer = useStore(s => s.openAddComputer);
  const selectedId = useSelectedWorkspaceId();
  const toggleRightPanel = useRightPanelStore(s => s.toggleVisibility);
  const verbs = useWorkspaceVerbs();

  useEffect(
    () =>
      onOpenCommandPalette(detail => {
        if (detail.toggle && isCommandPaletteOpen()) {
          setOpen(false);
          return;
        }
        setQuery(detail.query ?? "");
        setHighlightedItemValue(null);
        setOpen(true);
      }),
    [],
  );

  const projects = useSidebarProjects();
  const handlers = useMemo<PaletteHandlers>(
    () => ({
      selectWorkspace: goToWorkspace,
      selectThread: select,
      newWorkspace: () => requestNewWorkspace(),
      toggleSidebar,
      toggleRightPanel,
      nextWorkspace: () => goToAdjacentWorkspace(1),
      previousWorkspace: () => goToAdjacentWorkspace(-1),
      nextThread: () => cycleThreadInSpace(1),
      previousThread: () => cycleThreadInSpace(-1),
      openSettings,
      addProject: requestAddProject,
      openAddComputer,
    }),
    [openAddComputer, openSettings, select, toggleRightPanel, toggleSidebar],
  );
  const items = useMemo(
    () => buildPaletteItems({ projects, selectedId, query, canCreate: api !== null, handlers, verbs, places }),
    [api, handlers, places, projects, query, selectedId, verbs],
  );

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const root = buildRootGroups({ actionItems: items.actionItems, recentThreadItems: items.recentThreadItems });
    if (items.workspaceItems.length > 0) {
      root.splice(1, 0, { value: "workspaces", label: "Tasks", items: items.workspaceItems });
    }
    return filterCommandPaletteGroups({
      activeGroups: root,
      query,
      isInSubmenu: false,
      projectSearchItems: NO_ITEMS,
      threadSearchItems: items.threadSearchItems,
    });
  }, [items, query]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setHighlightedItemValue(null);
  };

  const executeItem = (item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void => {
    if (item.disabled || item.kind !== "action") return;
    if (!item.keepOpen) close();
    void item.run().catch((error: unknown) => {
      noticeFailure(error, said => `${String(item.title)}: ${said}`);
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    const highlighted = groups.flatMap(group => group.items).find(item => item.value === highlightedItemValue);
    if (!highlighted) return;
    event.preventDefault();
    executeItem(highlighted);
  };

  return (
    <CommandDialog open={open} onOpenChange={next => (next ? setOpen(true) : close())}>
      <CommandDialogPopup
        aria-label="Command palette"
        className="overflow-hidden p-0"
        data-command-palette="true"
        onBackdropPointerDown={close}
      >
        <CommandPaletteContent
          aria-label="Command palette"
          footerActionLabel="Run"
          inputProps={{ placeholder: getCommandPaletteInputPlaceholder("root"), onKeyDown: onInputKeyDown }}
          mode="none"
          onItemHighlighted={value => setHighlightedItemValue(typeof value === "string" ? value : null)}
          onValueChange={value => {
            setHighlightedItemValue(null);
            setQuery(value);
          }}
          panelClassName="max-h-[min(28rem,70vh)]"
          value={query}
        >
          <CommandPaletteResults
            groups={groups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={query.startsWith(">")}
            keybindings={keybindings}
            onExecuteItem={executeItem}
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
