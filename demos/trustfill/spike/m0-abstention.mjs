/**
 * M0 — abstention spike.  THROWAWAY. Answers a question, does not become code.
 *
 * The riskiest assumption in TrustFill is NOT the Solari plumbing — we know from
 * the cookbook that a browser can reach a sandbox preview URL. The risk is that
 * the model ANSWERS QUESTIONS IT SHOULDN'T. If it confidently reports a
 * penetration-testing cadence that appears nowhere in the corpus, the demo has no
 * ending and the product has no premise.
 *
 * So: measure abstention before building anything.
 *
 * Two things are under test.
 *   1. Does the model abstain on all 4 traps, and keep answering the other 26?
 *   2. Is ENTAILMENT VERIFICATION a better abstention signal than the model's own
 *      self-reported confidence? Self-reported LLM confidence is poorly
 *      calibrated and a reviewer will say so. If a second-pass entailment check
 *      catches traps that confidence misses, the trust score should be built from
 *      entailment — and we will have measured that rather than assumed it.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node m0-abstention.mjs
 *   OPENAI_API_KEY=...    node m0-abstention.mjs --provider openai
 *   node m0-abstention.mjs --runs 5 --model claude-opus-5
 */

import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
}
const PROVIDER = arg("provider", "anthropic")
const RUNS = Number(arg("runs", "3"))
const DEFAULT_MODEL = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  openrouter: "nvidia/nemotron-3.5-lightning:free",
  nvidia: "moonshotai/kimi-k3",
}
const MODEL = arg("model", DEFAULT_MODEL[PROVIDER])
const ONLY = arg("only", null) // e.g. --only T2  or  --only Q05,Q10,Q11,Q27
const ONLY_IDS = ONLY ? new Set(ONLY.split(",").map((s) => s.trim())) : null
const DELAY_MS = Number(arg("delay", PROVIDER === "openrouter" ? "1200" : "0")) // free tiers rate-limit hard
const EFFORT = arg("effort", "max") // nvidia reasoning models

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── prompts ─────────────────────────────────────────────────────────────────
// This is the actual product logic under test. The last instruction is the one
// that matters most: models are trained toward helpfulness and will over-answer
// unless refusing is explicitly framed as a correct outcome.
const SYSTEM = `You answer vendor security questionnaires on behalf of a company, using ONLY that company's own evidence documents.

You will be given the complete evidence corpus and one question.

Classify the question into exactly one sufficiency category:

- SUFFICIENT — the evidence directly and unambiguously answers the question. This includes evidence that answers it NEGATIVELY (e.g. the documents state the company is NOT ISO 27001 certified). An explicit "no" in the evidence is a complete answer.
- INSUFFICIENT — the evidence does not answer the question. This includes the case where the evidence discusses the surrounding topic in detail but never states the specific fact asked for. Discussion of a topic is NOT an answer about that topic.
- CONFLICTING — two or more parts of the evidence give materially different answers to this question.
- OUT_OF_SCOPE — the question asks you to ACCEPT AN OBLIGATION, agree to a term, or make a forward commitment, rather than to state an existing fact. Only a human with authority can do that.

Rules:
- Use only the supplied evidence. You have no other knowledge of this company.
- NEVER fall back on what is typical, standard, or common in the industry. If the evidence does not state it, you do not know it.
- Every claim in your answer must be supported by a verbatim quote from the evidence.
- Quotes must be copied exactly. Do not paraphrase inside a quote.
- Answer ONLY when the category is SUFFICIENT. For every other category, set "answer" to null.

Abstaining when the evidence does not support an answer is a CORRECT and valued outcome. It is not a failure, and it is not unhelpful. A wrong answer in a security questionnaire is far worse than no answer.

Return ONLY a JSON object, no prose, no markdown fence:
{
  "sufficiency": "SUFFICIENT" | "INSUFFICIENT" | "CONFLICTING" | "OUT_OF_SCOPE",
  "answer": string | null,
  "citations": [{ "document": string, "quote": string }],
  "selfConfidence": number,
  "reasoning": string
}`

// CLAIM-LEVEL, not answer-level. The first version of this verifier judged the
// whole answer as one unit, and rejected fully-correct answers because of an
// incidental clause the model hadn't quoted (e.g. citing a document's content
// but not its version number). One uncited adjunct nullified everything.
//
// Splitting essential from incidental fixes that, and is also the only way to
// produce a trust SCORE rather than a trust boolean.
const ENTAILMENT_SYSTEM = `You verify which parts of a drafted answer are supported by its cited quotes.

You are given a QUESTION, a DRAFTED ANSWER, and the QUOTES cited in support.

Break the answer into atomic factual claims. For each claim, decide two things independently:

1. "essential" — is this claim REQUIRED to answer the question as asked?
   Essential: the fact the question actually asked for.
   Incidental: surrounding context the answer volunteered — document version numbers, review dates, restatements of scope, background the question did not request.

2. "supported" — do the QUOTES establish this specific claim?
   Judge only against the quotes. Do not use outside knowledge. Do not accept a claim because it sounds plausible or is probably true. A quote that is ABOUT the right topic but does not contain the specific fact does NOT support the claim.

Return ONLY JSON, no prose, no markdown fence:
{ "claims": [ { "claim": string, "essential": true | false, "supported": true | false } ] }`

// ── providers ───────────────────────────────────────────────────────────────
async function callAnthropic(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: user }],
    }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = await res.json()
  return body.content.map((b) => b.text ?? "").join("")
}

// OpenAI-compatible: covers both api.openai.com and openrouter.ai.
async function callOpenAICompatible(system, user, { url, apiKey, jsonMode, extra = {} }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      // OpenRouter attribution headers — harmless elsewhere.
      "http-referer": "https://github.com/solari-sdk/solari-cookbook",
      "x-title": "TrustFill M0 abstention spike",
    },
    body: JSON.stringify({
      model: MODEL,
      // Not every OpenRouter model honours json_object; the parser below is
      // tolerant, so we simply don't ask for a mode the model may not support.
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      ...extra,
    }),
  })
  if (!res.ok) {
    const err = new Error(`${PROVIDER} ${res.status}: ${(await res.text()).slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  const body = await res.json()
  const choice = body.choices?.[0]?.message
  // Some reasoning models return an empty `content` alongside a `reasoning`
  // field. Fall back rather than reporting a spurious parse failure.
  return choice?.content || choice?.reasoning || ""
}

const callRaw = {
  anthropic: (s, u) => callAnthropic(s, u),
  openai: (s, u) =>
    callOpenAICompatible(s, u, {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: process.env.OPENAI_API_KEY,
      jsonMode: true,
    }),
  openrouter: (s, u) =>
    callOpenAICompatible(s, u, {
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: process.env.OPENROUTER_API_KEY,
      jsonMode: false,
    }),
  nvidia: (s, u) =>
    callOpenAICompatible(s, u, {
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: process.env.NVIDIA_API_KEY,
      jsonMode: false,
      // NOTE: deliberately no `seed`. A fixed seed makes every run identical,
      // which would make multi-run reliability measurement meaningless — the
      // question is whether abstention is STABLE, not whether it happened once.
      extra: { max_tokens: 16384, temperature: 1, reasoning_effort: EFFORT },
    }),
}[PROVIDER]

if (!callRaw) {
  console.error(`\n  unknown provider "${PROVIDER}" — use anthropic | openai | openrouter\n`)
  process.exit(1)
}

// Free tiers throttle aggressively. A 429 is a scheduling problem, not a result —
// retry it rather than let it pollute the abstention measurement.
async function call(system, user) {
  let wait = 2000
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const out = await callRaw(system, user)
      if (DELAY_MS) await sleep(DELAY_MS)
      return out
    } catch (err) {
      const retryable = err.status === 429 || (err.status >= 500 && err.status < 600)
      if (!retryable || attempt === 5) throw err
      await sleep(wait)
      wait *= 2
    }
  }
}

// Models occasionally fence the JSON despite instructions. Don't let that be a
// test failure — it's a parsing concern, not an abstention concern.
function parseJson(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error(`no JSON found in: ${raw.slice(0, 200)}`)
  return JSON.parse(cleaned.slice(start, end + 1))
}

// ── evidence ────────────────────────────────────────────────────────────────
async function loadCorpus() {
  const dir = join(ROOT, "evidence")
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"))
  const docs = await Promise.all(
    files.map(async (f) => `<document name="${f}">\n${await readFile(join(dir, f), "utf8")}\n</document>`),
  )
  // Small corpus, ~5 documents. Everything goes in context. A vector database
  // here would be architecture for its own sake — see scope §5.
  return docs.join("\n\n")
}

// ── one question ────────────────────────────────────────────────────────────
async function evaluate(corpus, q) {
  const draft = parseJson(
    await call(SYSTEM, `<evidence>\n${corpus}\n</evidence>\n\nQuestion: ${q.text}`),
  )

  // Second pass runs only when the model claims it can answer — that is the only
  // case where entailment can catch something confidence missed.
  let entail = null
  if (draft.sufficiency === "SUFFICIENT" && draft.answer) {
    entail = parseJson(
      await call(
        ENTAILMENT_SYSTEM,
        `QUESTION: ${q.text}\n\nDRAFTED ANSWER: ${draft.answer}\n\nQUOTES:\n${(draft.citations ?? [])
          .map((c) => `- [${c.document}] "${c.quote}"`)
          .join("\n") || "(none cited)"}`,
      ),
    )
  }

  const claims = entail?.claims ?? []
  const unsupportedEssential = claims.filter((c) => c.essential && !c.supported)
  const unsupportedIncidental = claims.filter((c) => !c.essential && !c.supported)

  const abstainedByCategory = draft.sufficiency !== "SUFFICIENT" || !draft.answer
  // Abstain only when a claim the question actually ASKED FOR is unsupported.
  // Unsupported incidental claims are a trimming problem, not a refusal reason.
  const abstainedAfterEntailment = abstainedByCategory || unsupportedEssential.length > 0
  const trustScore = claims.length ? claims.filter((c) => c.supported).length / claims.length : null

  return {
    id: q.id,
    expected: q.expected,
    trap: q.trap ?? null,
    sufficiency: draft.sufficiency,
    selfConfidence: draft.selfConfidence,
    claims,
    trustScore,
    unsupportedEssential: unsupportedEssential.map((c) => c.claim),
    unsupportedIncidental: unsupportedIncidental.map((c) => c.claim),
    abstainedByCategory,
    abstainedAfterEntailment,
    // Which of the two independent gates actually fired. Without this you cannot
    // tell a null answer from an entailment rejection, and they need opposite fixes.
    abstainReason: !abstainedByCategory && unsupportedEssential.length > 0
      ? "ESSENTIAL_CLAIM_UNSUPPORTED"
      : draft.sufficiency !== "SUFFICIENT"
        ? `CATEGORY_${draft.sufficiency}`
        : !draft.answer
          ? "EMPTY_ANSWER_DESPITE_SUFFICIENT"
          : null,
    answer: draft.answer,
    citations: draft.citations ?? [],
    reasoning: draft.reasoning,
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const key = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  nvidia: "NVIDIA_API_KEY",
}[PROVIDER]
if (!process.env[key]) {
  console.error(`\n  ${key} is not set.\n\n  ${key}=... node --env-file=.env demos/trustfill/spike/m0-abstention.mjs --provider ${PROVIDER}\n`)
  process.exit(1)
}

const corpus = await loadCorpus()
const spec = JSON.parse(await readFile(join(ROOT, "questions", "questionnaire.json"), "utf8"))
const questions = ONLY_IDS ? spec.questions.filter((q) => ONLY_IDS.has(q.id)) : spec.questions

console.log(`\n  M0 — abstention spike`)
console.log(`  provider ${PROVIDER} · model ${MODEL} · ${questions.length} questions × ${RUNS} runs\n`)

const all = []
for (let run = 1; run <= RUNS; run++) {
  process.stdout.write(`  run ${run}/${RUNS}  `)
  for (const q of questions) {
    try {
      const r = await evaluate(corpus, q)
      all.push({ run, ...r })
      const correct =
        r.expected === "ABSTAIN" ? r.abstainedAfterEntailment : !r.abstainedAfterEntailment
      process.stdout.write(correct ? "." : "X")
    } catch (err) {
      all.push({ run, id: q.id, expected: q.expected, trap: q.trap ?? null, error: String(err.message) })
      process.stdout.write("!")
    }
  }
  process.stdout.write("\n")
}

// ── report ──────────────────────────────────────────────────────────────────
const traps = all.filter((r) => r.expected === "ABSTAIN")
const answerable = all.filter((r) => r.expected === "ANSWER")
const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`)

console.log(`\n  ── traps (must abstain) ─────────────────────────────────────`)
for (const id of [...new Set(traps.map((r) => r.id))]) {
  const rows = traps.filter((r) => r.id === id)
  const byCat = rows.filter((r) => r.abstainedByCategory).length
  const byEnt = rows.filter((r) => r.abstainedAfterEntailment).length
  const trapType = rows[0].trap ?? "?"
  const flag = byEnt === rows.length ? "✓" : "✗"
  console.log(
    `  ${flag} ${id}  ${trapType.padEnd(24)} category ${byCat}/${rows.length}   +claim-check ${byEnt}/${rows.length}`,
  )
  for (const r of rows.filter((x) => !x.abstainedAfterEntailment)) {
    console.log(`      LEAK run ${r.run}: ${String(r.answer).slice(0, 110)}`)
  }
}

const falseAbstain = answerable.filter((r) => r.abstainedAfterEntailment)
console.log(`\n  ── answerable (must not abstain) ────────────────────────────`)
console.log(`  answered ${answerable.length - falseAbstain.length}/${answerable.length}   false abstentions ${falseAbstain.length}`)
for (const id of [...new Set(falseAbstain.map((r) => r.id))]) {
  const rows = falseAbstain.filter((r) => r.id === id)
  console.log(`  ✗ ${id} abstained ${rows.length}× — ${rows[0].abstainReason}`)
  for (const c of rows[0].unsupportedEssential ?? []) console.log(`      unsupported essential: ${String(c).slice(0, 110)}`)
}

// Does entailment verification earn its place, or is self-confidence enough?
const caughtOnlyByEntailment = traps.filter((r) => !r.abstainedByCategory && r.abstainedAfterEntailment)
const trapConf = traps.filter((r) => typeof r.selfConfidence === "number").map((r) => r.selfConfidence)
const ansConf = answerable.filter((r) => typeof r.selfConfidence === "number").map((r) => r.selfConfidence)
const mean = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : "—")

console.log(`\n  ── trust signal ─────────────────────────────────────────────`)
console.log(`  traps caught by category alone      ${traps.filter((r) => r.abstainedByCategory).length}/${traps.length}`)
console.log(`  additionally caught by entailment   ${caughtOnlyByEntailment.length}`)
console.log(`  mean self-confidence, traps         ${mean(trapConf)}`)
console.log(`  mean self-confidence, answerable    ${mean(ansConf)}`)
console.log(`  → if those two means are close, self-reported confidence is not a`)
console.log(`    usable trust signal and the score must be built from entailment.`)

const errors = all.filter((r) => r.error)
if (errors.length) console.log(`\n  ${errors.length} call errors — e.g. ${errors[0].error}`)

// Always persist the full records. Summary output threw away the evidence needed
// to tell an empty answer from an entailment rejection — that cost a re-run once.
const dumpPath = join(HERE, "last-run.json")
await writeFile(dumpPath, JSON.stringify({ provider: PROVIDER, model: MODEL, runs: RUNS, records: all }, null, 2))
console.log(`\n  full records → ${dumpPath}`)

const trapsPassed = [...new Set(traps.map((r) => r.id))].every((id) =>
  traps.filter((r) => r.id === id).every((r) => r.abstainedAfterEntailment),
)
const falseAbstainRate = falseAbstain.length / Math.max(answerable.length, 1)

console.log(`\n  ── GATE ─────────────────────────────────────────────────────`)
console.log(`  all traps abstained, every run   ${trapsPassed ? "PASS" : "FAIL"}`)
console.log(`  false abstention rate            ${pct(falseAbstain.length, answerable.length)} ${falseAbstainRate <= 0.1 ? "PASS" : "FAIL"} (threshold 10%)`)
console.log(
  `\n  ${trapsPassed && falseAbstainRate <= 0.1 ? "M0 PASSES — the premise holds, proceed to M1." : "M0 FAILS — fix abstention before building anything else."}\n`,
)
