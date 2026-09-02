/**
 * Reliability, in miniature.
 *
 * The idea behind AgentGauntlet, reduced to one file: run the same task twice —
 * once on a clean page, once with a cookie banner in the way — and judge each
 * run by the page's own state rather than by what the script thinks happened.
 *
 * That last part is the whole trick. An agent that reports success is not
 * evidence of success. Here the check is `isVisible()` on the confirmation the
 * page renders, which the script cannot fake.
 *
 * Two runs is not a benchmark. It is the smallest thing that shows the shape:
 * same task, different environment, independent verdict.
 */
import { Solari } from "@solarisdk/browser"

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("Set SOLARI_API_KEY — https://console.getsolari.com")
  process.exit(1)
}

/** A two-field signup, optionally behind a consent banner that blocks clicks. */
const page = (withBanner: boolean) => `data:text/html,${encodeURIComponent(`
<!doctype html><meta charset="utf-8"><title>Demo</title>
<style>
  body { font: 16px system-ui; padding: 2rem }
  #banner { position: fixed; inset: auto 0 0 0; background: #222; color: #fff; padding: 1rem }
  #done { display: none; color: #0a0 }
</style>
<h1>Sign up</h1>
<input id="email" placeholder="Email">
<button id="submit">Submit</button>
<p id="done">Signed up</p>
${withBanner ? `<div id="banner">We use cookies. <button id="accept">Accept</button></div>` : ""}
<script>
  document.getElementById("submit").onclick = () => {
    // The banner genuinely covers the button, exactly like the real thing.
    if (document.getElementById("banner")) return
    if (document.getElementById("email").value) document.getElementById("done").style.display = "block"
  }
  document.getElementById("accept")?.addEventListener("click", () => document.getElementById("banner").remove())
</script>`)}`

/** The agent. Deliberately naive: it never looks for an overlay. */
async function attempt(withBanner: boolean) {
  const solari = new Solari({ apiKey })
  try {
    const browser = await solari.launch()
    const p = await browser.newPage()
    await p.goto(page(withBanner))

    let steps = 0
    await p.fill("#email", "ada@example.com"); steps++
    await p.click("#submit"); steps++

    // The verdict comes from the page, not from the code above it.
    const passed = await p.locator("#done").isVisible()
    await browser.close()
    return { passed, steps }
  } finally {
    // Required in Node: the client holds a proxy that keeps the event loop alive.
    await solari.close()
  }
}

const variants = [
  { name: "baseline", banner: false },
  { name: "cookie_popup", banner: true },
]

const results = []
for (const v of variants) {
  const r = await attempt(v.banner)
  results.push({ variant: v.name, ...r })
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${v.name.padEnd(14)} ${r.steps} steps`)
}

const passed = results.filter((r) => r.passed).length
console.log(`\nReliability ${((passed / results.length) * 100).toFixed(0)}% (${passed}/${results.length})`)
console.log(
  passed === results.length
    ? "The agent survived every environment."
    : "The agent completes the task, but not when the environment changes.\n" +
        "That gap is what AgentGauntlet measures: https://github.com/Konuktor/agent-gauntlet",
)
