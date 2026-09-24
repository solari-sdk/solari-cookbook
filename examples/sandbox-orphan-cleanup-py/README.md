# Orphan cleanup by run id (Python)

Your process dies, and you don't know which sandboxes it left running. The fix is
to decide before the crash: tag every sandbox with a run-scoped `metadata` value
when you create it, then list by that tag and kill only what matches.

The script creates two sandboxes tagged with its run id. It kills the first
normally, and drops its only reference to the second without killing it, which
stands in for a crash. It also creates a control sandbox tagged with a different
run id. The cleanup then works from the run id alone:

- **Positive control:** the control must not appear in the run's listing, and must
  still be running after the cleanup. A cleanup that kills everything fails here.
- **Negative case:** after the cleanup, nothing tagged with the run id may still be
  `starting`, `running` or `paused`.

It also measures how long a new sandbox takes to show up in a filtered list, and
whether killed ones stay listed. On 2026-09-24 both were immediate (0.1 s, and
killed sandboxes dropped out of the list at once); the script measures rather
than assumes, because a cleanup that runs before the list catches up misses things.
The control is killed with `kill()` in `finally`, along with everything else the
script created.

Three sandboxes exist over the run, never more than two at once, so it fits a
two-VM concurrency limit.

## Run

```bash
cd examples/sandbox-orphan-cleanup-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py
```

In PowerShell, use `$env:SOLARI_API_KEY = 'slr_live_...'` instead of `export`.
The script reads the environment variable; it does not load `.env` automatically.
Run without Python's `-O` flag, which disables assertions.

Expected output (live run, 2026-09-24; ids and timings will differ):

```
orphan Av4ozW0uVz… listed under its run id after 0.1 s
killed Av4ozW0uVz… (running)
run 6a26c20be328: 0 alive after 0.1 s (still listed as: none)
control AuACAdHvxp… untouched: running
Control killed; every sandbox this script created is gone.
```

This uses real Solari sandboxes; normal usage charges apply.

## Why it matters

- Metadata is set at create; the SDK (0.2.1) has no call to add it later. A sandbox
  created without the tag can't be found this way.
- A handle can be lost without a crash in your code: in `solari-sandbox` 0.2.2,
  `create_desktop` starts a billable desktop and then raises before returning it
  ([#81](https://github.com/solari-sdk/solari-cookbook/issues/81)). This example
  pins 0.2.1.
- `close()` drops your control channel and leaves the VM running until its idle
  timeout. Use `kill()` (or `client.kill(id)` when you only have the id).

Source: [`main.py`](main.py). The pattern is from
[MisterWanted](https://github.com/MisterWanted)'s orphan recovery in
[#16](https://github.com/solari-sdk/solari-cookbook/pull/16).
