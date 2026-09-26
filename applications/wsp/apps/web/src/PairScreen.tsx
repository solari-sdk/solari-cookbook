// SPDX-License-Identifier: AGPL-3.0-only
// What a page from a host beyond this computer shows before it can dial
// anything: the one time code the person read off wsp host pair on the host, and
// the token it buys, kept in this browser. One input, one button and one error
// line: nothing here has a host to read a theme, a font or a workspace from.
import { useState, type FormEvent } from "react";
import { PAIR_CODE_LENGTH } from "@wsp/protocol";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";

export const PAIR_HEADING = "Pair this browser";
const PAIR_HINT = "Run wsp host pair on the computer the host runs on and type the code it prints.";

export function PairScreen({ onRedeem }: { onRedeem: (code: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void onRedeem(code).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  };
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <form className="flex w-80 flex-col gap-3" onSubmit={submit}>
        <h1 className="text-base font-medium">{PAIR_HEADING}</h1>
        <p className="text-sm text-muted-foreground">{PAIR_HINT}</p>
        <Label htmlFor="pair-code">Pairing code</Label>
        <Input
          id="pair-code"
          nativeInput
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={PAIR_CODE_LENGTH}
          value={code}
          onChange={event => setCode(event.target.value)}
        />
        <Button type="submit" disabled={busy || code.trim().length === 0}>
          {busy ? "Pairing" : "Pair"}
        </Button>
        {error !== undefined ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
