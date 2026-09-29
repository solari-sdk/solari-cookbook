# Watchdog + fixer: a self-healing app (TypeScript)

Two LLM agents, two Solari products, one closed loop:

1. **Serve.** A small todo app — with one deliberate bug in [`app/app.js`](app/app.js) — is written into a Solari **sandbox** and served over `python3 -m http.server`, exposed on a public `previewUrl`.
2. **Watchdog** ([`src/watchdog.ts`](src/watchdog.ts)) launches a Solari **cloud browser**, hands an LLM a plain-English spec plus `click`/`type`/`read` tools, and lets it test the live app. On failure it captures a screenshot, the DOM, and any console errors as a structured bug report — and stops there. It never looks at the app's source.
3. **Fixer** ([`src/fixer.ts`](src/fixer.ts)) gets *only* that bug report, plus `read_file`/`write_file`/`run_command` tools scoped to the same sandbox. It reads the source, finds the bug, and patches it — live, since the server reads from disk on every request, so there's no restart step.
4. **Watchdog runs again** against the same URL to confirm the fix actually holds, rather than trusting the fixer's word for it.

Both agents share one tool-use loop ([`src/llm.ts`](src/llm.ts)); only their tools, system prompt, and handler differ. Each is forced to end its run through a single terminal tool call (`report` / `report_fix`) rather than free-form prose — that's what makes the watchdog's output structured enough for the fixer to consume unattended.

## Run

```bash
cd examples/watchdog-selfheal-ts
npm install
export SOLARI_API_KEY=slr_live_...      # https://console.getsolari.com
export ANTHROPIC_API_KEY=sk-ant-...     # https://console.anthropic.com
npm start
```

Expect output like:

```
sandbox: sbx_...
app live: https://....preview.getsolari.com

--- watchdog: first pass ---
bug found: Typed "Buy milk" and clicked Add, but no list item appeared.
console errors: [ 'ReferenceError: list is not defined' ]
evidence saved to .../out

--- fixer: patching inside the sandbox ---
fix applied: Replaced the undefined `list` reference with document.getElementById("todo-list"). [ 'app.js' ]

--- watchdog: confirming the fix ---
PASS: Typed "Buy milk", clicked Add, and it appeared in the todo list.
```

`out/bug-report.json` and `out/failure.png` are the watchdog's evidence from the first, failing pass.

## Gotchas this example encodes

- **The watchdog never sees the source, and the fixer never sees the browser.** That separation is the point — it's what makes the bug report in `types.ts` the actual interface between two otherwise-independent agents, closer to how you'd wire a real QA-bot-to-dev-bot pipeline than a single agent with every tool.
- **No restart needed after a fix.** The app is static files behind a plain HTTP server, so a `write_file` call is live on the sandbox's *next* request. A real app with a build step or a process to restart would need the fixer to run that step before the recheck.
- **The terminal tool is what ends the loop**, not the model falling silent — see `stopTool` in `llm.ts`. An agent that stops calling tools without invoking `report`/`report_fix` is treated as a failed run, not a silent pass.
- Swap `SPEC` in `index.ts` and the two files in `app/` for your own app and you have a generic "point this at a preview URL and self-heal it" harness.

Source: [`index.ts`](index.ts) · [`src/watchdog.ts`](src/watchdog.ts) · [`src/fixer.ts`](src/fixer.ts) · [`src/llm.ts`](src/llm.ts)
