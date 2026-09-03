# Session survival (TypeScript)

A Solari browser session ends about ten minutes after it starts, whatever you send it — six sessions measured from fully idle to a live screencast all ended 604–616 s after creation, and the sessions API kept reporting each dead one as `active` ([issue #25](https://github.com/solari-sdk/solari-cookbook/issues/25)). Any task longer than that dies in the middle.

[`outlive`](https://github.com/Sy-D/outlive) makes the death survivable: it checkpoints cookies, localStorage and the URL, notices the death on the connection (never through the status API), launches a new browser with that state, and calls your task again with `ctx.attempt` and `ctx.resumedFrom`. Measured against the live API with twelve-minute tasks: a plain browser finished 0 of 5, outlive 5 of 5, losing 4.9 s of work at the median.

What does not survive: the DOM and anything the page held in JavaScript. A task is written to be re-entered — checkpoint right after the step that must not run twice, and check for its effect on re-entry. The library puts that in the API instead of hiding it.

## Run

```bash
cd examples/browser-session-survival-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

The task polls a page every 20 s for twelve minutes. Around the ten-minute mark the session ends; you see the relaunch and the re-entry in the log, and the run finishes with all 36 polls.

Source: [`index.ts`](index.ts)

Part of a series with [`handraise`](https://github.com/Sy-D/handraise) ([browser-human-handoff-ts](../browser-human-handoff-ts)), which handles the other way an agent stops: a human is needed.
