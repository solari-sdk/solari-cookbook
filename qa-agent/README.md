# Sentinel

An autonomous QA agent that chains two of Solari's products behind one
investigation: it explores a target web app with the **cloud browser**, then
scripts fast repeatable probes in the **sandbox** to confirm what it finds.

A Mistral model (via AWS Bedrock) drives the whole loop as a tool-using
agent: it decides which product to reach for at each step, forms
hypotheses, and confirms them cheaply and repeatably with scripted probes
rather than clicking through the UI for every test.

## Results (live runs against a real target, not mocks)

All runs below were against [OWASP Juice Shop](https://owasp.org/www-project-juice-shop/)
(an intentionally vulnerable app built for exactly this kind of testing),
self-hosted locally and tunneled out so Solari's cloud browser could reach
it (see "Why Juice Shop" below for why self-hosting, not the public demo).

- **Verified challenge solve** — `--challenge` mode pointed Sentinel at
  Juice Shop's own "Confidential Document" challenge. It found `/ftp`
  disallowed in `robots.txt`, enumerated filenames under it, and pulled a
  file explicitly marked confidential via `GET /ftp/acquisitions.md` (200).
  Confirmed **not** by trusting the model's own claim, but by re-querying
  Juice Shop's own `/api/Challenges` endpoint after the run and checking its
  `solved` flag server-side — full transcript in
  [`reports/report-20260904-035158.md`](reports/report-20260904-035158.md).
- **Real finding in open-ended mode** — unauthenticated PII exposure on
  `/api/feedbacks` (partially-redacted user emails, no auth required). The
  same run correctly reported SQLi/XSS/weak-credential attempts on login and
  search as unsuccessful instead of overclaiming — see
  [`reports/report-20260903-211717.md`](reports/report-20260903-211717.md).
- **Verification layer catching the model, live, twice:**
  1. In a DOM XSS challenge attempt, the model's own reasoning claimed
     "Success! The payload triggered a DOM XSS alert" with zero evidence
     for it (`browser_open` only returns page text — it cannot observe a JS
     `alert()` firing). The independent post-run API check correctly
     reported `verified: false` regardless of what the model said —
     [`reports/report-20260903-222106.md`](reports/report-20260903-222106.md).
  2. On the verified solve above, the model tried to self-check its own
     work with sandbox code that called `eval()` on a raw JSON response
     instead of `json.loads()` — crashed on JSON's `null`, so the model's
     own self-check wrongly concluded the challenge was unsolved. The
     report's real `solved: true` came from a separately-coded check
     (`agent/challenges.py::is_solved`) that never trusted the model's
     interpretation of the API response, only the response itself.

The common thread: every "solved" or "found" claim in a report is backed by
either a raw HTTP request/response the model can't fabricate, or an
independent re-query of the target's own state — never the model's
self-report alone.

## Why Bedrock + Mistral, not Claude

This project was originally built against Claude, but the account driving
it doesn't have Anthropic API access (Claude Pro/Max covers claude.ai and
Claude Code usage, not a separate metered API key) and getting a paid
Anthropic key wasn't an option. The same AWS account already had Bedrock
access with a Mistral entitlement, so the orchestrator was rewired to use
that instead — see `agent/bedrock_client.py`.

**Verified live against the account's actual Bedrock access** (not assumed):
- Tool calling works on `mistral.mistral-large-3-675b-instruct` — confirmed
  with a real `converse()` call that correctly emitted a `toolUse` block.
- Vision does **not** work on anything this account can reach. Tried
  `mistral.devstral-2-123b` (clean `ValidationException`: "doesn't support
  the image content block") and `mistral.mistral-large-3-675b-instruct`
  (consistent `ServiceUnavailableException` on every attempt with an image
  block, never with text-only). None of the 11 Mistral models available in
  this account's region are from Mistral's vision line (Pixtral) — Voxtral
  is speech, everything else is text-only.

That second finding is why there's no desktop/computer-use step here: the
original design used a vision loop (screenshot in, click/type decision out)
to visually confirm findings on a real screen, which needs a model that can
see images. If you have access to a vision-capable model on Bedrock (or
switch back to Claude), that's the natural thing to add back — the Solari
desktop product wrapper already exists in git history if you want to revive
it (see `agent/solari_tools.py` and `agent/vision_desktop.py` as of the
commit before this rewrite).

## Why Juice Shop

The default target is [OWASP Juice Shop's public demo instance](https://demo.owasp-juice.shop) -
an intentionally vulnerable app that OWASP hosts specifically so people can
practice exactly this kind of testing against it. **In practice, this
instance is unreliable from Solari's cloud browser** — sometimes an
"Application Error" with an empty body (plausibly blocking cloud/datacenter
IP ranges), sometimes a flat outage, and repeated test runs against the
shared public instance can rate-limit it further.

The results above are all against a **self-hosted instance** instead, which
sidesteps both problems and avoids contaminating a shared public instance
other people are using:

```sh
docker run -d -p 3000:3000 --name juice-shop bkimminich/juice-shop
cloudflared tunnel --url http://localhost:3000   # no Cloudflare account needed
python main.py --target https://<printed>.trycloudflare.com
```

Point `--target` at your own app, or any Juice Shop instance you control,
either way.

## Architecture

```
main.py
  -> Orchestrator (agent/orchestrator.py)
       tools: browser_open / browser_fill / browser_click   -> SolariToolkit (cloud browser)
              sandbox_exec                                   -> SolariToolkit (sandbox kernel)
              finish                                          -> ends the run, records findings
  -> report.py writes reports/report-<timestamp>.md
```

`agent/solari_tools.py` is the only file that talks to Solari directly; its
call patterns (`recording=True`, `sandbox.kill()` vs `close()`) are copied
from the cookbook's own examples in `../examples/`. `agent/bedrock_client.py`
is the only file that talks to AWS; it's a thin wrapper around Bedrock's
`converse()` API with a raised read timeout (boto3's 60s default isn't
enough for a 675B-parameter model's first token) and offloads the
sync-only boto3 call to a thread so it doesn't block the orchestrator's
asyncio loop.

## Setup

1. Fork/clone this repo (you're already in it if you're reading this file
   from `qa-agent/`).
2. `cd qa-agent && pip install -r requirements.txt`
3. Copy `.env.example` to `.env` and fill in:
   - `SOLARI_API_KEY` - from [console.getsolari.com](https://console.getsolari.com)
   - `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` - an AWS
     account with **Bedrock model access enabled for a Mistral model**
     (AWS Console → Bedrock → Model access — this is a separate opt-in step
     per model, not automatic once you have AWS credentials)
4. `python main.py`

Optional: `python main.py --target https://your-app.example --max-steps 30`

### Objective mode: target a specific, checkable challenge

By default Sentinel does open-ended "find any bug" recon, which makes a
finding only as trustworthy as the model's own report. `--challenge` instead
points it at one of Juice Shop's ~100 built-in numbered challenges (the same
ones behind its public scoreboard) and, after the run, independently
re-queries the app's own `/api/Challenges` endpoint to check whether that
challenge's `solved` flag actually flipped - a ground-truth check that
doesn't depend on trusting the model's self-report.

```sh
python main.py --challenge                              # easiest unsolved challenge (difficulty <= 2)
python main.py --challenge --max-difficulty 3            # allow harder challenges
python main.py --challenge --category "Broken Access Control"
```

Caveat: this is a shared public instance, so another concurrent user solving
the same challenge would also flip the flag - the verification check
corroborates the run's own request/response proof, it doesn't replace it.

## What you get

- `reports/report-<timestamp>.md` - the full run: summary, severity, proof,
  and a step-by-step transcript of every tool call and result.
- The browser session also records an rrweb replay server-side
  (`recording=True`); see `browser-session-recording-py` in `../examples/`
  for how to pull it down.

## Known rough edges

- **No vision / desktop step** — see "Why Bedrock + Mistral" above. This is
  a real capability gap in the current setup, not a bug.
- **`ServiceUnavailableException` on image input is ambiguous.** It reads
  like a transient error but was 100% reproducible across repeated attempts
  against the same model — treated here as "this model doesn't support
  images" rather than retried, but if Mistral ships vision support on
  Bedrock later this error might mean something else by then. Worth
  re-testing before assuming it's permanent.
- **`sandbox_exec` code is restricted to the Python standard library**
  (`urllib`/`http.client`) since the `base` sandbox template's installed
  packages aren't documented in the cookbook - `requests` may or may not be
  preinstalled.
- **`--challenge` mode's built-in "unsolved" search can run dry** on a
  well-used shared instance — every challenge at a given difficulty may
  already be solved by other concurrent users. Self-hosting (above) avoids
  this entirely since it's a private instance no one else is touching.

## Cost note

Every step in the outer loop can spin up a browser session; `sandbox_exec`
spins up a sandbox VM on first use. Both bill against your Solari balance -
keep an eye on [console.getsolari.com](https://console.getsolari.com).
Bedrock inference is billed per-token by AWS separately - `mistral-large-3`
is a large model, so a full run isn't free, but it's the model this project
verified tool-calling against; a smaller model (e.g. `ministral-3-14b-instruct`)
would be cheaper if it also handles the tool-use loop well - untested here.
