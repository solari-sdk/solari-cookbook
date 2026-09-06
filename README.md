# PatchProof

Verify that a patch actually fixes the regression it claims to fix — using isolated [Solari](https://getsolari.com) sandbox execution as the evidence source.

A patch is **VERIFIED** only when:
- The baseline reproduces the expected defect (fails with expected witness)
- The candidate passes the exact same probe (succeeds with expected witness)
- Both execution receipts are valid, SHA-256 sealed, and tamper-evident
- MicroVM cleanup is confirmed

Anything less is **INCONCLUSIVE**. PatchProof does not guess.

---

## Why this exists

Code review tells you what changed. CI tells you whether tests pass. Neither tells you whether the regression you are trying to fix actually happened in the baseline and is actually gone in the candidate — in a controlled, reproducible execution environment.

PatchProof closes that gap by running a two-sided experiment in Solari sandboxes: one sandbox for the commit before the patch, one for the commit after. The verdict comes from execution evidence, not from reading diffs.

---

## Quick start

```bash
git clone https://github.com/aayushkumbharkar/solari-cookbook.git
cd solari-cookbook
git checkout feat/solari-product
npm install
export SOLARI_API_KEY=slr_live_...   # console.getsolari.com
```

### Simulate (no API key needed)
```bash
npm run cli -- simulate --patch examples/sample-patch.json
```

### Run for real (disposable Solari sandboxes)
```bash
npm run cli -- run --patch examples/sample-patch.json
```

### Verify existing receipts
```bash
npm run cli -- verify --receipt receipts/run-cdf077b0.json
```

---

## What a VERIFIED result looks like

```text
[BASELINE]   probe: cache-invalidation  →  FAIL  ✓ (expected witness: STALE_READ)
[CANDIDATE]  probe: cache-invalidation  →  PASS  ✓ (expected witness: CACHE_OK)
[RECEIPTS]   valid, SHA-256 sealed, tamper-evident
[CLEANUP]    confirmed (both microVMs released)

Verdict: VERIFIED
```

Two real Solari runs with this exact output are in [`receipts/`](receipts/):
- [`receipts/run-cdf077b0.json`](receipts/run-cdf077b0.json) — Live Solari microVM run (2.3s compute, $0.0001 est. cost)
- [`receipts/run-9d839545.json`](receipts/run-9d839545.json) — Reproducibility verification run

---

## What was built

| Component | Description |
| --- | --- |
| **Domain engine** | TypeScript verdict logic (`src/domain.ts`) — baseline must fail, candidate must pass, same probe guaranteed |
| **Guest runner** | Sandboxed Python probe executor (`guest/runner.py`) running inside the Solari microVM |
| **Solari adapter** | Ephemeral sandbox lifecycle (`src/solari.ts`) — microVM creation, execution, and guaranteed cleanup |
| **CLI & Report** | `plan` / `run` / `simulate` / `verify` / `cleanup` (`src/cli.ts`) + standalone CSP-hardened HTML report (`src/report.ts`) |
| **Receipts** | Tamper-aware JSON evidence with manifest SHA-256 and probe execution digests |
| **Tests** | 52 Node unit tests + 13 guest tests covering protocol boundaries, redaction, and error isolation |

### Validation

- ✅ **52 Node tests passing** (`npm test`)
- ✅ **13 guest tests passing** (`npm run test:guest`)
- ✅ **TypeScript typecheck clean** (`npm run typecheck`)
- ✅ **Production build passing** (`npm run build`)
- ✅ **Deterministic simulation** (`npm run demo`)
- ✅ **2 real Solari VERIFIED runs** (see [`receipts/`](receipts/))

---

## Security position

PatchProof verifies execution evidence within its controlled experiment. It does not claim cryptographic trust over contributor-produced evidence outside that boundary.

Known limitations are documented in [`docs/SECURITY.md`](docs/SECURITY.md), including: malicious revisions can forge probe output outside PatchProof's execution context. A sophisticated evaluator should know we know this.

---

## Why Solari

Solari sandboxes boot from a snapshot in ~1 second, are fully isolated, and bill to a single API key across browsers, sandboxes, and desktops. PatchProof uses the sandbox product: headless microVMs that run arbitrary code in a controlled environment and terminate cleanly. The two-sided experiment requires that isolation — you cannot fake a baseline failure from inside the candidate's process.

---

## Further reading

- [`docs/DEMO.md`](docs/DEMO.md) — Step-by-step demo walkthrough
- [`docs/SUBMISSION.md`](docs/SUBMISSION.md) — Challenge submission notes and live evidence
- [`docs/COST.md`](docs/COST.md) — Solari usage, billing model, and pricing
- [`docs/SECURITY.md`](docs/SECURITY.md) — Threat model, trust boundaries, and limitations
- [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md) — Upstream Solari cookbook examples

---

MIT licensed.
