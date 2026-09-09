# ProcureLens demo

Install Node 24+ and Python 3.10+, then run `npm ci` from the repository root. If Python is not on PATH, set `PROCURELENS_PYTHON` to its executable. `npm run demo` runs a synthetic reconciliation, prints SIMULATION REVIEW_REQUIRED and an output directory. Open report.html in that directory. All generated output is ignored by Git.

For individual commands, first `cd examples/procurelens`:

```sh
node src/cli.ts plan fixtures/live-internal.json https://www.adafruit.com/product/385
node src/cli.ts simulate fixtures/internal.json fixtures/source-a.json
node src/cli.ts simulate fixtures/internal.json fixtures/source-b.json
node src/cli.ts verify runs/<first-directory>/run.json
node src/cli.ts report runs/<first-directory>/run.json
node src/cli.ts compare runs/<first-directory>/run.json runs/<second-directory>/run.json
```

Use the UUID directories printed by each simulation. The second synthetic observation changes ACME-104 from 129 to 139: +10, +7.75%. Cards also demonstrate exact and normalized matching, unknown values, stock and availability differences, duplicates and missing counterparts. A missing supplier row means absent from this acquired scope, not absent from the supplier catalog.

`verify` validates receipt integrity and repeats deterministic processing. It does not attest that a receipt came from Solari or authenticate supplier facts. `report` first verifies then writes a fresh report directory. `compare` requires two successful, chronologically ordered observations of the same source, adapter and mode. Comparison bundles also support `verify` and `report`: both embedded runs and their comparison are replayed.

For a deliberate paid workflow, set SOLARI_API_KEY securely in the environment, then:

```sh
node src/cli.ts run fixtures/live-internal.json https://www.adafruit.com/product/385
```

The live internal fixture is synthetic purchasing data, not an actual company's records. The supplier capture is real only when this command successfully acquires it. Never commit live output. REVIEW_REQUIRED is a completed comparison with discrepancies; failed acquisition/processing and uncertain cleanup exit 2. Supplier markup changes may cause an honest acquisition failure.

Development checks from the root: `npm test`, `npm run typecheck`, `npm run build`, `npm run demo`. Compiled CLI from the example directory: `node build/src/cli.js ...`; keep processor.py alongside the package.
