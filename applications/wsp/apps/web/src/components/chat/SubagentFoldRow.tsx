// SPDX-License-Identifier: AGPL-3.0-only
// The chat row for one subagent an agent launched inside its own turn. A
// harness runs its subagents on the session that spawned them, so their lines
// arrive among the parent's with nothing in the stream but the launching call
// to tell them apart; this is that call, drawn as the run it started. The
// task's own description titles it, its state and its elapsed sit in the slot
// the other rows keep their state word in, and everything the subagent wrote
// is folded behind the title so five of them are five titles rather than five
// voices in one paragraph. A prompt its run raised is drawn inside the fold
// under the subagent's own name, and the fold stands open the moment one is
// waiting: a question nobody can see is a turn that never moves, and the
// question arrives long after this row is first drawn, so opening it is a
// change to the fold's own state and never a default read once at mount.
// After that the person's own toggle stands, until the next question.
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { fmtDuration, subagentAskerLine } from "@wsp/protocol";
import type { PermissionPrompt, SubagentRun, SubagentState } from "../../adapt";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PermissionPromptRow } from "./PermissionPromptRow";
import { Spaced } from "../ui/spaced";

/** Running holds nothing: the row's own presence says it, which is the rule every state slot here follows. */
const STATE_WORDS: Record<SubagentState, string> = { running: "", done: "Done", failed: "Failed", stopped: "Stopped" };

function elapsedLine(run: SubagentRun): string | null {
  if (run.endedAt === null || run.startedAt === "") return null;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms > 0 ? fmtDuration(ms) : null;
}

export function SubagentFoldRow({
  subagent,
  onAnswer,
}: {
  subagent: SubagentRun;
  onAnswer: (sessionId: string, askId: string, optionId: string) => void;
}) {
  const asking = subagent.prompts.some((p: PermissionPrompt) => p.outcome === null);
  const [open, setOpen] = useState(asking);
  const [asked, setAsked] = useState(asking);
  // A question arriving is the edge that opens this, not the fact that one is open: a person who shuts the fold
  // again while the same question waits keeps it shut, and the next question opens it once more.
  if (asking !== asked) {
    setAsked(asking);
    if (asking) setOpen(true);
  }
  const elapsed = elapsedLine(subagent);
  const state = STATE_WORDS[subagent.state];
  return (
    <div className="min-w-0 px-1" data-subagent={subagent.parentToolUseId} data-subagent-state={subagent.state}>
      <Collapsible onOpenChange={setOpen} open={open}>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 text-left" data-subagent-trigger="">
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open:rotate-90" />
          <span className="min-w-0 flex-1 truncate text-sm leading-5 text-foreground/80" data-subagent-title="">
            {subagent.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground tabular-nums" data-subagent-slot="">
            <Spaced parts={[state, elapsed].filter(part => part !== null && part !== "")} />
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          {/* The rail hangs from the chevron's centre (half of size-3) and the body starts under the title (size-3
              plus the trigger's gap), so the fold's own header is what its contents line up with. */}
          <div className="flex min-w-0 flex-col gap-1 border-border/60 border-l pt-1 pl-[11px] ml-1.5" data-subagent-body="">
            {subagent.lines.map(line => (
              <div className="flex min-w-0 flex-col" data-subagent-line={line.kind} key={line.id}>
                {line.label === "" ? null : (
                  <span
                    className={
                      line.kind === "text"
                        ? "break-words whitespace-pre-wrap text-sm leading-relaxed text-foreground/80"
                        : "break-words whitespace-pre-wrap font-mono text-xs leading-4 text-muted-foreground"
                    }
                  >
                    {line.label}
                  </span>
                )}
                {line.detail === undefined ? null : (
                  <span className="break-words whitespace-pre-wrap font-mono text-xs leading-4 text-muted-foreground/72" data-subagent-detail="">
                    {line.detail}
                  </span>
                )}
              </div>
            ))}
            {subagent.prompts.map(prompt => (
              <PermissionPromptRow asker={subagentAskerLine(subagent.title)} key={prompt.askId} onAnswer={onAnswer} permission={prompt} />
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
