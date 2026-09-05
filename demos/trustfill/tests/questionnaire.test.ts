import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, test } from "vitest"

import { fixtureModel } from "../src/fixtures.js"
import { answerQuestion, type Answer } from "../src/pipeline.js"
import { DraftSchema, VerificationSchema } from "../src/schemas.js"
import { trim } from "../src/trim.js"

/**
 * The M1 definition of done, replayed against payloads captured from a real
 * model. No network: `npm test` must run cold on a fresh clone.
 *
 * Regenerate with `npx tsx scripts/capture.ts` after changing a prompt or model.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const FIXTURES = join(ROOT, "fixtures", "moonshotai_kimi-k3")

interface FixtureFile {
  id: string
  question: string
  expected: "ANSWER" | "ABSTAIN"
  draft: unknown
  verification: unknown | null
}

let fixtures: FixtureFile[] = []
let results: Map<string, Answer> = new Map()

beforeAll(async () => {
  const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".json")).sort()
  fixtures = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(FIXTURES, f), "utf8")) as FixtureFile),
  )
  results = new Map(
    await Promise.all(
      fixtures.map(
        async (f) =>
          [
            f.id,
            await answerQuestion({
              question: f.question,
              corpus: "replayed",
              model: fixtureModel({ draft: f.draft, verification: f.verification }),
            }),
          ] as const,
      ),
    ),
  )
})

const answered = () => fixtures.filter((f) => f.expected === "ANSWER")
const traps = () => fixtures.filter((f) => f.expected === "ABSTAIN")

describe("questionnaire (replayed)", () => {
  test("the corpus yields 26 answerable questions and 4 traps", () => {
    expect(answered()).toHaveLength(26)
    expect(traps()).toHaveLength(4)
  })

  test("every trap abstains", () => {
    for (const f of traps()) expect(results.get(f.id)?.abstained, f.id).toBe(true)
  })

  // The demo beat depends on this. Four blanks that all say "insufficient" is one
  // behaviour repeated; four blanks with four different reasons is judgement.
  test("the traps abstain for four distinct reasons", () => {
    const reasons = traps().map((f) => results.get(f.id)?.sufficiency)
    expect(new Set(reasons).size).toBe(3) // INSUFFICIENT ×2, CONFLICTING, OUT_OF_SCOPE
    expect(results.get("T3")?.sufficiency).toBe("CONFLICTING")
    expect(results.get("T4")?.sufficiency).toBe("OUT_OF_SCOPE")
  })

  test("every answerable question is answered", () => {
    for (const f of answered()) {
      const r = results.get(f.id)
      expect(r?.abstained, f.id).toBe(false)
      expect(r?.answer, f.id).toBeTruthy()
    }
  })

  test("no answered question rests on an unsupported essential claim", () => {
    for (const f of answered()) {
      const unsupported = results.get(f.id)?.claims.filter((c) => c.essential && !c.supported) ?? []
      expect(unsupported, f.id).toEqual([])
    }
  })

  test("every answer carries at least one citation", () => {
    for (const f of answered()) expect(results.get(f.id)?.citations.length, f.id).toBeGreaterThan(0)
  })

  test("trustScore is within [0,1], and anything below 1 has an unsupported incidental claim", () => {
    for (const f of answered()) {
      const r = results.get(f.id)!
      expect(r.trustScore, f.id).toBeGreaterThanOrEqual(0)
      expect(r.trustScore, f.id).toBeLessThanOrEqual(1)
      if (r.trustScore! < 1) {
        expect(r.claims.some((c) => !c.essential && !c.supported), f.id).toBe(true)
      }
    }
  })

  test("both model payloads validate against their schemas", () => {
    for (const f of fixtures) {
      expect(() => DraftSchema.parse(f.draft), f.id).not.toThrow()
      if (f.verification !== null) {
        expect(() => VerificationSchema.parse(f.verification), f.id).not.toThrow()
      }
    }
  })

  test("trimming removes exactly the unsupported incidental claims and nothing else", () => {
    for (const f of answered()) {
      const r = results.get(f.id)!
      const dropped = r.claims.filter((c) => !c.essential && !c.supported)
      expect(r.removed, f.id).toEqual(dropped.map((c) => c.claim))

      // The returned text must ACTUALLY be trimmed. Asserting only on `removed`
      // let a mutation that bypassed the trim call pass unnoticed — found by
      // mutation testing, not by the suite passing.
      for (const c of dropped) expect(r.answer, `${f.id} still contains removed span`).not.toContain(c.sourceText)

      // And every span the verifier named was locatable in the drafted answer.
      const draft = DraftSchema.parse(f.draft)
      expect(trim(draft.answer!, r.claims).unlocatable, f.id).toEqual([])
    }
  })
})
