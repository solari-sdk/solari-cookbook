# Prime Prompts compliance review

This document records the repository-specific applicability review for the public Solari OSINT Operations Center. It is an evidence summary, not a certification claim.

## Review marker

- Governing repository: `tocsindata/prime-prompts`
- Prime Prompts revision reviewed: `0c499baad9f2b8dcf42e78deb6086174d000a90f`
- Review date: 2026-09-01
- Repository reviewed: `tocsindata/solari-cookbook`
- Branch reviewed: `develop`
- Review result: **Remediation required** because the repository is not yet represented in the central work-repository registry/TODO mirror and the full Git-history scan is still being validated. These are governance/release-readiness findings, not evidence of a live credential or protected-data exposure.

## Applicable-rules review

| Area | Result | Repository evidence / disposition |
|---|---|---|
| Required root governance files | Meets repository-local requirement | `AAA_READ_ME_FIRST.md`, `meta.md`, `sources.md`, and `TODO.md` exist and define the public project boundary. |
| Root TODO review | Meets repository-local requirement | `TODO.md` preserves product work and tracks unresolved governance, security, live-provider, cross-platform, and release items. Implemented items are checked only when code/tests/docs provide evidence. |
| Central TODO mirror | Remediation required | The repository-local TODO records that the central mirror is pending. This public-repository task has not modified the separate private governance repository. |
| Work-repository registry | Remediation required | The repository is not yet recorded in the central `WORK_REPOSITORIES.md` registry. This remains a cross-repository governance action. |
| Canonical identity / naming | Meets local requirement | Project identity and canonical GitHub repository are explicit in `meta.md`; no production hostname, Slack channel, or alternate project identity is claimed. |
| Slack name/ID and repository-update reporting | N/A currently | No Slack channel is assigned to this project, so no channel ID or Slack reporting evidence is claimed. |
| Solicitation/reference controls | N/A | This is a public engineering challenge/portfolio project, not a solicitation-backed repository. |
| Branch/development rules | Meets local requirement | `main` is primary and `develop` is the active development branch; repository automation and update scripts enforce the development-branch boundary. |
| Single-entrypoint update/bootstrap scripts | Meets implementation requirement; platform verification tracked separately | `update.sh`, `update-macos.sh`, and `update.ps1` validate repository/branch/runtime, install dependencies, run static and Python tests, and report missing evaluator-supplied Solari credentials without inventing them. CI performs fresh/repeat runs on Linux, macOS, and Windows; remaining platform failures stay open until green. |
| Documentation and source provenance | Meets current implementation scope | `sources.md` records public/open source provenance and adapter constraints; `docs/` records architecture, operations, object storage, cases, source policy, and other implemented behavior. |
| Configuration / credential handling | Meets current-tree requirement | Solari and gated-source credentials are user/environment supplied; `.gitignore` excludes runtime/secrets; static mode keeps BYO Solari key material session-local; the current-tree public-release scanner is enforced in CI. |
| Dependency/build governance | Meets current stack requirement | Python dependencies are declared and bounded in `requirements.txt` / `requirements-dev.txt`; runtime checks enforce Python/Node minimums used by update/test flows. |
| Framework/database/transaction rules | Applicable and implemented for current SQLite mode | FastAPI/Pydantic/SQLite boundaries, deterministic writes, persisted audit/history records, schema evolution, and tests are present. Larger optional deployment backends remain TODO items rather than being implied. |
| Cron/batch memory-safety | N/A to current deployment | No production cron deployment is claimed. Collection concurrency, source response sizes, retry behavior, and batch operations are bounded in application logic/tests. |
| Information handling | Meets declared public-only boundary | `meta.md` and `AAA_READ_ME_FIRST.md` prohibit private, proprietary, customer, FCI, CUI, classified, credentialed-private, and personally sensitive datasets. |
| CMMC/NIST/DFARS/FCL/clearance | N/A based on current evidence | No authoritative applicability is identified for this public showcase. The repository makes no certification, assessment-score, clearance, or protected-system claim. |
| System-boundary/provider review | N/A for protected-data compliance; provider behavior still product-tested | The repository is public-only and has no production deployment. Solari and public data providers are treated as external services with credential, egress, rate, and lawful-use boundaries documented in code/docs/TODO. |
| Personnel/privacy references | Meets public-release boundary | Public repository content is kept project-focused and avoids private personnel records or unrelated personal identifiers. |
| Incident-response/reporting | N/A to current protected-data/regulated scope | No regulated incident-reporting obligation is claimed. Security findings are handled as repository remediation without exposing secret values. |
| Public-release restrictions | Applicable and enforced, final review still open | Current-tree scanning, sensitive-filename rules, public-only source boundaries, no-secret rules, and a Git-history scanner are implemented. Final public-release review remains open until the history scan and final content review pass. |
| Security-hygiene audit | Partial / remediation in progress | Current-tree scanning, `.gitignore`, sensitive-file/config/runtime handling, and synthetic scanner fixtures are covered. Git-history scanning is implemented and CI-enforced but remains open until the current validation run is green. |
| Repository visibility | Appropriate for current content boundary | Repository is intentionally public and the project rules prohibit non-public/protected data. |

## Explicitly non-applicable shared controls

There is currently no assigned Slack channel, production hostname, Matomo site, solicitation/reference number, FCI/CUI/classified information, CMMC/NIST assessment boundary, FCL/personnel-clearance requirement, customer environment, or production credential set. Those fields are therefore not fabricated. If project scope changes, applicability must be reviewed again and new unresolved obligations must be added to `TODO.md`.

## Open remediation / completion criteria

The applicable-rules review itself is complete for this revision, but the repository cannot be described as Prime Prompts compliant while governance/release findings remain. The unresolved items are tracked in root `TODO.md`: synchronize the central TODO mirror, register the repository centrally, obtain a clean full Git-history scan, complete final public-release review, and finish any live/manual/provider validations required for submission readiness.

A later material Prime Prompts revision or material change to project information handling, deployment, Slack use, solicitation status, or service-provider boundary requires re-review.
