// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a computer or a provider is taken back out. The
// sentence is computed from what that computer holds right now, so a person
// reads what leaves rather than a warning; the host's own refusal lands under
// it in the refusal slot, with the host's fix.
//
// A computer that is not answering cannot be swept from here, so the dialog
// hands over the line that sweeps it on the computer itself.
import { useState } from "react";
import { PLACES_WORDS, type PlaceView } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "../components/ui/button.js";
import { failureOf } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { WHERE_WORDS } from "./format.js";
import { placeIsOffline, removeSentence, removeTitle, type PlaceHolding } from "./places.js";
import { CopyRow, RefusalSlot } from "./sheetParts.js";

/** What the app says when its own client carries no remove road: the same shape the forget dialog's refusal has. */
export const CANNOT_REMOVE = "this wsp cannot take a computer back out from here";

export function RemoveComputerDialog({ place, holding, imageBytes, open, onOpenChange, onRemoved }: { place: PlaceView; holding: PlaceHolding; imageBytes?: number; open: boolean; onOpenChange: (open: boolean) => void; onRemoved?: () => void }) {
  const api = useStore(s => s.api);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ said: string; fix?: string } | null>(null);

  const change = (next: boolean): void => {
    if (!next) setRefusal(null);
    onOpenChange(next);
  };

  const remove = async (): Promise<void> => {
    if (api?.removePlace === undefined) {
      setRefusal({ said: CANNOT_REMOVE });
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await api.removePlace(place.id);
      // A remove the host did not make is not a failure to report twice: the row is already gone from the list.
      if (answer.note !== undefined && !answer.removed) setRefusal({ said: answer.note });
      else {
        onRemoved?.();
        change(false);
      }
    } catch (e) {
      const failure = failureOf(e);
      setRefusal({ said: failure.said, ...(failure.fix === undefined ? {} : { fix: failure.fix }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogPopup data-remove-place-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle data-k="remove-title">{removeTitle(place)}</AlertDialogTitle>
          <AlertDialogDescription data-k="remove-sentence">{removeSentence(place, holding, imageBytes)}</AlertDialogDescription>
        </AlertDialogHeader>
        {placeIsOffline(place) ? (
          <div className="flex flex-col gap-3 px-6 pt-1 pb-6">
            <CopyRow k="leave-line" value={PLACES_WORDS.remove.leaveLine} />
            <p className="text-[13px] text-muted-foreground">{PLACES_WORDS.remove.leaveTakes}</p>
          </div>
        ) : null}
        {refusal === null ? null : (
          <div className="px-6">
            <RefusalSlot k="remove-refusal" {...refusal} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{WHERE_WORDS.cancel}</AlertDialogClose>
          <Button data-k="remove-confirm" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? WHERE_WORDS.removing : WHERE_WORDS.remove}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
