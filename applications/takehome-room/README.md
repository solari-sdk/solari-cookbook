# takehome-room

Take-home coding interviews in a real desktop. The candidate works in a recorded Linux desktop in their browser, with any AI tools they like. When the clock runs out, the reviewer gets the recording, the candidate's commits, and the results of tests the candidate never saw.

Built on [Solari](https://getsolari.com): each interview gets its own Solari desktop, and the hidden tests run in a fresh Solari sandbox.

Try it as the candidate at [takehome.nitanjana.com](https://takehome.nitanjana.com). The demo is a shorter task, and you get the reviewer's report for your own attempt at the end.

This folder is a copy of [nitan-jana/takehome-room](https://github.com/nitan-jana/takehome-room), where development continues. The screenshots load from there, because the cookbook does not keep screenshot files.

<picture>
  <source srcset="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/desktop-dark.webp" media="(prefers-color-scheme: dark)">
  <img src="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/desktop-light.webp" alt="The candidate at work in VS Code inside the remote desktop, under the bar with the work clock and the Submit button" width="720">
</picture>

## How an interview works

1. The reviewer creates an interview on the `/admin` page and gets two links. The reviewer sends the candidate link and keeps the reviewer link.

   <picture>
     <source srcset="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/admin-dark.webp" media="(prefers-color-scheme: dark)">
     <img src="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/admin-light.webp" alt="The reviewer page, with the form to create an interview, the two new links, and the list of interviews" width="560">
   </picture>

2. The candidate opens their link, agrees to the screen recording, and opens the desktop. It has VS Code, Git, and Python, with the task's starter files already committed.

   <picture>
     <source srcset="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/candidate-dark.webp" media="(prefers-color-scheme: dark)">
     <img src="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/candidate-light.webp" alt="The candidate page, with the two clocks, the recording notice, and the button to open the desktop" width="560">
   </picture>

3. Setup time (10 minutes by default) does not count. If the candidate presses Start, or if setup time ends, the work clock starts.
4. The interview ends at Submit or at the end of the clock. Then the server stops the recording, takes the task folder out of the desktop, and kills the desktop.
5. The hidden tests run against a copy of that folder in a new sandbox. They never enter the candidate's desktop.
6. The reviewer link shows the score, the video, the commits, the test output, and a download of the final folder.

   <picture>
     <source srcset="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/report-dark.webp" media="(prefers-color-scheme: dark)">
     <img src="https://raw.githubusercontent.com/nitan-jana/takehome-room/main/web/public/screenshots/report-light.webp" alt="A report: 7 of 9 hidden tests passed, the time used, the recording of the desktop, the commits, and the hidden test output" width="560">
   </picture>

The server owns the clock. The timer in the browser is only a display.

## What it uses from Solari

| Feature | Where |
| --- | --- |
| Desktops from the `code` template, with `record: true` | [src/solari/room.ts](src/solari/room.ts) |
| The desktop's live stream, shown with noVNC | [web/src/components/RoomScreen.tsx](web/src/components/RoomScreen.tsx) |
| `record.start()` and `record.stop()`, then the MP4 from `recordingUrl` | [src/solari/room.ts](src/solari/room.ts) |
| `pause` on idle, and `resume` on the candidate's return | [src/solari/room.ts](src/solari/room.ts) |
| A `base` sandbox for the hidden tests | [src/solari/grader.ts](src/solari/grader.ts) |
| Metadata tags and `listAll()` to find leftover desktops | [scripts/sweep.ts](scripts/sweep.ts) |

## Run it locally

You need Node 22.9 or later, pnpm, and a Solari API key from [console.getsolari.com](https://console.getsolari.com). The free plan works. If you do not have pnpm, run `corepack enable` first.

```bash
cd applications/takehome-room
pnpm install
cp .env.example .env    # then set SOLARI_API_KEY and ADMIN_TOKEN
```

For development, run the API and the web app in two terminals:

```bash
pnpm run dev:api         # API on port 3101
pnpm run dev:web         # web app on port 3100, which sends /api to 3101
```

Open http://localhost:3100/admin, enter your `ADMIN_TOKEN`, and create an interview. To run one server as in production:

```bash
pnpm run build
pnpm start               # everything on PORT, 3000 by default
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs the unit tests. They use in-memory fakes, so they need no key and spend no credit. |
| `pnpm run typecheck` | Type-checks the server and the web app. |
| `pnpm run new lru-cache` | Creates an interview from the terminal and prints both links. |
| `pnpm run e2e` | Runs a full interview against Solari, with a script as the candidate. Expect 9 / 9. Add `broken` for a buggy solution, or `paused` to pause the desktop before Submit. Costs a few cents of credit. |
| `pnpm run sweep` | Kills tagged desktops whose interview has ended. It only lists desktops whose interview is not in `DATA_DIR`. |

## Settings

All settings are in [.env.example](.env.example). The important ones:

- `SOLARI_API_KEY`: your Solari key.
- `ADMIN_TOKEN`: turns on the `/admin` page. If it is empty, the page and its API stay off.
- `DATA_DIR`: where interviews, videos, and final folders are kept. On a host, point it at a persistent volume.
- `MAX_ROOMS`: how many desktops your plan allows at once. The free plan allows 1. Extra interviews wait instead of failing.
- `DEMO=on`: shows a "Try it as the candidate" demo on the home page. Demos are short, run one at a time, and are capped at `DEMO_DAILY_LIMIT` per 24 hours.

## Tasks

A task is a folder in [tasks/](tasks/): `task.json` for the title and times, `starter/` for the files the candidate gets, and `hidden/` for the hidden tests. The sample task, `lru-cache`, is a Python LRU cache with expiry. It has 3 visible and 9 hidden tests.

## Limits to know

- **The free plan runs one desktop at a time. Each session ends after 1 hour.** On the free plan, keep setup time plus work time under 60 minutes.
- **The `code` template has no Node, Cursor, or Claude Code**, and about 480 MB of free disk. Candidates can use AI tools in the browser, or install more during setup time. A custom template with more tools needs a paid plan.
- **The remote screen is a little slower than a local one.** The candidate page says so before they start.
- **The candidate can read everything inside the desktop.** That is why the hidden tests and any API keys never go there.
- **The hidden tests run the candidate's code in the same Python process.** A determined candidate can write code that changes the results. The recording and the commits are the check against that.
- **Solari's idle pause did not fire in testing.** Also, a desktop that was paused earlier sometimes came back after a kill. The server checks every kill and retries, and `pnpm run sweep` cleans up anything left over. [The research notes](docs/research/solari-and-takehome-room.md) record what was measured.

## Hosting

Run one instance of the server, never more: one process owns the clocks and the data folder. Mount a persistent volume and set `DATA_DIR` to it, or every deploy deletes the interviews. Build with `pnpm run build` and start with `pnpm start`.

## Code layout

| Path | What is there |
| --- | --- |
| [src/interview.ts](src/interview.ts) | The rules: phases, clocks, the slot, and the demo cap. Pure functions. |
| [src/flow.ts](src/flow.ts) | Moves interviews through the phases. It reaches the machines only through two ports, `Rooms` and `Grader`. |
| [src/solari/](src/solari/) | The Solari adapters for those ports. |
| [src/views.ts](src/views.ts) | What the candidate and the reviewer can see. The stream link reaches only the candidate. |
| [src/server.ts](src/server.ts) | The HTTP routes. [src/main.ts](src/main.ts) starts the server. |
| [web/](web/) | The web app: Vite, React, TanStack Router and Query, Tailwind. |
| [shared/api.ts](shared/api.ts) | The JSON types that the server and the web app share. |
| [test/](test/) | Unit tests, with fakes for Solari. |
| [scripts/](scripts/) | The live end-to-end test, the sweep, and the spikes that came before the build. |
| [docs/](docs/) | Research notes and decision records. [CONTEXT.md](CONTEXT.md) defines the words the code uses. |
