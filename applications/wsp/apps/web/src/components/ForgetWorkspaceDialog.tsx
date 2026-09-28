// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a workspace goes, on either road out: a delete,
// which takes its machine in that kind's own words and its record with it, and
// a forget, which is the same road for a workspace whose machine is already
// gone. It names the workspace and what leaves, asks the host once, and shows
// the host's refusal in place. The row leaves on workspace.deleted, which the
// store already applies.
import { useState } from "react";
import { deleteNotice, forgetNotice, workspaceKind, type WorkspaceView } from "@wsp/protocol";
import { CLIENT_CANNOT_DELETE, CLIENT_CANNOT_FORGET } from "../actions/format.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "./ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "./ui/button.js";

/** The two roads out, each with the word on its button, the sentence under the title and the verb it asks for. */
const ROADS = {
  delete: { word: "Delete", busy: "Deleting\u2026", cannot: CLIENT_CANNOT_DELETE },
  forget: { word: "Forget", busy: "Forgetting\u2026", cannot: CLIENT_CANNOT_FORGET },
} as const;

export function ForgetWorkspaceDialog({
  workspace,
  threads,
  act = "forget",
  open,
  onOpenChange,
}: {
  workspace: WorkspaceView;
  threads: number;
  /** Which road out this dialog is for; a workspace whose machine is gone takes the forget. */
  act?: "forget" | "delete";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useStore(s => s.api);
  const road = ROADS[act];
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const change = (next: boolean): void => {
    if (!next) setRefusal(null);
    onOpenChange(next);
  };

  const forget = async (): Promise<void> => {
    const ask = act === "delete" ? api?.deleteWorkspace : api?.forget;
    if (!ask) {
      setRefusal(road.cannot);
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await ask(workspace.id);
      change(false);
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {road.word} {workspace.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>{act === "delete" ? deleteNotice(threads, workspaceKind(workspace), workspace.copy) : forgetNotice(threads)}</AlertDialogDescription>
        </AlertDialogHeader>
        {refusal && (
          <p className="text-[11px] text-muted-foreground" data-k="forget-refusal">
            {refusal}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void forget()} data-k="end-workspace">
            {busy ? road.busy : road.word}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
