// SPDX-License-Identifier: AGPL-3.0-only
// The field for a sign-in whose page hands a code back, on the row's own
// action line: one mono field and one keycap, Enter doing what the keycap
// does. What is typed goes to that sign-in's own terminal on the machine and
// is dropped from here as it goes, so nothing holds it after the press.
import { useState } from "react";
import { CLOUD_SETUP_WORDS } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { FIELD } from "./rows.js";

/** `ask`: what the page hands back where it is not a code. */
export function SignInCode({ label, onCode, ask, className }: { label: string; onCode: (code: string) => void; ask?: string; className?: string }) {
  const words = CLOUD_SETUP_WORDS.build;
  const asked = ask ?? words.codeAsk;
  const [code, setCode] = useState("");
  const typed = code.trim();
  const send = (): void => {
    if (typed === "") return;
    setCode("");
    onCode(typed);
  };
  return (
    <div data-k="code-line" className={cn("flex min-w-0 flex-1 items-center gap-3", className)}>
      <Input
        data-k="code-field"
        size="compact"
        autoComplete="off"
        spellCheck={false}
        value={code}
        placeholder={asked}
        aria-label={`${label}: ${asked}`}
        onChange={e => setCode(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") send();
        }}
        className={cn(FIELD, "min-w-0 flex-1")}
      />
      <Button data-k="code-submit" size="sm" variant="outline" className="h-7 font-mono text-xs sm:h-7 sm:text-xs" disabled={typed === ""} onClick={send}>
        {words.codeSubmit}
      </Button>
    </div>
  );
}
