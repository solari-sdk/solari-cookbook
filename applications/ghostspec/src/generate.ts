/**
 * Trace ─► Playwright spec.
 *
 * The trace is ground truth: every locator in it was executed against a real
 * browser during exploration, so it cannot name an element that isn't there.
 * That is the entire product claim, which makes this prompt's real job stopping
 * the model from being helpful — from "improving" an observed locator into a
 * prettier one nobody ever ran.
 */
import { ask } from "./llm.js"
import type { Trace } from "./types.js"

const IMPORT = "import { test, expect } from '@playwright/test'"

export async function generateSpec(trace: Trace): Promise<string> {
  const base = prompt(trace)
  const spec = clean(await ask(base))
  // "We generate real tests" is the product claim, and a spec with no `expect()` is not
  // one. The trace already holds the material for at least one, so ask again rather than
  // ship a file that proves only that nothing threw. Once — if it ignores the rule twice
  // the failure is worth seeing, not papering over.
  if (/\bexpect\(/.test(spec) || !trace.steps.some((s) => s.action === "expect")) return spec
  return clean(
    await ask(
      `${base}\n\nYour previous attempt contained no expect() at all, which is not a test. ` +
        `Every "expect" step listed above must appear as a real assertion, and the last ` +
        `statement in the test body must be one.`,
    ),
  )
}

function prompt(trace: Trace): string {
  const steps = trace.steps
    .map((s, i) => {
      const line = [`${i + 1}. ${s.action}`]
      if (s.locator) line.push(`locator: ${s.locator}`)
      if (s.value !== undefined) line.push(`value: ${JSON.stringify(s.value)}`)
      line.push(`why: ${s.note}`)
      return line.join("\n   ")
    })
    .join("\n")

  return `Write a Playwright test from this recording of a real browser session.

Goal: ${trace.goal}
Start URL: ${trace.url}

Observed steps — a real browser executed every one of these successfully, so every
locator below is known to exist and to match exactly one element:

${steps}

A "locator:" line is a locator expression; you use it as \`page.<expression>\`.

Rules, in order of importance:

1. NEVER invent a locator. Every locator in your output must appear
   character-for-character in the list above. Do not simplify one, do not swap
   getByRole for a CSS selector, do not add a locator to a step that has none.
   This is not a style preference: a locator nobody observed is a broken test we
   ship to a user who trusted us.
2. Every \`expect\` step above MUST become a real assertion — that is what makes
   this a test rather than a recording. Emit exactly ONE assertion per \`expect\`
   step, chosen like this:
   - If the locator already selects the element BY the step's own value —
     \`getByText('Products')\` with value "Products", \`getByRole('heading',
     { name: 'X' })\` with value "X" — then \`.toContainText('Products')\` is true
     by construction: it cannot fail unless the line above it already did. Emit
     only \`await expect(page.<locator>).toBeVisible()\`.
   - Otherwise the value is text found *inside* an element located some other
     way, so asserting it carries real information: emit
     \`await expect(page.<locator>).toContainText(<value>)\`.
   Never emit both for the same locator. An assertion that cannot fail is
   padding, and a reviewer reads padding as a test nobody thought about.
   The test must contain at least one assertion, and its LAST statement must be
   an assertion on the end state of the flow — the confirmation text, the final
   heading — not a click.
3. Assertions are the ONE thing you may add, and only from the material above:
   the text an \`expect\` step named, a value that was typed, the URL a \`goto\`
   opened. Never assert on page content nobody observed. An invented assertion
   is worse than a missing one, because it fails on a site that is working.
4. Use web-first assertions — \`await expect(page.<locator>).toBeVisible()\`,
   \`.toContainText(...)\`, \`await expect(page).toHaveURL(...)\`. They retry,
   which is why they replace waiting entirely.
   Use \`.toContainText(...)\`, never \`.toHaveText(...)\`: an \`expect\` step was
   verified during exploration by a *substring* match against the element's
   innerText, so equality is a stronger claim than anything we observed and
   would fail on an element whose text merely contains the value.
5. No \`waitForTimeout\`, no \`waitForSelector\`, no \`page.waitFor*\` of any
   kind, no try/catch, no if/else, no loops.
6. Exactly one \`test(...)\`, named with the goal verbatim. Its body is a
   straight run of awaits in step order.
7. Comments describe the TEST, not the exploration. The "why:" lines above are
   the explorer's own running notes: they sometimes mention what it tried first,
   which locator timed out, or what it worked out about the site. None of that
   belongs in a file someone commits. Above each step write one short \`//\`
   comment saying what the step does in the flow and why it matters to the flow.
   Never mention exploration, attempts, retries, timeouts, snapshots, or why one
   locator was chosen over another.
8. The file starts with, and module scope contains nothing but:
   ${IMPORT}

Reply with the raw TypeScript file. No markdown fence, no explanation.`
}

/**
 * Deterministic cleanup, because "reply with raw TypeScript" holds about half
 * the time. Anything this can't fix, verify.ts catches by running the thing.
 */
function clean(reply: string): string {
  const fenced = reply.match(/```[a-z]*\n([\s\S]*?)```/)
  let code = (fenced ? fenced[1] : reply).trim()

  // Unfenced: drop the "Here's your test!" preamble by finding where code starts.
  if (!fenced) {
    const start = code.search(/^(import |\/\*|\/\/|test\()/m)
    if (start > 0) code = code.slice(start)
  }

  // The import is the one line the spec cannot run without, so don't trust it.
  if (!/^import\b[^\n]*['"]@playwright\/test['"]/m.test(code)) code = `${IMPORT}\n\n${code}`

  return `${code.replace(/\s+$/, "")}\n`
}
