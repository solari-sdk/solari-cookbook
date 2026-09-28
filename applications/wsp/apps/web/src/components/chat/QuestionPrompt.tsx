// SPDX-License-Identifier: AGPL-3.0-only
// The chat row for a call that asks the person something rather than asking to
// do something. It is not a consent, so it carries no allow: the header and the
// question stand as themselves, every choice is a button under them with its
// own sentence, and the pick travels back as the call's own answer. A question
// that takes more than one choice draws boxes and one Answer button, since a
// pick that closed the prompt on the first tick could not take the second. One
// question with one answer needs no Answer button: the choice is the button,
// which is what the whole row exists to shorten.
import { useState } from "react";
import type { AskedQuestion } from "@wsp/protocol";
import { pickedOptionId } from "@wsp/protocol";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

export function QuestionPrompt({
  questions,
  onAnswer,
}: {
  questions: ReadonlyArray<AskedQuestion>;
  onAnswer: (optionId: string) => void;
}) {
  const [ticked, setTicked] = useState<ReadonlyArray<string>>([]);
  const oneShot = questions.length === 1 && !questions[0]!.multiSelect;
  const answered = questions.every(q => q.options.some(o => ticked.includes(o.id)));
  const toggle = (question: AskedQuestion, id: string): void => {
    setTicked(held => {
      if (held.includes(id)) return held.filter(o => o !== id);
      const others = question.multiSelect ? held : held.filter(o => !question.options.some(candidate => candidate.id === o));
      return [...others, id];
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-3" data-question="">
      {questions.map(question => (
        <div className="flex min-w-0 flex-col gap-1.5" data-question-item={question.header} key={question.key}>
          {question.header === "" ? null : (
            <span className="font-mono text-[11px] leading-4 text-muted-foreground" data-question-header="">
              {question.header}
            </span>
          )}
          <span className="break-words whitespace-pre-wrap text-sm leading-relaxed text-foreground/80" data-question-text="">
            {question.question}
          </span>
          <div className="flex min-w-0 flex-col gap-2 pt-0.5">
            {question.options.map(option =>
              oneShot ? (
                // The button keeps the one shape every button here has; the sentence sits under it rather than
                // inside it, which is what a two-line button would cost.
                <div className="flex min-w-0 flex-col items-start gap-0.5" data-question-option={option.id} key={option.id}>
                  <Button onClick={() => onAnswer(option.id)} size="xs" type="button" variant="outline">
                    {option.label}
                  </Button>
                  {option.description === "" ? null : (
                    <span className="break-words font-mono text-[11px] leading-4 text-muted-foreground" data-question-description="">
                      {option.description}
                    </span>
                  )}
                </div>
              ) : (
                <label className="flex min-w-0 cursor-pointer items-start gap-2 py-0.5" data-question-option={option.id} key={option.id}>
                  <Checkbox
                    checked={ticked.includes(option.id)}
                    className="mt-0.5"
                    onCheckedChange={() => toggle(question, option.id)}
                    tone="neutral"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm leading-5 text-foreground/80">{option.label}</span>
                    {option.description === "" ? null : (
                      <span className="font-mono text-[11px] leading-4 text-muted-foreground" data-question-description="">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ),
            )}
          </div>
        </div>
      ))}
      {oneShot ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            data-question-answer=""
            disabled={!answered}
            onClick={() => onAnswer(pickedOptionId(ticked))}
            size="xs"
            type="button"
            variant="outline"
          >
            Answer
          </Button>
        </div>
      )}
    </div>
  );
}
