# Static-console threat model

The static console treats public-source responses, imported investigations, screenshots/documents, generated parser logic, and third-party data as untrusted.

Primary threats are cross-site scripting through source-derived content, malicious imported bundles, oversized data intended to exhaust browser resources, browser-storage theft, accidental provider-key persistence, compromised third-party runtime dependencies, service-worker cache poisoning, and execution of source/generated code in the console origin.

Controls in the static console include a restrictive Content Security Policy with no inline script execution, no runtime third-party CDN dependencies, DOM rendering through `textContent`, HTTPS-only direct source URLs, no `eval` or `Function` execution path, bounded import size and collection counts, checksum verification for version-2 portable cases, secret/session scanning on import/export, AES-GCM encrypted bundle support, memory-only key handling, explicit credential clearing, memory-only privacy mode, storage/quota visibility, full local-database/cache purge controls, and offline/online capability reporting.

Generated or otherwise untrusted parser code belongs in Solari Sandbox, not in the browser origin. Source-provided JavaScript is never injected or executed by the console. If future features introduce HTML evidence previews, they must remain escaped or be passed through an audited sanitizer before rendering.

Direct browser calls to Solari are not assumed safe or supported until provider CORS/browser-client behavior is verified. A narrow credential broker can be added later for deployments that should keep provider credentials out of browser JavaScript.
