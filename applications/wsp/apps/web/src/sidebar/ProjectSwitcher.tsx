// SPDX-License-Identifier: AGPL-3.0-only
// The project switcher at the head of the sidebar: a row naming "All projects"
// or the one project picked, and under it a menu on the app's popover
// primitive with a search field, "All projects", one row per project in the
// host's order and "Add a project" at its foot. Picking filters what the tree
// under it lists and nothing else. While one project is picked the head
// stands in for that project's row: its plus on hover is New workspace and a
// right-click opens the project's menu. On a wsp with no project the head is
// held, since there is nothing to pick.
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover.js";
import { SidebarMenuAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn, normalizeSearchText } from "../lib/utils.js";
import { ProjectGlyph } from "../projects/look.js";
import { openProjectSettings } from "../settings/openAt.js";
import { GLYPH_ROW_CLASS, HOVER_GLYPH_CLASS, ONE_LINE_ROW_CLASS, ROW_META_CLASS } from "./rowGrammar.js";
import type { ProjectRef } from "./threadTree.js";
import { NEW_WORKSPACE, PROJECT_WORDS, SWITCHER_WORDS } from "./words.js";
import { projectComputerWord } from "./workspaceRows.js";


/** One row of the menu: a project, or the pick that shows them all, whose id is null. */
interface Option {
  readonly id: string | null;
  readonly name: string;
  readonly computer: string | null;
}

const MENU_ROW_CLASS = "group/option flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-left text-sm text-foreground outline-none";
/** The id of one menu row, which the field names as its active descendant while the keys are on it. */
const optionId = (id: string | null): string => `project-switcher-option-${id ?? "all"}`;
const ADD_ROW_ID = "project-switcher-option-add";

/** The rows the menu lists for a query: "All projects" always, then every project whose name holds the typed
 * text, case aside. */
export function switcherOptions(projects: ReadonlyArray<ProjectRef>, named: ReadonlyMap<string, string>, query: string): Option[] {
  const q = normalizeSearchText(query);
  return [
    { id: null, name: SWITCHER_WORDS.all, computer: null },
    ...projects.filter(project => q === "" || normalizeSearchText(project.name).includes(q)).map(project => ({ id: project.id, name: project.name, computer: projectComputerWord(project, named) })),
  ];
}

export function ProjectSwitcher({
  projects,
  named,
  pick,
  onPick,
  onNewWorkspace,
  onAddProject,
  onContextMenu,
}: {
  projects: ReadonlyArray<ProjectRef>;
  /** Every computer this host holds by id, for the word beside a project that is not on this one. */
  named: ReadonlyMap<string, string>;
  /** The project the tree is filtered to, or null for every project. */
  pick: ProjectRef | null;
  onPick: (projectId: string | null) => void;
  onNewWorkspace: (projectId: string) => void;
  onAddProject: () => void;
  /** The picked project's own menu, which the head offers while it stands in for that project's row. */
  onContextMenu: (event: MouseEvent<HTMLElement>, projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const headRef = useRef<HTMLButtonElement>(null);
  const options = useMemo(() => switcherOptions(projects, named, query), [projects, named, query]);
  /** The last row the keys reach: "Add a project", after the options. */
  const last = options.length;
  const held = projects.length === 0;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    headRef.current?.focus();
  };
  const choose = (option: Option): void => {
    onPick(option.id);
    close();
  };
  const add = (): void => {
    close();
    onAddProject();
  };

  // Every key the menu takes stops here: the popup is a portal under the sidebar's own key handler, which would
  // otherwise walk the tree rows on the same ArrowDown.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive(at => (at + (event.key === "ArrowDown" ? 1 : last)) % (last + 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const option = options[active];
      if (option !== undefined) choose(option);
      else add();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  // The head's own ArrowDown opens the menu and goes no further: the rows under it walk on the same key.
  const onHeadKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "ArrowDown" || held) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  const computer = pick === null ? null : projectComputerWord(pick, named);
  return (
    <Popover open={open} onOpenChange={next => setOpen(next && !held)}>
      <div className="group/menu-item relative" {...(pick === null ? {} : { onContextMenu: (event: MouseEvent<HTMLElement>) => onContextMenu(event, pick.id) })}>
        <PopoverTrigger
          ref={headRef}
          render={<SidebarMenuButton size="sm" />}
          data-k="project-switcher"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={held}
          className={cn(ONE_LINE_ROW_CLASS, GLYPH_ROW_CLASS)}
          onKeyDown={onHeadKeyDown}
        >
          {pick === null ? <FolderIcon className="size-4" /> : <ProjectGlyph projectId={pick.id} />}
          <span data-switcher-name className="min-w-0 flex-1 truncate">
            {pick?.name ?? SWITCHER_WORDS.all}
          </span>
          {computer === null ? null : (
            <span data-switcher-computer className={cn(ROW_META_CLASS, "shrink-0")}>
              {computer}
            </span>
          )}
          {/* The room the plus takes on hover, kept at rest so nothing moves. */}
          {pick === null ? null : <span aria-hidden data-switcher-plus-room className="w-5 shrink-0" />}
          <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 transition-transform duration-150", open && "rotate-180")} />
        </PopoverTrigger>
        {pick === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  showOnHover
                  // The room's own place: the row's 8 px inset, the 16 px chevron and the 10 px gap before it.
                  className={cn(HOVER_GLYPH_CLASS, "right-8.5")}
                  data-k="new-workspace"
                  data-project={pick.id}
                  aria-label={NEW_WORKSPACE}
                  onClick={() => onNewWorkspace(pick.id)}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{NEW_WORKSPACE}</TooltipPopup>
          </Tooltip>
        )}
      </div>
      <PopoverPopup
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-(--anchor-width) p-0 transition-[opacity,translate] duration-150 data-starting-style:scale-100 data-starting-style:-translate-y-0.5"
        viewportClassName="p-0 [--viewport-inline-padding:0]"
      >
        <div data-project-switcher-menu className="flex flex-col" onKeyDown={onMenuKeyDown}>
          <label className="flex h-8 items-center gap-2 border-b border-border px-3">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setActive(0);
              }}
              placeholder={SWITCHER_WORDS.search}
              aria-label={SWITCHER_WORDS.search}
              aria-activedescendant={active === last ? ADD_ROW_ID : optionId(options[active]?.id ?? null)}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-placeholder"
              data-switcher-search
            />
          </label>
          <div role="listbox" aria-label="Projects" className="flex flex-col p-1">
            {options.map((option, index) => (
              <div
                key={option.id ?? "all"}
                id={optionId(option.id)}
                role="option"
                aria-selected={(pick?.id ?? null) === option.id}
                data-switcher-option={option.id ?? "all"}
                data-active={index === active || undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(MENU_ROW_CLASS, index === active && "bg-accent text-accent-foreground")}
              >
                {option.id === null ? <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <ProjectGlyph projectId={option.id} />}
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {option.computer === null ? null : <span className={cn(ROW_META_CLASS, "shrink-0")}>{option.computer}</span>}
                {(pick?.id ?? null) === option.id ? <CheckIcon aria-hidden className="size-4 shrink-0" /> : null}
                {option.id === null ? null : (
                  <button
                    type="button"
                    data-k="project-settings"
                    aria-label={SWITCHER_WORDS.settingsOf(option.name)}
                    onClick={event => {
                      event.stopPropagation();
                      setOpen(false);
                      openProjectSettings(option.id!);
                    }}
                    className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-background/60 hover:text-foreground"
                  >
                    <SettingsIcon className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-border p-1">
            <button
              type="button"
              id={ADD_ROW_ID}
              data-k="add-project-row"
              data-active={active === last || undefined}
              onMouseEnter={() => setActive(last)}
              onClick={add}
              className={cn(MENU_ROW_CLASS, active === last && "bg-accent text-accent-foreground")}
            >
              <PlusIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{PROJECT_WORDS.add}</span>
            </button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
