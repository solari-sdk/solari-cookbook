# Evidence

Two runs of the same six checks against the same app, one on local Chromium and
one on Solari cloud browsers. Generated with `--proof`, not written by hand:

```bash
npm run demo -- --proof proof/local.json
SOLARI_API_KEY=slr_live_... npm run check -- --backend solari --proof proof/solari.json
```

`local.json` — local Playwright, demo site on `127.0.0.1`.
`solari.json` — six Solari browsers with six server-side profiles, demo site
hosted in a Solari sandbox on its public preview URL (guest Node v18.20.4),
2026-09-08, Starter plan.

Both agree on all six classes: `anon` leaks `tracker`, `free` leaks `export`,
`eu-consent-rejected` leaks both, and the other three pass. That agreement is the point — the sandbox
runs the same `demo-site/site.js` the local run serves, so a divergence would
mean the cloud was checking a different app.

`target` records only the origin. The preview URL's `pt_token` query parameter
is a live credential and is deliberately not committed.
