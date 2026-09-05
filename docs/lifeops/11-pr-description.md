### What

Adds `examples/lifeops-task-agent-ts`, an end-to-end task agent demonstrating a verified billing audit workflow:

```text
Solari Cloud Browser
         │  (retrieve DOM invoice rows + SHA-256 fingerprint)
         ▼
StatementPayload
         │
         ▼
Solari Sandbox MicroVM
         │  (isolated in-guest discrepancy calculation)
         ▼
AuditResult + VerificationManifest
         │
         ▼
Solari Port Preview (Port 3000)
         │  (serve dark-mode verification dashboard)
         ▼
Human Review & Guaranteed Teardown (sandbox.kill())
```

---

### Why

Real-world AI agents frequently need to scrape billing dashboards or operational web consoles. However, running calculations, business rules, or compliance checks in the same execution context that browses untrusted third-party web content blurs security and execution trust boundaries.

This example demonstrates how to build an agent using Solari's architectural separation:
1. **Browser** handles stealth web retrieval and structured extraction.
2. **Sandbox** independently audits the untrusted data inside an ephemeral Linux microVM.
3. **Port Preview** exposes an inspectable HTML evidence dashboard over a secure edge tunnel (`previewUrl()`).

---

### Deterministic Demo Scenario

The example runs completely self-contained out-of-the-box (no live banking credentials required), evaluating an August 2026 statement against a July 2026 baseline:

- **Baseline Total (July 2026):** `$329.80`
- **Current Total (August 2026):** `$356.60`
- **Net Variance:** `+$26.80 (+8.13%)`
- **Configured Variance Threshold:** `15.00%`
- **Individual Anomaly Detected:** `item_browser_04` (*Stealth Residential Proxy Sessions (Burst)*) increased from `$20.00` to `$45.00` (**+125.00%**).
- **Outcome:** `ANOMALIES_FLAGGED`. Demonstrates how line-item microVM auditing catches localized cost spikes that aggregate bill totals mask.

---

### Live Execution Trace

<details>
<summary><b>Click to expand full live E2E run log (~25s)</b></summary>

```text
> tsx index.ts

=========================================================
LIFEOPS — VERIFIED BILLING AUDIT
================================

Task: monthly-cloud-billing-audit
Threshold: 15%

--- Stage 1: Cloud Browser ---
[Browser Engine] Initializing Solari Cloud Browser session...
[Browser Engine] Target mode: demo (Synthetic Portal Fixture)
[Browser Engine] Cloud Browser session established (id: ip-10-0-10-40:e7...)
[Browser Engine] Navigating to billing portal...
[Browser Engine] Scanning DOM for statement records...
[Browser Engine] Validating and normalizing 5 billing rows...
[Browser Engine] Extraction complete. Integrity SHA-256: 21eb7800b3691253e6509191451e743e2d5179e75039c5ab92a8b1ca8c46801f
[Browser Engine] Releasing Cloud Browser session (ip-10-0-10-40:e7...)...
[Browser Engine] Browser session released successfully.
✓ Billing statement acquired
✓ 5 line items normalized
✓ Arithmetic integrity validated
✓ Statement fingerprint generated
✓ Browser session released

--- Stage 2: Isolated Sandbox Audit ---
[Sandbox Engine] Provisioning isolated Solari Sandbox microVM (template: "base")...
[Sandbox Engine] MicroVM booted successfully (id: ZGVza3RvcC1wb29s...)
[Sandbox Engine] Connecting secure control channel...
[Sandbox Engine] Initializing guest workspace directory...
[Sandbox Engine] Transferring current statement (INV-2026-08-4912) and baseline (INV-2026-07-3801)...
[Sandbox Engine] Executing isolated discrepancy audit (threshold: 15%)...
[Sandbox Engine] In-guest output: [Guest Audit] Completed. Status: ANOMALIES_FLAGGED, Anomalies: 1, Net Variance: $+26.80 (+8.13%)
[Sandbox Engine] Reading verified audit artifacts from guest filesystem...
[Sandbox Engine] Audit result verified on host. Status: ANOMALIES_FLAGGED
✓ Sandbox provisioned
✓ Current + baseline statements transferred
✓ Audit executed inside isolated microVM
✓ 1 anomaly detected
✓ Audit fingerprint generated
✓ Audit artifacts validated

--- Stage 3: Verification Dashboard ---
✓ Dashboard generated
[Sandbox Dashboard] Ingesting verification dashboard into guest filesystem (/workspace/index.html)...
[Sandbox Dashboard] Launching in-guest HTTP server on port 3000...
[Sandbox Dashboard] Verifying preview tunnel reachability...
[Sandbox Dashboard] Preview tunnel verified active and reachable.
✓ HTTP server started
✓ Solari port preview created

Verification Dashboard: https://<sandbox-id>-3000.preview.getsolari.com?token=...

Status: ANOMALIES_FLAGGED
Net variance: +$26.80 (+8.13%)
Anomalies: 1

  ⚠ [item_browser_04] Stealth Residential Proxy Sessions (Burst)
    $20.00 → $45.00 (+125.00%) [Threshold: 15%]
    Reason: Cost increased by 125.00% (from $20.00 to $45.00), exceeding 15.0% threshold

✓ Sandbox destroyed
✓ Verification session complete.
```

</details>

---

### Solari Gotchas Encoded

Following the Cookbook convention, the code handles and documents several key Solari behaviors:
- **`commands.run` is not shell-interpreted:** In-guest HTTP backgrounding requires explicit `sh -c "cd /workspace && nohup python3 -m http.server 3000 >/dev/null 2>&1 &"`.
- **`kill()`, not `close()`, terminates a microVM:** `activeSandbox.kill()` is called unconditionally in `finally` and in `SIGINT`/`SIGTERM` handlers to avoid orphaned VM runtime.
- **Port preview tunnel warm-up:** Uses exponential backoff probes to confirm edge reachability before displaying the dashboard URL.
- **Node.js event loop unbinding:** Explicitly closes browser connection handles to allow clean process termination.

---

### Safety & Boundaries

- **Zero leaked credentials:** API keys and preview URLs with tokens are strictly excluded from git tracking. Placeholder formatting used throughout.
- **No external heavy frameworks:** Zero React, Next.js, Vite, or Tailwind dependencies. Dashboard is pure vanilla HTML/CSS served via Python stdlib inside the guest VM.
- **Cryptographic integrity vs. economic truth:** Explains clearly that SHA-256 fingerprints prove data tamper-evidence across stages, but do not certify third-party portal veracity.

---

### How to Test & Verify

```bash
cd examples/lifeops-task-agent-ts
npm install

# 1. Offline mathematical and boundary unit tests (22 assertions, 0 API credits used)
npm test

# 2. Strict TypeScript typechecking
npm run typecheck

# 3. Live end-to-end execution against Solari API (takes ~25s)
export SOLARI_API_KEY=slr_live_...
LIFEOPS_NON_INTERACTIVE=true LIFEOPS_PREVIEW_TIMEOUT_SEC=5 npm start
```
