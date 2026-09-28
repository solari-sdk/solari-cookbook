// SPDX-License-Identifier: AGPL-3.0-only
// The one row a folder is named in, the Files and Diff panes over the
// machine's roots and the project dialogs over this computer's own: the root
// the folder sits in is the first crumb, then one crumb per folder below it,
// the last being the folder shown. Every crumb goes to its folder, the first
// one included, so the row reads the same over one root or two; over two, the
// chevron beside the first crumb is its own button and is what picks another
// root. Going up is a key (Backspace, Alt+Up) on the pane, which takes focus
// as it is shown, so the row holds nothing dead at a root and keeps its height
// wherever the panes are.
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, type KeyboardEvent } from "react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { CrumbScroller } from "./CrumbScroller.js";
import { folderCrumbs, parentWithin, useRoot, useRoots, useRootStore } from "./root.js";

// The panel's other crumb row, over the open file, draws its crumbs at this size and spacing; the two sit one above
// the other, so they match here.
const CRUMB =
  "block max-w-40 shrink-0 truncate rounded-sm px-0.5 font-mono text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";
const CLICKABLE = "cursor-pointer hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground";

interface UpKeyEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly target: EventTarget | null;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** The keys that go up a folder, unless a field has them: Backspace deletes there and Alt+Up walks the caret. */
export function isUpAFolderKey(event: UpKeyEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.shiftKey || isTextEntry(event.target)) return false;
  return event.key === "Backspace" ? !event.altKey : event.key === "ArrowUp" && event.altKey;
}

/** For the pane's own container: the key goes to the folder above and is inert at a root's edge, which is where the
 * daemon stops listing. */
export function useUpAFolder(workspaceId: string): (event: KeyboardEvent<HTMLElement>) => void {
  const roots = useRoots(workspaceId);
  const root = useRoot(workspaceId);
  const pin = useRootStore(s => s.pin);
  return event => {
    if (root === null || !isUpAFolderKey(event)) return;
    const above = parentWithin(roots, root);
    if (above === null) return;
    event.preventDefault();
    pin(workspaceId, above);
  };
}

/** As a ref on the pane the keys are on: it takes focus when it mounts, which is when its tab is shown. The tab strip
 * is a sibling above the panes, so without this the first Backspace would go to the tab button. */
export function focusPaneOnShow(pane: HTMLElement | null): void {
  pane?.focus({ preventScroll: true });
}

/** One crumb, with the folder it names under the pointer: the folder shown is text, every other crumb a button that
 * goes there. */
function Crumb({
  path,
  label,
  current,
  onPick,
}: {
  path: string;
  label: string;
  current: boolean;
  onPick: ((path: string) => void) | null;
}) {
  const tone = current ? "font-medium text-foreground" : "text-muted-foreground";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          onPick === null ? (
            <span className={cn(CRUMB, tone)} aria-current="page" data-folder-crumb={path} />
          ) : (
            <button
              type="button"
              className={cn(CRUMB, CLICKABLE, tone)}
              aria-current={current ? "page" : undefined}
              data-folder-crumb={path}
              onClick={() => onPick(path)}
            />
          )
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The first crumb: one click to its root, always. A second root the daemon browses adds the chevron beside it, which
 * is the only control that switches root, so importing a project never changes what the crumb does. */
function RootCrumb(props: { roots: readonly string[]; path: string; current: boolean; onPick: (path: string) => void }) {
  const crumb = <Crumb path={props.path} label={props.path} current={props.current} onPick={props.onPick} />;
  if (props.roots.length < 2) return crumb;
  return (
    <span className="flex min-w-0 shrink-0 items-center">
      {crumb}
      <Menu>
        <MenuTrigger
          className={cn("shrink-0 rounded-sm p-1 text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", CLICKABLE)}
          aria-label="Pick a browsable folder"
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-max min-w-40 max-w-[min(24rem,var(--available-width))]">
          {props.roots.map(candidate => (
            <MenuItem
              key={candidate}
              className={cn("font-mono text-xs", candidate === props.path && "bg-foreground/[0.08]")}
              data-current-root={candidate === props.path}
              onClick={() => props.onPick(candidate)}
            >
              <span className="min-w-0 flex-1 truncate">{candidate}</span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </span>
  );
}

/** The row itself, over any roots and any folder inside them: the panes read the workspace's, and the import and
 * export dialogs the host's own, so both rows are this one. */
export function FolderCrumbRow({ roots, folder, onPick, className }: { roots: readonly string[]; folder: string | null; onPick: (path: string) => void; className?: string }) {
  const crumbs = useMemo(() => (folder === null ? [] : folderCrumbs(roots, folder)), [roots, folder]);
  return (
    <CrumbScroller label="Folder path" className={className} data-folder-crumbs>
      {crumbs.map((crumb, index) => {
        const current = crumb.path === folder;
        return (
          <div key={crumb.path} className="flex min-w-0 shrink-0 items-center">
            {index > 0 ? <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" /> : null}
            {index === 0 ? (
              <RootCrumb roots={roots} path={crumb.path} current={current} onPick={onPick} />
            ) : (
              <Crumb path={crumb.path} label={crumb.name} current={current} onPick={current ? null : onPick} />
            )}
          </div>
        );
      })}
    </CrumbScroller>
  );
}

export function FolderBreadcrumbs({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const roots = useRoots(workspaceId);
  const root = useRoot(workspaceId);
  const pin = useRootStore(s => s.pin);
  return <FolderCrumbRow roots={roots} folder={root} onPick={path => pin(workspaceId, path)} className={className} />;
}
