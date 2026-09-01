# Competitive feature research notes

These references are used only to identify public feature categories and interoperability expectations. No source code or proprietary implementation detail is copied into this project.

## OpenCTI

Reference: https://github.com/OpenCTI-Platform/opencti

Relevant public feature categories: persistent entities/relationships, graph-oriented exploration, case/investigation context, connectors, confidence/provenance concepts, and structured intelligence interchange. For this project, those categories motivated a typed entity/relationship model, bounded graph neighborhood/path queries, explicit observed-versus-derived state, and future interoperability work.

## IntelOwl

Reference: https://github.com/intelowlproject/IntelOwl

Relevant public feature categories: reusable analyzers/connectors, orchestrated enrichment, observable processing, job execution state, and modular integrations. The local response is a small plugin manifest/registry, explicit capability discovery, bounded resource settings, and sandbox-only execution for untrusted/generated analyzer code.

## SpiderFoot

Reference: https://github.com/smicallef/spiderfoot

Relevant public feature categories: modular public-source collection, pivots between observables, scan-style workflows, and broad enrichment. This project keeps those ideas separated from situational events by reserving an observable/enrichment layer and emphasizes lawful free/public sources, provenance, and bounded execution.

## MISP warning lists

Reference: https://github.com/MISP/misp-warninglists

Relevant public feature category: known-benign/contextual values that reduce false positives. This project independently implements a generic warning-list matcher supporting exact, substring, hostname, CIDR, and regular-expression rules without importing external list content into the repository.

## Design conclusions

The recurring gaps across mature tools are not merely more collectors. High-value capabilities are: reproducible investigations, explicit evidence/provenance, graph pivots, modular analyzers, false-positive controls, portable exports, job observability, and analyst-controlled review boundaries. The Solari showcase therefore prioritizes those architectural surfaces while retaining a static/no-hosting mode that is intentionally uncommon in server-centric platforms.
