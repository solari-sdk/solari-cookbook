/**
 * Council calendar — list every Philadelphia City Council meeting this year as typed JSON. No AI.
 *
 * The calendar lives on a public meeting-management site whose grid is built
 * by an ASP.NET postback: there is no URL for "this year", only a dropdown
 * that defaults to "This Month". So the script does what a person would:
 * click Calendar, pick the year, wait for the grid to redraw, and read it.
 *
 * Cells are matched to fields by their column headers rather than position, so
 * an added or reordered column doesn't silently shift every value.
 */
import { writeFile } from "node:fs/promises"
import { Solari } from "@solarisdk/browser"

const SITE = process.argv[2] ?? "https://phila.legistar.com/"
const YEAR = String(new Date().getFullYear())
const GRID = "#ctl00_ContentPlaceHolder1_gridCalendar_ctl00"
const YEARS = "#ctl00_ContentPlaceHolder1_lstYears"
const MAX_PAGES = 20

type Meeting = { name: string; date: string; time: string }

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const browser = await solari.launch()
const meetings: Meeting[] = []

try {
  const page = await browser.newPage()
  await page.goto(SITE, { waitUntil: "domcontentloaded" })

  await Promise.all([page.waitForURL(/Calendar\.aspx/i), page.getByRole("link", { name: "Calendar", exact: true }).first().click()])
  console.log("opened :", page.url())

  // The year picker is a styled combobox, not a <select>: open it, then click the item.
  await page.click(`${YEARS}_Input`)
  await page.locator(`${YEARS}_DropDown li`, { hasText: new RegExp(`^${YEAR}$`) }).click()
  // Choosing an item posts the form back and redraws the grid.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {})
  const picked = await page.inputValue(`${YEARS}_Input`)
  if (picked !== YEAR) throw new Error(`year picker shows "${picked}", expected ${YEAR}`)
  console.log("year   :", picked)

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const rows = await page.$$eval(`${GRID} > thead th, ${GRID} > tbody > tr`, (els) => {
      // No named helpers in here: tsx wraps them in a `__name` call that doesn't exist in the page.
      // Telerik adds a "Data pager" header cell that has no column of its own; drop it so the
      // header count matches the cell count of a data row.
      const headers = els
        .filter((e) => e.tagName === "TH")
        .map((th) => (th as HTMLElement).innerText.trim())
        .filter((h) => h !== "Data pager")
      const [nameCol, dateCol, timeCol] = ["Name", "Meeting Date", "Meeting Time"].map((h) => headers.indexOf(h))
      return els
        .filter((e) => e.tagName === "TR" && e.querySelectorAll("td").length === headers.length)
        .map((tr) => {
          const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim())
          return { name: cells[nameCol], date: cells[dateCol], time: cells[timeCol] }
        })
    })
    meetings.push(...rows)

    // Large years spill onto more grid pages; follow "next" until it stops changing the grid.
    const next = page.locator(`${GRID} input.rgPageNext`)
    if (!rows.length || !(await next.count())) break
    const first = await page.locator(`${GRID} > tbody > tr`).first().innerText()
    await next.first().click()
    const moved = await page
      .waitForFunction(([sel, before]) => document.querySelector(`${sel} > tbody > tr`)?.textContent !== before, [GRID, first] as const, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (!moved) break
  }
} finally {
  await browser.close()
}

const outside = meetings.filter((m) => !m.date?.endsWith(YEAR))
if (!meetings.length) throw new Error("the grid had no meetings; the page may have changed")
if (outside.length) console.log(`warning: ${outside.length} rows are not dated ${YEAR}`)

await writeFile("meetings.json", JSON.stringify({ year: YEAR, results: meetings }, null, 2))
console.table(meetings.slice(0, 15))
console.log(`${meetings.length} meetings in ${YEAR}; all saved to meetings.json`)
