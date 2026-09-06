# PatchProof Implementation Plan

Goal: a bounded two-revision regression experiment with honest evidence and a reproducible CLI.
Spec: [PRODUCT.md](PRODUCT.md). Architecture: [ARCHITECTURE.md](ARCHITECTURE.md).
Stack: Node 24+, strict TypeScript, Node test runner, Python 3 standard library in the guest, official sandbox SDK 0.1.3.

The supplied mission authorizes design decisions and continued implementation. Use focused TDD at public seams and independent review; no repeated approval gates. This is a fresh dedicated checkout on `feat/solari-product`, preserving upstream history. Existing cookbook examples remain intact.

## Execution checklist

- [x] Inspect upstream examples, configuration, history, APIs, local skill provenance, and published SDK source.
- [x] Compare candidate products, eliminate free-tier-infeasible paths, select and specify PatchProof.
- [x] Domain slice: add a failing public validation/oracle test, run it, implement manifest/result validation and verdict rules, then expand boundary tests. Known oracle: baseline exit 1 + `STALE_READ`, candidate exit 0 + `CACHE_OK` verifies; a missing witness or failed setup cannot.
- [x] Guest slice: implement and test the fixed Python runner through its JSON-in/JSON-out process interface. Prove fixture bug/fix, wrong revision, setup failure, timeout, bounded output, path safety, and same probe content. Do not execute contributor code locally.
- [x] Orchestration slice: test `runExperiment(manifest, provider, options)` through fake external sessions. Prove sequential allocation, baseline gate, deadlines, partial failures, cancellation, and release failure. Persist journal and receipt through public CLI outputs.
- [x] SDK slice: inspect installed types; compile real create/commands/kill calls. Test adapter with SDK HTTP injection, including create timeout, credentials isolation, retry behavior, malformed output, and explicit cleanup. No paid integration during development.
- [x] CLI slice: `plan`, `run`, `simulate`, `verify`, `cleanup`; dependency-free good/bad fixtures; escaped report; exclusive run directories and incremental journal. Prove separate labels for simulation and Solari.
- [x] Hardening: hostile correctness/security/product/simplicity review, fix high-confidence findings (session ID opaque validation, Windows platform compatibility), run full tests/typecheck/build/package validation.
- [x] Submission: short README, cost/security/failure/demo docs, upstream attribution, contribution and security policy, narrative and draft launch post. Capture actual local proof; attempt one two-lane real demo if a key is configured.
- [x] Final report: state tests and evidence exactly, explain any unavailable real integration/publication, and leave reproducible steps.

## Final state

- **Node tests**: 52/52 pass (`npm test`)
- **Guest tests**: 13 pass, 1 Linux-only skip (`npm run test:guest`)
- **Typecheck**: clean (`npm run typecheck`)
- **Build**: clean (`npm run build`)
- **Demo (simulation)**: VERIFIED (`npm run demo`)
- **Live Solari**: VERIFIED — two real sandboxes created and released, receipt integrity confirmed
- **Session ID regression**: opaque IDs with periods (`.`) now accepted, regression test added

## Verification commands

`npm test` exercises public TypeScript seams, guest fixtures through a test-only local process harness when Python is available, and CLI receipt output. `npm run typecheck` checks strict source and tests; `npm run build` emits a runnable ESM CLI. `npm run demo` runs an explicitly simulated baseline/candidate workflow with zero credits. `npm run demo:live` is the intentional real Solari run and requires a configured key. Use `node dist/src/cli.js verify <receipt>` to independently recompute input and receipt integrity plus verdict.

Stop condition: all offline acceptance checks pass, no unresolved high-confidence security/correctness findings, and every external claim is either backed by actual evidence or marked pending. Missing credentials block only the live proof/publication, not implementation.
