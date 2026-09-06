# PatchProof — Submission

## What was built

**PatchProof** is a two-sided regression experiment CLI for open-source maintainers.
It runs the same reviewer-owned regression probe against two Git revisions (or fixture files)
in sequential disposable Solari sandboxes, producing a local receipt and HTML report.

## Evidence

### Offline (simulation)

```
npm run demo
```

Result: `VERIFIED` — both lanes produced correct output, all resources released.

### Live Solari (real sandboxes)

Run ID: `cdf077b0-e58f-4a7e-82dd-a1223fbbd5fc`
Receipt: `runs/cdf077b0-e58f-4a7e-82dd-a1223fbbd5fc/receipt.json`

```
Verdict:   VERIFIED
Provider:  SOLARI
Sessions:  2
Compute:   2.3s
Est. cost: $0.0001
Cleanup:   all released
```

Session IDs (opaque, period-separated JWT-style tokens):
- Baseline: `ZGVza3RvcC...MTc4ODcyMjA1NzA1MA.dnu28yISg0MbaGrhQECGCwTTNsnKXwMuWfR_CKvBlcY`
- Candidate: `ZGVza3RvcC...MTc4ODcyMjA1OTAzMA.mA2eG0Ni6AX1LTAzmQVgQcXyh30drpppIeKnaAhgVjE`

Baseline result: exit 1, stdout contains `STALE_READ` — reproduced.
Candidate result: exit 0, stdout contains `CACHE_OK` — fixed.
Both sessions released before verdict was sealed.

Receipt SHA-256: `feb79279befdef319e024dbd904fa872e8ee442c04e297033b3553a3a91ad216`
Manifest SHA-256: `98030fce4ea17f0088075d44cc7ebe7a42409269a371335dca06379748142b86`

## Test counts

| Suite | Tests | Result |
|---|---|---|
| Node (domain, runner, solari, CLI) | 52 | All pass |
| Python guest runner | 13 | 12 pass, 1 Linux-only skip |

## Key files

| File | Purpose |
|---|---|
| `src/domain.ts` | Manifest parsing, verdict rules, input hashing |
| `src/runner.ts` | Orchestration, session lifecycle, receipt generation |
| `src/solari.ts` | Solari SDK adapter |
| `src/cli.ts` | CLI commands: plan, run, simulate, verify, cleanup |
| `src/report.ts` | Escaped HTML report generation |
| `guest/runner.py` | Bounded Python guest (runs inside sandboxes) |
| `fixtures/cache-fix.json` | Fixture: baseline fails (STALE_READ), candidate passes (CACHE_OK) |
| `fixtures/cache-unfixed.json` | Fixture: both lanes fail (STILL_FAILING) |

## Hardening summary

- Session IDs are treated as opaque (accepts any printable non-control string); regression test for period-containing IDs added
- Same-probe guarantee: both lanes receive identical manifest.probe; SHA-256 verified by guest and checked in verifyReceipt
- Cleanup-gated verdict: uncertain cleanup blocks VERIFIED
- HTML report: CSP `script-src 'none'`, all guest text escaped, terminal controls stripped
- Simulation is never labeled as Solari evidence; provider type is stamped in every receipt
- Windows cross-platform: guest runner uses blocking reads on Windows (os.set_blocking is POSIX-only)

## What was not built

- No PR comment bot, GUI, database, queue, LLM, browser session, or desktop dependency
- No private repository support
- No automatic code repair or generated tests
- No hermetic pinning of provider template or unpinned setup dependencies (V1 limitation)

## How to verify independently

```bash
git clone https://github.com/aayushkumbharkar/solari-cookbook -b feat/solari-product
cd solari-cookbook
npm install
npm test
npm run typecheck
npm run build
npm run demo
# With a key: npm run demo:live
node dist/src/cli.js verify runs/<uuid>/receipt.json
```
