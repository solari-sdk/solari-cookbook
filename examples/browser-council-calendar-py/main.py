"""Council calendar — list every Philadelphia City Council meeting this year as typed JSON. No AI.

The calendar lives on a public meeting-management site whose grid is built by
an ASP.NET postback: there is no URL for "this year", only a dropdown that
defaults to "This Month". So the script does what a person would: click
Calendar, pick the year, wait for the grid to redraw, and read it.

Cells are matched to fields by their column headers rather than position, so an
added or reordered column doesn't silently shift every value.
"""

import asyncio
import json
import os
import re
import sys
from datetime import date
from typing import TypedDict

from solari_browser import Solari

SITE = sys.argv[1] if len(sys.argv) > 1 else "https://phila.legistar.com/"
YEAR = str(date.today().year)
GRID = "#ctl00_ContentPlaceHolder1_gridCalendar_ctl00"
YEARS = "#ctl00_ContentPlaceHolder1_lstYears"
MAX_PAGES = 20

READ_GRID = """els => {
  // Telerik adds a "Data pager" header cell with no column of its own; drop it so the
  // header count matches the cell count of a data row.
  const headers = els.filter(e => e.tagName === 'TH').map(th => th.innerText.trim()).filter(h => h !== 'Data pager')
  const col = name => headers.indexOf(name)
  return els
    .filter(e => e.tagName === 'TR' && e.querySelectorAll('td').length === headers.length)
    .map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim())
      return { name: cells[col('Name')], date: cells[col('Meeting Date')], time: cells[col('Meeting Time')] }
    })
}"""


class Meeting(TypedDict):
    name: str
    date: str
    time: str


async def main() -> None:
    solari = Solari(api_key=os.environ["SOLARI_API_KEY"])
    meetings: list[Meeting] = []
    browser = await solari.launch()
    try:
        page = await browser.new_page()
        await page.goto(SITE, wait_until="domcontentloaded")

        calendar = page.get_by_role("link", name="Calendar", exact=True).first
        await asyncio.gather(page.wait_for_url(re.compile(r"Calendar\.aspx", re.I)), calendar.click())
        print("opened :", page.url)

        # The year picker is a styled combobox, not a <select>: open it, then click the item.
        await page.click(f"{YEARS}_Input")
        await page.locator(f"{YEARS}_DropDown li", has_text=re.compile(f"^{YEAR}$")).click()
        # Choosing an item posts the form back and redraws the grid.
        try:
            await page.wait_for_load_state("networkidle", timeout=30_000)
        except Exception:
            pass
        picked = await page.input_value(f"{YEARS}_Input")
        if picked != YEAR:
            raise RuntimeError(f'year picker shows "{picked}", expected {YEAR}')
        print("year   :", picked)

        for _ in range(MAX_PAGES):
            rows: list[Meeting] = await page.eval_on_selector_all(f"{GRID} > thead th, {GRID} > tbody > tr", READ_GRID)
            meetings.extend(rows)

            # Large years spill onto more grid pages; follow "next" until it stops changing the grid.
            nxt = page.locator(f"{GRID} input.rgPageNext")
            if not rows or not await nxt.count():
                break
            first = await page.locator(f"{GRID} > tbody > tr").first.text_content()
            await nxt.first.click()
            try:
                await page.wait_for_function(
                    "([sel, before]) => document.querySelector(`${sel} > tbody > tr`)?.textContent !== before",
                    arg=[GRID, first],
                    timeout=15_000,
                )
            except Exception:
                break
    finally:
        await browser.close()
        await solari.close()

    if not meetings:
        raise SystemExit("the grid had no meetings; the page may have changed")
    outside = [m for m in meetings if not (m["date"] or "").endswith(YEAR)]
    if outside:
        print(f"warning: {len(outside)} rows are not dated {YEAR}")

    with open("meetings.json", "w") as f:
        json.dump({"year": YEAR, "results": meetings}, f, indent=2)
    for m in meetings[:15]:
        print(f"{m['date']:<12}{m['time']:<10}{m['name']}")
    print(f"{len(meetings)} meetings in {YEAR}; all saved to meetings.json")


if __name__ == "__main__":
    asyncio.run(main())
