/**
 * M3 — the browser fills the questionnaire.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/fill.ts
 *
 * Answers come from the captured fixtures by default, so this is fast and needs
 * no model key. Pass --live to re-run the pipeline against the provider.
 *
 * Run it twice: the first run logs in and saves the profile, the second starts
 * already authenticated.
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnv } from "../src/env.js"

import { Solari } from "@solarisdk/browser"
import { launchBrowser } from "../src/browser.js"
import { loadCorpus } from "../src/corpus.js"
import { buildFillPlan } from "../src/fill-plan.js"
import { ensureSignedIn, fillQuestionnaire, PortalChangedError } from "../src/filler.js"
import { fixtureModel } from "../src/fixtures.js"
import { liveModel, NVIDIA_URL } from "../src/provider.js"
import { fetchReplayUrl } from "../src/replay.js"
import { buildReviewPacket } from "../src/review.js"
import { runQuestionnaire, type QuestionResult } from "../src/run.js"
import { startPortal } from "../src/sandbox.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// Load .env before anything reads process.env.
loadEnv(join(ROOT, ".env"))
const FIXTURES = join(ROOT, "fixtures", "moonshotai_kimi-k3")
const live = process.argv.includes("--live")

const solariKey = process.env.SOLARI_API_KEY
if (!solariKey) {
  console.error("\n  SOLARI_API_KEY is not set.\n")
  process.exit(1)
}

const spec = JSON.parse(await readFile(join(ROOT, "questions", "questionnaire.json"), "utf8")) as {
  questions: { id: string; text: string; expected: "ANSWER" | "ABSTAIN" }[]
}

console.log(`\n  TrustFill · ${live ? "live model" : "replaying captured fixtures"}`)

// ── answers ────────────────────────────────────────────────────────────────
const corpus = await loadCorpus(join(ROOT, "evidence"))
let results: QuestionResult[]

if (live) {
  const apiKey = process.env.NVIDIA_API_KEY
  if (!apiKey) throw new Error("--live needs NVIDIA_API_KEY")
  results = await runQuestionnaire({
    questions: spec.questions.map((q) => ({ id: q.id, text: q.text })),
    corpus,
    concurrency: 3,
    modelFor: () => liveModel({ url: NVIDIA_URL, apiKey, model: "moonshotai/kimi-k3", reasoningEffort: "max" }),
  })
} else {
  const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".json"))
  const byId = new Map(
    await Promise.all(
      files.map(async (f) => {
        const fx = JSON.parse(await readFile(join(FIXTURES, f), "utf8"))
        return [fx.id as string, fx] as const
      }),
    ),
  )
  results = await runQuestionnaire({
    questions: spec.questions.map((q) => ({ id: q.id, text: q.text })),
    corpus,
    concurrency: 30, // replay is local; nothing to rate-limit
    modelFor: (q) => fixtureModel({ draft: byId.get(q.id)?.draft, verification: byId.get(q.id)?.verification ?? null }),
  })
}

const plan = buildFillPlan(results)
const toFill = plan.filter((e) => e.action === "FILL").length
const toBlank = plan.length - toFill
console.log(`  ${toFill} answered · ${toBlank} left blank\n`)
for (const e of plan.filter((x) => x.action === "LEAVE_BLANK")) {
  console.log(`    ${e.questionId.padEnd(4)} ${e.reason}`)
}

// ── portal + browser ───────────────────────────────────────────────────────
let sessionId: string | null = null
let portalUrl = ""
let completed = false

const portal = await startPortal({ apiKey: solariKey, root: ROOT })
console.log(`\n  portal  ${portal.url.split("?")[0]}`)

// Two browser sessions against ONE portal.
//
// Cookies are domain-scoped and every run gets a fresh sandbox on a fresh
// preview hostname, so a profile saved in one invocation is useless in the next.
// That is an artifact of an ephemeral demo portal — a real customer's portal has
// a stable domain — so the profile is demonstrated within a single portal
// lifetime instead, which is both honest and deterministic.
const first = await launchBrowser({ apiKey: solariKey })
try {
  const cold = await ensureSignedIn(first.page, portal.url)
  console.log(`  pass 1  ${cold.loggedIn ? "logged in with credentials" : "unexpected: already authenticated"}`)
  await first.saveProfile()
  console.log("  pass 1  profile saved (cookies + localStorage)")
} finally {
  await first.stop()
}

const browser = await launchBrowser({ apiKey: solariKey })

try {
  const { loggedIn } = await ensureSignedIn(browser.page, portal.url)
  console.log(`  pass 2  ${loggedIn ? "LOGGED IN AGAIN — profile did not restore" : "restored from profile — no login form touched"}`)

  const outcome = await fillQuestionnaire(browser.page, plan)
  await browser.page.locator('[data-testid="save-draft"]').click()
  await browser.page.waitForSelector('[data-testid="draft-status"]')
  const status = await browser.page.locator('[data-testid="draft-status"]').innerText()

  await mkdir(join(ROOT, ".tmp"), { recursive: true })
  const shot = join(ROOT, ".tmp", "questionnaire.png")
  await browser.page.screenshot({ path: shot, fullPage: true })

  await browser.saveProfile()

  console.log(`\n  filled ${outcome.filled} · blank ${outcome.leftBlank}`)
  console.log(`  portal says: ${status}`)
  console.log(`  screenshot  ${shot}`)

  sessionId = browser.sessionId
  portalUrl = portal.url
  completed = true
} catch (err) {
  if (err instanceof PortalChangedError) {
    console.error(`\n  PORTAL_CHANGED — ${err.message}`)
    console.error("  Refusing to report success against a portal we do not recognise.\n")
  }
  throw err
} finally {
  await browser.stop()
  await portal.stop()
}

// ── audit + review handoff ─────────────────────────────────────────────────
// Deliberately after browser.stop(): the replay upload only begins once the
// session is released, so polling before that just burns the retry budget.
if (completed) {
  const solari = new Solari({ apiKey: solariKey })
  const replayUrl = await fetchReplayUrl({
    sessionId,
    // Returns { url, expiresInSeconds, contentEncoding } — not a bare string.
    getReplayUrl: async (id) => (await solari.sessions.getReplayUrl(id)).url,
    attempts: 8,
    delayMs: 3000,
  }).finally(() => solari.close().catch(() => {}))

  const packet = buildReviewPacket({
    questions: spec.questions.map((q) => ({ id: q.id, text: q.text })),
    plan,
    audit: { portalUrl, sessionId, replayUrl },
  })

  const packetPath = join(ROOT, ".tmp", "review-packet.json")
  await writeFile(packetPath, JSON.stringify(packet, null, 2))

  console.log("\n  ── needs a human ─────────────────────────────────────────")
  for (const item of packet.needsReview) {
    console.log(`  ${item.questionId.padEnd(4)} ${item.questionText}`)
    console.log(`       ${item.reason}\n`)
  }

  const edited = packet.answered.filter((a) => a.edited)
  if (edited.length) {
    console.log(`  ${edited.length} answer(s) had unsupported detail removed: ${edited.map((a) => a.questionId).join(", ")}\n`)
  }

  console.log(`  review packet ${packetPath}`)
  console.log(`  session       ${sessionId ?? "n/a"}`)
  console.log(`  replay        ${replayUrl ?? packet.audit.replayNote}\n`)
}
