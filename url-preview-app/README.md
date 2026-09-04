# URL Preview

Paste a URL, get back a preview of what's behind it. Everything runs on
Solari — a repo gets cloned, installed, and started in a sandbox VM; any
other page gets loaded in a hosted browser and its behaviour reported back.
Nothing touches the machine running this app.

## Two modes, one shell

The pasted URL decides the mode (with a toggle to override):

- **Repo mode** — `github.com/owner/repo`, `gitlab.com/...`, anything
  ending in `.git`, or a link to a `.zip`/`.tar.gz` archive. Clones into a
  Solari sandbox, detects the package manager and framework, installs,
  builds, starts, and hands back a live preview.
- **Site mode** — everything else. Loads the page in a Solari browser
  session and reports what it did: redirect chain, downloads, screenshots,
  outbound requests by domain, clipboard writes. No verdicts — it reports
  observations, not a safe/unsafe rating.

Session lifecycle (countdown, heartbeat, log stream, teardown, quotas) is
shared between both modes.

## Setup

```bash
cd url-preview-app
npm install
cp .env.example .env.local   # fill in SOLARI_API_KEY, AUTH_SECRET, ADMIN_SECRET
mkdir -p data
npm run db:push              # creates data/app.db from src/lib/schema.ts
npm run dev
```

Open `http://localhost:3000`, sign up with an email + password (accounts
are required — there's no anonymous mode), paste a URL, go.

`AUTH_SECRET` signs the login cookie — generate one with
`openssl rand -hex 32`. `ADMIN_SECRET` gates `/admin` and `GET /api/admin`.

## Standalone scripts

Two scripts prove the Solari SDK usage end to end without any web app
around them — read these first if you want the shortest path to
understanding what the app does:

```bash
cd scripts
npm install
export SOLARI_API_KEY=slr_live_...
npm run repo -- https://github.com/some/vite-app   # clones, builds, prints a preview URL, waits, kills
npm run site -- https://example.com                # loads the page, prints redirect chain + downloads, releases
```

## How a repo-mode session works

1. **Detect** — a sandbox is created, the repo is shallow-cloned, and we
   sniff the package manager (from the lockfile), framework (from
   `package.json`), and port. Repos that need a database, docker-compose,
   multiple processes (Procfile with >1 process type), are private, or are
   over 300MB are rejected here with a plain explanation instead of failing
   halfway through an install.
2. **Confirm** — the detected install/build/start commands and port are
   shown in the UI for review. Nothing has run yet; edit any of the four
   fields and click Run. This is also where an ambiguous detection (unknown
   framework, no lockfile) gets sorted out by hand instead of guessed.
3. **Run** — install, build, start (bound to `0.0.0.0`, never `localhost` —
   otherwise the exposed port reaches nothing), then the port is exposed.
4. **Preview** — the app never hands the raw `*.preview.getsolari.com` URL
   to the browser. The iframe points at `/api/preview/[id]/...`, our server
   proxies it to the real preview URL after checking the request owns the
   session. See "Preview URL access" below for why.

## How a site-mode session works

Load, wait, scroll once, screenshot — nothing is clicked and no forms are
filled. Captured and reported: the full redirect chain, any download the
page started (filename, size, MIME type, sha256 — the file itself is
hashed and then deleted, never handed to the user or kept anywhere they
can reach), screenshots at load and after settle, outbound requests
grouped by domain, and any clipboard write the page attempted (the
paste-into-your-terminal scam pattern, surfaced loudly since a sandboxed
page has every reason to look clean while it isn't).

## Session lifecycle

- One session = one sandbox or one browser session: create, run, hold,
  kill.
- Hard wall-clock cap enforced by our own `setTimeout`, not Solari's
  `timeoutMs` (that's a rolling idle window and a live dev server would
  keep it alive forever). 15 min for repo mode, 2 min for site mode.
- Repo mode has an Extend button, +15 min per click, up to 45 min total.
- Site mode expects a heartbeat from the open tab every 15s
  (`POST /api/heartbeat`); two missed beats and the session tears down, so
  a closed tab doesn't keep billing.
- `kill()` destroys the sandbox/session; `close()` alone would only drop
  the local control channel and leave it running. Every teardown path
  calls `kill()` (and, for browser sessions, the per-session `Solari`
  client's `close()` too — see the note in `src/lib/solari.ts` about why
  each browser session gets its own client instance).
- Live sandbox/browser handles are held in `src/lib/session-registry.ts`
  (in-memory, this process only — there's no cross-process job queue in
  scope here). `instrumentation.ts` sweeps orphaned DB rows on boot (a
  crashed process leaves rows in a non-terminal status) and wires
  `SIGINT`/`SIGTERM`/`unhandledRejection`/`uncaughtException` to tear down
  every session this process is still holding, so a killed process doesn't
  leave a sandbox running and billing.

## Abuse control

- Accounts required, no anonymous runs (`src/lib/auth.ts` — email +
  password, scrypt-hashed, signed cookie session).
- One concurrent session per user, 120 daily minutes, global concurrency
  cap of 10 (`src/lib/session-manager.ts`).
- Repo size cap (300MB) and an install-time cap (6 min) — see
  `src/lib/repo-runner.ts`.
- Site mode blocks private IP ranges and `localhost` before creating a
  session, so this can't be used to probe internal networks.
- Sandbox/browser session creation retries capacity errors
  (`NoCapacityError` / `ConcurrencyLimitExceeded`) with exponential
  backoff and logs that it's queuing rather than failing silently
  (`src/lib/solari.ts`).
- Per-job cost is estimated and logged on every session; cumulative spend
  is on `/admin` (gated by `ADMIN_SECRET`).

## Preview URL access

Solari's `previewUrl()` returns a `*.preview.getsolari.com` URL that's
reachable from anywhere with no auth of its own — the port-preview cookbook
example proves this by fetching it from outside the VM with a plain
`fetch()`, no token attached. That means anyone who obtains the URL reaches
a sandbox we're paying for, for as long as it lives. So the raw URL is
never sent to the browser: `GET /api/preview/[id]/[...path]` checks the
request's session cookie owns that session and only then proxies to the
real preview URL server-side (`src/app/api/preview/[id]/[[...path]]/route.ts`).

## Per-session cost estimates

Solari's cookbook doesn't publish per-minute pricing, so
`src/lib/cost.ts` uses placeholder rates — swap them for your real rate
from `console.getsolari.com`:

| Mode | Assumed rate | Cap | Estimated cost per full session |
| --- | --- | --- | --- |
| Repo (sandbox) | $0.02/min | 15 min (45 min extended) | ~$0.30 (~$0.90 extended) |
| Site (browser) | $0.03/min | 2 min | ~$0.06 |

## Rebuilding the sandbox template

Repo mode uses `template: "base"` on every run, which means Node, a
package manager, and git get reinstalled or re-verified per job — fine for
a `base` image but slower than it needs to be. Solari lets you compile a
custom template once and reuse it:

```ts
import { SolariClient, Image } from "@solarisdk/sdk"

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })

const image = Image.fromTemplate("base")
  .aptInstall(["git"])
  .runCommands("corepack enable") // ships pnpm/yarn alongside npm without a separate install

// Blocks until the build finishes (or throws on failure/timeout).
const template = await pt.templates.build(image, { name: "url-preview-repo-runner" })

console.log("template:", template.templateId, template.status)
```

Then point sandbox creation at it instead of `"base"`:

```ts
client.sandboxes.create({ template: "url-preview-repo-runner", timeoutMs: 5 * 60_000 })
```

in `src/lib/repo-runner.ts`'s `detectRepoSession`. Rebuild the template
whenever the baked-in tool versions need to move (new Node LTS, etc.) by
re-running the script above with an updated `Image` chain and repointing
the `template` string.

## Known limitations

- The preview proxy forwards the response as-is; it doesn't rewrite
  redirect `Location` headers back through the proxy path, so a repo that
  redirects mid-session may break out of the iframe.
- Browser sessions can't be reconnected to after a process restart (no
  `sandboxes.get`-equivalent for browser sessions), so a crash mid-site-mode
  session leaves it to age out on Solari's own deadline; the DB row still
  gets swept to `killed` on boot.
- Out-of-scope detection (needs-a-database, multi-process, docker-compose)
  is heuristic — it checks `package.json` dependencies, `Procfile`, and
  compose files, not a full static analysis.
