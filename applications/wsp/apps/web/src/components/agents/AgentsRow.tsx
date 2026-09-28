// SPDX-License-Identifier: AGPL-3.0-only
// One row of any kind at its kind's one height, split from the next by 2 px
// and no rule: the lead, the name with the agents' marks after it, one fact
// under it, its status as a dot and a word under that, and at the right end
// the one step it needs, or off with its dot where it is turned off. The row is one button whose ::before carries the
// hover over the whole block; the step is a sibling that lets the pointer
// through except on its own button, so no button stands inside a button and
// Tab reaches the row, then its step.
import { cn } from "../../lib/utils.js";
import { ActButton, AgentMarks, LeadMark, StatusView } from "./agentsParts.js";
import { AGENTS_LIST_WORDS as W } from "./agentsRows.js";
import type { RowView } from "./kinds/kind.js";

export function AgentsRow({ row, height, dim, first, onOpen }: { row: RowView; height: string; dim: boolean; first: boolean; onOpen: () => void }) {
  const quick = row.quick;
  const step = quick?.run === undefined || quick.inPlace === true ? quick : { ...quick, run: () => (quick.run!(), onOpen()) };
  return (
    <div role="listitem" data-agents-row={row.key} {...(row.available === true ? { "data-available": "" } : {})} className={cn("relative isolate mx-2 flex items-center gap-3 rounded-lg px-2 transition-opacity duration-150", height, dim && "opacity-50")}>
      <button
        type="button"
        data-row-trigger
        tabIndex={first ? 0 : -1}
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch text-left outline-none before:absolute before:inset-0 before:-z-10 before:rounded-lg before:transition-colors before:duration-150 hover:before:bg-accent focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
      >
        <LeadMark lead={row.lead} label={row.title} />
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2">
            <span data-row-title className={cn("truncate text-sm leading-5 font-medium", row.available === true || row.off === true ? "text-foreground/70" : "text-foreground")} title={row.title}>
              {row.title}
            </span>
            {row.marks === undefined ? null : <AgentMarks agents={row.marks} />}
          </span>
          {row.subtext === undefined ? null : (
            <span data-row-subtext className={cn("truncate leading-4", row.available === true ? "text-xs text-muted-foreground" : "font-mono text-xs tabular-nums text-muted-foreground")} title={row.subtext}>
              {row.subtext}
            </span>
          )}
          {row.status === undefined ? null : (
            <span data-row-status className="mt-1.5 flex">
              <StatusView status={row.status} />
            </span>
          )}
        </span>
      </button>
      {step !== undefined || row.off !== true ? null : (
        <span data-row-word className="flex shrink-0">
          <StatusView status={{ state: "off", tone: "quiet", words: W.off }} fit />
        </span>
      )}
      {step === undefined ? null : (
        <div data-row-slot className="pointer-events-none flex shrink-0 items-center">
          <ActButton act={step} className="pointer-events-auto relative z-10" />
        </div>
      )}
    </div>
  );
}
