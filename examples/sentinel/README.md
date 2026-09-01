# sentinel

A passive vendor security posture review: runs a Solari browser and a Solari sandbox against a vendor's public surface and prints a graded report.

## What this shows

Two Solari primitives behind one API key, working on the same job. The browser reads what a vendor *says* about its security on its public trust pages, capturing a screenshot of each one it reaches. The sandbox measures what that vendor's infrastructure *actually does* over TLS, HTTP, and DNS, using ordinary command line tools that are already in the `base` template. A fixed rubric in the same file turns both halves into a score where every point traces back to a named finding with its evidence attached. The two passes are independent and run at the same time, so a failure in either still yields a report built from the other.

## What it does not do

- No authentication. It never logs in, and it has no credentials to log in with.
- No exploitation, no fuzzing, no brute forcing, no writes of any kind.
- No port scanning. It confirms 443 answers a standard TLS handshake and stops there.
- `robots.txt` is fetched and honoured per host, longest match wins, before any page is opened.
- The User Agent is honest and descriptive, and says what the request is for.
- Requests are throttled to one page per second, from a fixed list of ten known trust surfaces. This is not a crawler and must not become one.

Everything it reads is what any visitor or any DNS resolver would already see. Findings are observations of public data, and scores are derived from those observations by the rubric in `index.ts`. Nothing this prints says a vendor is vulnerable.

## Run it

```bash
cd examples/sentinel
cp .env.example .env
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start -- vercel.com
```

The `start` script is `tsx index.ts` and does not load `.env` for you, so export the variable yourself or run it through your shell's loader. `SENTINEL_USER_AGENT` is optional and overrides the default.

Real output, trimmed:

```
------------------------------------------------------------------------
Sentinel posture report for vercel.com
Scanned 2026-09-01T20:50:23.301Z
Grade A    Score 91.1 of 100    Assessed on 90 of 100 rubric points
Browser pass 46980ms    Sandbox pass 9615ms    Total 46983ms
------------------------------------------------------------------------

Governance and compliance  25.0 / 25
  [pass       ] Vulnerability disclosure policy published  4/4
     Found on https://vercel.com/.well-known/security.txt.
     evidence: https://vercel.com/.well-known/security.txt
  [pass       ] Status or uptime page published  1/1
     record: https://status.vercel.com/ redirected off-site to www.vercel-status.com
  [unverified ] Trust surface redirected to another domain  0/0
     https://status.vercel.com/ redirected to www.vercel-status.com, which is
     outside the scan target, so the page content was not read and no governance
     signal was credited from it.

Application security headers  14.0 / 15
  [pass       ] Strict-Transport-Security  4/4
     Header present with max-age 31536000.
  [fail       ] Permissions-Policy  0/1
     Header not present.

DNS hygiene  5.0 / 10
  [pass       ] CAA record published  5/5
     4 CAA record or records published.
  [fail       ] DNSSEC delegation present  0/5
     No DS record was published at the parent zone.

Evidence screenshots
  screenshots/https-vercel-com-security.jpg    https://vercel.com/security
```

Screenshots are JPEG files written under `screenshots/`, which is gitignored, and referenced by relative path in the report. The process exits on its own when it is done, which is the observable proof that `solari.close()` and `sandbox.kill()` both ran.

## What it costs

One browser session and one sandbox per run, both torn down in a `finally`. Against a large vendor the browser pass held its session for about fifty seconds to read ten pages and screenshot each one, and the sandbox lived about ten seconds; the two overlap, so wall clock for the whole run was under a minute. Check your own balance in the console after a run, since browser session time is the dominant cost and it scales with how slow the vendor's pages are, not with anything this script decides.

The numbers at the top of `index.ts` are where to lower it. `MAX_TRUST_PAGES` is the direct lever on browser time. `PAGE_TIMEOUT_MS` and `THROTTLE_MS` set the worst case per page, and `BROWSER_TOTAL_TIMEOUT_MS` has to stay above their product or a slow vendor aborts the whole pass. `MAX_CVE_LOOKUPS` and `NVD_SPACING_MS` bound the only sandbox step that can run long, because NVD allows five requests per thirty seconds without an API key.

## How it works

The browser pass probes a fixed list of ten known trust surfaces, seven paths on the domain plus `trust.`, `security.` and `status.`, checking `robots.txt` first and re-checking after every redirect that it is still on the vendor's own domain. A table of ten governance signals, deliberately narrow so a false positive cannot inflate a vendor's score, is matched against each page's text and its own URL. The sandbox pass runs six passive checks in parallel: a TLS handshake and certificate read with `openssl`, security headers from one `curl` to the root, SPF, DMARC and DKIM over DNS over HTTPS, CAA and DNSSEC the same way, Certificate Transparency from crt.sh with a Cert Spotter fallback, and a software fingerprint whose observed versions are looked up against NVD. The rubric weights those six categories to a hundred points and awards absolute points, never scaling a category up to its full weight on the strength of the few checks that happened to work. A check that could not run contributes zero earned and zero available points, so it leaves both sides of the ratio and a scanner side outage never reads as a worse vendor posture, which is why the header line says how many of the hundred points were assessed. Everything lives in `index.ts`, in that order, under banner comments.

Source: [`index.ts`](index.ts)
