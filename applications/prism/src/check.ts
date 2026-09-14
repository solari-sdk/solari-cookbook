/**
 * The check itself: render one URL as every user class, then assert what each
 * one ACTUALLY saw.
 *
 * Nothing here trusts that a profile attached, or that a cookie was set. Every
 * verdict comes from testids read off a live page -- the same discipline as
 * clicking a repaired element and confirming the page changed, rather than
 * believing a claim about it.
 */
import type { Backend } from "./backend.js"
import { CLASSES, type UserClass } from "./classes.js"
import { runFleet } from "./fleet.js"

export type Finding = { kind: "missing" | "leaked"; testid: string }
export type ClassResult = {
  name: string
  because: string
  ok: boolean
  saw: string[]
  findings: Finding[]
  error?: string
  ms: number
}

export function judge(cls: UserClass, saw: string[]): Finding[] {
  const set = new Set(saw)
  return [
    ...cls.mustSee.filter((t) => !set.has(t)).map((t): Finding => ({ kind: "missing", testid: t })),
    ...cls.mustNotSee.filter((t) => set.has(t)).map((t): Finding => ({ kind: "leaked", testid: t })),
  ]
}

export async function check(
  backend: Backend,
  url: string,
  classes: UserClass[] = CLASSES,
  onEvent?: (e: { type: string; concurrency: number }) => void,
): Promise<ClassResult[]> {
  const results = await runFleet(
    classes.map((cls) => async (): Promise<ClassResult> => {
      const t0 = Date.now()
      const probe = await backend.probe(url, cls.cookies, cls.name)
      const findings = judge(cls, probe.testids)
      return {
        name: cls.name, because: cls.because, ok: findings.length === 0,
        saw: probe.testids, findings, ms: Date.now() - t0,
      }
    }),
    { isBackpressure: backend.isBackpressure ?? (() => false), onEvent },
  )

  return results.map((r, i) => r.value ?? {
    name: classes[i]!.name, because: classes[i]!.because, ok: false, saw: [],
    findings: [], error: String(r.error).slice(0, 200), ms: 0,
  })
}
