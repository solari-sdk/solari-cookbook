# Interoperability and client-boundary evaluations

This document records evaluated options so the backlog can distinguish an explicit architectural decision from unexamined work. It does not claim an integration that is not implemented.

## GraphQL

The current client needs are bounded event filters, cursor pagination, entity/relationship listings, graph neighborhood/path/component queries, and portable-case export. REST/OpenAPI already expresses those operations with explicit limits and predictable observability. GraphQL would add a second query surface, authorization/rate-limit complexity, query-cost controls, and another schema lifecycle without solving a current demonstrated requirement.

**Decision:** do not add GraphQL now. Re-evaluate only if a real client requires compound graph/event queries that produce material round-trip or maintainability problems with the current bounded REST API. If introduced later, depth/cost limits and field-level authorization must be part of the first implementation.

## MISP compatibility

MISP interoperability is relevant to cyber observables such as domains, IPs, URLs, hashes, and related indicators. The current showcase is primarily public situational-event data and intentionally does not pretend an earthquake/weather event is a MISP indicator.

**Decision:** defer MISP import/export until the separate observable/enrichment model is implemented. At that point, map only semantically compatible cyber observables and preserve original MISP identifiers, timestamps, tags, confidence/context, and provenance. Do not map unrelated situational events merely to claim compatibility.

## STIX 2.x

STIX is potentially appropriate for a future cyber-observable/relationship layer, but the current event schema is not automatically equivalent to STIX cyber objects. Implementation remains open until a concrete semantic mapping and round-trip fixture are defined.

## Optional encrypted browser persistence of a Solari key

Persisting an encrypted API key in IndexedDB would improve convenience but not remove the core browser-origin threat: an XSS-capable attacker running in the origin while the key is unlocked could still invoke provider APIs or access plaintext after decryption. A passphrase also creates a second credential lifecycle that the no-hosting demo does not need.

**Decision:** keep provider keys memory-only by default and do not implement persistent browser key storage at this stage. If a future requirement demands persistence, prefer an OS-backed credential store through an optional desktop wrapper or a narrow server-side broker before adding browser persistence. Any browser persistence must be explicit opt-in, use Web Crypto with a user secret, and display the residual XSS/origin-compromise risk.
