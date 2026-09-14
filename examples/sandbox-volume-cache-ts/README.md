# A dependency cache that outlives the sandbox (TypeScript)

Sandboxes are ephemeral, so every run re-downloads the same packages. A volume
is not: you create it separately, mount it at `sandboxes.create()`, and it
survives the sandbox being destroyed. Run this twice and the second install
starts from a cache the first one left behind.

One trap decides the design. Volumes are s3fs, and **s3fs does not support
hardlinks**:

```
npm ERR! code ENOTSUP
npm ERR! syscall link
npm ERR! path /root/.npm/_cacache/tmp/...
```

npm's cacache finalises every download by `link()`-ing a temp file into
content-addressed storage, so mounting the volume directly at `~/.npm` fails on
the very first package. pnpm's store and `git clone --local` need hardlinks
too. So the cache stays on local disk and the volume holds an archive of it:
restore on the way in, re-archive on the way out.

Measured across two days. Every run installed the same 329 packages:

| run | date | restore | install | total |
| --- | --- | --- | --- | --- |
| no volume | 2026-09-08 | — | 13679ms | 13679ms |
| no volume | 2026-09-09 | — | 13884ms | 13884ms |
| volume, cold | 2026-09-08 | 317ms | 14514ms | 14831ms |
| volume, warm | 2026-09-08 | 1014ms | 7568ms | **8582ms** |
| volume, warm | 2026-09-09 | 1044ms | 10532ms | **11576ms** |

**Between 17% and 37% faster warm**, restore included — 37% on 2026-09-08,
17% when the same cache was reused a day later. The cold run is slower than
using no volume at all, which is the honest shape of any cache: you pay once to
fill it, and win on every run after.

The spread is worth stating plainly. The no-volume baseline is stable across
days (13679ms and 13884ms, 1.5% apart), so the variance is not the harness — it
is the warm install itself (7568ms and 10532ms). Within a single day the warm
figure reproduced to within 8ms across two separate sandboxes (8590ms and
8582ms), so the cache is really doing the work; across days, how much it saves
depends on registry conditions for whatever the cache does not cover. Expect
the direction to hold and the magnitude to move.

The 2026-09-09 warm run also reused a volume created the previous day, which is
the persistence claim tested the only way that counts: a cache filled by a
sandbox that no longer exists.

The example prints the package count next to the timing on purpose. An install
that fails installs nothing very quickly, and that is exactly what a broken
cache looks like if you only measure seconds.

## Run

```bash
cd examples/sandbox-volume-cache-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start                            # cold
npm start                            # warm
```

The volume is left in place between runs, because that is the point. Delete it
with `pt.volumes.delete(id)` when you stop wanting to pay for it.

Source: [`index.ts`](index.ts)
