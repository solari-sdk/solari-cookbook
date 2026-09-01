# READ THIS FIRST

This fork is being developed as a public, production-minded OSINT operations-center showcase using Solari browsers, sandboxes, and desktops.

## Before changing anything

1. Read `meta.md`.
2. Read `TODO.md`.
3. Read `sources.md` before adding or changing collectors.
4. Work on `develop` or `develop/*`; do not develop directly on `main`.
5. Preserve the upstream cookbook examples unless a deliberate compatibility change is required.
6. Keep repository output neutral: do not put AI assistant/tool/model names into branch names, commit messages, stored prompts, comments, docs, fixtures, or changelogs.

## Public-repository boundary

This repository is public. Only public/open-source information and generic engineering techniques belong here.

Do not add:
- proprietary code or private operational logic from unrelated systems;
- private source inventories;
- credentials, API keys, tokens, cookies, private keys, or session material;
- customer/client information;
- private personal names or identifying information from unrelated work;
- FCI, CUI, classified, or other restricted information;
- media-monitoring functionality or a clone of an existing media-monitoring product.

## Product rule

This is not intended to be a toy scraper. Build an end-to-end OSINT operations center that demonstrates acquisition, isolation, normalization, enrichment, correlation, evidence/provenance, geospatial analysis, visualization, source health, observability, debugging, replay, export, and API access.

Use Solari capabilities because they solve a concrete problem, not merely to check a feature box:
- Browser for browser-native acquisition.
- Sandbox for isolated execution and transformation.
- Desktop for legitimate GUI/screen-driven workflows.

## Evidence rule

Derived intelligence must remain human-verifiable. Preserve source URL/identifier, acquisition time, collector identity/version, relevant raw evidence, transformation history, and confidence/quality state. Clearly distinguish observed source facts from inference.

## Source rule

Prefer lawful free/open public sources. Every source adapter must document provenance, access method, license/terms considerations when relevant, update cadence, expected schema, failure behavior, rate limits, and health-check strategy in `sources.md` or source-specific documentation.

## Safety and reliability

Treat acquired web content, uploaded documents, generated parsers, and third-party data as untrusted. Avoid executing source-controlled or generated content on the host when it belongs in a sandbox. Bound retries and concurrency. Do not hide collector failures. Make ingestion idempotent and deduplicate deterministically where possible.

## Update workflow

Normal setup/update must use one root command per host:
- Linux: `./update.sh`
- macOS: `./update-macos.sh`
- Windows: `.\update.ps1`

If routine setup requires undocumented manual commands, improve the updater instead of institutionalizing the workaround.

## Definition of submission-ready

Do not claim the project is ready to submit until:
- representative collectors work end-to-end against real public sources;
- Browser + Sandbox + Desktop each have a legitimate tested workflow;
- dashboard maps/filters/timelines/evidence/debug/health surfaces work;
- tests pass;
- fresh-install and repeat-update paths pass on supported hosts or limitations are explicitly documented;
- secret/current-tree/history checks have been performed;
- public-release review finds no private names, proprietary references, credentials, or restricted material;
- documentation explains architecture, setup, sources, evidence model, operations, and limitations;
- a reviewer can understand the value proposition quickly and reproduce the demo.
