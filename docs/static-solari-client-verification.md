# Static Solari client support verification

Verification date: 2026-09-02 UTC

## Conclusion

Direct provider orchestration from the browser-only static console is **not enabled** with the currently documented Solari SDK interfaces. The safe supported design remains:

1. static console for local analyst state and CORS-capable public-source acquisition;
2. optional narrow credential broker/server delegation for provider operations; and
3. no long-lived provider credential embedded in static JavaScript or persisted browser storage.

This is a verified compatibility/security decision rather than an unimplemented promise.

## Evidence reviewed

The current official Solari cookbook TypeScript Browser example is an executable Node/`tsx` program. It reads `SOLARI_API_KEY` from `process.env`, returns a Playwright browser, and explicitly requires `solari.close()` because the client keeps a **Node-side loopback proxy server** open. The public Rust Browser SDK independently documents that the reference TypeScript SDK proxies browser endpoints through a Node-side loopback `LocalProxy`.

The current official Sandbox TypeScript example likewise reads `SOLARI_API_KEY` from `process.env` and opens a remote control channel. The current Desktop cookbook example is Python and reads the provider key from the process environment. The public cookbook does not publish a browser-script example or a browser-safe credential flow for these products.

## Security consequence

Even if individual REST endpoints happened to allow cross-origin browser requests, placing a live provider key in a public/static JavaScript execution context would expose that credential to the page origin and browser extensions. The project therefore does not infer browser support from generic HTTP reachability.

Direct static Browser, Sandbox and Desktop orchestration are consequently treated as **not applicable under the currently documented provider client/security model**. They should be reconsidered only if Solari publishes a browser-targeted credential model (for example short-lived scoped tokens) and explicit browser/CORS support that does not require exposing a durable provider key.

## Current static-mode behavior

The static console keeps its optional evaluator key field in page memory only and never claims direct provider execution. CORS-restricted public-source fetches and provider operations can use the repository's optional narrow broker pattern, whose allowlists and credential injection occur outside the static page.
