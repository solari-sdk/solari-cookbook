// SPDX-License-Identifier: AGPL-3.0-only
// The agent road's own step: while a thread on this computer writes the recipe,
// the one line that thread is on sits in the mono block the build's stage lines
// use, with the app's spinner beside it and a link into the thread itself. The
// line is the thread's own (the tool it is running, the prompt it is blocked
// on), so nothing here fakes progress. When the turn ended without the recipe
// the block holds the last thing it said, and the step's frame carries the two
// ways on: run the agent again, or go back to the choice and pick the screens.
import { CLOUD_SETUP_WORDS, initJobOver, type InitJob } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { cn } from "../../lib/utils.js";
import { CARD } from "./rows.js";

/** The step's title and sentence, and whether the turn is over, which is when the frame offers Retry and Start over. */
export function agentStepWords(job: InitJob): { headline: string; top: string; over: boolean } {
  const words = CLOUD_SETUP_WORDS.agent;
  const over = initJobOver(job.phase);
  return { headline: over ? words.failed : words.headline, top: over ? (job.error ?? words.stopped) : words.top, over };
}

export function AgentLine({ job, onOpenThread }: { job: InitJob; onOpenThread: () => void }) {
  const words = CLOUD_SETUP_WORDS.agent;
  const over = initJobOver(job.phase);
  return (
    <>
      <div data-k="block" className={cn(CARD, "flex items-start gap-3 px-4 py-3")}>
        {over ? null : <Spinner data-k="spinner" className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />}
        <pre data-k="line" className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.6] text-muted-foreground">
          {job.line ?? words.waiting}
        </pre>
      </div>
      {job.thread !== undefined ? (
        <div className="mt-3 flex justify-center">
          <Button data-k="open-thread" variant="link" className="h-auto p-0 text-[13px] text-muted-foreground hover:text-foreground sm:text-[13px]" onClick={onOpenThread}>
            {words.open}
          </Button>
        </div>
      ) : null}
    </>
  );
}
