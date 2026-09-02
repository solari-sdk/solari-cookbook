# Human handoff (TypeScript)

When a browser agent hits a wall it can't climb — a 2FA code, a failed captcha, a dialog it doesn't understand — `raiseHand()` pauses it and puts the live session on your phone. A QR code prints in the terminal; scan it, you see the real page, fix the one thing, tap **Hand back**, and the agent continues in the same session.

The handoff UI runs on Solari itself: `raiseHand` boots a sandbox, deploys a relay, and exposes it through port preview. The same API key that runs the browser runs the escape hatch — nothing to host, nothing to install on the phone.

The second kind of wall is not a capability gap but an authority boundary: the agent could submit the payment, but must not decide that alone. `raiseHand(page, { mode: "approval", reason, action })` sends one screenshot and the step in words; the human answers yes or no, on the phone or — with `channels: [telegram(...)]` — from a Telegram chat, and the agent carries out the step itself. Nothing is injected into the page while it waits.

Uses [`handraise`](https://github.com/Sy-D/handraise), a small library built on Solari's browser + sandbox primitives.

## Run

```bash
cd examples/browser-human-handoff-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Scan the QR code that appears with your phone. The live browser session opens in your mobile browser — no app, no login.

Source: [`index.ts`](index.ts)
