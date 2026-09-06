# PatchProof Cost Notes

## Billing model

PatchProof creates at most two sequential 1-vCPU/2048-MiB base Solari sandboxes per experiment.
One session if the baseline does not reproduce the bug. Two sessions if the baseline reproduces
and the candidate runs.

Solari bills by requested compute time. PatchProof reports estimated requested-compute cost
using a published rate for informational purposes.

**This is an estimate, not the billed amount.** Actual billing includes startup, idle, and
infrastructure components. Consult your Solari invoice for actual charges.

## Rate reference

At the time of the last measured run:

- Estimated rate: $0.0855/hour (1-vCPU/2048-MiB base sandbox)
- Formula: `estimatedUsd = computeSeconds × rate / 3600`
- Labeled `estimateOnly: true` in all receipts

## Measured live run

Run `cdf077b0-e58f-4a7e-82dd-a1223fbbd5fc` (2026-09-07):

```
Sessions:  2
Compute:   2.3s
Est. cost: $0.0001
Cleanup:   all released
```

## Cost controls

- Candidate is skipped if baseline does not reproduce → at most 1 session for unreproduce bugs
- Each session has a wall deadline (default 120s, maximum 300s)
- Cleanup uses a separate bounded allowance (10s)
- Invalid manifests are rejected before any allocation
- `npm run demo` (simulation) uses zero Solari credits

## Not included in the estimate

- Network transfer
- Startup overhead
- Idle billed time between commands
- Any Solari infrastructure fees beyond compute
