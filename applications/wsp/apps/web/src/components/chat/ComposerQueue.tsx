// SPDX-License-Identifier: AGPL-3.0-only
// The messages entered while a turn ran, stacked above the composer oldest
// first: each is a textarea edited in place, a remove button, and a send-now
// button. With a harness that steers, send-now puts the row into the running
// turn; with one that does not, it stops the turn first and says so in one
// line. The head row goes when the turn ends; the row a send-now promoted
// reads next while its request is in flight. Every row keeps the same three
// controls in every state, so nothing shifts as the turn starts or ends.
import { ArrowUpIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { QueuedMessage } from "./composerDraftStore";

export const STEER_NOTICE = "Stopping the turn, then this message sends.";

export function ComposerQueue({
  rows,
  steering,
  steer,
  onEdit,
  onRemove,
  onSteer,
}: {
  rows: ReadonlyArray<QueuedMessage>;
  /** The row a send-now put at the head while its request is in flight; null when none. */
  steering: string | null;
  /** What send-now does: sends the row now (into the turn, or as the next start), stops the turn first, or nothing can go yet. */
  steer: "now" | "stop" | null;
  onEdit: (id: string, prompt: string) => void;
  onRemove: (id: string) => void;
  onSteer: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1.5" data-composer-queue="true">
      <ul aria-label="Queued messages" className="flex flex-col gap-1">
        {rows.map(row => {
          const next = row.id === steering;
          return (
            <li key={row.id} className="flex items-start gap-1 rounded-xl border border-border/60 bg-card/50 py-1 ps-3 pe-1.5" data-queued-id={row.id}>
              <textarea
                aria-label="Queued message"
                rows={1}
                value={row.prompt}
                onChange={event => onEdit(row.id, event.target.value)}
                onBlur={event => {
                  if (event.target.value.trim() === "") onRemove(row.id);
                }}
                className="field-sizing-content min-h-6 w-full min-w-0 flex-1 resize-none bg-transparent py-0.5 text-sm leading-5 text-foreground outline-none"
              />
              <span className="w-[6ch] shrink-0 select-none py-0.5 text-end font-mono text-[11px] leading-5 text-muted-foreground">{next ? "next" : "queued"}</span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={steer === "stop" ? "Stop the turn and send now" : "Send now"}
                title={steer === "stop" ? "Stop the turn and send now" : "Send now"}
                onClick={() => onSteer(row.id)}
                disabled={steer === null || next}
              >
                <ArrowUpIcon />
              </Button>
              <Button size="icon-xs" variant="ghost-muted" aria-label="Remove queued message" title="Remove queued message" onClick={() => onRemove(row.id)}>
                <XIcon />
              </Button>
            </li>
          );
        })}
      </ul>
      {steer === "stop" && steering !== null && rows.some(row => row.id === steering) ? (
        <p role="status" className="px-3 font-mono text-[11px] text-muted-foreground">{STEER_NOTICE}</p>
      ) : null}
    </div>
  );
}
