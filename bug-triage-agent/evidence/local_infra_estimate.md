# What parallel stealth browsing costs without Solari

This is the honest side of the diff — written to actually hold up if
someone pushes back on it, not as a hand-wavy exaggeration.

To run 30-50 concurrent, undetected browser sessions against real sites
without Solari, a realistic local/self-hosted stack needs:

| Piece | Why you need it | Rough effort |
|---|---|---|
| Headless browser orchestration | Playwright/Puppeteer pool management, session lifecycle, cleanup on crash | ~1-2 days |
| Proxy pool + rotation | Residential/datacenter proxy provider integration, rotation logic, dead-proxy detection | ~1 day + ongoing $ cost |
| Fingerprint randomization | User-agent, canvas/WebGL fingerprint, timezone/locale spoofing to avoid detection at scale | ~1-2 days (this is genuinely fiddly, not boilerplate) |
| CAPTCHA handling | Either a solving service integration or accept a nontrivial failure rate | ~0.5-1 day integration + per-solve cost |
| Concurrency/resource management | VM or container sizing, memory limits (headless Chrome is not light), crash recovery | ~1 day |
| Session persistence | Cookie/localStorage handling across runs if any flow needs to stay logged in | ~0.5 day |

**Realistic total: 3-5 focused days for a first working version**, before
accounting for ongoing proxy costs and the maintenance burden every time a
site updates its bot detection.

**With Solari**: `stealth: true`, `proxy: "us"`, `captcha: true` as launch
options, one API key, one credit balance. The 30-line async loop in
`evidence/parallel_scale_demo.py` is the entire orchestration layer.

To be fair to the honest version of this argument: this doesn't mean
Solari eliminates all engineering work — writing good agent logic on top
of the browser is still real work either way. What it eliminates
specifically is the undifferentiated infrastructure grind that has nothing
to do with the actual problem you're solving. That's the real claim, and
it's the one worth making precisely rather than inflating.
