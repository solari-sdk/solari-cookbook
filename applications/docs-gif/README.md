# docs-gif

A how-to page goes in. A verified GIF comes out, embedded under the steps it shows.
Pages whose steps no longer work on the real app get flagged instead of illustrated.

The app runs in a Solari sandbox, a Solari browser clicks through it, and a checker
compares the screen before and after against the page's own words.

## Run

Node 24, npm, and three keys.

```bash
cd applications/docs-gif
npm install
cp .env.example .env       # then fill in the three keys below
npm run snapshot           # build the app snapshot on Solari once
npm run docs-generate      # record every page in docs/docs/how-to
npm run dev                # app on :3000, docs on :3001, to see the GIFs in place
```

| Variable | What it pays for | Where it comes from |
| --- | --- | --- |
| `SOLARI_API_KEY` | The sandbox, its snapshot and the browser | [console.getsolari.com](https://console.getsolari.com) |
| `AI_GATEWAY_API_KEY` | The planner and the checker, through Vercel's AI Gateway | Vercel dashboard, AI Gateway, API Keys |
| `TYPESAFE_API_KEY` | The click agent, TypeSafe's Jev model | [console.typesafe.ai](https://console.typesafe.ai), Keys. No TypeSafe account? The gateway serves Jev too: in `pipeline/jev.ts` use `https://ai-gateway.vercel.sh/typesafe/v1/systemone`, the gateway key and model `typesafe-ai/jev` |

The pipeline commands check their keys first and exit naming the missing one before
anything is billed. No GIFs are checked in; the first run makes them.

```bash
npm run docs-generate -- docs/docs/how-to/add-a-task.md   # one page
npm run docs-update       # only pages changed since the last commit
npm run snapshot          # again after changing app/ or pipeline/serve.ts
npm run clean             # strip embeds, delete GIFs and out/, reset the Tweak panel
```

## How a page becomes a GIF

1. **Plan.** A model reads the page and writes one goal per how-to section: the end
   state a reader should see, in one sentence. Conceptual sections get nothing.
2. **Record.** The click agent gets the goal and the page's accessibility tree, picks
   the next click, and says done when the screen shows the goal. Each click is a frame;
   the frames become a GIF with a cursor and a spotlight on what was clicked.
3. **Check.** The checker sees the first frame, the last frame and the goal, and answers
   yes or no with a reason. A no gets one retry, with the reason folded into the agent's
   instructions.
4. **Write.** A verified GIF lands in `docs/static/img` and is embedded at the end of its
   section. A failed one is kept as `.failed.gif` under `out/`, with the reason in
   `out/<run>/log.txt`, and the page is left alone.

## Try it: move a control, watch the docs follow

Open **Tweak the UI**, bottom right of the app on :3000. Move the Status filter to the
left, middle or right of the toolbar and press **Done**. That saves the layout, rewrites
the sentence in the docs that says where the filter is, and runs `npm run docs-update`,
which re-records only the pages git sees as changed. The panel shows each stage, then
links to the re-recorded page.

The docs are the source of truth. `app/tweaks.json` only remembers the layout, and it
is copied into the sandbox at the start of every run, so a moved control shows up in
recordings without a new snapshot.

## Try it: a page that lies

Rename the "Done" status to "Complete" in `app/tasks/data/data.tsx`, rebuild the
snapshot, and run `filtering-tasks.md`. The steps still click through, but the checker
sees rows reading Complete, not Done, and refuses the GIF. That is the failure this
exists to catch: a help page describing something the app no longer does.

## Where Solari comes in

- `npm run snapshot` puts Node, `app/` and `pipeline/serve.ts` in a base sandbox,
  installs, starts the app on port 3000, snapshots it and kills it. Every run after
  that boots from the snapshot and reaches the app through its preview URL.
- For each page the pipeline creates a browser session, connects Playwright over CDP,
  sends the sandbox's preview token as a header so the browser is let in, and releases
  the session when the page is done. No session lives longer than one page takes.
- Both are released in a `finally`, failed runs and Ctrl-C included.

## Layout

- `pipeline/` — `index.ts` runs the steps. `planner.ts`, `jev.ts` and `verifier.ts` are
  the three model calls. `sandbox.ts` and `browser.ts` are the Solari side. `gif.ts`
  stitches frames. `serve.ts` serves the app and the Tweak panel's endpoint.
- `app/` — the demo app the GIFs are recorded against: a task list on TanStack Table
  with faceted filters, sortable and hideable columns, and row selection.
- `docs/` — the Docusaurus site whose pages get rewritten.

The planner, agent and checker know nothing about the demo app. The snapshot script
does: it ships `app/` and starts `serve.ts`, so pointing this at another app means
changing those two things and the docs folder.
