# Fonts

Drop the two variable font files here to get the real faces:

- `ReferenceSans.woff2` — weights 100–900, used for all UI text
- `ReferenceDisplay.woff2` — weights 400–900, used for the hero headline and
  `.display` page titles

They are declared in `app/globals.css` and `app/vantage.css`. Until the files
are present the stack falls through to Geist and then the system sans, so the
layout is unaffected — only the typeface differs.
