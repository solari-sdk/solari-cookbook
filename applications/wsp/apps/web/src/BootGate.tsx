// SPDX-License-Identifier: AGPL-3.0-only
// The one decision the page makes before the app exists: which token it dials
// this host with. No page carries the host's own. In the desktop shell the
// page asks the shell, which holds a token for whichever host the window is
// on and reads the host's own off its file at every call; in a browser the
// page spends the code wsp init put in its address, then holds the device
// token that bought, then asks the person for a code from wsp host pair. A
// token this host no longer honours sends the page back to the code screen
// rather than leaving it dialling something that will never answer, except
// where the shell is the one that gave it: the host mints a fresh token at
// every start, so a refusal right after a host restart is answered by asking
// the shell again. Each refused token is asked about once, so a host that will
// not take anything ends on the code screen rather than in a loop.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BootPayload } from "@wsp/protocol";
import { AppRoot } from "./AppRoot.js";
import { desktopBridge } from "./lib/desktopShell.js";
import { PairScreen } from "./PairScreen.js";
import { takePairingCode } from "./protocol/address.js";
import { deviceName, forgetDeviceToken, redeemPairingCode, rememberDeviceToken, runtimeUrl, storedDeviceToken, type PageLocation } from "./protocol/pairing.js";

export interface BootGateProps {
  boot: BootPayload;
  at: PageLocation;
  agent: string;
  storage: Storage;
}

export function BootGate({ boot, at, agent, storage }: BootGateProps) {
  const url = runtimeUrl(boot, at);
  const askShell = desktopBridge()?.hostToken;
  const refused = useRef(new Set<string>());
  // Taken out of the address before anything is drawn, so the app never reads it and a second look finds none.
  const [code] = useState(() => (askShell === undefined ? takePairingCode() : undefined));
  const [token, setToken] = useState<string | undefined>(() => (askShell === undefined && code === undefined ? storedDeviceToken(storage) : undefined));
  // The shell's answer, or the code's, decides before anything is drawn: the page is blank for the one round trip,
  // never on the code screen for a moment on a host the shell already paired with.
  const [asking, setAsking] = useState(askShell !== undefined || code !== undefined);
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    if (askShell === undefined) return;
    let live = true;
    const usable = (held: string | undefined): string | undefined => (held !== undefined && !refused.current.has(held) ? held : undefined);
    const settle = (held: string | undefined): void => {
      if (!live) return;
      setToken(usable(held) ?? usable(storedDeviceToken(storage)));
      setAsking(false);
    };
    askShell().then(settle, () => settle(undefined));
    return () => {
      live = false;
    };
  }, [askShell, storage, asks]);
  const redeem = useCallback(
    async (typed: string) => {
      const minted = await redeemPairingCode(url, typed, deviceName(at, agent));
      rememberDeviceToken(storage, minted);
      setToken(minted);
    },
    [url, at, agent, storage],
  );
  // The code wsp init minted for this browser, spent once: a code the host will not take leaves the page on the
  // code screen, where a fresh one from wsp host pair is typed.
  useEffect(() => {
    if (code === undefined) return;
    let live = true;
    redeem(code)
      .catch(() => undefined)
      .then(() => {
        if (live) setAsking(false);
      });
    return () => {
      live = false;
    };
  }, [code, redeem]);
  // The host stopped honouring this token: the device was revoked, the state file it was paired against was
  // replaced, or the host restarted and minted another. The browser's store keeps nothing the host refused; where
  // the shell can be asked, it is asked once more, since a restarted host has a token for this computer already.
  const onUnauthorized = useCallback(() => {
    if (token !== undefined) {
      refused.current.add(token);
      if (storedDeviceToken(storage) === token) forgetDeviceToken(storage);
    }
    if (askShell === undefined) {
      setToken(undefined);
      return;
    }
    setAsking(true);
    setAsks(n => n + 1);
  }, [askShell, storage, token]);
  if (asking) return <div data-k="booting" className="h-dvh bg-background" />;
  if (token === undefined) return <PairScreen onRedeem={redeem} />;
  return <AppRoot wsUrl={url} token={token} onUnauthorized={onUnauthorized} />;
}
