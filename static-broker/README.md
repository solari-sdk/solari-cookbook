# Optional Static Credential Broker

The static analyst console is designed to work without an application server. This directory contains an optional, deliberately narrow edge-worker reference for the two cases where browser JavaScript should not perform a request directly:

1. a public source does not permit browser-side CORS; or
2. an operator wants a provider credential to remain in an edge secret rather than in browser memory.

The broker is **not** a replacement application backend. It has no database, case storage, analyst state, queue, scheduler, user directory, or arbitrary proxy endpoint.

## Operations

`public-source-fetch` accepts a source ID and public HTTPS URL. The worker only fetches sources in its hard-coded source/hostname allowlist. The initial allowlist contains the same USGS earthquake source supported by the static console. Redirects are rejected if they leave the allowlisted HTTPS host.

`delegate` forwards a JSON POST to a relative path beneath one operator-configured HTTPS origin. The provider authorization value is injected from an edge secret and is never returned to the browser. Absolute URLs, cross-origin redirects, path traversal, embedded credentials, oversized requests, and oversized responses are rejected.

## Required deployment configuration

Set these as deployment environment values/secrets; do not commit them:

- `ALLOWED_ORIGIN`: exact origin allowed to call this worker, for example the deployed static-console origin.
- `DELEGATE_BASE_URL`: optional HTTPS provider base origin for credential delegation.
- `DELEGATE_AUTHORIZATION`: optional authorization header value stored as an edge secret.

The static console does not hard-code a broker address. An evaluator/operator enters the broker endpoint at runtime. Direct public-source requests remain the default; the configured broker is used as a fallback when the browser request cannot be completed.

## Security boundary

This reference intentionally does not expose a generic URL fetcher. Add a public source only by extending `PUBLIC_SOURCE_HOSTS` with an exact source ID and hostname after reviewing that source's access and redistribution terms. Do not turn the broker into an open proxy.

Provider-specific delegation should remain path-bounded to the configured provider origin. If a provider needs a different authentication scheme, create a small explicit provider adapter rather than accepting arbitrary browser-supplied headers or credentials.

The worker is compatible with edge runtimes that implement the standard `fetch`, `Request`, `Response`, `URL`, `TextEncoder`, and `TextDecoder` APIs; the checked-in example uses the module-worker export shape commonly supported by edge platforms. Deployment is optional and is not required for the no-hosting console's direct-CORS sources.
