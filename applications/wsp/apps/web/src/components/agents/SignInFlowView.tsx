// SPDX-License-Identifier: AGPL-3.0-only
// One sign-in as it stands, drawn under an agent's or a server's acts in its
// detail: a watched run holds its lines from the press, the code the tool
// printed with Open, then the field a page's answer goes back through, only
// for a sign-in whose page can hand one back; or the wait on the browser
// where the harness takes the redirect itself; a token or key is pasted under
// the line that mints it; a
// row only the person can finish shows the line for their terminal. A failure
// lands in the refusal slot in the tool's own words.
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Spinner } from "../ui/spinner.js";
import { CopyRow, RefusalSlot } from "../../settings/sheetParts.js";
import { SignInCode } from "../../settings/recipe/SignInCode.js";
import { AGENTS_LIST_WORDS, type FlowView } from "./agentsRows.js";

const LABEL = "text-xs text-muted-foreground";

export function SignInFlowView({ view, label }: { view: FlowView; label: string }) {
  const { flow } = view;
  const [key, setKey] = useState("");
  if (flow.kind === "copy") {
    return (
      <div data-k="sign-in-flow" className="flex flex-col gap-2">
        <span data-k="sign-in-why" className={LABEL}>
          {flow.why ?? AGENTS_LIST_WORDS.runInTerminal}
        </span>
        <CopyRow k="sign-in-line" value={flow.line} />
      </div>
    );
  }
  if (flow.kind === "vault") {
    const typed = key.trim();
    const save = (): void => {
      if (typed === "" || flow.saving === true) return;
      view.save(typed);
    };
    return (
      <div data-k="sign-in-flow" className="flex flex-col gap-3">
        {flow.mint === undefined ? null : (
          <div className="flex flex-col gap-2">
            <span className={LABEL}>{AGENTS_LIST_WORDS.runInTerminal}</span>
            <CopyRow k="sign-in-mint" value={flow.mint} />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className={LABEL}>{flow.word === "token" ? AGENTS_LIST_WORDS.pasteToken : AGENTS_LIST_WORDS.pasteKey}</span>
          <div className="flex items-center gap-3">
            <Input
              data-k="sign-in-key"
              type="password"
              size="compact"
              autoComplete="off"
              spellCheck={false}
              value={key}
              aria-label={`${label}: ${flow.word === "token" ? AGENTS_LIST_WORDS.pasteToken : AGENTS_LIST_WORDS.pasteKey}`}
              onChange={e => setKey(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") save();
              }}
              className="min-w-0 flex-1 font-mono text-[13px]"
            />
            <Button data-k="sign-in-save" size="xs" variant="outline" disabled={typed === "" || flow.saving === true} onClick={save}>
              {flow.saving === true ? <Spinner className="size-3.5" /> : <CheckIcon aria-hidden className="size-3.5" />}
              {AGENTS_LIST_WORDS.save}
            </Button>
          </div>
        </div>
        <RefusalSlot k="sign-in-refused" {...(flow.refused !== undefined ? { said: flow.refused } : {})} />
      </div>
    );
  }
  const openPage = (word: string) =>
    flow.url === undefined ? null : (
      <Button data-k="sign-in-open" size="xs" variant="outline" onClick={() => void window.open(flow.url, "_blank", "noopener,noreferrer")}>
        <ExternalLinkIcon aria-hidden className="size-3.5" />
        {word}
      </Button>
    );
  const browser = flow.finish === "callback" && flow.state !== "failed";
  return (
    <div data-k="sign-in-flow" className="flex flex-col gap-2">
      <div data-sign-in-line className="flex h-10 items-center gap-3">
        {browser ? (
          <>
            <Spinner className="size-3.5 text-muted-foreground" />
            <span data-k="sign-in-browser" className="text-xs text-muted-foreground">
              {AGENTS_LIST_WORDS.finishInBrowser}
            </span>
            {openPage(AGENTS_LIST_WORDS.openPage)}
          </>
        ) : flow.url === undefined ? (
          flow.state === "running" ? <Spinner className="size-3.5 text-muted-foreground" /> : null
        ) : (
          <>
            {flow.code === undefined ? null : (
              <span data-k="sign-in-code" className="font-mono text-xl tabular-nums text-foreground">
                {flow.code}
              </span>
            )}
            {openPage(AGENTS_LIST_WORDS.open)}
          </>
        )}
      </div>
      {flow.pastes === true || flow.paste === true ? (
        <div data-sign-in-line className="flex h-10 items-center">
          {flow.paste === true && flow.state === "waiting" ? <SignInCode label={label} onCode={view.code} {...(flow.finish !== undefined ? { ask: AGENTS_LIST_WORDS.landedAddress } : {})} /> : null}
        </div>
      ) : null}
      <RefusalSlot k="sign-in-refused" {...(flow.state === "failed" && flow.said !== undefined ? { said: flow.said } : {})} />
    </div>
  );
}
