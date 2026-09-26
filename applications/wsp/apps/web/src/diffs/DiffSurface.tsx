// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Diff surface over git.diff: a scope picker (working
// tree, staged, branch against its merge-base), git run in the panes' shared
// root (the thread's folder unless pinned) named in the same breadcrumb row
// the Files pane uses, with the branch git resolved there beside it, the
// changed-files tree, and the copied code view with per-file collapse and
// inline comments that stay in this surface until a composer exists to hand
// them to.
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FolderGitIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  Rows3Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { REPO_STATE_WORDS, type GitDiffReply, type GitStatusReply, type RepoStateWord } from "@wsp/protocol";
import { ChangedFilesTree } from "../components/chat/ChangedFilesTree.js";
import { DiffStatLabel } from "../components/chat/DiffStatLabel.js";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "../components/diffs/AnnotatableCodeView.js";
import { Button } from "../components/ui/button.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { Spinner } from "../components/ui/spinner.js";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { noDiffLine } from "../actions/format.js";
import { SEND_TO_THREAD } from "./words.js";
import { useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { baseName, relativeTo } from "../files/entries.js";
import { focusPaneOnShow, FolderBreadcrumbs, useUpAFolder } from "../files/FolderBreadcrumbs.js";
import { NotRunning } from "./NotRunning.js";
import { usePinned, useRoot, useRootStore } from "../files/root.js";
import { useDaemonWire } from "../files/wire.js";
import { useLinkWord } from "../terminal/paneWords.js";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse.js";
import { getDiffCollapseIconClassName, resolveDiffThemeName, resolveFileDiffPath } from "../lib/diffRendering.js";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting.js";
import { cn } from "../lib/utils.js";
import { reviewCommentsQuote, type ReviewCommentContext } from "../reviewCommentContext.js";
import { repoAbsence } from "../adapt/git.js";
import { gitDiff, gitStatus } from "../terminal/daemon-fs.js";
import { SCOPE_LABELS, SCOPES, toDiffModel } from "./model.js";
import { useDiffRevealStore } from "./reveal.js";
import { DEFAULT_SCOPE, useDiffStore, type DiffRenderMode } from "./store.js";

/** The diff read for one folder: in flight or failed with the last reply it may keep showing, or the reply itself. */
type LoadState =
  | { kind: "pending"; cwd: string; last: GitDiffReply | null }
  | { kind: "ready"; cwd: string; reply: GitDiffReply }
  | { kind: "error"; cwd: string; message: string; absence: RepoStateWord; last: GitDiffReply | null };

/** The repository git resolved for one folder: its top level and branch, or one of the states the word table names. */
type RepoState = { kind: RepoStateWord } | { kind: "repo"; root: string; branch: string };

const NO_KEYS: ReadonlySet<string> = new Set();
/** The git mark beside the crumbs: one box whether it names a branch or a word from the repo-state table. */
const REPO_MARK_CLASS = "inline-flex h-6 shrink-0 items-center gap-1 px-1 font-mono text-[11px] text-muted-foreground";
/** A sentence that fills an empty pane body, whatever it says: one muted mono line, centred. */
const PANE_LINE_CLASS = "flex flex-1 items-center justify-center px-5 text-center font-mono text-[11px] text-muted-foreground";

function lastReply(state: LoadState): GitDiffReply | null {
  return state.kind === "ready" ? state.reply : state.last;
}

function repoOf(status: GitStatusReply): RepoState {
  return { kind: "repo", root: status.root, branch: status.branch.head };
}

/** What the pane draws its code view with. Its own export so a render test measures the settings the pane ships
 * rather than a copy of them. Two of them are what makes a change readable: the side, which has to be the side the
 * page is drawing, since the tints are mixed from the page's own tokens and the tokens are coloured from the side;
 * and the wrap, since the panel is narrower than a line of prose and the platform's own sideways scrollbar is an
 * overlay a person who never scrolled never sees. */
export function diffPanelOptions(theme: "light" | "dark", renderMode: DiffRenderMode): ComponentProps<typeof AnnotatableCodeView>["options"] {
  return {
    diffStyle: renderMode === "split" ? "split" : "unified",
    lineDiffType: "none",
    overflow: "wrap",
    theme: resolveDiffThemeName(theme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: theme,
    stickyHeaders: true,
  };
}

export function DiffSurface({ workspaceId, theme }: { workspaceId: string; theme: "light" | "dark" }) {
  const wire = useDaemonWire(workspaceId);
  const linkWord = useLinkWord(workspaceId);
  const root = useRoot(workspaceId);
  const cwd = root ?? "";
  const pinned = usePinned(workspaceId);
  const pin = useRootStore(s => s.pin);
  const unpin = useRootStore(s => s.unpin);
  const scope = useDiffStore(s => s.scopeByWorkspaceId[workspaceId] ?? DEFAULT_SCOPE);
  const renderMode = useDiffStore(s => s.renderMode);
  const setScope = useDiffStore(s => s.setScope);
  const setRenderMode = useDiffStore(s => s.setRenderMode);
  const onKeyDown = useUpAFolder(workspaceId);
  const [load, setLoad] = useState<LoadState>({ kind: "pending", cwd, last: null });
  const [repo, setRepo] = useState<{ cwd: string; state: RepoState }>({ cwd, state: { kind: "unknown" } });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NO_KEYS);
  const [treeOpen, setTreeOpen] = useState(true);
  const [comments, setComments] = useState<ReviewCommentContext[]>([]);
  const viewerRef = useRef<AnnotatableCodeViewHandle>(null);
  const scopeKey = `${cwd} ${scope}`;
  const revealRequest = useDiffRevealStore(s => s.pendingByWorkspaceId[workspaceId]);
  const takeReveal = useDiffRevealStore(s => s.take);
  const [revealNote, setRevealNote] = useState<string | null>(null);
  const setDraft = useComposerDraftStore(s => s.setDraft);

  // The comments of one pass go to the thread in front of the person as one block under whatever is already
  // typed there, and the pane keeps none: what is in the composer is what the person edits and sends. The box is
  // not focused from here: the editor's focus reports the text it holds, which on the same tick is still the text
  // before this write, and that report lands back on the draft and empties it.
  const sendToThread = useCallback(() => {
    if (comments.length === 0) return;
    const draft = useComposerDraftStore.getState().drafts[workspaceId]?.prompt ?? "";
    const prompt = draft === "" ? `${reviewCommentsQuote(comments)}\n\n` : `${draft}\n\n${reviewCommentsQuote(comments)}\n\n`;
    setDraft(workspaceId, { prompt, cursor: prompt.length });
    setComments([]);
  }, [comments, setDraft, workspaceId]);

  // The link's word is a dependency for the rule useLinkWord carries: a pane reopened at load reads over a link
  // that is not up yet, and that first failed read is not this header's last word.
  const fetchDiff = useCallback(() => {
    if (!wire || cwd === "") return;
    let gone = false;
    // The last diff and the repository label stay through a refresh of the same folder and reset for a new one.
    setLoad(current => ({ kind: "pending", cwd, last: current.cwd === cwd ? lastReply(current) : null }));
    setRepo(current => (current.cwd === cwd ? current : { cwd, state: { kind: "unknown" } }));
    gitDiff(wire, cwd, scope).then(
      reply => {
        if (!gone) setLoad({ kind: "ready", cwd, reply });
      },
      (e: unknown) => {
        if (gone) return;
        const absence = repoAbsence(e);
        // A state whose pane line replaces the diff has none to keep; a refused read keeps the last one through the failure.
        setLoad(current => ({ kind: "error", cwd, message: e instanceof Error ? e.message : String(e), absence, last: REPO_STATE_WORDS[absence].pane === "" ? lastReply(current) : null }));
      },
    );
    gitStatus(wire, cwd).then(
      status => {
        if (!gone) setRepo({ cwd, state: repoOf(status) });
      },
      (e: unknown) => {
        if (!gone) setRepo({ cwd, state: { kind: repoAbsence(e) } });
      },
    );
    return () => {
      gone = true;
    };
  }, [wire, cwd, scope, linkWord]);

  useEffect(() => fetchDiff(), [fetchDiff]);
  // A new scope or folder is a new set of files; stale collapse keys would pin
  // the wrong ones shut and comments would point at lines that no longer exist.
  useEffect(() => {
    setCollapsed(NO_KEYS);
    setComments([]);
    setRevealNote(null);
  }, [scopeKey]);

  const reply = lastReply(load);
  const model = useMemo(() => (reply ? toDiffModel(reply, scopeKey) : null), [reply, scopeKey]);
  const fileKeys = useMemo(() => model?.files.map(f => f.fileKey) ?? [], [model]);
  const allCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsed);
  const codeViewFiles = useMemo(
    () => (model?.files ?? []).map(f => ({ ...f, collapsed: collapsed.has(f.fileKey) })),
    [model, collapsed],
  );

  const toggleFile = (fileKey: string) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
  };
  const revealFile = useCallback(
    (filePath: string): boolean => {
      const file = model?.files.find(f => f.filePath === filePath);
      if (!file) return false;
      setCollapsed(current => {
        if (!current.has(file.fileKey)) return current;
        const next = new Set(current);
        next.delete(file.fileKey);
        return next;
      });
      viewerRef.current?.scrollTo({ type: "item", id: file.fileKey, align: "start" });
      return true;
    },
    [model],
  );

  // A file another pane asked for is shown once a diff is here to look in; one the diff does not touch is named in a line.
  useEffect(() => {
    if (revealRequest === undefined || model === null) return;
    takeReveal(workspaceId);
    setRevealNote(revealFile(relativeTo(cwd, revealRequest)) ? null : noDiffLine(baseName(revealRequest), SCOPE_LABELS[scope]));
  }, [cwd, model, revealFile, revealRequest, scope, takeReveal, workspaceId]);

  if (!wire || root === null) return <NotRunning workspaceId={workspaceId} />;

  const isPending = load.kind === "pending";
  const scopeLabel = SCOPE_LABELS[scope];
  const shown = repo.cwd === cwd ? repo.state : { kind: "unknown" as const };
  const folderLabel = shown.kind === "repo" ? shown.root : cwd;
  const paneLine = load.kind === "error" ? REPO_STATE_WORDS[load.absence].pane : "";

  return (
    <div
      // Focus is a hairline where the walk needs one and nothing on a click, as the terminal pane beside it is: a
      // ring around the whole pane read as the pane being the thing rather than the diff in it.
      className="flex h-full min-w-0 flex-col bg-background outline-none focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-inset"
      ref={focusPaneOnShow}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-diff-surface
      data-diff-scope={scope}
      data-diff-cwd={cwd}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Menu>
            <MenuTrigger
              className="inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Diff scope: ${scopeLabel}`}
            >
              <span className="truncate">{scopeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </MenuTrigger>
            <MenuPopup align="start" className="w-60">
              {SCOPES.map(candidate => (
                <MenuItem
                  key={candidate}
                  className={candidate === scope ? "bg-foreground/[0.08]" : undefined}
                  onClick={() => setScope(workspaceId, candidate)}
                >
                  <span>{SCOPE_LABELS[candidate]}</span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          {/* The path and the branch leave the header at the narrow width: the file list under it names the file
              and the workspace's own row names the branch, and three facts on a 390 px header drew over one
              another. The path leaves again when a comment puts Send to thread on the header: it is the one fact
              here with no bound, and squeezed to two letters it says nothing while the branch beside it still reads. */}
          {comments.length === 0 ? <FolderBreadcrumbs workspaceId={workspaceId} className="hidden flex-initial sm:flex" /> : null}
          {shown.kind === "repo" ? (
            <span className={cn(REPO_MARK_CLASS, "hidden sm:inline-flex")} title={`git: ${shown.root}`} data-diff-repo={shown.root} data-diff-repo-state={shown.kind}>
              <FolderGitIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="max-w-40 truncate">{shown.branch}</span>
            </span>
          ) : REPO_STATE_WORDS[shown.kind].word === "" ? null : (
            <span className={cn(REPO_MARK_CLASS, "hidden sm:inline-flex")} data-diff-repo-state={shown.kind}>
              <FolderGitIcon className="size-3.5 shrink-0 opacity-40" />
              <Tooltip>
                <TooltipTrigger render={<span className="max-w-40 truncate" tabIndex={0} />}>{REPO_STATE_WORDS[shown.kind].word}</TooltipTrigger>
                <TooltipPopup side="top" className="max-w-72">
                  {REPO_STATE_WORDS[shown.kind].note}
                </TooltipPopup>
              </Tooltip>
            </span>
          )}
          <Tooltip>
            {/* The pin is about the folder in the crumbs beside it, and goes with them at the narrow width. */}
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost"
                  className="hidden sm:inline-flex"
                  aria-label={pinned ? "Follow the agent's folder" : "Stay in this folder"}
                  aria-pressed={pinned}
                  onClick={() => (pinned ? unpin(workspaceId) : pin(workspaceId, cwd))}
                />
              }
            >
              {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{pinned ? "Follow the agent's folder again" : "Stay here when the agent moves"}</TooltipPopup>
          </Tooltip>
          {scope === "branch" && reply?.base ? (
            <div
              className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
              aria-label={`Comparing HEAD against ${reply.base}`}
              data-diff-base={reply.base}
            >
              <span className="min-w-0 truncate">HEAD</span>
              <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 max-w-48 truncate">{reply.base}</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {comments.length > 0 ? (
            <Button type="button" size="xs" variant="ghost" data-diff-send-to-thread onClick={sendToThread}>
              {SEND_TO_THREAD}
            </Button>
          ) : null}
          {model && model.files.length > 0 ? (
            <DiffStatLabel additions={model.stat.additions} deletions={model.stat.deletions} className="mr-1 text-[11px]" layout="inline" />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={<Button type="button" size="icon-sm" variant="ghost" aria-label={isPending ? "Refreshing diff" : "Refresh diff"} onClick={fetchDiff} />}
            >
              <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            </TooltipTrigger>
            <TooltipPopup side="top">{isPending ? "Refreshing diff…" : "Refresh diff"}</TooltipPopup>
          </Tooltip>
          {fileKeys.length > 0 ? (
            <Tooltip>
              {/* Every file's own chevron does this one at a time; the header gives its room back at the narrow
                  width, where the scope's own words need it. */}
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="hidden sm:inline-flex"
                    aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
                    onClick={() => setCollapsed(toggleAllDiffFiles(fileKeys, collapsed))}
                  />
                }
              >
                {allCollapsed ? <ChevronsUpDownIcon className="size-3.5" /> : <ChevronsDownUpIcon className="size-3.5" />}
              </TooltipTrigger>
              <TooltipPopup side="top">{allCollapsed ? "Expand all files" : "Collapse all files"}</TooltipPopup>
            </Tooltip>
          ) : null}
          {/* One diff at a time below the width a split pair can be read at, which is also the width the header
              needs back once a comment puts Send to thread on it. */}
          <ToggleGroup
            className="hidden shrink-0 gap-1 sm:flex"
            size="sm"
            value={[renderMode]}
            onValueChange={value => {
              const next = value[0];
              if (next === "stacked" || next === "split") setRenderMode(next);
            }}
          >
            <Toggle aria-label="Stacked diff view" value="stacked" variant="ghost">
              <Rows3Icon className="size-3.5" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split" variant="ghost">
              <Columns2Icon className="size-3.5" />
            </Toggle>
          </ToggleGroup>
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {reply?.truncated ? (
          <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground" data-diff-truncated>
            This diff was cut at the daemon's 2 MB budget. Files listed without a patch changed too.
          </p>
        ) : null}
        {load.kind === "error" && paneLine === "" ? (
          <p className="shrink-0 border-b border-border/70 px-3 py-2 text-[11px] text-destructive" role="alert">
            {load.message}
          </p>
        ) : null}
        {revealNote !== null ? (
          <p className="shrink-0 border-b border-border/70 px-3 py-1.5 font-mono text-[11px] text-muted-foreground" data-diff-reveal-note>
            {revealNote}
          </p>
        ) : null}
        {model === null ? (
          load.kind === "pending" ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground" role="status" aria-label="Loading diff">
              <Spinner className="size-5" />
            </div>
          ) : paneLine === "" ? null : (
            <p className={PANE_LINE_CLASS}>{paneLine}</p>
          )
        ) : model.raw ? (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <p className="mb-2 text-[11px] text-muted-foreground/75">{model.raw.reason}</p>
            <pre className="rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">{model.raw.text}</pre>
          </div>
        ) : model.changedFiles.length === 0 ? (
          <p className={PANE_LINE_CLASS}>
            No changes in {scopeLabel.toLowerCase()} at {folderLabel}.
          </p>
        ) : (
          <>
            <div className="shrink-0 border-b border-border/60" data-changed-files>
              <button
                type="button"
                aria-expanded={treeOpen}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
                onClick={() => setTreeOpen(open => !open)}
              >
                <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", treeOpen && "rotate-90")} />
                <span>
                  {model.changedFiles.length} changed file{model.changedFiles.length === 1 ? "" : "s"}
                </span>
              </button>
              {treeOpen ? (
                <div className="max-h-56 overflow-auto px-1 pb-1.5">
                  <ChangedFilesTree
                    turnId={scopeKey}
                    files={model.changedFiles}
                    allDirectoriesExpanded
                    resolvedTheme={theme}
                    onOpenTurnDiff={(_turn, filePath) => {
                      if (filePath) revealFile(filePath);
                    }}
                  />
                </div>
              ) : null}
            </div>
            {codeViewFiles.length > 0 ? (
              <div
                className="min-h-0 flex-1"
                onClickCapture={event => {
                  const composedPath = event.nativeEvent.composedPath?.() ?? [];
                  // Header controls keep their own actions; the chevron must not
                  // also fire the row toggle or the two cancel each other.
                  for (const node of composedPath) {
                    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return;
                  }
                  const header = composedPath.find(
                    (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                  );
                  const headerFilePath = header?.querySelector("[data-title]")?.textContent?.trim();
                  if (!headerFilePath) return;
                  const file = codeViewFiles.find(candidate => candidate.filePath === headerFilePath);
                  if (file) toggleFile(file.fileKey);
                }}
              >
                <AnnotatableCodeView
                  key={scopeKey}
                  viewerRef={viewerRef}
                  codeViewKey={scopeKey}
                  className="h-full min-h-0 overflow-auto"
                  files={codeViewFiles}
                  sectionId={scopeKey}
                  sectionTitle={scopeLabel}
                  reviewComments={comments}
                  onAddReviewComment={comment => setComments(current => [...current, comment])}
                  onRemoveReviewComment={id => setComments(current => current.filter(c => c.id !== id))}
                  renderHeaderPrefix={(fileDiff, fileKey, isCollapsed) => {
                    const filePath = resolveFileDiffPath(fileDiff);
                    return (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-micro"
                              variant="ghost"
                              className={cn("-ms-0.5 [--control-icon-color:currentColor] bg-transparent hover:bg-foreground/10", getDiffCollapseIconClassName(fileDiff))}
                              aria-label={isCollapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                              aria-expanded={!isCollapsed}
                              onClick={event => {
                                event.stopPropagation();
                                toggleFile(fileKey);
                              }}
                            />
                          }
                        >
                          {isCollapsed ? <ChevronRightIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
                        </TooltipTrigger>
                        <TooltipPopup side="top">{isCollapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
                      </Tooltip>
                    );
                  }}
                  options={diffPanelOptions(theme, renderMode)}
                />
              </div>
            ) : (
              <p className={PANE_LINE_CLASS}>Every changed file was over the patch budget; nothing to render.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
