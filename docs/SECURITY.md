# Security and evidence boundaries

Only exact HTTPS www.adafruit.com/product/numeric-ID URLs are accepted live. Requests are restricted to that origin, with off-target navigation, service workers, images, media and fonts blocked. Page JavaScript executes in Solari Browser. Schema.org facts must agree with visible product ID, heading, price and availability; this corroboration is still a supplier claim.

The sandbox receives a fixed Python program and bounded JSON records. No supplied code, shell commands, credentials, local mounts or host environment are transmitted. Decimal processing uses only Python's standard library. Local simulation/replay executes that same trusted repository program with a restricted environment. Treat the repository and selected Python executable as trusted code.

Both cloud stages have a 45-second work deadline and independent 10-second cleanup budget. Browser remote release and sandbox kill are explicit. No workflow allocation retries. Unknown allocation or release outcomes produce CLEANUP_UNCERTAIN, never COMPLETE. A disconnected client cannot guarantee a remote operation stopped; the sandbox additionally requests kill on idle timeout. Browser allocation uncertainty may need operator inspection in the provider account.

Receipts contain selected product fragments, visible facts, internal input, deterministic results and hashes. Hashes detect accidental changes; an editor can forge a fully self-consistent receipt. Verification is replay, not cryptographic source/provider attestation. Reports escape all evidence and prohibit scripts/network access through CSP.

Internal purchasing records can be confidential even without infrastructure identifiers. All runs are ignored. Never publish a real receipt or raw provider error. Credentials belong in environment variables or ignored .env files. Provider IDs, connection endpoints, cookies, full DOM and screenshots are excluded from the evidence model. Public fixtures are synthetic.

V1 does not resolve taxes, shipping, negotiated prices, pack conversions or quantity tiers. No automated purchase or procurement decision is made. UNKNOWN remains uncomparable; duplicate normalized identities remain ambiguous.
