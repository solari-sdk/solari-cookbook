# Accessibility and scale QA passes

## Accessibility baseline

The two reviewer-facing web surfaces (`app/static/` server dashboard and `static-console/`) are covered by automated structural accessibility regressions. The pass verifies:

- document language, title, main landmark and one primary heading;
- accessible names for form inputs/selects/textareas and buttons;
- accessible names for canvas/SVG visualizations;
- explicit high-visibility `:focus-visible` keyboard treatment; and
- `prefers-reduced-motion` handling.

Both surfaces use native labels around their form controls, native buttons for actions, and text/table alternatives for core operational data. Interactive graph/map visualization is supplementary rather than the sole representation of retained events or evidence.

This is a practical WCAG-oriented engineering pass, not a claim of third-party accessibility certification. External Leaflet internals and browser/assistive-technology combinations can vary, so future UI changes remain subject to regression coverage and manual reviewer feedback.

## Representative retained-data performance pass

`tests/test_scale_smoke.py` exercises a local single-host workload representative of the public showcase rather than a synthetic enterprise-scale claim:

- 5,000 normalized retained events across 20 logical sources and four categories;
- 300 content-addressed artifact records plus their files;
- 500-row full-text event retrieval; and
- retrieval of the 300-artifact catalog.

The test uses intentionally generous acceptance ceilings (30 seconds for each bulk insert phase, 5 seconds for the event query, and 10 seconds for artifact catalog retrieval) so it catches pathological regressions without pretending shared CI is a precision benchmark. It also verifies exact result counts. The project should move to PostgreSQL/distributed infrastructure only when measured deployment requirements exceed this documented SQLite/local-artifact boundary.
