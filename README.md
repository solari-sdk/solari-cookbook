# pulse

A live, verifiable benchmark of Solari browsers, sandboxes, and desktops.

Solari publishes a benchmark table on getsolari.com claiming it is faster
than Kernel, Steel, Browserbase, E2B, Modal, Daytona, and CodeSandbox. That
table is a static screenshot of a number someone ran once. Pulse is the same
benchmark, except it runs against the real Solari API when you click the
button, times itself stage by stage, and shows you the live number next to
Solari's own published reference - so the claim is something you can check
instead of something you have to trust.

## What it measures

- **Browser**: create session, connect over CDP, navigate to a page, release.
  Same four stages Solari lists on its own homepage.
- **Sandbox**: create the machine, run a command, tear it down. Same three
  stages as Solari's own sandbox benchmark.
- **Desktop**: create, wait for the display and VNC agent to report healthy,
  release. Solari has not published a cross-provider desktop benchmark, so
  this tab only measures Solari against itself.

Every stage timing comes from a real call to the Solari SDK. Nothing is
simulated. The competitor numbers shown next to the live result are static,
copied from getsolari.com, and clearly labeled as such - this server never
calls Browserbase, E2B, or anyone else.

## Setup

You need Node 20 or later and a Solari API key from console.getsolari.com.

```
npm install
cp .env.example .env
# edit .env and set SOLARI_API_KEY=slr_live_...
npm run dev
```

Open `http://localhost:8787`.

For a production build:

```
npm run build
npm start
```

## How it is built

- `src/config.ts` reads `SOLARI_API_KEY` and resolves the gateway URL
  (defaults to `https://api.getsolari.com`, Solari's live us-west region).
- `src/benchmarks/browserPulse.ts` uses `@solarisdk/browser`'s lower-level
  path (`sessions.create()` then `chromium.connectOverCDP()`, both documented
  in the SDK's own README) instead of `solari.launch()`, so create and
  connect can be timed as two separate stages rather than one.
- `src/benchmarks/sandboxPulse.ts` and `desktopPulse.ts` use
  `@solarisdk/sandbox`'s `SandboxClient`.
- `src/server.ts` is a single Express app. `GET /api/pulse?mode=browser`
  (or `sandbox` / `desktop`) streams each stage's timing over
  Server-Sent Events as soon as it finishes. `GET /api/reference` serves the
  static comparison table.
- `public/` is plain HTML, CSS, and one JS file. No build step, no framework.

## Why this shape

It is small enough to read start to finish in a few minutes, it uses
primitives from all three Solari products (browsers, sandboxes, desktops)
rather than picking one, and it produces something Solari could plausibly
embed on their own site: a "verify it yourself" widget standing next to the
benchmark table they already publish.

## License

MIT
