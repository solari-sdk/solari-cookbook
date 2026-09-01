# Investigation / portable-case workflow

The current implemented case workflow is deliberately local-first and evidence-preserving.

1. Acquire a supported public source into the static workspace or server store.
2. Review normalized event identity, time, location, properties, and evidence/source references.
3. Give the portable investigation a case title; static storage has dedicated stores for case metadata, entities, relationships, evidence, notes, saved views, and related workspace state as those features expand.
4. Export a versioned portable JSON case or an AES-GCM encrypted `.solari-case`.
5. Before export, secret/session pattern scanning blocks suspected credential material.
6. On import, the console validates size/schema, verifies version-2 member checksums, scans for secret/session material, and previews object/source/conflict counts before local mutation.
7. Choose deterministic merge (incoming newer/equal event records win) or isolated read-only open. Read-only mode does not write imported records to the local workspace.
8. Produce CSV, GeoJSON, or GraphML derivatives from the same case state when useful.

The broader backlog adds analyst notes/activity, manual entity and relationship authoring, hypothesis branching, reporting, and richer evidence/artifact packaging. Those capabilities must not be inferred as implemented from the portable-case foundation alone.
