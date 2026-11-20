# Council meeting calendar (TypeScript)

List every Philadelphia City Council meeting in the current year as JSON: name, date and time. The script opens the council's public legislation site, clicks Calendar, picks the current year in the date-range picker, waits for the grid to redraw, and reads every grid page. Results print as a table and are saved to `meetings.json`. No AI.

The non-obvious part is the picker: it is an ASP.NET combobox that posts the page back, and it defaults to "This Month", so there is no URL to jump straight to a year. The script checks the picker really shows the year afterwards and warns about any row dated outside it. Cells are mapped to fields by column header, not position, so a reordered column can't shift every value.

## Run

```bash
cd examples/browser-council-calendar-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start -- https://phila.legistar.com/
```

Source: [`index.ts`](index.ts)
