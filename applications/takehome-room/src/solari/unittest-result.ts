// Reads the summary that `python3 -m unittest` prints at the end of its run.
import type { Grade } from "../interview.ts"

export function parseUnittest(output: string): Grade {
  const ran = output.match(/^Ran (\d+) tests? in /m)
  if (!ran) return { passed: 0, failed: 0, total: 0, output }
  const total = Number(ran[1])
  // "FAILED (failures=1, errors=2, skipped=1)" or "OK" / "OK (skipped=1)".
  const count = (name: string) => Number(output.match(new RegExp(`${name}=(\\d+)`))?.[1] ?? 0)
  const failedCount = /^FAILED\b/m.test(output)
    ? count("failures") + count("errors") + count("unexpected successes")
    : 0
  const skipped = count("skipped")
  return { passed: total - failedCount - skipped, failed: failedCount, total, output }
}
