# Portal Watch (TypeScript)

The real problem: job/internship applications live scattered across a dozen
different ATS portals (Greenhouse, Lever, Ashby, some company's own Workday
instance), each with a different login and a different status page, and
"did anything change" means manually re-checking every one. This checks them
for you.

- **Login once, ever, per portal** — each tracked portal gets its own Solari
  browser **profile** ([`src/track.ts`](src/track.ts)), so the session
  persists across runs. See [`browser-profiles-ts`](../browser-profiles-ts)
  for the underlying pattern.
- **No CSS selectors** — [`src/extract.ts`](src/extract.ts) hands the page's
  visible text to Claude with one tool forced (`tool_choice`), so it comes
  back as structured JSON (`{ stage, detail }`) regardless of how that
  specific ATS happens to lay out its status page.
- **Only reports what changed** — [`src/state.ts`](src/state.ts) keeps the
  last-seen status per portal in `out/state.json` on disk; a scheduled run
  (cron, a GitHub Action) diffs against it and stays quiet unless something
  actually moved.

## Run the demo

No real accounts needed to see it work: `index.ts` stands up a small mock
careers portal inside a **Solari sandbox**, checks it once, rewrites the
portal to simulate a status change, then checks it again — the second check
is what a real scheduled run would see.

```bash
cd examples/portal-watch-ts
npm install
export SOLARI_API_KEY=slr_live_...      # https://console.getsolari.com
export ANTHROPIC_API_KEY=sk-ant-...     # https://console.anthropic.com
npm start
```

Expect:

```
sandbox: sbx_...
mock portal live: https://....preview.getsolari.com

--- check 1 (application just submitted) ---
[Acme (SWE Intern)] first check — Application received: We'll be in touch within two weeks.

--- a week passes: Acme updates the portal ---

--- check 2 (this is what a scheduled run would see) ---
[Acme (SWE Intern)] CHANGED — Application received -> Interview scheduled: next Tuesday at 2pm with the platform team.
```

Run it a third time and, since `out/state.json` persists on disk, it reports "no change" — exactly the quiet behavior you want on a cron job.

## Using it on your real applications

Replace the `PORTAL` constant in `index.ts` with your own tracked portals (or loop over a list — one `TrackedPortal` per entry), point `url` at each one's real status page, and give each a distinct `profileName`. The first run against a real portal needs an actual login flow in `src/track.ts` in place of the mock form-fill — for a simple username/password site, that's a couple of `page.locator(...).fill(...)` calls; for SSO or magic-link portals, log in once through your own credentials outside the profile flow and save that `storageState` instead (same idea as `browser-profiles-ts`, different login step). Never put real account credentials in a shared script or repo — keep them in your own local `.env`, un-committed.

## Gotchas this example encodes

- **Reusing a profile skips the login step entirely** — see check 2 in the demo output above go straight to the status without re-submitting the form. That's the Solari profile persisting session state across runs, not anything special the code does.
- **`tool_choice` forces the shape**, not just the presence, of the model's answer — no "sure, here's the status:" preamble to strip, no JSON.parse of a code fence. Reach for it any time you want one specific structured answer rather than an agentic loop.
- **The mock portal fakes login with `localStorage`, not a real session** — good enough to prove the profile-reuse mechanic; swap it for whatever your real target portal actually uses.

Source: [`index.ts`](index.ts) · [`src/track.ts`](src/track.ts) · [`src/extract.ts`](src/extract.ts) · [`src/state.ts`](src/state.ts)
