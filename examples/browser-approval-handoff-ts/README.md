# Approval handoff (TypeScript)

Show a person a screenshot, take their yes or no.

Most agent pauses do not need a human at the wheel. They need one decision:
this is the order, this is the amount, send it or not. So the agent works up to
the last safe moment before a consequential click, takes its own
`page.screenshot()`, and asks. Nothing is injected into the page and no relay is
opened. The screenshot is not uploaded to Solari or to anyone else — this
process serves it directly to one page it hosts on loopback, and that page stops
existing as soon as the answer arrives.

Approve and the agent clicks and finishes. Deny and it mints the native handoff
link with `reason` set to the question the person just read, so they can take
the wheel and do it themselves. That is the same relay as
[browser-login-handoff-ts](../browser-login-handoff-ts) — look first, take the
wheel only if needed.

## Run

```bash
cd examples/browser-approval-handoff-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start                            # or: npm start -- https://your-site/form
```

The script fills a pizza order on `httpbin.org/forms/post`, stops before the
submit button and prints a `127.0.0.1` URL with a one-time token. Open it and
play the human. httpbin only echoes the form back, so nothing real happens — it
stands in for the click you would not want an agent to take on its own, and the
order it describes is in the question you are asked.

Approve and it submits. Deny and it prints a handoff link, then polls until
whoever opens it is finished, or until the link's own `expiresAt` plus thirty
seconds has passed. It exits 0 only after an approved click or a handoff
somebody finished; a timeout, an expiry, a cancellation or a failed request all
exit 1.

## Answering from a phone

The approval page is plain HTML with no JavaScript, so a phone can answer it.
It binds to loopback, so a phone cannot reach it until you set `APPROVAL_HOST`.
Set it to `0.0.0.0` and the script prints your machine's LAN address instead of
`127.0.0.1`.

Know what that costs. Every request carries the 128-bit token, so somebody who
never sees the URL can neither read the screenshot nor answer in your place.
The page is plain HTTP, though, so the token crosses the network in the clear.
Anyone who can watch that traffic has it: an open network, a stranger's access
point, a machine doing ARP spoofing on the same switch. With the token they see
whatever the agent is looking at, which is usually a signed-in account, and
they can approve the click you were about to refuse.

The safer route is an address only your own devices can reach. `APPROVAL_HOST`
takes any address this machine holds, so pointing it at a WireGuard or Tailscale
interface reaches the phone over an encrypted link and never touches the local
network.

## The calls behind the deny path

Neither has an SDK method yet, so the example calls them over HTTP.

| Call | What it does |
| --- | --- |
| `POST /sessions/:id/handoff` | Mints the link. `reason` is required. |
| `GET /sessions/:id/handoff` | `pending` while the person is driving, then gone. |

The gateway parks no terminal status. Measured on 2026-09-08, the status went
straight from `pending` to `{"status":"none"}` inside a second of the person
clicking "I'm done" — `completed` never appeared. The record is also dropped
when the link expires, so `none` on its own cannot tell a finished handoff from
an abandoned one. The link's own `expiresAt` can: a `none` before it means
somebody ended the handoff, a `none` after it means nobody did. That is why
`expiresAt` is the deadline here, and why a handoff that just runs out exits 1.

`none` still cannot separate a handoff somebody finished from one they
cancelled, so the example reports `over` rather than claiming either.

`POST /sessions/:id/save-profile` is the third call in that family; the login
example uses it to keep what the human did.

## What matters here

The approval half needs nothing from the gateway. The agent already has the
page, so it takes the picture itself — which means the human judges exactly
what the agent can see, and the site never learns that a person was asked.
That is why a yes/no pause costs one screenshot rather than a live session
someone has to be free to drive.

The two halves chain on purpose. A denial is rarely "stop"; it is usually "not
like that". Passing the question through as the handoff `reason` means the link
arrives already explaining itself, and the person who just said no can finish
the job by hand in the same browser.

Source: [`index.ts`](index.ts)
