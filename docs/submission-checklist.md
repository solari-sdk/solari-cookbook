# Submission Checklist

This checklist is the final release gate for the public OSINT operations-center showcase. A checked item requires repository or live-run evidence; documentation alone does not prove a runtime claim.

## Repository and governance

- [ ] `develop` has been reviewed and is ready for the intended submission branch.
- [ ] Applicable repository rules and current Prime Prompts checkpoint have been reviewed.
- [ ] Current-tree secret/public-release scan passes.
- [ ] Git-history secret scan passes.
- [ ] Final public-release review finds no private names, unrelated project/company identifiers, credentials, proprietary material, restricted data, or media-monitoring functionality.
- [ ] `meta.md`, `TODO.md`, `sources.md`, README, architecture, security, operations, and known-limitations documentation agree with the final tree.

## Functional demonstration

- [ ] Representative direct public-source collectors complete successfully against live sources.
- [ ] Credential/configuration-gated public sources are either demonstrated with evaluator-owned values or explicitly identified as blocked/not exercised.
- [ ] Solari Browser has a legitimate live public-source workflow and remote resources clean up on success/failure.
- [ ] Solari Sandbox has a legitimate live isolated transformation/enrichment workflow and remote resources clean up on success/failure.
- [ ] Solari Desktop has a legitimate live GUI/screen-driven public workflow and remote resources clean up on success/failure.
- [ ] Browser/Sandbox/Desktop evidence and execution telemetry are visible and human-verifiable.
- [ ] Static/no-hosting console completes its documented direct-CORS workflow with no application backend running.
- [ ] Portable case export/import/integrity/encryption workflow is demonstrated.
- [ ] Server dashboard map, filters, event/evidence inspection, source health, execution/debug surfaces, graph, and exports are demonstrated.

## Quality gates

- [ ] Python test suite passes on the final commit.
- [ ] Static-console Node test suite passes on the final commit.
- [ ] Public-release scanner passes on the final commit.
- [ ] Browser UI smoke/accessibility checks pass in supported browsers.
- [ ] Representative-volume performance check passes or measured limits are documented.
- [ ] Fresh and repeat update paths are tested on Linux and Windows.
- [ ] macOS fresh/repeat update is tested, or the unavailable validation environment is stated explicitly.
- [ ] No stale remote Browser/Sandbox/Desktop resources remain after failure-path tests.

## Reviewer package

- [ ] README quickstart works from a fresh checkout.
- [ ] Static/no-hosting quickstart works from a fresh checkout/download.
- [ ] Checked-in deterministic sample output validates against current contracts.
- [ ] Reviewer walkthrough matches the final feature set and does not claim untested capabilities.
- [ ] Screenshots/GIF/video, if included, reflect the current UI and contain no sensitive data.
- [ ] Known limitations and evaluator-required credentials/configuration are explicit.
- [ ] Final end-to-end demonstration has been run from the exact submission commit.

## Release decision

The project is submission-ready only when every required item above is either checked with evidence or explicitly documented as a non-required limitation accepted for the submission. Do not convert an untested external dependency into a completed claim.
