# LifeOps — Verified Billing Audit Agent

> Give an AI agent the task, not the website.

This example demonstrates an outcome-oriented billing audit workflow where **Solari Cloud Browser** retrieves billing data from a portal, **Solari Sandbox** independently evaluates it inside an isolated microVM, and **Solari Port Preview** serves an inspectable verification dashboard over a secure public tunnel.

---

## Why this exists

Organizations increasingly have billing data distributed across cloud providers, SaaS subscriptions, infrastructure dashboards, and third-party portals.

An AI agent can automate the retrieval of that data. However, retrieval alone does not establish that the resulting calculation or decision has been independently checked. Executing complex audit logic in the same process that browses untrusted web content blurs security boundaries and makes results difficult to audit.

LifeOps demonstrates a clear trust boundary:

**Browser gets the data → Sandbox independently evaluates it → Preview exposes the evidence.**

---

## What it does

The included demo executes a complete 3-stage billing audit:

1. **Launches a Solari Cloud Browser** and navigates to the billing portal.
2. **Extracts five billing line items** directly from the page DOM.
3. **Normalizes and validates arithmetic integrity** (ensuring item sums match the declared statement total).
4. **Generates a SHA-256 integrity fingerprint** of the normalized statement.
5. **Releases the browser session** immediately after acquisition.
6. **Boots an isolated Solari Sandbox microVM** (`template: "base"`).
7. **Transfers current and historical baseline statements** into `/workspace`.
8. **Executes the discrepancy audit** inside the microVM using Python standard library tooling.
9. **Detects billing changes** exceeding the configured variance threshold (e.g. `> 15%`).
10. **Generates a cryptographic audit fingerprint** binding the computation results.
11. **Generates a standalone HTML verification dashboard** from the audit artifacts.
12. **Starts a minimal in-guest HTTP server** inside the Sandbox.
13. **Exposes the dashboard** via `sandbox.previewUrl(3000)`.
14. **Pauses for human review** of the live evidence dashboard.
15. **Cleanly destroys the Sandbox microVM** via `sandbox.kill()` on exit.

> **Note:** The default demo runs against a self-contained, deterministic synthetic billing statement. It requires **no external billing credentials** or private financial accounts.

---

## Architecture

```text
┌───────────────────────────────┐
│        User Task              │
│ monthly-cloud-billing-audit   │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│     Solari Cloud Browser      │
│                               │
│  Retrieve + normalize billing │
└──────────────┬────────────────┘
               │
               │ Statement + hash
               ▼
┌───────────────────────────────┐
│       Solari Sandbox          │
│        isolated microVM       │
│                               │
│ Current + baseline → audit    │
└──────────────┬────────────────┘
               │
               │ AuditResult
               ▼
┌───────────────────────────────┐
│ Verification Dashboard        │
│                               │
│ HTML → Python HTTP server     │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│   Solari Port Preview         │
│   *.preview.getsolari.com     │
└───────────────────────────────┘
```

---

## Solari primitives used

| Primitive | Purpose |
| --- | --- |
| **Cloud Browser** | Retrieve and normalize the billing statement |
| **Sandbox** | Independently validate and audit untrusted data in microVM isolation |
| **Sandbox Files** | Ingest statement artifacts and write the verification dashboard |
| **Sandbox Commands** | Execute the isolated Python audit and background HTTP server |
| **Port Preview** | Expose the in-guest verification dashboard on a public HTTPS URL |
| **`kill()`** | Terminate the remote microVM and release cloud resources |

---

## Installation and setup

```bash
cd examples/lifeops-task-agent-ts
npm install
cp .env.example .env
```

Configure your Solari API key in `.env`:

```bash
SOLARI_API_KEY=slr_live_...   # Get yours at https://console.getsolari.com
```

The default demo mode uses a synthetic billing fixture embedded in the code, so **no real billing credentials or accounts are required**.

---

## Configuration

Supported environment variables:

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `SOLARI_API_KEY` | string | *required* | Solari API authentication key (`slr_live_...`) |
| `PORTAL_URL` | string | *unset* | Optional URL of a custom billing portal. If unset, uses synthetic demo portal |
| `SOLARI_STEALTH` | boolean | `false` | Enables residential proxy egress and bot-detection countermeasures |
| `LIFEOPS_NON_INTERACTIVE` | boolean | `false` | When `true` (or `CI=true`), bypasses interactive terminal prompt and exits after preview timeout |
| `LIFEOPS_PREVIEW_TIMEOUT_SEC`| number | `10` | Seconds to keep the preview server live before automated cleanup in non-interactive mode |
| `PORT` | number | `3000` | Port inside the Sandbox used to serve the verification dashboard |

The discrepancy variance threshold is configured in `getDefaultTaskConfig()` (default: `15.0%`).

---

## Running the example

### Run the full pipeline

```bash
npm start
```

Runs the live end-to-end flow: Cloud Browser extraction → Sandbox discrepancy audit → Port Preview dashboard → Interactive pause → Sandbox teardown.

### Run offline validation tests

```bash
npm test
```

Runs the complete offline test suite (22 unit assertions verifying currency normalization, discrepancy mathematics, boundary checks, and dashboard HTML generation with XSS escaping). Consumes zero Solari API credits.

### Check types

```bash
npm run typecheck
```

---

## Deterministic demo scenario

The synthetic demo compares an August 2026 statement against a July 2026 baseline:

* **Current billing (August 2026):** `$356.60`
* **Baseline billing (July 2026):** `$329.80`
* **Net variance:** `+$26.80 (+8.13%)`
* **Configured threshold:** `15.00%`

### Flagged anomaly

| Item ID | Description | Baseline | Current | Change | Reason |
| --- | --- | --- | --- | --- | --- |
| `item_browser_04` | Stealth Residential Proxy Sessions (Burst) | `$20.00` | `$45.00` | **+125.00%** | Cost increased by 125.00% (exceeding 15.0% threshold) |

**Why this matters:** The aggregate monthly invoice only rose by **+8.13%**, well below a standard 10% or 15% aggregate alert threshold. However, the audit operates at the **line-item level**, instantly catching the **+125% localized cost surge** in proxy burst sessions that would otherwise be masked by larger line items.

---

## Verification model

LifeOps establishes an explicit provenance chain across execution stages:

* **Source Data:** The raw HTML rendered by the third-party billing portal.
* **Statement Fingerprint (`statementHash`):** Deterministic SHA-256 hash computed over normalized line items and statement metadata.
* **Isolated Audit:** An independent calculation running in an isolated microVM.
* **Audit Fingerprint (`auditHash`):** SHA-256 hash computed over the structured `AuditResult`.
* **Verification Manifest:** A machine-readable attestation binding task ID, session references, timestamps, and hashes.

> **Cryptographic Integrity Notice:** The SHA-256 fingerprint makes changes to the represented data detectable across pipeline stages. It does not prove that the originating billing provider's data is economically correct.

---

## Why use a Sandbox?

Web browsers interact with external, dynamic, and potentially untrusted web content.

If an agent parses invoice files, runs financial algorithms, or executes macros in the same local environment where it browses the web, it creates an attack vector for prompt injection, malicious file downloads, or execution errors.

LifeOps separates **retrieval** from **evaluation**:
1. The **Cloud Browser** is restricted to navigation and structured data extraction.
2. The **Sandbox** receives extracted data purely as passive JSON artifacts and executes the analysis inside a fresh, ephemeral Linux microVM.

This architectural separation creates a strict trust boundary between external web ingestion and core business logic.

---

## Verification dashboard

The dashboard is generated dynamically and served directly from inside the Sandbox microVM:

* **Zero Frameworks:** Written in clean, responsive HTML and CSS with dark-mode styling. Requires no React, Next.js, Vite, or external CDN dependencies.
* **Genuine Port Preview:** The public HTTPS URL is provisioned via the real Solari SDK call `await sandbox.previewUrl(3000)`. It is never assumed or fabricated manually.
* **Reachability Probing:** The agent verifies that the edge preview tunnel is active and returning `HTTP 200` before displaying the link.
* **Interactive Review:** In interactive mode, the agent keeps the microVM alive and waits for the reviewer (`Press Enter after reviewing the report...`) before destroying the environment.

---

## Example output

```text
=========================================================
LIFEOPS — VERIFIED BILLING AUDIT
================================

Task: monthly-cloud-billing-audit
Threshold: 15%

--- Stage 1: Cloud Browser ---
✓ Billing statement acquired
✓ 5 line items normalized
✓ Arithmetic integrity validated
✓ Statement fingerprint generated
✓ Browser session released

--- Stage 2: Isolated Sandbox Audit ---
✓ Sandbox provisioned
✓ Current + baseline statements transferred
✓ Audit executed inside isolated microVM
✓ 1 anomaly detected
✓ Audit fingerprint generated
✓ Audit artifacts validated

--- Stage 3: Verification Dashboard ---
✓ Dashboard generated
✓ HTTP server started
✓ Solari port preview created

Verification Dashboard: https://<sandbox-id>-3000.preview.getsolari.com?token=...

Status: ANOMALIES_FLAGGED
Net variance: +$26.80 (+8.13%)
Anomalies: 1

  ⚠ [item_browser_04] Stealth Residential Proxy Sessions (Burst)
    $20.00 → $45.00 (+125.00%) [Threshold: 15%]
    Reason: Cost increased by 125.00% (from $20.00 to $45.00), exceeding 15.0% threshold

Open the dashboard to review the evidence.
Press Enter after reviewing the report...

✓ Sandbox destroyed
✓ Verification session complete.
```

---

## Source

* Pipeline orchestrator: [`index.ts`](index.ts)
* Cloud browser extraction: [`browser.ts`](browser.ts)
* Isolated sandbox audit: [`sandbox.ts`](sandbox.ts)
* Dynamic verification dashboard: [`dashboard.ts`](dashboard.ts)
* Offline validation tests: [`test_validation.ts`](test_validation.ts)
