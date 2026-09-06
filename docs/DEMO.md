# PatchProof Demo

## What it demonstrates

PatchProof runs two sequential Solari sandboxes to check whether a candidate fix addresses a reproduced bug. The baseline must fail with the expected error; only then does the candidate run.

## Fixture: cache invalidation bug

The included fixture shows a common bug: a Python `Cache` class that fails to invalidate its in-memory cache when a key is deleted. After deletion, `get()` still returns the stale cached value.

**Baseline** (buggy code):
```python
def delete(self, key):
    self.store.pop(key, None)
    # Bug: cached entry is not removed — stale read returns the old value
```

**Candidate** (fixed code):
```python
def delete(self, key):
    self.store.pop(key, None)
    self.cached.pop(key, None)  # Fix: evict from cache too
```

**Probe**: checks that `cache.get(key)` returns `None` after `cache.delete(key)`.
- Expected failure: exit code 1, output contains `STALE_READ`
- Expected success: exit code 0, output contains `CACHE_OK`

## Run offline simulation (no Solari key)

```bash
npm run demo
```

Output:
```
PatchProof LOCAL SIMULATION: cache-invalidation
  [baseline]  creating
  [baseline]  running (sim-baseline-...)
  [baseline]  released
  [candidate] creating
  [candidate] running (sim-candidate-...)
  [candidate] released

  Verdict:   VERIFIED
  Provider:  LOCAL SIMULATION
```

> ⚠ **LOCAL SIMULATION** — fixtures execute on this computer, without remote isolation; not real Solari evidence.

## Run with real Solari sandboxes

Requires `SOLARI_API_KEY` in your environment or `.env` file.

```bash
# Using .env file
npm run demo:live

# Or export directly
export SOLARI_API_KEY=slr_live_...
node dist/src/cli.js run fixtures/cache-fix.json
```

Output:
```
PatchProof SOLARI: cache-invalidation
  [baseline]  creating
  [baseline]  running (ZGVza3RvcC1wb29s...period.signature)
  [baseline]  released
  [candidate] creating
  [candidate] running (ZGVza3RvcC1wb29s...period.signature2)
  [candidate] released

  Verdict:   VERIFIED
  Provider:  SOLARI
  Sessions:  2
  Compute:   2.3s
  Est. cost: $0.0001
  Cleanup:   all released
```

## Verify an existing receipt

```bash
node dist/src/cli.js verify runs/<uuid>/receipt.json
```

## Unfixed candidate (demonstrates STILL_FAILING)

```bash
node dist/src/cli.js simulate fixtures/cache-unfixed.json
```

Both baseline and candidate run the same probe and fail, resulting in `STILL_FAILING`.

## Verified semantics

`VERIFIED` is returned ONLY when:

1. Baseline fails with the expected exit code AND expected failure witness
2. Candidate runs the **exact same probe** (same argv, same files, verified by SHA-256)
3. Candidate exits 0 AND contains the success witness
4. All evidence is complete and valid (no timeout, truncation, or setup failure)
5. Both sessions are confirmed released (cleanup must succeed)

Everything else is `INCONCLUSIVE`, `NOT_REPRODUCED`, or `STILL_FAILING`.
