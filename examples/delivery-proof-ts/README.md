# Delivery proof (TypeScript)

"It runs" is not "it delivered exactly what it declared". `delivery.yaml` is the contract: the
commands you would type to install your software, and what must be true afterwards — a command
exits zero, a file has the right content, a port answers, and a directory tree holds exactly the
declared paths and nothing else.

This runs that contract twice, each time on a new sandbox. The first installer honours it. The
second is the same script with two mistakes a release could make: the config lands under the
wrong name, and a debug copy of the binary ships alongside the real one. The service still comes
up on its default port, so every "does it work" check passes — only the file and tree checks see
what was actually shipped.

The installer is an inline shell script standing in for your own. Swap it and `delivery.yaml` for
your real install commands and contract.

## Run

```bash
cd examples/delivery-proof-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

```
run 1 — the installer that honours the contract  (sandbox ...)
  install — ok
  start — ok
  cli-version (command) — ok: exit 0
  config-file (file) — ok: present, matches
  http-port (port) — ok: http 200
  install-tree (tree) — ok: exactly [bin/widgetd]

run 2 — the build that drifted  (sandbox ...)
  install — ok
  start — ok
  cli-version (command) — ok: exit 0
  config-file (file) — FAILED: missing
  http-port (port) — ok: http 200
  install-tree (tree) — FAILED: undeclared: bin/widgetd.debug

drift caught: the service came up, and the contract still failed on what was shipped
```

Catching the drift is the point, so that run exits 0. It exits 1 only if the honouring installer
fails the contract or the drifted one passes it (a stale fixture). Both sandboxes are killed on
the way out, even on failure.

Source: [`index.ts`](index.ts) · contract: [`delivery.yaml`](delivery.yaml)
