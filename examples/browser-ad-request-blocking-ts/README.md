# Ad request blocking (TypeScript)

Load an ad-heavy page in two Solari cloud browsers, one plain and one with an ad blocklist, and print a table comparing total requests, ad requests attempted, ad requests blocked and load time. Each run gets a fresh session, so both start with a cold cache.

Blocking happens inside the session with `page.route()`, which aborts any request whose host is on a list of ad-serving domains before it leaves the browser. Expect the blocked run to *attempt* far fewer ad requests, not just refuse the same number. Most ad traffic is requested by ad scripts, and a script that never loads never asks for the next creative, bid or tracker. Requests are counted for eight seconds after `load`, because ads load lazily. Edit `AD_DOMAINS` to match your own blocklist.

## Run

```bash
cd examples/browser-ad-request-blocking-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start -- https://www.theguardian.com
```

Source: [`index.ts`](index.ts)
