# Browser from a Cloudflare Worker, over raw CDP (TypeScript)

Launch a cloud browser from a Worker, open a page, read it, release the session.
No Node process anywhere in the path, and no `@solarisdk/browser` — the whole
example has zero runtime dependencies.

## Why this exists

`@solarisdk/browser` bundles a Playwright fork, which wants a Node runtime and
raw TCP sockets. Workers have neither, so the SDK cannot run there. The usual
answer is to stand up a small Node service beside the Worker whose only job is
to hold the browser: an extra hop on every action, an extra deploy, and an extra
thing to page someone about at 3am.

You don't need it. Solari exposes each session's Chrome DevTools Protocol
endpoint, and a Worker can hold an outbound WebSocket — so the Worker can speak
CDP directly. Playwright is a convenience over that protocol, not a requirement
of it, and the subset you need to open a page and read it is about sixty lines.

The same trick works from any WebSocket-capable edge runtime — Deno Deploy,
Vercel Edge, Bun — for the same reason.

## Run

```bash
cd examples/browser-workers-cdp-ts
npm install
cp .dev.vars.example .dev.vars       # then paste your key in
npm start                            # wrangler dev, on http://localhost:8787
```

```bash
curl 'http://localhost:8787/?url=https://example.com'
{"url":"https://example.com/","title":"Example Domain","h1":"Example Domain","session":"ip-10-0-11-65:30d02860-...:1788615203191.YXHjXU3oaXz8It406fGZ9g"}
```

`npm run deploy` puts it on your own workers.dev subdomain; set the key there
with `wrangler secret put SOLARI_API_KEY`.

## The five things that bite

All five are commented at the line where they happen in [`index.ts`](index.ts).

1. **A Worker has no `new WebSocket(url)`.** You upgrade an outbound `fetch` —
   `fetch(url, { headers: { Upgrade: "websocket" } })`, then read
   `response.webSocket`. `fetch` will not accept a `ws://` URL, so swap the
   scheme to `http://` first, and call `socket.accept()` or you never receive a
   single message.
2. **A CDP connection is the browser, not a page.** `Target.createTarget` then
   `Target.attachToTarget` with `flatten: true`, and every command meant for
   the page carries the session id that comes back. Send one without it and you
   are addressing the browser, which will tell you the method does not exist.
3. **Domains are opt-in and silent until enabled.** No `Page.enable`, no
   `Page.loadEventFired` — and the navigation just looks like it hung.
4. **`Page.navigate` resolves when the navigation starts**, not when the page is
   ready. Subscribe to `Page.loadEventFired` *before* navigating, then await it,
   or you will read `about:blank` off a fast page.
5. **Closing the socket does not end the session.** It runs on, billing, until
   its idle timeout. `DELETE /sessions/:id` in a `finally`, so a thrown error
   cannot leak a browser.

The session id is not a short token. It comes back as a composite string —
worker host, session uuid, and more — so treat it as opaque: pass it around
whole rather than parsing or truncating it.

And one about the payload rather than the protocol: the create-session response
carries the id as `sessionId` on the wire but as `id` on the SDKs' `Session`
type, and `cdpEndpoint` is optional — when it is absent, derive it from
`wsEndpoint` by swapping `/ws/` for `/cdp/`, which is what the SDKs do.

## Where to take it

- **A screenshot is one more call.** `Page.captureScreenshot` with
  `{ format: "png" }` returns base64; put the bytes in R2 and you have evidence
  a log line cannot give you.
- **Status codes and console errors need `Network.enable` and `Log.enable`,**
  then listen for `Network.responseReceived` and `Runtime.consoleAPICalled`.
  This example's `once()` handles one event; a real run wants a listener set.
- **Waiting for load is the weakest thing here.** A single-page app finishes
  loading long before it finishes rendering. What actually works is a quiet
  period: track in-flight requests from the `Network` events and wait for the
  page to stop making them, with a floor and a ceiling.
- **Anything longer than one request belongs in a Durable Object.** A fetch
  handler that drives a ten-step journey holds a client connection open for the
  whole thing. Put the loop in a DO, return a job id, and stream progress over
  SSE.

A production build of all four is [Forge](https://github.com/kurtiz/forge),
which drives Solari this way to verify deployed web apps end to end —
`apps/web/src/server/execution/` is this file grown up.
