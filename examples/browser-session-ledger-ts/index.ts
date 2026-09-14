/**
 * A ledger for sessions you cannot list.
 *
 * Browser time is billed per hour while a session is open, so a process that
 * dies between `launch()` and `close()` leaves something running that costs
 * money and holds one of your concurrent slots. Sandboxes have
 * `sandboxes.list()` to find strays like that. Browser sessions have no `list`
 * and `GET /sessions` is a 404, so there is nothing to ask.
 *
 * So write down what you started. Record the id before handing the browser
 * back, drop it on a clean close, and release whatever is still recorded next
 * time you start. It is a few lines, and without it a crashed run is invisible.
 *
 * Two things this deliberately does NOT do, because they do not work:
 *
 *   - It does not check whether a recorded session is still alive first.
 *     `GET /sessions/:id` reports dead sessions as `"status":"active"`, so the
 *     answer cannot be trusted. Releasing is idempotent; just release.
 *   - It cannot find sessions it did not record. Another machine, another CI
 *     job, or a crash before the ledger write are all permanently invisible
 *     from the client side. That is the missing endpoint, not a bug here.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { Solari } from "@solarisdk/browser"

const LEDGER = new URL("./sessions.ledger.json", import.meta.url)
const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

type Entry = { id: string; label: string; startedAt: string }

const read = (): Entry[] => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : [])
const write = (rows: Entry[]) =>
  rows.length ? writeFileSync(LEDGER, JSON.stringify(rows, null, 2)) : existsSync(LEDGER) && unlinkSync(LEDGER)

/** Release anything a previous run recorded and never closed. */
async function reap(): Promise<number> {
  const stale = read()
  for (const row of stale) {
    // Deliberately unconditional: liveness is not answerable, and DELETE is
    // idempotent, so releasing an already-dead session is free and safe.
    await solari.sessions.releaseAndWait(row.id).catch(() => {})
    console.log(`  released ${row.label} (open since ${row.startedAt})`)
  }
  write([])
  return stale.length
}

/** Launch, but write the id down first. */
async function tracked<T>(label: string, fn: (b: Awaited<ReturnType<typeof solari.launch>>) => Promise<T>): Promise<T> {
  const browser = await solari.launch({})
  // Record BEFORE any work: a crash during the work is the case this exists for.
  write([...read(), { id: browser.id, label, startedAt: new Date().toISOString() }])
  try {
    return await fn(browser)
  } finally {
    await browser.close()
    write(read().filter((r) => r.id !== browser.id))
  }
}

const reaped = await reap()
console.log(reaped ? `reaped ${reaped} orphan(s) from a previous run\n` : "ledger clean, nothing to reap\n")

const title = await tracked("read-example", async (browser) => {
  const page = await browser.newPage()
  await page.goto("https://example.com")
  return page.title()
})
console.log(`clean run: "${title}" — ledger now has ${read().length} entries`)

// Now simulate the crash this exists for: record a session and never close it.
const leaked = await solari.launch({})
write([...read(), { id: leaked.id, label: "crashed-run", startedAt: new Date().toISOString() }])
console.log(`\nleaked a session on purpose — ledger has ${read().length} entry`)
console.log("this is what a process dying mid-run leaves behind\n")

console.log("next run reaps it:")
const cleaned = await reap()
console.log(`\nreaped ${cleaned}, ledger now has ${read().length} entries`)
await solari.close()
