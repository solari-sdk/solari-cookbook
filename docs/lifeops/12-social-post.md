# LifeOps — Social Launch Drafts (Solari SWE Challenge)

These launch drafts accompany the open-source submission for the **Solari Software Engineering Challenge**.
Do not claim the PR is merged or announce hiring outcomes. Use the placeholder URLs until the branch and PR are published.

---

## LinkedIn Version

**Headline / Hook:**
A total monthly cloud bill that only went up 8.13% can easily hide a 125% localized cost surge.

Most web automation today stops at data extraction: an AI agent logs into a portal, scrapes the invoice, and spits out a summary. But retrieval alone doesn't guarantee that the calculations are reliable, isolated, or auditable.

For the **Solari SWE Challenge**, I built **LifeOps — Verified Billing Audit Agent**, an end-to-end Cookbook example that establishes a clean architectural trust boundary:

1. **Cloud Browser (@solarisdk/browser)**: Navigates the portal, normalizes itemized billing records, validates arithmetic integrity, and computes a SHA-256 fingerprint of the extracted statement.
2. **Cloud Sandbox (@solarisdk/sdk)**: Ingests the statements into an isolated, ephemeral Linux microVM to execute an independent discrepancy audit against historical baselines.
3. **Port Preview**: Launches a lightweight in-guest HTTP server and exposes a live, interactive HTML verification dashboard directly from the microVM via `sandbox.previewUrl(3000)`.
4. **Guaranteed Teardown**: Automatically destroys the remote microVM after human review or a bounded CI window.

In our deterministic baseline demo, the overall August cloud bill rose by just $26.80 (+8.13%). A standard top-level variance rule (e.g. alert on >10% surge) would have completely ignored it. But by auditing at the line-item level inside the Sandbox, LifeOps immediately flagged a +125% spike in residential proxy burst sessions ($20.00 → $45.00).

The key takeaway: separating untrusted web ingestion from isolated evaluation gives agents verifiable proof of work without compromising security.

Built with pure TypeScript, Python stdlib, zero heavy frontend frameworks, and clean Solari primitives.

Check out the code and PR:
- Cookbook Example: https://github.com/AliRana30/solari-cookbook/tree/feat/lifeops-verified-billing-audit/examples/lifeops-task-agent-ts
- Pull Request: https://github.com/solari-sdk/solari-cookbook/pull/46

cc @Harry Chow @Solari

#AI #SoftwareEngineering #CloudInfrastructure #FinOps #TypeScript #WebAutomation #Solari

---

## X (Twitter) Version

A cloud bill that only rose 8.13% month-over-month can hide a +125% surge on a critical line item.

For the @getsolari SWE challenge, I built **LifeOps**: an outcome-oriented billing audit agent with a strict trust boundary.

The architecture:
1. **Solari Browser** logs in, extracts statement DOM rows, verifies math, & hashes the data.
2. **Solari Sandbox** boots a Linux microVM in ~1s and runs an independent variance audit.
3. **Port Preview** (`previewUrl`) hosts an interactive verification report directly from the microVM.
4. **Teardown** unconditionally destroys the VM on exit.

Why it matters:
An 8.13% total invoice increase escapes typical top-level alerts. But line-item auditing inside the Sandbox immediately flags a localized +125% spike in proxy burst sessions ($20 → $45).

Zero frontend bloat. Pure TypeScript + Python stdlib. Ephemeral infrastructure.

PR: https://github.com/solari-sdk/solari-cookbook/pull/46
Repo: https://github.com/AliRana30/solari-cookbook

cc @harrychow_ @getsolari
