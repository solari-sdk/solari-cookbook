# Submission readiness checklist

Use this checklist before representing the repository as submission-ready. Repository-local deterministic checks may be completed autonomously; provider-credential and platform-specific checks must remain explicitly unverified until exercised in the relevant environment.

## Repository and public-release review
- Confirm the final `develop` head and intended submission ref.
- Run the complete Python and static-console test suites.
- Run the current-tree public-release scanner on the final tree.
- Scan Git history for credentials/secrets and review any findings before publication.
- Review the final tree for unrelated private names, project identifiers, proprietary material, restricted information, and generated runtime artifacts.
- Verify `.gitignore`, example configuration, generated output exclusions, and dependency lock/version policy.

## Reproducibility
- Exercise Linux fresh-install and repeat-update paths.
- Exercise Windows fresh-install and repeat-update paths.
- Exercise macOS fresh-install/repeat-update where a macOS validation environment is available; otherwise document the limitation explicitly.
- Verify missing-credential behavior remains safe and understandable.
- Verify static/no-hosting mode starts with no FastAPI/database process and retains local investigations offline.

## Public-source and Solari demonstrations
- Run representative live public-source smoke tests and retain non-sensitive results/log evidence.
- With evaluator/operator-owned credentials, run the documented Solari Browser integration path and verify resource cleanup.
- Run the Solari Sandbox integration path and verify cleanup plus captured execution diagnostics.
- Run the selected Solari Desktop GUI workflow and verify evidence normalization plus cleanup.
- Verify Browser + Sandbox + Desktop are each used for a concrete requirement rather than merely invoked.

## Product review
- Exercise map, filters, timeline, evidence/provenance, source health, collector execution, graph, case, portable bundle, alert/watchlist, and export workflows.
- Verify imported portable bundles do not overwrite unresolved divergent local records.
- Verify encrypted portable case round trips and secret/session scanning.
- Verify offline reports escape untrusted source text and contain the reproducibility manifest.
- Run accessibility and representative-volume performance passes.
- Capture current screenshots or a short demonstration recording only after the final UI is stable.

## Final evidence
- Record test/CI result for the exact submission commit.
- Record live smoke-test date and source set.
- Record Solari Browser/Sandbox/Desktop live-test evidence without credentials/session material.
- Reconcile `TODO.md`, `meta.md`, `sources.md`, README limitations, and this checklist.
- Do not mark the repository submission-ready while any required live/manual/public-release item above remains unverified.
