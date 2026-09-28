// SPDX-License-Identifier: AGPL-3.0-only
// What the app says about a computer that has stopped answering, beyond the
// state word: where the host expects it, when it last spoke, what the last dial
// said, and the button that dials it once more. The computer's own row in
// Settings reads it, and the reading is composed once in the protocol
// (absentRoad) and drawn here.
//
// The answer to a press lands in the slot the sentence was in, so a person
// reads one thing in one place rather than a toast that goes.
import { useState } from "react";
import { placeDialRoad, type PlaceDialRoad, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { failureOf, type Failure } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { WHERE_WORDS } from "./format.js";

/** One dial and what it came to. The line is the host's own where it answered,
 * and a refusal comes back whole, with the host's fix, for the refusal slot under the row. A wsp that cannot dial
 * at all says so in the row's own slot rather than on the held button, since no tooltip carries a reason. The road
 * is the host's own reading of it: nothing comes back for a computer there is no road to, and the slot draws no
 * button rather than one whose only answer is that it had nowhere to dial. */
export function useDialPlace(place: Pick<PlaceView, "id" | "present" | "road">): { dial: () => void; busy: boolean; line: string | null; refused: Failure | null; held: boolean; heldWhy: string | null; road: PlaceDialRoad | undefined } {
  const dialPlace = useStore(s => s.dialPlace);
  const road = placeDialRoad(place);
  const held = useStore(s => s.api?.dialPlace === undefined);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [refused, setRefused] = useState<Failure | null>(null);
  const dial = (): void => {
    setBusy(true);
    setLine(null);
    setRefused(null);
    void dialPlace(place.id).then(
      answer => setLine(answer.line),
      (e: unknown) => setRefused(failureOf(e)),
    ).finally(() => setBusy(false));
  };
  return { dial, busy, line, refused, held, heldWhy: held && road !== undefined ? WHERE_WORDS.cannotDial : null, road };
}

/** The button itself, drawn the same in both slots: an extra-small outline that keeps its variant while it waits
 * and changes its word, since a press that answers in its own time is not a held one. Its word is the road's, so a
 * box this host can only log in to says what the press would do. Why it is held carries no tooltip: the reason is
 * written in the slot the sentence stands in, before any pointer touches the button. */
export function DialButton({ busy, held, road, onDial }: { busy: boolean; held: boolean; road: PlaceDialRoad; onDial: () => void }) {
  return (
    <Button data-k="dial" size="xs" variant="outline" disabled={busy || held} onClick={onDial}>
      {busy ? WHERE_WORDS.dialling : WHERE_WORDS.dial[road]}
    </Button>
  );
}
