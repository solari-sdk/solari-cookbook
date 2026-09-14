/**
 * Replay a browser test and catch the release that moved the DOM out from
 * under it.
 *
 * A recorded run compiles down to a list of steps. This replays them on a
 * Solari browser twice — against the build the test was recorded on, then
 * against the release that renamed the button it clicks — and prints the
 * failing step with the DOM it failed against, which is what any repair
 * (human or model) has to reason from.
 *
 * The "app under test" is two inline HTML strings served with
 * `page.setContent()`: no server, no build step, nothing to install past the
 * SDK. Swap them for your real URLs.
 */
import { Solari, type BrowserSession } from "@solarisdk/browser"

/** The Playwright-compatible page type, derived so we don't import Playwright. */
type Page = Awaited<ReturnType<BrowserSession["newPage"]>>

const STEP_TIMEOUT_MS = 3_000

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
// why repairing a step means rewriting one field of one object.
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
  /** The DOM as it actually was — the only thing a repair can reason from. */
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

/** Scripts are noise to whoever repairs the step; show the markup. */
const trimDom = (dom: string): string =>
  dom
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700)

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set — see .env.example")
  const solari = new Solari({ apiKey })
  const browser = await solari.launch()
  try {
    console.log("run 1 — the build the test was recorded against")
    const first = await replay(browser, PRISTINE, SPEC, "pristine")
    if (!first.ok) {
      console.log(`\nthe pristine build failed at step ${first.index + 1}`)
      return 1
    }

    console.log("\nrun 2 — after the release")
    const drifted = await replay(browser, DRIFTED, SPEC, "drifted ")
    if (drifted.ok) {
      console.log("\nthe drifted build passed — the fixture is stale")
      return 1
    }
    // Finding this is the point. Print what a repair would have to work from.
    console.log(
      `\ndrift: step ${drifted.index + 1} ${drifted.step.selector} — ${drifted.error}`,
    )
    console.log(`DOM at failure: ${trimDom(drifted.dom)}`)
    return 0
  } finally {
    await browser.close()
    // Required on @solarisdk/browser < 0.1.3, and harmless after: the client
    // keeps a loopback proxy open for connection retries, and that handle keeps
    // Node's event loop alive.
    await solari.close()
  }
}

process.exitCode = await main()
