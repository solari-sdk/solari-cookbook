/**
 * The agent loop: look at the page, ask the model for one action, do it, repeat.
 *
 * The output is a `Trace` of actions that were *observed working* on a real browser.
 * That is the whole trick — codegen downstream cannot invent a selector, because it
 * only ever sees locators that already clicked something.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Locator, Page } from "playwright-core"
import { ask, extractJson } from "./llm.js"
import { connect, createSession, releaseSession, waitForReplay } from "./session.js"
import type { Step, Trace } from "./types.js"

export type ExploreOptions = {
  /** Hard ceiling on model round-trips. Every step is a browser-second and a token bill. */
  maxSteps?: number
  /** Where screenshots land. `trace.screenshots` holds paths relative to this. */
  outDir?: string
  /** Budget for a single click/fill/assertion. */
  actionTimeoutMs?: number
}

/** What we ask the model for, once per step. */
type Decision = {
  action?: string
  locator?: string
  value?: string
  note?: string
  done?: boolean
  reason?: string
}

const ACTIONS = new Set<Step["action"]>(["goto", "click", "fill", "press", "select", "expect"])

/** The aria snapshot of a real app can be tens of KB. Past this it stops earning its tokens. */
const SNAPSHOT_BUDGET = 6_000

// ---------------------------------------------------------------------------
// Locator expressions
// ---------------------------------------------------------------------------

/**
 * Turn a locator *expression string* into a real Playwright locator.
 *
 * This is a trust boundary: the string is written by a language model, so there is no
 * `eval`, no `new Function`, and no indexing into `page` by a model-supplied name. We
 * recognise exactly the `getBy*` forms we ask for — everything else is rejected, which
 * also conveniently rejects the CSS selectors models reach for when they get lazy.
 */
type LocatorOptions = {
  name?: string
  exact?: boolean
  level?: number
  checked?: boolean
  selected?: boolean
  pressed?: boolean
  expanded?: boolean
  disabled?: boolean
  includeHidden?: boolean
}

const OPTION_KEYS = new Set([
  "name", "exact", "level", "checked", "selected", "pressed", "expanded", "disabled", "includeHidden",
])

export function toLocator(page: Page, expr: string): Locator {
  const calls = splitCalls(expr.trim())
  const [head, ...rest] = calls
  if (!head) throw new Error(`empty locator expression`)

  const args = splitTopLevel(head.args)
  const text = args.length ? parseString(args[0]) : ""
  const options = args.length > 1 ? parseOptions(args[1]) : {}
  if (args.length > 2) throw new Error(`too many arguments to ${head.name}()`)

  let loc: Locator
  switch (head.name) {
    // `role` is a closed union in the Playwright types; an unknown role throws at call
    // time with a clear message, which is exactly the feedback we want to hand back.
    case "getByRole":
      loc = page.getByRole(text as Parameters<Page["getByRole"]>[0], options)
      break
    case "getByLabel": loc = page.getByLabel(text, options); break
    case "getByPlaceholder": loc = page.getByPlaceholder(text, options); break
    case "getByText": loc = page.getByText(text, options); break
    case "getByTestId": loc = page.getByTestId(text); break
    case "getByTitle": loc = page.getByTitle(text, options); break
    case "getByAltText": loc = page.getByAltText(text, options); break
    default:
      throw new Error(
        `unsupported locator '${head.name}(...)' — use getByRole/getByLabel/getByPlaceholder/` +
          `getByText/getByTestId/getByTitle/getByAltText`,
      )
  }

  for (const call of rest) {
    const inner = call.args.trim()
    if (call.name === "first" || call.name === "last") {
      if (inner) throw new Error(`.${call.name}() takes no arguments`)
      loc = call.name === "first" ? loc.first() : loc.last()
    } else if (call.name === "nth") {
      const n = Number(inner)
      if (!Number.isInteger(n)) throw new Error(`.nth() needs an integer, got '${inner}'`)
      loc = loc.nth(n)
    } else {
      throw new Error(`unsupported locator chain '.${call.name}()' — only .first(), .last(), .nth(n)`)
    }
  }
  return loc
}

type Call = { name: string; args: string }

/** `getByRole('button', { name: 'x' }).first()` → two calls. Quote- and nesting-aware. */
function splitCalls(expr: string): Call[] {
  const out: Call[] = []
  let i = 0
  while (i < expr.length) {
    const m = /^\s*\.?\s*([A-Za-z][A-Za-z0-9]*)\s*\(/.exec(expr.slice(i))
    if (!m) throw new Error(`cannot parse locator expression: ${expr}`)
    i += m[0].length
    const start = i
    let depth = 1
    let quote: string | null = null
    for (; i < expr.length && depth > 0; i++) {
      const c = expr[i]
      if (quote) {
        if (c === "\\") i++
        else if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === "`") quote = c
      else if (c === "(" || c === "{" || c === "[") depth++
      else if (c === ")" || c === "}" || c === "]") depth--
    }
    if (depth !== 0) throw new Error(`unbalanced brackets in locator: ${expr}`)
    out.push({ name: m[1], args: expr.slice(start, i - 1) })
  }
  return out
}

/** Split on commas that are not inside a string or a nested bracket. */
function splitTopLevel(src: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") quote = c
    else if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") depth--
    else if (c === "," && depth === 0) {
      out.push(src.slice(start, i))
      start = i + 1
    }
  }
  const tail = src.slice(start)
  if (tail.trim() || out.length) out.push(tail)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

function parseString(src: string): string {
  const s = src.trim()
  const q = s[0]
  if ((q !== "'" && q !== '"' && q !== "`") || s[s.length - 1] !== q || s.length < 2)
    throw new Error(`expected a quoted string, got \`${s}\` — regexes and variables are not supported`)
  return s
    .slice(1, -1)
    .replace(/\\(['"`\\])/g, "$1")
    .replace(/\\n/g, "\n")
}

function parseOptions(src: string): LocatorOptions {
  const s = src.trim()
  if (!s.startsWith("{") || !s.endsWith("}")) throw new Error(`expected an options object, got \`${s}\``)
  const out: Record<string, unknown> = {}
  for (const entry of splitTopLevel(s.slice(1, -1))) {
    const at = entry.indexOf(":")
    if (at === -1) throw new Error(`bad option \`${entry}\` — shorthand is not supported`)
    const key = entry.slice(0, at).trim().replace(/^['"`]|['"`]$/g, "")
    if (!OPTION_KEYS.has(key)) throw new Error(`unsupported locator option '${key}'`)
    const raw = entry.slice(at + 1).trim()
    if (raw === "true" || raw === "false") out[key] = raw === "true"
    else if (/^-?\d+$/.test(raw)) out[key] = Number(raw)
    else out[key] = parseString(raw)
  }
  return out as LocatorOptions
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function explore(url: string, goal: string, opts: ExploreOptions = {}): Promise<Trace> {
  const maxSteps = opts.maxSteps ?? 25
  const outDir = opts.outDir ?? "ghostspec-out"
  const timeout = opts.actionTimeoutMs ?? 15_000
  mkdirSync(outDir, { recursive: true })

  const trace: Trace = { url, goal, steps: [], screenshots: [] }
  const session = await createSession({ recording: true })
  trace.sessionId = session.sessionId

  try {
    const page = await connect(session.cdpEndpoint)
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
      // The opening `goto` is a real step: the generated spec has to start with it.
      trace.steps.push({ action: "goto", value: url, note: `start at ${url}` })
      await shoot(page, outDir, trace, "01-start")

      let lastError: string | undefined
      let nudge: string | undefined
      let nudged = false
      let consecutiveFailures = 0
      let finished = false

      for (let i = 0; i < maxSteps; i++) {
        const snapshot = await page
          .ariaSnapshot({ mode: "ai", timeout })
          .catch((e: Error) => `(snapshot failed: ${e.message.split("\n")[0]})`)
        const decision = extractJson<Decision>(
          await ask(
            buildPrompt(
              goal, page.url(), await page.title(), snapshot, trace.steps,
              lastError, consecutiveFailures, nudge,
            ),
          ),
        )
        nudge = undefined

        if (decision.done) {
          // This trace becomes a test, and a test whose last statement is a click proves
          // only that nothing threw. Ask once for a closing assertion; once, because a
          // model that will not assert twice will not assert on the third ask either.
          if (!nudged && trace.steps[trace.steps.length - 1]?.action !== "expect") {
            nudged = true
            nudge =
              `You said the goal is reached, but the last recorded step is not an "expect", so the ` +
              `test this becomes would assert nothing at all. Do NOT say done yet. Reply with one ` +
              `final "expect" on the end state of the goal, using text you can see in the snapshot ` +
              `above. Say done on the turn after that.`
            continue
          }
          finished = true
          break
        }

        try {
          const step = validate(decision)
          await perform(page, step, timeout)
          // A click can start a navigation; snapshotting a document that is being torn
          // down gives the model garbage to reason about.
          await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {})
          trace.steps.push(step)
          lastError = undefined
          consecutiveFailures = 0
        } catch (e) {
          lastError = `${(e as Error).message}`.split("\n").slice(0, 4).join(" ").slice(0, 400)
          // Three in a row means the model is not learning from the feedback; every
          // further round-trip is a browser-minute spent watching it guess.
          if (++consecutiveFailures >= 3) {
            trace.failed = `3 consecutive failed actions, last: ${lastError}`
            break
          }
        }
      }

      // `done` never fired and nothing broke — we simply ran out of budget.
      if (!finished && !trace.failed) trace.failed = `hit the ${maxSteps}-step cap without reaching the goal`

      await shoot(page, outDir, trace, "02-final")
    } finally {
      await page.context().browser()?.close().catch(() => {})
    }
  } catch (e) {
    trace.failed ??= (e as Error).message ?? String(e)
  } finally {
    // Non-negotiable. A leaked browser bills for an hour and eats one of three slots.
    await releaseSession(session.sessionId)
  }

  trace.replayUrl = await waitForReplay(session.sessionId)
  return trace
}

/** Reject anything the type says is impossible before it reaches Playwright. */
function validate(d: Decision): Step {
  const action = d.action as Step["action"]
  if (!ACTIONS.has(action)) throw new Error(`unknown action '${d.action}'`)
  if (action !== "goto" && !d.locator) throw new Error(`'${action}' needs a locator`)
  if ((action === "goto" || action === "fill" || action === "press" || action === "select") && !d.value)
    throw new Error(`'${action}' needs a value`)
  // Models like to fill every field; an empty `value` would become `.click("")` downstream.
  return { action, locator: d.locator, value: d.value || undefined, note: d.note?.trim() || `${action}` }
}

async function perform(page: Page, step: Step, timeout: number): Promise<void> {
  if (step.action === "goto") {
    await page.goto(step.value!, { waitUntil: "domcontentloaded", timeout: 30_000 })
    return
  }
  const loc = toLocator(page, step.locator!)
  switch (step.action) {
    case "click": await loc.click({ timeout }); return
    case "fill": await loc.fill(step.value!, { timeout }); return
    case "press": await loc.press(step.value!, { timeout }); return
    case "select": await loc.selectOption(step.value!, { timeout }); return
    case "expect": {
      // ghostspec itself does not depend on @playwright/test, so assertions are done by
      // hand here. The generated spec turns these back into real `expect()` calls.
      // No `.first()`: `expect(loc).toContainText()` downstream is strict, so an
      // assertion that only passes here because we quietly took the first of six
      // matches is an assertion that fails in the spec we hand the user. Letting the
      // strict-mode violation through as feedback is also what teaches the model to
      // name the element instead of guessing at it.
      await loc.waitFor({ state: "visible", timeout })
      if (step.value) {
        const text = (await loc.innerText()).trim()
        if (!text.includes(step.value))
          throw new Error(`expected text ${JSON.stringify(step.value)}, found ${JSON.stringify(text.slice(0, 200))}`)
      }
      return
    }
  }
}

async function shoot(page: Page, outDir: string, trace: Trace, name: string): Promise<void> {
  const file = `${name}.png`
  writeFileSync(join(outDir, file), await page.screenshot())
  // Relative, because the HTML report sits in the same directory.
  trace.screenshots.push(file)
}

function buildPrompt(
  goal: string,
  url: string,
  title: string,
  snapshot: string,
  steps: Step[],
  lastError?: string,
  failures = 0,
  nudge?: string,
): string {
  const trimmed =
    snapshot.length > SNAPSHOT_BUDGET
      ? `${snapshot.slice(0, SNAPSHOT_BUDGET)}\n… (snapshot truncated at ${SNAPSHOT_BUDGET} characters — scroll or narrow the page if what you need is missing)`
      : snapshot

  return `You are driving a real Chrome browser, one action at a time, to accomplish a goal.

GOAL: ${goal}

CURRENT PAGE
url:   ${url}
title: ${title}
accessibility snapshot (roles and accessible names):
${trimmed}

ALREADY DONE (${steps.length} step${steps.length === 1 ? "" : "s"}):
${steps.map((s, i) => `${i + 1}. ${s.action} ${s.locator ?? ""}${s.value ? ` -> ${JSON.stringify(s.value)}` : ""}  // ${s.note}`).join("\n") || "(nothing yet)"}
${lastError ? `\nYOUR LAST ACTION FAILED: ${lastError}\nPick a different locator or a different action.${failures >= 2 ? `\nThat is ${failures} failures in a row on the same thing. STOP reaching for the locator that reads nicely and take whatever actually matches the snapshot above — getByText, .first(), .nth(n) are all fine here. If the thing you are aiming at is printed as \`generic\`, it has no role: use getByText on its text, with .first(). A locator that works beats a locator that is pretty, and one more failure ends the run with the goal unfinished.` : ""}` : ""}${nudge ? `\nNOT SO FAST: ${nudge}` : ""}

Reply with ONE JSON object and nothing else:
{"action":"click|fill|press|select|expect|goto","locator":"<expression>","value":"<text>","note":"<why>","done":false,"reason":""}

Rules:
- "locator" is a Playwright locator EXPRESSION built from the roles and accessible names
  above. Pick the one that describes INTENT, in this order of preference:
    1. getByRole('button', { name: 'Sign in' }) — a role plus its accessible name. This is
       your default. It is what a human would say out loud, and it survives a redesign.
    2. getByLabel('Email'), getByPlaceholder('Search'), getByAltText('Logo'),
       getByTitle('Close'), getByTestId('cart') — when there is no useful role/name pair.
    3. getByText('Welcome back') — for genuine prose only, and last.
  getByText on a bare number or a single character — getByText('1') — is a LAST RESORT.
  That is a badge or a counter: it names nothing, it tells a future reader nothing, and it
  stops matching the moment the count changes. Look in the snapshot for a role and name
  wrapping it and use that instead. But last resort means last resort, not banned: if the
  snapshot really offers nothing better, take it. The locator you record has to be one that
  actually worked in the browser — never one that merely reads well. When a preferred form
  fails, fall DOWN this list rather than trying three variations of the same idea.
  Options allowed: name, exact, level, checked, selected, pressed, expanded, disabled.
  .first(), .last() and .nth(2) are allowed and are sometimes exactly right — but they are
  not a reflex. Reach for a more specific name first; use them when the position genuinely
  is what you mean. CSS selectors, XPath and regexes are REJECTED.
- READ THE SNAPSHOT LITERALLY. The role printed there is the role Playwright will match,
  and a node shown as \`generic\` has NO targetable role — the text after its colon is its
  content, not an accessible name. getByRole('link', …) or getByRole('button', …) aimed at
  a \`generic\` node will NEVER match, however much it looks like a link on screen (a cart
  badge in an <a> without an href is exactly this). For a \`generic\`, getByText on that text
  — with .first() when the text nests and so matches twice — is the only handle there is,
  and reaching for it there is correct, not lazy.
- Omit "locator" for goto and put the URL in "value".
- "expect" asserts the locator resolves to exactly ONE visible element, and — if you supply
  a "value" — that the element's text contains it. It is strict: a locator matching several
  elements FAILS, so name the one you mean.
- ASSERT AS YOU GO. This trace is turned into a real test, and a test that only proves
  nothing threw is worthless. After each meaningful state transition — a login landing, an
  item entering a cart, a form being accepted, a new page — your next action is one
  "expect" proving it happened, on something visible in the snapshot above.
  Assert only text you can actually see there. Never assert text you merely expect.
- ONE assertion per transition, and never the same one twice. Read ALREADY DONE before you
  assert: if that locator is already asserted there, the transition is covered — get on
  with the flow. Repeating an assertion burns a step and proves nothing new.
- Your last action before "done" must be an "expect" on the end state the goal describes
  (the order confirmation, the welcome message, the final heading).
- Set "done": true with a "reason" once the goal is achieved AND asserted, or if it is
  impossible from here.
- Exactly one action per reply. Do not batch, do not explain outside the JSON.`
}
