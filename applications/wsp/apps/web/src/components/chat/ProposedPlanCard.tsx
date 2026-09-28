// Adapted from pingdotgg/t3code apps/web/src/components/chat/ProposedPlanCard.tsx at 57a66608 (MIT).
// Differs from upstream: the writeFile atom command is the onSavePlan prop, environmentId and threadRef are removed, resolvedTheme is a prop forwarded to the markdown.
import { memo, useState, useId } from "react";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../lib/proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { addNotice, noticeFailure } from "../../notices/store";
import { failureOf } from "../../protocol/failure";
import { RefusalSlot } from "../../settings/sheetParts";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd,
  workspaceRoot,
  resolvedTheme,
  onSavePlan,
}: {
  planMarkdown: string;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  onSavePlan?: (input: { path: string; contents: string }) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const [pathRefusal, setPathRefusal] = useState<{ said: string; fix?: string } | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "plan",
    onError: (error) => noticeFailure(error, (said) => `Plan not copied: ${said}`),
  });
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      addNotice({ kind: "error", text: "This thread has no folder to save the plan into." });
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setPathRefusal(null);
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const relativePath = savePath.trim();
    setPathRefusal(null);
    if (!workspaceRoot || !onSavePlan) {
      return;
    }
    if (!relativePath) {
      setPathRefusal({ said: "Type a path to save the plan to." });
      return;
    }

    setIsSavingToWorkspace(true);
    void (async () => {
      try {
        await onSavePlan({ path: relativePath, contents: saveContents });
        setIsSavingToWorkspace(false);
        setIsSaveDialogOpen(false);
      } catch (error) {
        setIsSavingToWorkspace(false);
        const { said, fix } = failureOf(error);
        setPathRefusal({ said: `Plan not saved: ${said}`, fix });
      }
    })();
  };

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            {onSavePlan ? (
              <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
                Save to task
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              isStreaming={false}
              resolvedTheme={resolvedTheme}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              isStreaming={false}
              resolvedTheme={resolvedTheme}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      {onSavePlan ? (
        <Dialog
          open={isSaveDialogOpen}
          onOpenChange={(open) => {
            if (!isSavingToWorkspace) {
              setIsSaveDialogOpen(open);
            }
          }}
        >
          <DialogPopup className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Save plan to a folder</DialogTitle>
              <DialogDescription>
                Enter a path relative to <code>{workspaceRoot ?? "the task"}</code>.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <label htmlFor={savePathInputId} className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Folder</span>
                <Input
                  id={savePathInputId}
                  value={savePath}
                  onChange={(event) => {
                    setSavePath(event.target.value);
                    setPathRefusal(null);
                  }}
                  placeholder={downloadFilename}
                  spellCheck={false}
                  disabled={isSavingToWorkspace}
                />
              </label>
              <RefusalSlot k="plan-path-refusal" {...pathRefusal} />
            </DialogPanel>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsSaveDialogOpen(false)}
                disabled={isSavingToWorkspace}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSaveToWorkspace()}
                disabled={isSavingToWorkspace}
              >
                {isSavingToWorkspace ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
});
