// SPDX-License-Identifier: AGPL-3.0-only
// One of the screens of wsp init the person answers, drawn from the data the
// host hands over: the rows the terminal's list draws, grouped where the
// terminal groups them, a checkbox or the app's picker on each, a mark where
// the row has a real one, the source and the size in mono coloured by weight
// where the protocol says the screen weighs, and under the card, centred, the
// tally: the step's count and the whole image so far against the disk,
// coloured by its share, with the disk meter inline after it on the steps that
// change the image's size. The ticks, answers and typed keys live in one draft
// until Continue sends them. The Image card's recipe draws each screen with
// this.
import { CLOUD_SETUP_WORDS, UNKNOWN_SIZE, diskTone, fmtBytes, initSizeTone, initTallyCount, fmtBytesOfTotal, initTallyOf, initTicksOf, type InitDraft, type InitScreen, type InitScreenItem } from "@wsp/protocol";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Input } from "../../components/ui/input.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import { TONE_TEXT } from "../../lib/tone.js";
import { Card, FIELD, FIELD_LABEL, GroupLabel, META, Meter, NAME, ROW, ROW_LINE, RowPicker, STATE_WORD, SizeCell, Slot } from "./rows.js";
import { RowMark } from "./SignInMark.js";

/** What the person has changed on the screen and not yet sent: the rows ticked, each answering row's answer, and the
 * API keys typed under the rows that took one. The ticks and answers are kept on the host as they change; a typed
 * key never is, since a key belongs in the key store and nowhere else. */
export interface Draft {
  ticks: ReadonlySet<string>;
  answers: Readonly<Record<string, string>>;
  keys: Readonly<Record<string, string>>;
}

/** The draft a screen opens on: what the person left on it and the host kept, else what the host says stands; the
 * ticks by the protocol's one rule, the same one the estimate counts by. */
export const draftOf = (screen: InitScreen, kept?: InitDraft): Draft => ({ ticks: initTicksOf(screen, kept), answers: { ...screen.answers, ...kept?.answers }, keys: {} });

/** A row's answer as it stands in the draft. */
export const answerOf = (draft: Draft, item: InitScreenItem): string | undefined => draft.answers[item.id];

/** The why beside a row's name, and under it below 640 px. */
const WHY = "min-w-0 flex-1 cursor-default truncate text-left max-sm:w-full max-sm:flex-none max-sm:text-[11px] max-sm:leading-4";

/** The API key the row's choice is: the one answer that opens a field under the row. */
const KEY_CHOICE = "key";

export function RecipeScreen({ screen, draft, onDraft, image }: { screen: InitScreen; draft: Draft; onDraft: (next: Draft) => void; /** The image so far, the protocol's one estimate, against the machine's disk where the provider reports one. */ image: { used: number; total?: number } }) {
  const groups = [...new Set(screen.items.map(i => i.group ?? ""))];
  const grouped = groups.some(g => g !== "");
  const tick = (id: string, on: boolean): void => {
    const next = new Set(draft.ticks);
    if (on) next.add(id);
    else next.delete(id);
    onDraft({ ...draft, ticks: next });
  };
  const answer = (id: string, value: string): void => onDraft({ ...draft, answers: { ...draft.answers, [id]: value } });
  const typeKey = (id: string, value: string): void => onDraft({ ...draft, keys: { ...draft.keys, [id]: value } });
  const tally = screen.tally !== undefined ? initTallyOf(screen, draft.ticks) : undefined;
  const imageTone = image.total === undefined ? "muted" : diskTone(image.used, image.total);
  const rows = (items: readonly InitScreenItem[]) =>
    items.map(item => {
      const fixed = item.choices !== undefined && item.choices.length === 1;
      const choice = item.choices !== undefined ? (answerOf(draft, item) ?? item.choices[0]?.value) : undefined;
      const keyOpen = item.key !== undefined && choice === KEY_CHOICE;
      return (
        <li key={item.id} data-k="row" data-row={item.id} className={ROW_LINE}>
          <div className={ROW} title={item.detail.join("\n")}>
            {item.choices === undefined ? <Checkbox tone="neutral" aria-label={item.label} checked={item.lock === "on" || draft.ticks.has(item.id)} disabled={item.lock !== undefined} onCheckedChange={on => tick(item.id, on === true)} /> : null}
            <RowMark id={item.mark ?? item.id} />
            {/* Below 640 px the why stands under the name, where a phone's row has no room for both on one line. */}
            <span className="flex min-w-0 flex-1 items-center gap-3 max-sm:flex-col max-sm:items-start max-sm:justify-center max-sm:gap-0">
              <span className={cn(NAME, "flex-none max-w-[45%] max-sm:max-w-full")}>{item.label}</span>
              {item.why !== undefined ? (
                item.choices !== undefined && item.detail[0] !== undefined ? (
                  <Tooltip>
                    <TooltipTrigger data-k="why" className={cn(META, WHY)} render={<span />}>
                      {item.why}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{item.detail[0]}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span data-k="why" className={cn(META, WHY)}>
                    {item.why}
                  </span>
                )
              ) : null}
            </span>
            {item.size !== undefined ? <SizeCell tone={initSizeTone(screen, item.size)}>{item.size === null ? UNKNOWN_SIZE : fmtBytes(item.size)}</SizeCell> : null}
            {item.choices !== undefined ? (
              <Slot>
                {item.state !== undefined ? (
                  <span data-k="state" className={STATE_WORD}>
                    {item.state}
                  </span>
                ) : null}
                <RowPicker k="answer" row={item.id} label={item.label} value={choice} choices={item.choices} disabled={fixed} onPick={value => answer(item.id, value)} />
              </Slot>
            ) : null}
          </div>
          {keyOpen && item.key !== undefined ? (
            <div data-k="key-field" data-row={item.id} className="flex h-12 items-center gap-3 pb-2 pl-4 pr-[10px]">
              <label htmlFor={`setup-key-${item.id}`} className={cn(FIELD_LABEL, "w-[30%] shrink-0 truncate font-mono text-xs text-muted-foreground")}>
                {item.key.name}
              </label>
              <Input id={`setup-key-${item.id}`} type="password" size="compact" autoComplete="off" spellCheck={false} value={draft.keys[item.id] ?? ""} placeholder={item.key.saved ? "••••••••" : ""} onChange={e => typeKey(item.id, e.target.value)} className={cn(FIELD, "min-w-0 flex-1")} />
              <span data-k="key-state" className={STATE_WORD}>
                {item.key.saved ? CLOUD_SETUP_WORDS.keys.saved : CLOUD_SETUP_WORDS.keys.unset}
              </span>
            </div>
          ) : null}
        </li>
      );
    });
  return (
    <>
      <Card label={screen.title}>
        {grouped
          ? groups.map(group => (
              <li key={group} className={ROW_LINE}>
                <ul>
                  {group !== "" ? <GroupLabel>{group}</GroupLabel> : null}
                  {rows(screen.items.filter(i => (i.group ?? "") === group))}
                </ul>
              </li>
            ))
          : rows(screen.items)}
      </Card>
      {tally !== undefined && screen.tally !== undefined ? (
        <p data-k="tally" className={cn(META, "mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center")}>
          <span>
            {initTallyCount(tally.count, screen.tally)}{" "}
            <span data-k="tally-size" data-tone={imageTone} className={cn("ms-2", TONE_TEXT[imageTone])}>
              {fmtBytesOfTotal(image.used, image.total)}
            </span>
          </span>
          {image.total !== undefined ? (
            // A phone's width holds the words or the meter on one line, not both with room around them.
            <span className="flex max-sm:basis-full max-sm:justify-center">
              <Meter used={image.used} total={image.total} />
            </span>
          ) : null}
        </p>
      ) : null}
      {screen.footer.length > 0 ? (
        <div data-k="footer-lines" className="mt-3 flex flex-col gap-0.5">
          {screen.footer.map((line, i) => (
            <p key={i} className={cn(META, line.tone === "red" ? "text-destructive-foreground" : line.tone !== undefined ? "text-warning-foreground" : "")}>
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}
