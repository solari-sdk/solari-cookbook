# Snapshot, fork, verify (Python)

Write a seed file, snapshot its sandbox, destroy the base, and create three
independent clones. Read each clone's file through the filesystem API and assert
its SHA-256 matches the seeded bytes. Mutate each worker afterward: the next clone
must still restore the original seed.

Clones run sequentially to fit a one-VM concurrency limit. Cleanup is registered
as soon as each resource is created and is attempted even if verification fails.
Snapshots persist after a VM is killed, so they are explicitly deleted too.

## Run

```bash
cd examples/sandbox-snapshot-fork-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py
```

In PowerShell, use `$env:SOLARI_API_KEY = 'slr_live_...'` instead of `export`.
The script reads the environment variable; it does not load `.env` automatically.
Run without Python's `-O` flag, which disables assertions.

Expected output: three matching digests, followed by confirmation of cleanup.
This uses real Solari sandboxes and a persistent snapshot; normal usage charges apply.

Source: [`main.py`](main.py). Extracted from
[Worldline](../../applications/worldline) by
[YesterdaysLemon](https://github.com/YesterdaysLemon).
