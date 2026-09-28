// SPDX-License-Identifier: AGPL-3.0-only
// A waiting step that shows its work: while this computer is read, the card
// fills row by row with what the read found, the app's spinner beside the row
// being read and a mono word in the slot once it is done. The rows are the
// job's own, so nothing here fakes progress; until the first lands the card
// holds one row for this computer with the spinner, so the work reads as
// started.
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, type InitJob } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { Card, META, NAME, ROW, ROW_LINE, RowState, Slot } from "./rows.js";

export function ReadingRows({ job }: { job: InitJob | null }) {
  const landed = job?.rows ?? [];
  const rows: InitJob["rows"] = landed.length > 0 ? landed : [{ id: "fact/first", kind: "fact", label: CLOUD_SETUP_WORDS.reading.first, state: INIT_ROW_STATES.running }];
  return (
    <Card label={CLOUD_SETUP_WORDS.reading.headline}>
      {rows.map(row => (
        <li key={row.id} data-k="row" data-row={row.id} data-state={row.state} className={cn(ROW, ROW_LINE)}>
          <span className={NAME}>{row.label}</span>
          {row.detail !== undefined ? <span className={cn(META, "min-w-0 truncate")}>{row.detail}</span> : null}
          <Slot>
            <RowState state={row.state} />
          </Slot>
        </li>
      ))}
    </Card>
  );
}
