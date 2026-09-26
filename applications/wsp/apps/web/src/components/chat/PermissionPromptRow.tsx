// SPDX-License-Identifier: AGPL-3.0-only
// The chat row for a permission prompt the harness relayed: one sentence
// saying what the agent wants to do and on what, whatever of the tool's input
// that sentence does not already carry, and the options a person picks from.
// The words per kind of tool come from the protocol's table, which the command
// line reads too, so neither surface spells a tool's code name at a person.
// One uniform row, the input as muted mono text like every other tool row, and
// the options as plain buttons while the turn waits on them; once it is closed
// the buttons go and the outcome takes their place as one muted line, so a
// transcript read later says what was picked without pretending it is still
// open. No chip, no badge, no colour of its own: nothing here is a state word.
// A call that only asks the person something is none of this: there is no
// consent in it to give, so it draws as the question it is and the row's
// consent half is skipped whole.
// What is shown wraps whole where every other tool row truncates: this is the
// row where consent is given, and a command cut mid-word is one a person
// cannot judge. A command is drawn in the mono face beside the words rather
// than in them, because the sentence face closes the gap between two hyphens
// until --minWorkers reads as an em dash, and it breaks at its spaces only, so
// a run longer than the row scrolls sideways instead of being split across
// lines after one of its own slashes. A file's own text is folded away rather than shown, since a wall of
// it between the question and the buttons is what nobody reads, and the fold
// opens into a box of its own height so the buttons stay on the screen.
import { ChevronRightIcon } from "lucide-react";
import { isPromptOpen, type PermissionPrompt } from "../../adapt";
import { permissionOutcomeLine, permissionPromptWords, pickedOptions } from "@wsp/protocol";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { QuestionPrompt } from "./QuestionPrompt";

/** A command wraps where a person would break it, at its spaces, and nowhere else: each run without a space is a
 * box of its own that never wraps, so a path or a flag stays one string on the screen rather than being split after
 * one of its own slashes or hyphens, which is a break the line-breaking rules allow and a person cannot read past.
 * A run wider than the row makes the line scroll sideways instead. */
function commandParts(command: string): (string | { readonly token: string; readonly at: number })[] {
  return command.split(/(\s+)/).map((part, at) => (/^\s*$/.test(part) ? part : { token: part, at }));
}

export function PermissionPromptRow({
  permission,
  onAnswer,
  asker,
}: {
  permission: PermissionPrompt;
  onAnswer: (sessionId: string, askId: string, optionId: string) => void;
  /** Who is asking, where the asker is not the thread's own agent; drawn above the prompt so a person answering
   * several running agents knows which one this is. */
  asker?: string;
}) {
  const open = isPromptOpen(permission);
  const answer = (optionId: string): void => onAnswer(permission.sessionId, permission.askId, optionId);
  const picked = pickedOptions(permission.options, permission.optionId ?? "");
  const named = picked === undefined || picked.length === 0 ? undefined : { label: picked.map(o => o.label).join(", "), effect: picked[0]!.effect };
  const words = permissionPromptWords(permission.toolName, permission.input, permission.detail);
  // The gutter is the timeline's; a prompt inside a fold (the one an asker names) sits on the fold's body, which
  // already holds one, and a second would push it right of the lines the same agent wrote above it.
  const gutter = asker === undefined ? " px-1" : "";
  return (
    <div className={`min-w-0 border-b border-border/60 pb-2 pt-1${gutter}`} data-permission-prompt={permission.askId} data-permission-open={open ? "true" : "false"}>
      <div className="flex min-w-0 flex-col gap-1">
        {asker === undefined ? null : (
          <span className="font-mono text-[11px] leading-4 text-muted-foreground" data-permission-asker="">
            {asker}
          </span>
        )}
        {words.questions !== undefined ? (
          open ? (
            <QuestionPrompt onAnswer={answer} questions={words.questions} />
          ) : (
            <>
              <span className="break-words whitespace-pre-wrap text-sm leading-relaxed text-foreground/80" data-permission-says="">
                {words.says}
              </span>
              <span className="font-mono text-xs leading-4 text-muted-foreground" data-permission-outcome={permission.outcome ?? undefined}>
                {permissionOutcomeLine(permission.outcome!, named)}
              </span>
            </>
          )
        ) : null}
        {words.questions !== undefined ? null : words.code === undefined ? (
          <span className="break-words whitespace-pre-wrap text-sm leading-relaxed text-foreground/80" data-permission-lead="" data-permission-says="">
            {words.says}
          </span>
        ) : (
          <div className="flex min-w-0 items-start gap-1.5" data-permission-lead="">
            <span className="shrink-0 text-sm leading-relaxed text-foreground/80" data-permission-says="">
              {words.says}
            </span>
            <code
              data-permission-code=""
              className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-normal py-1 font-mono text-xs leading-4 text-foreground/80"
            >
              {commandParts(words.code).map(part => (typeof part === "string" ? part : <span key={part.at} className="whitespace-pre">{part.token}</span>))}
            </code>
          </div>
        )}
        {words.rest === "" ? null : <span className="break-words whitespace-pre-wrap font-mono text-xs leading-4 text-muted-foreground">{words.rest}</span>}
        {words.body === undefined ? null : (
          <Collapsible>
            <CollapsibleTrigger
              data-permission-body-trigger=""
              className="group flex items-center gap-1 text-left font-mono text-xs leading-4 text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon aria-hidden className="size-3 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90" />
              {words.body.label}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <span
                data-permission-body=""
                className="block max-h-80 overflow-y-auto break-words whitespace-pre-wrap pt-1 font-mono text-xs leading-4 text-muted-foreground"
              >
                {words.body.text}
              </span>
            </CollapsiblePanel>
          </Collapsible>
        )}
        {words.questions !== undefined ? null : open ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {permission.options.map(option => (
              <Button
                key={option.id}
                type="button"
                size="xs"
                variant="outline"
                data-permission-option={option.id}
                onClick={() => answer(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : (
          <span className="font-mono text-xs leading-4 text-muted-foreground" data-permission-outcome={permission.outcome ?? undefined}>
            {permissionOutcomeLine(permission.outcome!, named)}
          </span>
        )}
      </div>
    </div>
  );
}
