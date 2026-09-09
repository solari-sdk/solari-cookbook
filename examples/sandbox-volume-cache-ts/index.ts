/**
 * A dependency cache that outlives the sandbox.
 *
 * Sandboxes are ephemeral, so every run re-downloads the same packages. A
 * volume is not: it is created independently, mounted at start, and survives
 * the sandbox being destroyed. Point one at your package cache and the second
 * run starts warm.
 *
 * One trap decides the whole design. Volumes are s3fs, and s3fs does not
 * support hardlinks:
 *
 *   npm ERR! code ENOTSUP
 *   npm ERR! syscall link
 *   npm ERR! path /root/.npm/_cacache/tmp/...
 *
 * npm's cacache finalises every download by link()-ing a temp file into
 * content-addressed storage, so mounting the volume AT ~/.npm fails on the
 * first package. pnpm's store and `git clone --local` rely on hardlinks too.
 *
 * So the cache stays on local disk and the volume stores an archive of it:
 * restore on the way in, re-archive on the way out. Measured 2026-09-08/09 on 329
 * packages: ~13.8s with no volume, 8.6s-11.6s warm including the restore --
 * between 37% and 17% faster depending on the day. See the README for the
 * full table and why the magnitude moves.
 */
import { SolariClient } from "@solarisdk/sdk"

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
const PACKAGES = "express typescript eslint webpack jest react react-dom axios lodash zod"
const VOLUME_NAME = "npm-cache-demo"
const MOUNT = "/mnt/cache"

// Reuse the volume across runs; that persistence is the entire point.
const existing = (await pt.volumes.list()).find((v) => v.name === VOLUME_NAME)
const volume = existing ?? (await pt.volumes.create({ name: VOLUME_NAME, sizeMb: 4096 }))
console.log(existing ? `reusing volume ${volume.volumeId}` : `created volume ${volume.volumeId}`)

const sandbox = await pt.sandboxes.create({
  template: "base",
  timeoutMs: 10 * 60_000,
  volumes: [{ volumeId: volume.volumeId, path: MOUNT }],
})

try {
  await sandbox.connect()
  const sh = async (script: string) => {
    const r = await sandbox.commands.run("sh", { args: ["-c", script] })
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout || "").slice(0, 300)}`)
    return (r.stdout ?? "").trim()
  }

  const t0 = Date.now()
  const restored = await sh(
    `mkdir -p /root/.npm && if [ -f ${MOUNT}/npm.tar ]; then tar xf ${MOUNT}/npm.tar -C /root/.npm && echo warm; else echo cold; fi`,
  )
  const restoreMs = Date.now() - t0

  const t1 = Date.now()
  // Report the package count, not just the timing. A run that installs nothing
  // is extremely fast, and that is exactly how a broken cache looks like a win.
  const installed = await sh(
    `mkdir -p /tmp/proj && cd /tmp/proj && npm init -y >/dev/null 2>&1 &&` +
      ` npm install --no-audit --no-fund ${PACKAGES} >/tmp/npm.log 2>&1 &&` +
      ` ls node_modules | wc -l`,
  )
  const installMs = Date.now() - t1

  const t2 = Date.now()
  await sh(`tar cf ${MOUNT}/npm.tar -C /root/.npm .`)
  const saveMs = Date.now() - t2

  console.log(`start:   ${restored}`)
  console.log(`restore: ${restoreMs}ms`)
  console.log(`install: ${installMs}ms for ${installed} packages`)
  console.log(`save:    ${saveMs}ms`)
  console.log(
    restored === "cold"
      ? `\nRun it again: the cache is on the volume now, and the install should drop by about a third.`
      : `\nThat install reused a cache a previous sandbox left behind.`,
  )
} finally {
  await sandbox.kill()
  // The volume deliberately outlives the sandbox. Delete it with
  // `pt.volumes.delete(volume.volumeId)` when you are done paying for it.
}
