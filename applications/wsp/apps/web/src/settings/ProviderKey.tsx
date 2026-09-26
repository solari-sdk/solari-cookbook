// SPDX-License-Identifier: AGPL-3.0-only
// A provider's key as a person types it: on the cloud road of Add a computer,
// and in the Image card where a build found the saved key refused. The key is
// checked by the provider before the host saves it, goes to the key store
// through the store and is never shown back; a refusal is the provider's own.
import { CheckIcon, CloudIcon, ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { PROVIDER_KEY_WORDS } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { failureOf } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { ADD_COMPUTER_WORDS as MINE } from "./format.js";
import { isProviderPlace } from "./places.js";
import { RefusalSlot } from "./sheetParts.js";

export const INPUT = "h-10 w-full font-mono [&_input]:h-[38px] [&_input]:ps-9 [&_input]:text-[13px] [&_input]:leading-[38px] sm:[&_input]:h-[38px] sm:[&_input]:text-[13px] sm:[&_input]:leading-[38px]";

/** One provider's key: the field, Save or Replace, and the provider's own refusal under it. `held`: the host holds a
 * key for it from before; `kept`: one was saved here. What stands under the field is the caller's. */
export function ProviderKey({ id, words, held, kept, onKept, children }: { id: string; words: (typeof PROVIDER_KEY_WORDS)[string]; held: boolean; kept: boolean; onKept: (yes: boolean) => void; children?: ReactNode }) {
  const canSave = useStore(s => s.api?.initKeys !== undefined);
  const place = useStore(s => s.places.find(p => isProviderPlace(p) && p.id === id));
  const listed = place !== undefined;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ said: string; fix?: string } | null>(null);
  const has = held || kept;
  const save = (): void => {
    if (key.trim() === "" || !canSave) return;
    setBusy(true);
    setRefusal(null);
    // Through the store, which reads the places again: "key saved" waits for the row that save makes.
    useStore
      .getState()
      .saveKeys({ provider: id, key: key.trim() })
      .then(
        next => {
          setBusy(false);
          if (next.keys[id] === true) {
            onKept(true);
            setKey("");
          } else {
            onKept(false);
            setRefusal(MINE.keyRefused(words));
          }
        },
        (e: unknown) => {
          setBusy(false);
          const failure = failureOf(e);
          setRefusal({ said: failure.said, ...(failure.fix === undefined ? {} : { fix: failure.fix }) });
        },
      );
  };
  return (
    <div data-provider={id} className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2.5">
        <CloudIcon aria-hidden className="size-4 text-muted-foreground" />
        <span data-k="provider-name" className="text-[14px] text-foreground">{words.name}</span>
        {has ? (
          <span data-k="key-state" className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground/70">
            {listed ? <CheckIcon aria-hidden className="size-3" /> : null}
            {listed ? MINE.keySaved : MINE.keyKept}
          </span>
        ) : null}
        {words.keyConsole === undefined ? null : (
          <a href={`https://${words.keyConsole}`} target="_blank" rel="noopener noreferrer" className="ms-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
            {MINE.getKey}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="relative block min-w-0 flex-1">
          <KeyRoundIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input data-k="cloud-key" nativeInput type="password" autoComplete="off" spellCheck={false} value={key} placeholder={has ? MINE.replaceKey : words.keyName} aria-label={words.keyName} {...(refusal === null ? {} : { "aria-invalid": true })} onChange={e => setKey(e.target.value)} onKeyDown={e => (e.key === "Enter" && !busy ? save() : undefined)} className={INPUT} />
        </span>
        <Button data-k="cloud-save" variant={has ? "outline" : "default"} className="h-10 px-4 sm:h-10" held={busy || key.trim() === ""} onClick={save}>
          {busy ? MINE.checking : has ? MINE.replace : MINE.save}
        </Button>
      </div>
      {refusal !== null ? <RefusalSlot k="cloud-refusal" {...refusal} /> : null}
      {children}
    </div>
  );
}
