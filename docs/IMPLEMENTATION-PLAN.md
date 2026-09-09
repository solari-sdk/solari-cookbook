# ProcureLens implementation plan

Branch: feat/procure-lens, based on origin/main 46709a1. PatchProof branch must remain unchanged. Destination: the user's fork only; no upstream PR.

- [x] Verify repository, upstream examples and current SDK/source contract.
- [x] Specify one-page procurement workflow, explicit scope, unknown-field policy and evidence model.
- [x] Public-seam TDD: fixed processor normalization, exact/normalized matching, collisions, field classes, missing records and before/after comparison.
- [x] Acquisition slice: raw structured source/visible text agreement, provenance, malformed/partial source and supported URL validation.
- [x] Integration slice: bounded browser navigation/release and sandbox execution/kill with official SDK types; no paid tests.
- [x] Workflow/report slice: exclusive outputs, safe failure states, strict receipt replay verification, HTML evidence cards and CLI.
- [x] Hostile review: correctness/product/security/reliability/hiring; regression tests for findings; remove unjustified complexity.
- [x] Run npm test, npm run typecheck, npm run build, npm run demo. One real workflow if key available; preserve honest result and sanitize all public evidence.
- [x] Update product/demo/cost/security/submission/launch docs to actual behavior. Inspect unstaged/staged diff and secret exclusions; meaningful commits, push origin feat/procure-lens and verify tip.

Implementation uses the supplied autonomous execution authorization rather than repeated design approvals. Test seams: processor JSON protocol, acquisition conversion, provider lifecycle, run replay, and CLI files. Work in vertical slices: observe a failing regression, implement minimum correction, rerun focused tests. Full offline checks are the gate before the one deliberate live workflow.

Live result: FAILED_ACQUISITION, browser released, sandbox not started. Successful live end-to-end validation remains pending; see VALIDATION.md. No retry permitted by this run's one-attempt limit.
