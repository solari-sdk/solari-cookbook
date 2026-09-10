/**
 * Self-healing E2E — replay a test on a cloud browser, and repair it when a
 * release moves the DOM out from under it.
 *
 * The loop this shows, end to end, in one file:
 *
 *   record  a run on a Solari session with `recording: true`
 *   replay  the same steps deterministically against a new build
 *   heal    ask a model for a new selector when a step stops matching
 *   verify  re-run the WHOLE spec with the repair — a healer that is never
 *           re-verified is just a plausible-sounding guess
 *   evidence  one static HTML page linking the Solari replay of each session
 *
 * The "app under test" is two inline HTML strings served with
 * `page.setContent()`, so the recipe has no server, no build step, and nothing
 * to install past the Solari SDK. Swap them for your real URLs.
 */
import { Solari, type BrowserSession } from "@solarisdk/browser"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** The Playwright-compatible page type, derived so we don't import Playwright. */
type Page = Awaited<ReturnType<BrowserSession["newPage"]>>

const STEP_TIMEOUT_MS = 3_000
const EVIDENCE_DIR = "evidence"

// ---------------------------------------------------------------------------
// The app under test: one build that works, one release that broke it.
// ---------------------------------------------------------------------------

const PRISTINE = `<!doctype html>
<meta charset="utf-8"><title>Depot</title>
<body style="font:15px system-ui;max-width:32rem;margin:3rem auto">
<section id="signin">
  <h1>Sign in</h1>
  <input id="email" placeholder="Email">
  <input id="password" type="password" placeholder="Password">
  <button id="sign-in">Sign in</button>
</section>
<section id="order" hidden>
  <h1>Order #4182</h1>
  <textarea id="note" placeholder="Delivery note"></textarea>
  <button id="approve" class="approve">Approve order</button>
</section>
<section id="done" hidden>
  <p id="confirmation">Order approved</p>
</section>
<script>
  const show = (id) => {
    for (const s of document.querySelectorAll("section")) s.hidden = s.id !== id;
  };
  document.getElementById("sign-in").onclick = () => show("order");
  document.getElementById("approve").onclick = () => show("done");
</script>
</body>`

// The release that broke the test, as the three replacements it really was.
// Only the RENAME bites: a moved element with a stable id is exactly the kind
// of change a test should survive, and `#note` does.
const DRIFTED = PRISTINE.replace(
  `<h1>Order #4182</h1>\n  <textarea id="note" placeholder="Delivery note"></textarea>`,
  `<textarea id="note" placeholder="Delivery note"></textarea>\n  <h1>Order #4182</h1>`,
)
  .replace(
    `id="approve" class="approve"`,
    `id="confirm-order" class="btn-primary"`,
  )
  .replace(`getElementById("approve")`, `getElementById("confirm-order")`)

// ---------------------------------------------------------------------------
// The spec. A recorded trajectory compiles down to this same shape, which is
// why healing a step means rewriting one field of one object.
// ---------------------------------------------------------------------------

interface Step {
  action: "fill" | "click" | "expect"
  selector: string
  /** Text to type, for `fill`. */
  value?: string
  /** Substring the element must contain, for `expect`. */
  text?: string
}

const SPEC: Step[] = [
  { action: "fill", selector: "#email", value: "ops@depot.test" },
  { action: "fill", selector: "#password", value: "hunter2" },
  { action: "click", selector: "#sign-in" },
  // Scoped, not a bare `h1`: the sign-in view has one too, and a locator that
  // matches two elements is a strict-mode failure, not a passing step.
  { action: "expect", selector: "#order h1", text: "Order #4182" },
  { action: "fill", selector: "#note", value: "Leave at the loading dock" },
  { action: "click", selector: "#approve" },
  { action: "expect", selector: "#confirmation", text: "Order approved" },
]

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface Failure {
  index: number
  step: Step
  error: string
  /** The DOM as it actually was — the only thing a healer can reason from. */
  dom: string
}

type ReplayResult = { ok: true } | ({ ok: false } & Failure)

async function runStep(page: Page, step: Step): Promise<void> {
  const locator = page.locator(step.selector)
  if (step.action === "fill") {
    await locator.fill(step.value ?? "", { timeout: STEP_TIMEOUT_MS })
    return
  }
  if (step.action === "click") {
    await locator.click({ timeout: STEP_TIMEOUT_MS })
    return
  }
  // Assert VISIBLE before reading. `innerText` on an element that is not being
  // rendered falls back to `textContent` (that is the HTML spec, not a bug), so
  // without this an `expect` happily passes against a hidden section — a false
  // green in exactly the tool whose job is to not produce one.
  await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS })
  const seen = await locator.innerText({ timeout: STEP_TIMEOUT_MS })
  if (!seen.includes(step.text ?? "")) {
    throw new Error(
      `expected ${JSON.stringify(step.text)}, saw ${JSON.stringify(seen)}`,
    )
  }
}

/**
 * Run the spec against a FRESH page. Stops at the first failing step.
 *
 * Fresh matters, and this one bit hard: two `setContent()` calls on the same
 * page reuse one JS realm, so the fixture's top-level `const` throws
 * "already declared" the second time, the inline script never installs its
 * handlers, and every later step fails for a reason that has nothing to do
 * with the thing under test. A real runner starts each attempt clean; so does
 * this one.
 */
async function replay(
  browser: BrowserSession,
  html: string,
  spec: Step[],
  label: string,
): Promise<ReplayResult> {
  const page = await browser.newPage()
  await page.setContent(html)
  for (const [index, step] of spec.entries()) {
    try {
      await runStep(page, step)
      console.log(
        `  ${label} ${index + 1}/${spec.length} ${step.action} ${step.selector} — ok`,
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      console.log(
        `  ${label} ${index + 1}/${spec.length} ${step.action} ${step.selector} — FAILED: ${message}`,
      )
      return {
        ok: false,
        index,
        step,
        error: message,
        dom: await page.content(),
      }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Healers. Both answer the same question — "which selector should this step
// use now?" — and both are held to the same re-verification afterwards.
// ---------------------------------------------------------------------------

/** Scripts and styles are noise to a healer and burn most of the token budget. */
function trimDom(dom: string, limit = 4_000): string {
  const stripped = dom
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
  return stripped.length > limit ? `${stripped.slice(0, limit)}…` : stripped
}

function healPrompt(failure: Failure): string {
  return [
    "An end-to-end test step no longer matches the page after a release.",
    `Step: ${JSON.stringify(failure.step)}`,
    `Error: ${failure.error}`,
    "Current DOM:",
    trimDom(failure.dom),
    "",
    'Reply with JSON only, no prose and no code fence: {"selector": "<css selector>"}',
    "The selector must identify the element that now serves the step's purpose.",
  ].join("\n")
}

/** The model replies in prose more often than anyone admits. Take the object. */
function parseSelector(reply: string): string {
  const match = reply.match(/\{[\s\S]*?\}/)
  if (!match)
    throw new Error(`no JSON object in healer reply: ${reply.slice(0, 200)}`)
  const parsed = JSON.parse(match[0]) as { selector?: unknown }
  if (typeof parsed.selector !== "string" || parsed.selector.trim() === "") {
    throw new Error(`healer reply has no selector: ${match[0].slice(0, 200)}`)
  }
  return parsed.selector.trim()
}

/** Any OpenAI-compatible /chat/completions: OpenAI, OpenRouter, Ollama, … */
async function healWithOpenAiCompatible(failure: Failure): Promise<string> {
  const baseUrl = process.env.HEALER_BASE_URL ?? "https://api.openai.com/v1"
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.HEALER_API_KEY ?? ""}`,
    },
    body: JSON.stringify({
      model: process.env.HEALER_MODEL ?? "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: healPrompt(failure) }],
    }),
  })
  if (!response.ok) {
    throw new Error(
      `healer HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
    )
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error("healer returned no message content")
  return parseSelector(content)
}

/** The Claude Code CLI, non-interactively. Uses the reader's own subscription. */
async function healWithClaudeCli(failure: Failure): Promise<string> {
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", healPrompt(failure), "--output-format", "json", "--restricted"],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  // `--output-format json` emits either the result object or the whole message
  // array depending on the CLI version. The result is the last element either
  // way, and its `result` field is the model's raw text.
  const payload = JSON.parse(stdout) as unknown
  const last = Array.isArray(payload) ? payload[payload.length - 1] : payload
  const text = (last as { result?: unknown }).result
  if (typeof text !== "string")
    throw new Error("claude CLI returned no result text")
  return parseSelector(text)
}

type HealerName = "openai" | "claude" | "none"

function selectHealer(): HealerName {
  const explicit = process.env.HEALER?.trim().toLowerCase()
  if (explicit === "openai" || explicit === "claude") return explicit
  if (explicit) throw new Error(`unknown HEALER ${JSON.stringify(explicit)}`)
  return process.env.HEALER_API_KEY ? "openai" : "none"
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

interface SessionRecord {
  label: string
  id: string
  replayUrl: string | null
}

/**
 * The upload happens asynchronously AFTER the session is released, so the first
 * poll usually 404s even on a perfectly good recording. Retry before concluding
 * there is no replay. (And the session must have been created with
 * `recording: true` — without it this endpoint 404s forever.)
 */
async function pollReplayUrl(
  solari: Solari,
  id: string,
  attempts = 20,
): Promise<string | null> {
  let lastError = ""
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { url } = await solari.sessions.getReplayUrl(id)
      return url
    } catch (error) {
      // Say WHY on the way out. A silent null here reads as "no recording"
      // when it may equally be a plan limit or a wrong session id.
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
  }
  console.log(`  no replay for ${id} after ${attempts} polls: ${lastError}`)
  return null
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  )

interface Report {
  healer: HealerName
  failure: { index: number; step: Step; error: string } | null
  proposedSelector: string | null
  reVerified: boolean
  sessions: SessionRecord[]
}

/** One row per step; the drifted step is marked healed or failed, not passed. */
function stepRows(spec: Step[], report: Report): string {
  const drifted = report.failure?.index ?? -1
  const statusOf = (index: number): string =>
    index !== drifted ? "passed" : report.reVerified ? "healed" : "failed"
  return spec
    .map((step, index) => {
      const status = statusOf(index)
      return `<tr class="${status}"><td>${index + 1}</td><td>${step.action}</td><td><code>${escapeHtml(step.selector)}</code></td><td>${status}</td></tr>`
    })
    .join("\n")
}

async function writeEvidence(
  report: Report,
  healedSpec: Step[],
): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  const sessions = report.sessions
    .map(
      (session) =>
        `<li><b>${escapeHtml(session.label)}</b> — <code>${escapeHtml(session.id)}</code><br>` +
        (session.replayUrl
          ? `<a href="${escapeHtml(session.replayUrl)}">rrweb replay (presigned, expires)</a>`
          : "replay not uploaded yet — fetch it with " +
            `<code>solari.sessions.getReplayUrl("${escapeHtml(session.id)}")</code>`) +
        "</li>",
    )
    .join("\n")
  const html = `<!doctype html>
<meta charset="utf-8"><title>Self-healing E2E run</title>
<style>
 body{font:15px system-ui;max-width:52rem;margin:3rem auto;color:#111}
 table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
 tr.failed{background:#fdecea} tr.healed{background:#e9f7ef}
 pre{background:#f6f8fa;padding:.8rem;overflow-x:auto}
</style>
<h1>Self-healing E2E run</h1>
<p>Healer: <code>${report.healer}</code> · re-verified: <b>${report.reVerified ? "yes" : "no"}</b></p>
<h2>Steps after healing</h2>
<table><tr><th>#</th><th>Action</th><th>Selector</th><th>Status</th></tr>
${stepRows(healedSpec, report)}
</table>
<h2>Drift</h2>
<pre>${escapeHtml(report.failure ? `${report.failure.step.selector}\n${report.failure.error}` : "none")}</pre>
<h2>Proposal</h2>
<pre>${escapeHtml(report.proposedSelector ?? "no healer configured")}</pre>
<h2>Solari sessions</h2>
<ul>
${sessions}
</ul>`
  await writeFile(`${EVIDENCE_DIR}/index.html`, html)
  await writeFile(
    `${EVIDENCE_DIR}/run.json`,
    `${JSON.stringify({ ...report, healedSpec }, null, 2)}\n`,
  )
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** One recorded Solari session, closed (and therefore released) before return. */
async function inSession<T>(
  solari: Solari,
  sessions: SessionRecord[],
  label: string,
  body: (browser: BrowserSession) => Promise<T>,
): Promise<T> {
  // Recording is per session, not per account: without this flag the replay
  // endpoint 404s forever.
  const browser = await solari.launch({ recording: true })
  sessions.push({ label, id: browser.id, replayUrl: null })
  try {
    return await body(browser)
  } finally {
    // Give rrweb a moment to flush the events it batched, then close — which
    // also releases the session, which is what starts the replay upload.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await browser.close()
  }
}

async function main(): Promise<number> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set — see .env.example")
  const healer = selectHealer()
  console.log(`healer: ${healer}`)

  const solari = new Solari({ apiKey })
  const sessions: SessionRecord[] = []
  let healedSpec = SPEC
  const report: Report = {
    healer,
    failure: null,
    proposedSelector: null,
    reVerified: false,
    sessions,
  }

  try {
    console.log("\nrun 1 — the build the test was recorded against")
    const first = await inSession(
      solari,
      sessions,
      "run 1 (pristine)",
      (browser) => replay(browser, PRISTINE, SPEC, "pristine"),
    )
    if (!first.ok)
      throw new Error(`the pristine build failed at step ${first.index + 1}`)

    console.log("\nrun 2 — after the release")
    const outcome = await inSession(
      solari,
      sessions,
      "run 2 (drifted + healed)",
      async (browser) => {
        const drifted = await replay(browser, DRIFTED, SPEC, "drifted")
        if (drifted.ok)
          throw new Error("the drifted build passed — the fixture is stale")
        report.failure = {
          index: drifted.index,
          step: drifted.step,
          error: drifted.error,
        }
        console.log(`  drift: ${drifted.step.selector} → ${drifted.error}`)

        if (healer === "none") return false
        const selector =
          healer === "openai"
            ? await healWithOpenAiCompatible(drifted)
            : await healWithClaudeCli(drifted)
        report.proposedSelector = selector
        console.log(`  proposal: ${drifted.step.selector} → ${selector}`)

        // Never let a healer silently pass. Re-run the WHOLE spec with the
        // repair from a fresh load — a repaired step that only works because of
        // state the failed run left behind is not a repair.
        healedSpec = SPEC.map((step, index) =>
          index === drifted.index ? { ...step, selector } : step,
        )
        const verified = await replay(browser, DRIFTED, healedSpec, "healed ")
        if (!verified.ok) {
          // Print BOTH attempts. A repair that relocates the failure is a
          // different bug from a repair that simply did not take.
          console.log(
            `  attempt 1: step ${drifted.index + 1} ${drifted.step.selector} — ${drifted.error}`,
          )
          console.log(
            `  attempt 2: step ${verified.index + 1} ${verified.step.selector} — ${verified.error}`,
          )
          console.log(`  DOM at failure: ${trimDom(verified.dom, 700)}`)
          return false
        }
        return true
      },
    )
    report.reVerified = outcome

    for (const session of sessions) {
      session.replayUrl = await pollReplayUrl(solari, session.id)
      console.log(
        `${session.label}: ${session.replayUrl ?? `no replay yet for ${session.id}`}`,
      )
    }
  } finally {
    // Required on @solarisdk/browser < 0.1.3, and harmless after: the client
    // keeps a loopback proxy open for connection retries, and that handle keeps
    // Node's event loop alive.
    await solari.close()
  }

  await writeEvidence(report, healedSpec)
  console.log(`\nevidence: ${EVIDENCE_DIR}/index.html`)
  if (report.reVerified) return 0
  console.log(
    healer === "none"
      ? "no healer configured — set HEALER in .env to repair the drift"
      : "the healer's repair did not survive re-verification",
  )
  return 1
}

process.exitCode = await main()
