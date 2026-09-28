// SPDX-License-Identifier: AGPL-3.0-only
// The strip under the composer naming where the thread works: the folder and
// its git branch. Before the first message the folder is the one the runtime's
// rule will open, the picked project's or the machine's own, and a picker over
// the daemon's listings, one level at a time, across the same roots the panes
// browse (its home and every project), the machine's own hidden folders left
// out of the walk, with a field at its top for a folder typed or pasted whole,
// which is the road to one of those, and, in the desktop app, the system
// chooser beside it;
// a folder picked here is what sessions.start names as cwd, over every
// project, and where the panes root.
// Whether the picker is open is the composer's to say, so the project pick in
// the box's footer opens it for its other folder row. Once a turn exists the row is
// a label for the harness folder, which a cd in the agent's shell cannot move
// (the CLI keys a session to it), so the label explains itself on hover and
// offers a new thread with the picker open; the shell's own folder, as the
// agent's tool calls move it, is what the panes follow. The branch is read,
// not switched: the daemon has no checkout op.
import { ArrowLeftIcon, ChevronDownIcon, CheckIcon, FolderGitIcon, FolderIcon, FolderSearchIcon, GitBranchIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { hiddenFolder, isMacMachine, REPO_STATE_WORDS, type DaemonLinkStatus, type FolderMachine, type RepoStateWord } from "@wsp/protocol";
import { baseName } from "../../files/entries";
import { FOLDER_GHOST_WITH_WALK, FolderPathField, folderPathRefusal, useFolderPick, type FolderRefusal } from "../../files/FolderPathField";
import { useWorkspaceListing } from "../../files/listing";
import { parentWithin, rootOf, useRoots, useRootStore, useThreadFolder } from "../../files/root";
import { useDaemonRoot, useDaemonWire } from "../../files/wire";
import { useStatus } from "../../protocol/store";
import { useLinkWord } from "../../terminal/paneWords";
import { repoAbsence } from "../../adapt/git";
import { desktopBridge } from "../../lib/desktopShell";
import { cn } from "../../lib/utils";
import { DaemonOpError, fsList, gitStatus } from "../../terminal/daemon-fs";
import type { TerminalWire } from "../../terminal/link";
import { Button, BUTTON_GLYPH_INSET } from "../ui/button";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerSurface } from "./ComposerSurface";
import type { ChatThreadHandle } from "./useChatThread";

/** What git said about the folder: a branch, or one of the states the slot has a word (or none) for. */
type Branch = { readonly kind: RepoStateWord } | { readonly kind: "repo"; readonly head: string };

/** The branch git names for the folder under the box, asked again every time the daemon's link changes its word,
 * which is the rule `useLinkWord` carries and the Diff pane's header reads too. */
function useBranch(wire: TerminalWire | null, folder: string | null, running: boolean, link: DaemonLinkStatus): Branch {
  const [state, setState] = useState<{ folder: string | null; branch: Branch }>({ folder, branch: { kind: "unknown" } });
  useEffect(() => {
    if (!wire || folder === null || running) return;
    let gone = false;
    gitStatus(wire, folder).then(
      status => {
        if (!gone) setState({ folder, branch: { kind: "repo", head: status.branch.head } });
      },
      (e: unknown) => {
        if (!gone) setState({ folder, branch: { kind: repoAbsence(e) } });
      },
    );
    return () => {
      gone = true;
    };
  }, [wire, folder, running, link]);
  return state.folder === folder ? state.branch : { kind: "unknown" };
}

/** Whether the composer is about to open a new thread, so its folder and its project are still the person's to pick: a
 * fresh view, or an empty one whose send resumes no folder. The project pick in the footer and the folder picker in
 * this row read the one predicate, so neither offers a pick the other has locked. */
export function canPickFolder(thread: ChatThreadHandle): boolean {
  const { cwd, entries, running } = thread.view;
  return thread.hydrated && (thread.fresh || (entries.length === 0 && !running && cwd === null));
}

/** The size both the folder and the branch wear, the picker button's (size xs), so the row does not move when the
 * label replaces the button. */
const slotClass = "inline-flex h-7 items-center gap-1 px-2 text-sm text-muted-foreground sm:h-6 sm:text-xs";
/** The folder in either form: the one item in the row that gives its width up, and that keeps what it cannot hold
 * inside its own box, so a long path is cut at its edge rather than drawn over the branch. */
const folderItemClass = "min-w-0 shrink overflow-hidden";
/** The path, cut at its head: the end of a path is the part a person recognises, so the ellipsis goes on the left,
 * which is what a right-to-left box gives. The isolate keeps the path's own order inside that box. */
const folderPathClass = "min-w-0 truncate font-mono [direction:rtl]";
/** The button's own glyph inset, carried here so the path starts on the same pixel in both forms and does not step
 * sideways when the picker replaces the label. */
const labelClass = cn(slotClass, folderItemClass, BUTTON_GLYPH_INSET);

const LOCKED_FOLDER_NOTE = "The folder this thread's harness runs in. A cd inside the agent's shell does not move it; start a new thread to work from another folder.";
const BRANCH_NOTE = "The folder's branch as the task reports it. Nothing here switches it; check out another branch from the terminal.";
/** The branch slot keeps the label's height while empty, so the row does not move when a branch arrives. */
const branchSlotClass = cn(slotClass, "shrink-0 font-mono");

/** The menu's floor: the rows ask for what they need and it grows to them, since the row that commits a person to a
 * folder has to show which folder. Its ceiling is the composer's own width, which is measured rather than written,
 * below. */
const menuWidthClass = "min-w-72";

/** How wide the menu may grow: the composer's own box, measured, since the popup is portalled out of the composer
 * and can read nothing off it. A box the browser has not laid out leaves the menu uncapped rather than capping it
 * at nothing. */
function useComposerWidth(inside: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const box = inside.current?.closest<HTMLElement>("[data-chat-composer]") ?? null;
    if (box === null) return;
    const measure = (): void => setWidth(box.getBoundingClientRect().width || undefined);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    return () => watch.disconnect();
  }, [inside]);
  return width;
}

/** A row naming a folder: the word keeps its width and the path takes the rest, cut at its head like every other
 * path here. */
const folderRowClass = "flex min-w-0 flex-1 items-center gap-1";

/** The folder's path as both forms of the row draw it. */
function FolderPath({ path }: { path: string }) {
  return (
    <span className={folderPathClass}>
      <bdi dir="ltr">{path}</bdi>
    </span>
  );
}

function FolderMenu({
  workspaceId,
  wire,
  roots,
  machine,
  folder,
  open,
  onOpenChange,
  onPick,
}: {
  workspaceId: string;
  wire: TerminalWire;
  roots: readonly string[];
  /** The home this workspace's daemon announced and whether that machine is a Mac: what the walk hides reads it. */
  machine: FolderMachine;
  folder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (dir: string) => void;
}) {
  // The level walked to while the menu is up; null is the shown folder, so a menu opened from outside starts there.
  const [walked, setWalked] = useState<string | null>(null);
  const dir = walked ?? folder;
  const setDir = setWalked;
  const { levels, ensure } = useWorkspaceListing(workspaceId);
  const level = levels.get(dir);
  const parent = parentWithin(roots, dir);
  const current = rootOf(roots, dir);
  const folders = level?.entries?.filter(entry => entry.kind === "directory" && !hiddenFolder(entry.path, machine)) ?? null;
  const setOpen = (next: boolean): void => {
    onOpenChange(next);
    setWalked(null);
  };
  // A path typed or chosen is a folder only if the daemon lists it, so the pick asks the same op the walk does and
  // the answer it refuses with is the daemon's own.
  const hold = useFolderPick(async (path): Promise<FolderRefusal | null> => {
    try {
      await fsList(wire, path, { gitignore: true });
    } catch (e) {
      return folderPathRefusal(e instanceof DaemonOpError ? e.code : undefined);
    }
    onPick(path);
    setOpen(false);
    return null;
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const room = useComposerWidth(trigger);
  // Only a shell with a system chooser has this road; a browser tab walks the daemon's own levels below instead.
  const chooser = desktopBridge()?.pickFolder;
  const chooseFolder = async (): Promise<void> => {
    const picked = await chooser?.();
    if (picked !== undefined) await hold.submit(picked);
  };

  useEffect(() => {
    if (open) ensure(dir);
  }, [open, dir, ensure]);

  return (
    <Menu
      open={open}
      onOpenChange={next => {
        setOpen(next);
        hold.edit("");
      }}
    >
      <MenuTrigger
        ref={trigger}
        render={<Button type="button" variant="ghost" size="xs" />}
        className={cn(folderItemClass, "justify-start font-medium text-muted-foreground hover:text-foreground/80")}
        aria-label={`Working folder: ${folder}`}
        data-composer-folder={folder}
      >
        <FolderIcon className="size-3 shrink-0" />
        <FolderPath path={folder} />
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className={menuWidthClass} style={room === undefined ? undefined : { maxWidth: room }}>
        <FolderPathField id="composer-folder-path" label="Path" placeholder={FOLDER_GHOST_WITH_WALK} hold={hold} className="px-2 pt-1.5" />
        {chooser === undefined ? null : (
          <MenuItem closeOnClick={false} onClick={() => void chooseFolder()} data-composer-folder-choose="">
            <FolderSearchIcon />
            <span className="min-w-0 flex-1 truncate">Choose a folder</span>
          </MenuItem>
        )}
        <MenuSeparator />
        {roots.length > 1 ? (
          <>
            <MenuRadioGroup aria-label="Browsable folders" value={current} onValueChange={next => typeof next === "string" && setDir(next)}>
              {roots.map(candidate => (
                <MenuRadioItem key={candidate} value={candidate} closeOnClick={false} title={candidate} data-composer-folder-root={candidate}>
                  <span className="flex min-w-0 items-center gap-2">
                    <FolderIcon className="text-muted-foreground" aria-hidden />
                    <span className="truncate font-mono">{candidate}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem onClick={() => onPick(dir)} data-composer-folder-pick={dir}>
          <CheckIcon />
          <span className={folderRowClass}>
            <span className="shrink-0">Work in</span>
            <FolderPath path={dir} />
          </span>
        </MenuItem>
        {parent !== null ? (
          <MenuItem closeOnClick={false} onClick={() => setDir(parent)} data-composer-folder-up={parent}>
            <ArrowLeftIcon />
            <span className={folderRowClass}>
              <span className="shrink-0">Up to</span>
              <FolderPath path={parent} />
            </span>
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuGroup key={dir}>
          {folders === null && level?.error ? (
            <MenuItem disabled>{level.error}</MenuItem>
          ) : folders === null ? (
            <MenuItem disabled>
              <LoaderCircleIcon className="animate-spin" />
              Loading folder…
            </MenuItem>
          ) : folders.length === 0 ? (
            <MenuItem disabled>No folders here.</MenuItem>
          ) : (
            folders.map(entry => (
              <MenuItem key={entry.path} closeOnClick={false} onClick={() => setDir(entry.path)} data-composer-folder-entry={entry.path}>
                <FolderIcon />
                <span className="min-w-0 flex-1 truncate font-mono">{baseName(entry.path)}</span>
              </MenuItem>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function ComposerCheckoutRow({
  workspaceId,
  thread,
  pickerOpen,
  onPickerOpenChange,
  access = null,
}: {
  workspaceId: string;
  thread: ChatThreadHandle;
  /** The access picker, which the one-line composer carries here rather than in the box. */
  access?: ReactNode;
  /** Whether the folder picker is up; the composer holds it so the footer's other folder row can open it. */
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
}) {
  const wire = useDaemonWire(workspaceId);
  const roots = useRoots(workspaceId);
  const home = useDaemonRoot(workspaceId);
  const os = useStatus(workspaceId)?.facts?.os;
  // The machine's own two answers, which is all the walk needs to know a home's Library from a folder of that name
  // somebody made: a machine that has reported neither hides the dot folders alone.
  const machine = useMemo<FolderMachine>(() => ({ home, mac: isMacMachine(os) }), [home, os]);
  const follow = useRootStore(s => s.follow);
  const shell = useRootStore(s => s.shell);
  const choose = useRootStore(s => s.choose);
  const startFolder = useThreadFolder(workspaceId);
  const linkWord = useLinkWord(workspaceId);
  const { cwd, shellCwd, running } = thread.view;
  const pickable = canPickFolder(thread);
  // A view on a turn names that turn's folder; a view about to open a thread names the one the thread will start in.
  const folder = pickable ? startFolder : (cwd ?? startFolder);
  const canPick = wire !== null && roots.length > 0 && folder !== null;
  const branch = useBranch(wire, folder, running, linkWord);

  useEffect(() => {
    if (cwd !== null) follow(workspaceId, cwd);
  }, [cwd, follow, workspaceId]);
  useEffect(() => {
    shell(workspaceId, shellCwd);
  }, [shell, shellCwd, workspaceId]);

  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-pickable={pickable || undefined}>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {pickable && canPick ? (
          <FolderMenu workspaceId={workspaceId} wire={wire} roots={roots} machine={machine} folder={folder} open={pickerOpen} onOpenChange={onPickerOpenChange} onPick={dir => choose(workspaceId, dir)} />
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger render={<span className={labelClass} tabIndex={0} data-composer-folder={folder ?? undefined} />}>
                {branch.kind === "repo" ? <FolderGitIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
                <FolderPath path={folder ?? ""} />
              </TooltipTrigger>
              <TooltipPopup side="top" align="start" className="max-w-80">
                {LOCKED_FOLDER_NOTE}
              </TooltipPopup>
            </Tooltip>
          </>
        )}
        {access !== null ? <span className="flex shrink-0 items-center">{access}</span> : null}
      </div>
      {branch.kind === "repo" ? (
        <Tooltip>
          <TooltipTrigger render={<span className={branchSlotClass} tabIndex={0} data-composer-branch={branch.head} />}>
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{branch.head}</span>
          </TooltipTrigger>
          <TooltipPopup side="top" align="end" className="max-w-80">
            {BRANCH_NOTE}
          </TooltipPopup>
        </Tooltip>
      ) : REPO_STATE_WORDS[branch.kind].word === "" ? (
        <span className={branchSlotClass} data-composer-branch={branch.kind} />
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className={branchSlotClass} tabIndex={0} data-composer-branch={branch.kind} />}>
            {REPO_STATE_WORDS[branch.kind].word}
          </TooltipTrigger>
          <TooltipPopup side="top" align="end" className="max-w-80">
            {REPO_STATE_WORDS[branch.kind].note}
          </TooltipPopup>
        </Tooltip>
      )}
    </ComposerSurface.ContextStrip>
  );
}

/** The strip under a project home's composer: no workspace exists yet, so it names the folder and the branch the
 * send's workspace starts from, off the project's own record. */
export function HomeCheckoutRow({ path, branch }: { path: string; branch: string }) {
  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-composer-home>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className={labelClass} data-composer-folder={path}>
          <FolderGitIcon className="size-3 shrink-0" />
          <FolderPath path={path} />
        </span>
      </div>
      {branch !== "" ? (
        <span className={branchSlotClass} data-composer-branch={branch}>
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
    </ComposerSurface.ContextStrip>
  );
}
