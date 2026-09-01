# Project Polished ✨

> An autonomous UI/UX revamp agent built on the Solari SDK.
> Drop a GitHub repo. Get a polished UI PR. No setup, no manual triage.

**Bounty submission** for the [Solari Cookbook](https://github.com/solari-sdk/solari-cookbook).
Tags: **@harrychow_**, **@getsolari**, **@im_roy_lee**.

---

## What it does

Project Polished is an end-to-end autonomous agent that takes any public
GitHub repo and ships a ready-to-merge pull request containing surgical UI/UX
fixes. The agent runs a 6-stage pipeline that exercises all three Solari
capability surfaces — **browser**, **sandbox**, and **desktop**:

```
   ┌────────────────┐     ┌──────────────┐     ┌────────────────┐
   │  Sandbox Clone │ ──▶ │  Dev Server  │ ──▶ │  Browser Drive  │
   │  (solari       │     │  npm install │     │  crawl routes,  │
   │   sandbox)     │     │  npm run dev  │     │  capture pages  │
   └────────────────┘     └──────────────┘     └───────┬────────┘
                                                       │
       ┌───────────────────────────────────────────────┘
       ▼
   ┌────────────────┐     ┌──────────────┐     ┌────────────────┐
   │ Vision Analyze │ ──▶ │ Desktop Fix  │ ──▶ │  Verify + PR   │
   │ (vision model  │     │ (solari       │     │  rebuild, push,│
   │  audits pages) │     │  desktop →    │     │  open PR       │
   └────────────────┘     │  VS Code)     │     └────────────────┘
                          └──────────────┘
```

| Stage          | Solari surface | What happens                                                  |
| -------------- | -------------- | ------------------------------------------------------------- |
| Sandbox Clone  | sandbox        | Fork target repo into isolated container                      |
| Dev Server     | sandbox        | `npm install` + boot dev server inside the sandbox             |
| Browser Drive  | browser        | Headless Chromium crawls routes, captures 1440×900 screenshots |
| Vision Analyze | (vision model) | WCAG 2.2 AA + UX heuristics audit on each capture             |
| Desktop Fix    | desktop        | Open VS Code, locate offending code, apply surgical patches    |
| Verify + PR    | browser + git  | Re-capture, `npm run build`, push branch, open PR              |

---

## Demo video

**📺 `demo/project-polished-demo.mp4`** — 28 seconds, 1440×900, H.264, no audio.

Shows the full pipeline running end-to-end against a demo repo.

---

## Run it locally

```bash
cd examples/project-polished

# Install dependencies
bun install

# Wire in your real Solari API key (already gitignored)
cp .env.local.example .env.local
# edit .env.local and drop in your slr_live_... key

# Boot the dashboard
bun run dev
```

Then open the URL shown in your terminal.

### Live mode vs. demo mode

- `SOLARI_LIVE_MODE=false` (default) — pipeline runs in fully simulated demo mode.
  The dashboard shows every stage running, screenshot captures, vision analysis,
  VS Code patches, and PR creation — but no real Solari API calls are made.
- `SOLARI_LIVE_MODE=true` — the `/api/solari/run` endpoint additionally POSTs
  to the real Solari API. Wire in the real `@solari/sdk` calls in
  `src/app/api/solari/run/route.ts` to enable live execution.

---

## Stack

- **Next.js 16** (App Router, Turbopack)
- **TypeScript 5** strict
- **Tailwind CSS 4** + **shadcn/ui** (New York)
- **Zustand** for client state
- **Framer Motion** for animations
- **Server-side API routes** proxy Solari SDK calls (key never exposed client-side)

---

## Sample issues the agent detects

1. **Primary CTA button overlaps hero image** (high · layout)
2. **Footer links fail WCAG AA contrast ratio** (critical · contrast)
3. **Pricing cards missing hover / focus affordance** (medium · interaction)
4. **Hero headline truncates on mobile breakpoint** (high · responsive)
5. **Form input lacks accessible label association** (medium · a11y)

Each issue is paired with a surgical code patch applied via the desktop stage.

---

## Bounty submission

This example is a submission for the Solari Cookbook bounty.

**Tagging the founders as required:**
- [@harrychow_](https://twitter.com/harrychow_)
- [@getsolari](https://twitter.com/getsolari)
- [@im_roy_lee](https://twitter.com/im_roy_lee) — took your advice: shipped this fast with AI pair programming.

---

## License

Inherits the cookbook's license.
