/**
 * Capture — run the real pipeline against a live model and record every payload
 * as a fixture. Tests replay these; nothing in the suite touches the network.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/capture.ts
 *
 * Re-run when a prompt or the model changes — not otherwise.
 * Questions are independent, so they run through a bounded worker pool rather
 * than serially. The first serial capture took 140 minutes for work whose
 * critical path is a single question.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadCorpus } from "../src/corpus.js"
import { recordingModel } from "../src/fixtures.js"
import { liveModel, NVIDIA_URL } from "../src/provider.js"
import { runQuestionnaire } from "../src/run.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const MODEL = process.env.TRUSTFILL_MODEL ?? "moonshotai/kimi-k3"
const CONCURRENCY = Number(process.env.TRUSTFILL_CONCURRENCY ?? "3")
const EFFORT = process.env.TRUSTFILL_EFFORT ?? "max"
const apiKey = process.env.NVIDIA_API_KEY
if (!apiKey) {
  console.error("\n  NVIDIA_API_KEY is not set. Use: set -a; . ./.env; set +a; npx tsx scripts/capture.ts\n")
  process.exit(1)
}

const onlyArg = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null

const corpus = await loadCorpus(join(ROOT, "evidence"))
const spec = JSON.parse(await readFile(join(ROOT, "questions", "questionnaire.json"), "utf8")) as {
  questions: { id: string; text: string; expected: "ANSWER" | "ABSTAIN" }[]
}
const questions = only ? spec.questions.filter((q) => only.has(q.id)) : spec.questions

const suffix = EFFORT === "max" ? "" : `-${EFFORT}`
const outDir = join(ROOT, "fixtures", MODEL.replace(/[^a-z0-9.-]/gi, "_") + suffix)
await mkdir(outDir, { recursive: true })

console.log(`\n  capture · ${MODEL} · ${questions.length} questions · concurrency ${CONCURRENCY} · effort ${EFFORT}`)
console.log(`  corpus ${corpus.length} chars\n`)

// One recorder per question, so each fixture holds only its own payloads.
const recorders = new Map<string, ReturnType<typeof recordingModel>>()
const started = Date.now()

const results = await runQuestionnaire({
  questions: questions.map((q) => ({ id: q.id, text: q.text })),
  corpus,
  concurrency: CONCURRENCY,
  modelFor: (q) => {
    const rec = recordingModel(liveModel({ url: NVIDIA_URL, apiKey, model: MODEL, reasoningEffort: EFFORT }))
    recorders.set(q.id, rec)
    return rec.model
  },
})

let ok = 0
let failed = 0

for (const r of results) {
  const q = questions.find((x) => x.id === r.id)!
  if (r.error || !r.answer) {
    console.log(`  ! ${r.id.padEnd(4)} ${String(r.error).slice(0, 90)}`)
    failed++
    continue
  }
  // Store the raw payloads AND the derived answer. The payloads are what tests
  // replay; the derived answer is a snapshot to eyeball when something drifts.
  await writeFile(
    join(outDir, `${r.id}.json`),
    JSON.stringify(
      { id: r.id, question: q.text, expected: q.expected, ...recorders.get(r.id)!.recorded(), answer: r.answer },
      null,
      2,
    ),
  )
  const verdict = r.answer.abstained ? `abstain ${r.answer.sufficiency}` : `answer ${r.answer.trustScore?.toFixed(2)}`
  const correct = (q.expected === "ABSTAIN") === r.answer.abstained
  console.log(`  ${correct ? "✓" : "✗"} ${r.id.padEnd(4)} ${verdict}`)
  ok++
}

console.log(`\n  captured ${ok}, failed ${failed} · wall time ${((Date.now() - started) / 60000).toFixed(1)} min`)
console.log(`  → ${outDir}\n`)
