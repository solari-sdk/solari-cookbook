/**
 * Self-healing selectors — repair a broken selector instead of failing.
 *
 * A scraper dies when someone renames an id. The element is still there; only
 * its address changed. This captures a semantic description of the element
 * while the selector still works, then uses it to re-find the element after a
 * redesign.
 *
 * The part worth stealing: a repair is not accepted until a postcondition
 * confirms it. Without that check a confidently wrong answer reports itself as
 * a success, and you silently click the wrong button on every run after.
 */
import { Solari } from "@solarisdk/browser"

const page1 = `<main><section aria-label="Invoices"><h1>Invoices</h1>
  <button id="export-btn" name="export" onclick="document.getElementById('status').textContent='exported'"
    >Export CSV</button>
  <p id="status">ready</p></section></main>`

// The same page after a redesign: id, name, tag and label all changed.
const page2 = `<main><section aria-label="Invoices"><h1>Invoices</h1>
  <a href="#" id="cta-dl" name="download" role="button"
     onclick="document.getElementById('status').textContent='exported'">Download report</a>
  <p id="status">ready</p></section></main>`

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

const browser = await solari.launch()
try {
  const page = await browser.newPage()

  // 1. Learn: everything about the element except where it lives.
  await page.setContent(page1)
  const anchor = await page.evaluate((sel) => {
    const el = document.querySelector(sel)!
    return {
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      name: el.textContent!.trim(),
      near: [...el.parentElement!.children].map((c) => c.textContent!.trim()),
    }
  }, "#export-btn")
  console.log("learned  :", JSON.stringify(anchor))

  // 2. Break it.
  await page.setContent(page2)
  if ((await page.locator("#export-btn").count()) > 0) throw new Error("expected a break")
  console.log("broken   : #export-btn no longer matches")

  // 3. Candidates carry an index, never a selector, so the model cannot invent
  //    a selector that is not on the page.
  const candidates = await page.evaluate(() =>
    [...document.querySelectorAll("a,button,input")].map((el, idx) => ({
      idx,
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      name: el.textContent!.trim(),
      id: el.id,
    })),
  )

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "dots-studio/dots-3-note-preview:free",
      messages: [
        {
          role: "user",
          content:
            `This control moved:\n${JSON.stringify(anchor)}\n\n` +
            `Elements on the page now:\n${JSON.stringify(candidates)}\n\n` +
            `Which idx is the same control?`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "match", strict: true,
          schema: {
            type: "object",
            properties: { idx: { type: "integer" } },
            required: ["idx"], additionalProperties: false,
          },
        },
      },
    }),
  })
  const body = (await res.json()) as { choices: { message: { content: string } }[] }
  const { idx } = JSON.parse(body.choices[0]!.message.content) as { idx: number }
  const repaired = `#${candidates[idx]!.id}`
  console.log("repaired :", repaired)

  // 4. Verify. A repair you cannot check is a guess.
  await page.locator(repaired).click()
  const ok = (await page.locator("#status").innerText()).trim() === "exported"
  console.log(ok ? "verified : it does the same thing" : "REJECTED : postcondition failed")
  if (!ok) process.exitCode = 1
} finally {
  await browser.close()
  // REQUIRED in Node: the client keeps a loopback proxy open for connection
  // retries, and that handle keeps the event loop alive. Skip it and the
  // script prints its output and then hangs forever.
  await solari.close()
}
