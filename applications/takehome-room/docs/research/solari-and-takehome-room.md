# Solari and the takehome-room idea: research notes

Gathered on 2026-10-08. Sources are cited inline. "Primary" means the Solari docs, the Solari SDK packages on npm, or the cookbook repo on GitHub. "Secondary" means news, vendor listicles, or law-firm blogs. "Unverified" means nobody checked the claim against a primary source.

SDK citations refer to the npm packages `@solarisdk/desktop@0.1.3` and `@solarisdk/core@0.1.4`, unpacked on 2026-10-08.

## 1. The challenge

The user pasted a post from the founder of Pinetree Research. Nobody verified the post independently. It says:

- The role is a SWE intern at $300K annualized.
- No resume, cover letter, or grades.
- Fork `https://github.com/solari-sdk/solari-cookbook/`.
- Build a real use case with Solari browsers, sandboxes, or desktops.
- Publish it on a public GitHub account.
- Share it on LinkedIn or X and tag `@harrychow_` and `@getsolari`.
- The founder insists that you use AI to build it.
- They review every build that tags them, interview the ones they like, and can hire on the spot.

The salary and the identity of the author are unverified.

## 2. What Solari is

Solari is a paid cloud service. It rents three kinds of remote machines under one API key (`slr_live_...`). All usage bills to one credit balance. Source: [cookbook README](https://github.com/solari-sdk/solari-cookbook), [pricing](https://docs.getsolari.com/pricing).

| Product | What it is | Source |
| --- | --- | --- |
| Browser | A remote Chrome driven with Playwright or raw CDP. Options: stealth, proxies, captcha solving, profiles, recording. | [sessions](https://docs.getsolari.com/sessions) |
| Sandbox | A headless microVM for running code. Snapshot, fork, PTY, preview URLs. | [sandboxes](https://docs.getsolari.com/sandboxes) |
| Desktop (VM) | A sandbox with a Linux GUI and a live VNC stream. Mouse, keyboard, screenshots, shell, files, clipboard. | [desktops](https://docs.getsolari.com/desktops) |

SDK packages seen: `@solarisdk/browser`, `@solarisdk/sdk`, `@solarisdk/sandbox`, `@solarisdk/desktop`, `@solarisdk/core`, and a Python SDK. The docs list more languages at [docs.getsolari.com/languages](https://docs.getsolari.com/languages) (not opened). Solari also ships an MCP server ([docs.getsolari.com/mcp](https://docs.getsolari.com/mcp), not opened).

Solari markets itself as "cloud infrastructure for AI agents". Source: docs site meta description.

## 3. Platform facts for takehome-room

### Creating a desktop

`desktops.create()` accepts these options. Source: `@solarisdk/core@0.1.4` `dist/types.d.ts` (`CreateDesktopOptions`), and [desktops docs](https://docs.getsolari.com/desktops).

| Option | Meaning |
| --- | --- |
| `template` | Image to start from. Default `"default"`. |
| `cpu` | 1 to 8 vCPUs, default 2. A larger value is rejected with 400. |
| `memMb` | Up to 16384 MB, default 2048. A larger value is rejected with 400. |
| `resolution` | For example `"1280x720"`. Can change later with `display.set()`. |
| `record` | Records the session server-side. The response carries a presigned playback URL. |
| `idleTimeoutMs` | Rolling idle window. Replaces the deprecated `timeoutMs`. Default 30 minutes. |
| `ttlSeconds` | Time to live before the gateway releases the session. |
| `lifecycle` | `onTimeout: "pause"` (default) or `"kill"`, plus park, hibernate, and checkpoint settings. |
| `isolation` | `"dedicated"` (default) or `"hardened"`. `"shared"` is refused for desktops. |
| `metadata` | Caller-defined strings echoed onto the session. |
| `volumes` | Persistent volumes to mount. |

The size survives pause and resume. Source: [desktops docs](https://docs.getsolari.com/desktops).

`"hardened"` blocks outbound network. The SDK comment says this was verified on staging on 2026-09-23 and is "not yet independently verified on prod". Some hosts lack it and return `409 HostCapabilityMissing`. Source: `@solarisdk/core@0.1.4` `dist/types.d.ts` (`SandboxIsolation`).

If the desktop pool has no warm hosts, `create` can hang or return a capacity error. Source: [desktop-computer-use-py README](https://github.com/solari-sdk/solari-cookbook/tree/main/examples/desktop-computer-use-py).

### Live stream and the viewer

- `streamUrl` is a `wss://` URL that serves plain RFB (VNC) bytes. Source: `@solarisdk/core@0.1.4` `dist/types.d.ts` (`CreateDesktopResponse`).
- The control channel is a separate `wss://` URL (`controlUrl`) for JSON-RPC. So a stream link does not carry the control channel. Source: same file.
- The stream URL is minted at create time. `stream.start()` only returns it. `stream.stop()` does nothing ("nothing to tear down here"). Source: `@solarisdk/core@0.1.4` `dist/desktop.js`.
- `mountDesktop(element, { streamUrl, viewOnly, scaleViewport, background, onConnect, onDisconnect })` embeds the live view in a web page with noVNC. `viewOnly: true` renders without sending input. Source: `@solarisdk/desktop@0.1.3` `dist/viewer.d.ts`.
- The stream URL has no separate token. It is `wss://api.getsolari.com/stream/<sessionId>`, and the signed session id is the credential. Anyone with the link can see and control the desktop while it runs. Source: spike run on 2026-10-08.
- After `kill()`, the stream link stops working: the socket closes with code 1005. Source: spike run on 2026-10-08.
- `expiresAt` at create time was 15 minutes after creation, which equals the `idleTimeoutMs` the spike set. This suggests that `expiresAt` follows the idle window. Whether it extends with activity is untested.

### Recording

- `record: true` at create time makes the response carry a presigned `recordingUrl`. Source: `@solarisdk/core@0.1.4` `dist/types.d.ts`.
- `desktop.record.start()` returns the in-guest mp4 path and the frame rate. `desktop.record.stop()` returns the final path and size. The guest uploads the mp4 on `stop()`, so the URL resolves only after a start and a stop. Source: `@solarisdk/core@0.1.4` `dist/desktop.d.ts`, `dist/types.d.ts` (`RecordStartResult`, `RecordStopResult`), `dist/desktop.js`.
- The [desktops docs](https://docs.getsolari.com/desktops) and the [recording docs](https://docs.getsolari.com/recording) do not mention desktop recording. The recording docs cover browser sessions only.
- Desktop recording works. In the spike run on 2026-10-08, a 10 fps recording of about 4 minutes made a 2.5 MB MP4, which uploaded on `record.stop()` and stayed readable after `kill()`.
- `recordingUrl` is a presigned Google Cloud Storage link, valid for 7 days (`X-Goog-Expires=604800`). Anyone with the link can watch the video without a Solari key. Treat it as a secret, and copy the video to your own storage for longer retention.
- `resume()` does not return `recordingUrl`. `connect(id)` does. Source: `@solarisdk/desktop@0.1.3` `dist/client.d.ts`.
- Browser session replays are NDJSON event logs, not video. They capture input values by default, including passwords. Source: [recording docs](https://docs.getsolari.com/recording).

### Snapshots

- `snapshot(name?)` saves RAM and disk of a running machine and returns an id. The machine keeps running. Source: [snapshots docs](https://docs.getsolari.com/snapshots).
- `revert(id)` rewinds the same machine. Open connections drop and reconnect. Source: same page.
- `create({ fromSnapshot })` starts independent copies. Pass the same `memMb` as the source. Source: same page.
- Snapshot and revert need a running machine. A paused one returns `409 NotRunning`. Source: same page.
- Snapshots work the same way for desktops and sandboxes. Source: same page.

### Templates

- Built-in desktop templates: `default` and `workstation` (the same image today: XFCE with Chrome, LibreOffice, VS Code), `office`, and `code` ("VS Code and common dev tools"). Source: [templates docs](https://docs.getsolari.com/templates).
- Custom templates use a builder: `aptInstall`, `pipInstall`, `runCommands`, `env`, `workdir`, and `Image.fromTemplate("workstation")`. Uploading local files is not supported yet. Source: same page.
- Custom templates need a paid plan. On the free plan `POST /templates` returns 402. Source: same page.
- The same page says template builds are "gated the same way desktop creation is". The free plan still created a desktop from the `code` template in the spike run on 2026-10-08, so desktops do not need a paid plan.

### Idle timeout and lifecycle

- The idle timeout is rolling. Every action and every open connection resets it. A busy VM does not time out. Source: [desktops docs](https://docs.getsolari.com/desktops).
- A paused VM does not count against the plan's running-VM limit. Source: same page.
- `parkAfterMs` freezes the CPUs but keeps the slot, network, and live VNC stream. A parked VM still counts against the plan. Minimum 2 s. Source: same page.
- `hibernateAfterParkedMs` escalates a long park to a full pause. Source: same page.
- `checkpointEveryMs` takes durable checkpoints, minimum 60 s. Source: same page.
- `connect(id)` re-attaches by id and resumes a paused VM. Source: same page and `@solarisdk/desktop@0.1.3` `dist/client.d.ts`.

## 4. Pricing and limits

Source: [pricing](https://docs.getsolari.com/pricing), read on 2026-10-08.

| | Free | Starter | Professional | Enterprise |
| --- | --- | --- | --- | --- |
| Monthly fee | $0 | $20 | $200 | Custom |
| Monthly credits | $3 | $20 | $200 | Custom |
| Max session time | 1 hour | 5 hours | 24 hours | Unlimited |
| Browser rate | $0.15/h | $0.10/h | $0.07/h | $0.05/h |
| Concurrent browsers | 3 | 20 | 150 | 150+ |
| Stealth mode | No | Yes | Yes | Yes |
| Per vCPU-hour | $0.0525 | $0.035 | $0.0245 | $0.0175 |
| Per GB-hour | $0.0165 | $0.011 | $0.0077 | $0.0055 |
| Concurrent sandboxes and VMs | 1 | 2 | 10 | 50+ |

- VMs add $0.02 per hour for the live screen.
- Credits refill monthly and do not roll over. Solari does not bill past the balance.
- Snapshot storage: $0.05 per GB-month, pro-rated daily, from 2026-10-01. The first 10 GB per organization are free.

Worked cost of one 3-hour interview on Starter, 4 vCPU and 8 GB:

```
4 × $0.035 + 8 × $0.011 + $0.02 = $0.248 per hour
3 hours × $0.248 = $0.744
```

This covers the machine only. The $20 monthly fee is extra. If the candidate uses a model on the company's key, AI usage is the largest per-interview cost. A 3-hour Claude Code or Cursor session can cost several dollars or more (estimate, unverified).

## 5. Gotchas

The source is the [cookbook README](https://github.com/solari-sdk/solari-cookbook), except where a line names another source.

- Sandbox commands are not run by a shell. `run("ls -la")` looks for a binary named `ls -la`. Pass `args`, or run `sh -c`.
- `kill()` ends a VM. `close()` drops only the local control channel, and the VM runs until its idle timeout.
- `timeoutMs` is a rolling idle window, not a deadline.
- `commands.run` waits for the process to exit. Background a server with `sh -c "nohup ... &"`. Source: [sandbox-port-preview-ts](https://github.com/solari-sdk/solari-cookbook/blob/main/examples/sandbox-port-preview-ts/index.ts).
- `previewUrl(port)` returns a URL with a `?pt_token=` parameter. Appending a path by string puts it inside the query and the gateway answers 401. Use `new URL()`. Source: [PR #44](https://github.com/solari-sdk/solari-cookbook/pull/44) (closed, not merged).
- The `base` sandbox ships Node 18, but `@solarisdk/browser` needs Node 20 or later. Source: [PR #34](https://github.com/solari-sdk/solari-cookbook/pull/34) (open).
- The Playwright wire protocol is version-gated. The server rejects a client with a different version with 428. CDP has no version gate. Source: README and [browser-playwright-runner-ts](https://github.com/solari-sdk/solari-cookbook/tree/main/examples/browser-playwright-runner-ts).
- On a plain `launch()` with no proxy, `browser.contexts()` is empty. Fall back to `newContext()`.
- A profile does not seed the browser on its own. Pass `session.storageState` to `newContext({ storageState })`.
- Browser recording is per session. Without `recording: true` the replay endpoint returns 404. The upload is async, so poll for about 30 s.
- The TypeScript browser SDK cannot run on edge runtimes. Use raw CDP from Workers. Source: [browser-workers-cdp-ts](https://github.com/solari-sdk/solari-cookbook/tree/main/examples/browser-workers-cdp-ts).
- Browser sessions reportedly end about ten minutes after creation regardless of activity. Source: [PR #37](https://github.com/solari-sdk/solari-cookbook/pull/37) and its issue 25 (unverified, and possibly fixed since).

## 6. Cookbook landscape on 2026-10-08

Counts from the GitHub API on 2026-10-08:

- 481 forks. 259 were pushed after forking. About 200 have commits that `main` lacks.
- About 80 PRs in total. Repo created 2026-08-18.

The [applications README](https://github.com/solari-sdk/solari-cookbook/tree/main/applications) sets these rules for an application:

- It runs end to end with only a `slr_live_` key.
- `.env.example` lists only the variables that the code reads.
- It has no `CLAUDE.md`, no `AGENTS.md`, and no untouched scaffolding.
- It makes no claims that the code does not support.

### Clusters

| Cluster | Examples (PR number or fork) |
| --- | --- |
| AI QA agents and test tools | GoblinQA (#41), Sentinel/Forge/Deskbot (#54), ghostspec (#9), self-healing-e2e-ts (#50), qa-intern-ts, autonomous-qa-ts, nightshift-qa-ts, preflight-qa-agent-ts, Replaywright, FlakeProof (#26), flake-conviction, crux (#76), browser-flake-tenfold-ts |
| Proving an agent's work | Worldline (#20, merged), PatchProof (#48), Verified Agent Runtime (#16), proofloop, AgentProof, DoneLedger, blackbox-agent-receipts, HITO (#78), pay-on-pass (#14) |
| Bug reproduction | twin (#91), ReproLab (#92), repropub-ts, thrice-jaeger, one-in-twenty (#36), bug-repro-ts |
| Agent benchmarks and reliability | perturbation suite (#59), solari-agentbench, Agent Crash Lab, agent-reliability-lab, passk, AgentGauntlet, solari-arena-py, pulse (#10) |
| Scrapers and research agents | price-watcher-ts, pricescope, price-radar-ts, Vantage (#75), webscout, competitor-radar, gtm-researcher, solari-osint-cookbook, tariff-radar, desktop-research-brief (#11) |
| Business-workflow agents | TrustFill (#45), ProcureLens (#73), billing audit (#46), Nightshift AP close, bom-sourcing, legal-research-agent-ts, closing-rescue |
| Job portals | portal-watch-ts (#72), job-board-monitor, jobber, solari-career-autopilot-ts |
| Coding-agent infrastructure | agentinstance (#88), wsp (#85), sleeper AFK agent, github-issue-resolver-ts, PatchPilot |
| MCP wrapper | solari-mcp (fork by thevenice) |
| Other | docs GIFs that re-record (#90), LocaleLens, EU consent evidence (#18, merged), consent-geo-diff, Gauntlet code reviewer, lanparty, ExecKit |

### What maintainers merged

The maintainers merged small, correct examples and fixes:

- Fixes: profile restore (#17, #52), recording poll message (#51), browser close for SDK 0.1.3 (#47).
- Examples: Workers raw CDP (#43), page assertions (#53), Ruby quickstart (#7), audit-hook scan (#32), sentinel concurrency (#31), EU consent evidence (#18), form delivery check (#4).
- Other: the Worldline application (#20), SAST and CI workflows (#86).

### Empty areas

No project found on accessibility, consumer or fun apps (lanparty is the exception), education, or candidate-side hiring.

### Closest hiring project

Solari Screener ([TCYTseven/solari-hr-pipeline](https://github.com/TCYTseven/solari-hr-pipeline)) finds forks of this challenge and boots each one in a sandbox. A Claude agent then demos each fork in a browser or desktop with recording, and the tool scores it. It works on the reviewer side and judges finished submissions. takehome-room works on the candidate side and runs the interview itself.

## 7. Competitors and market

All secondary.

- HackerRank sells AI-Assisted Interviews as an add-on. Interviewers watch the candidate use an AI assistant with inline completions, file-aware chat, and an agent mode, in HackerRank's own IDE. Source: [HackerRank help article](https://hackerrank-knowledge-base.help.usepylon.com/articles/5821380141), updated 2026-04-22.
- SHL Coding Interview lists an IDE for 50+ languages and full record and replay. Source: [SHRM vendor directory](https://vendordirectory.shrm.org/company/353951/products/233374/shl-coding-interview).
- HackerEarth lists session recording and playback, AI summaries, and panel video. Source: [HackerEarth roundup 2026](https://www.hackerearth.com/blog/top-coding-interview-platforms-2026) (vendor-written).
- CoderPad and CodeSignal: no detail found on AI IDEs or replay. Unverified.
- Canva requires candidates for backend, ML, and frontend roles to use AI tools such as Copilot, Cursor, or Claude in technical interviews. Source: [Scroll, 2025-06-16](https://scroll.media/en/2025/06/16/canva-requires-engineers-to-use-ai-in-interviews/).
- Meta pilots AI-enabled coding interviews for a small group of candidates. Source: [TechRadar](https://www.techradar.com/pro/meta-is-going-to-let-candidates-use-ai-in-job-interviews), [Business Insider](https://www.businessinsider.nl/meta-will-let-some-job-candidates-use-ai-in-their-coding-interviews/). Its current scope is unverified.
- Anthropic reportedly bans AI use in its interviews. Source: TechRadar, as above.

takehome-room differs from these. The candidate gets a full Linux desktop and uses real tools (Cursor, Claude Code, a terminal, a browser) on an open-ended task. The reviewer gets video, git history, and hidden test results on one page. It is open source and runs on the company's own Solari key.

## 8. Legal notes

Secondary sources. Not legal advice.

- Under GDPR, recording a candidate is processing personal data. You need a lawful basis, a notice of rights, and a retention and deletion policy. Regulators often doubt that consent from job applicants is freely given, because of the power imbalance. Source: [tl dv](https://tldv.io/blog/can-i-record-a-job-interview/).
- If AI analyzes interview video, the Illinois Artificial Intelligence Video Interview Act applies. It requires notice, an explanation of the AI, consent, limited access, and deletion within 30 days of a request. Source: [Winston & Strawn](https://www.winston.com/en/blogs-and-podcasts/privacy-law-corner/illinois-regulates-the-use-of-ai-in-video-interviews), [bill text](https://ilga.gov/legislation/101/hb/10100HB2557.htm).
- If a tool computes face or voice data, Illinois BIPA applies. Plaintiffs sued online proctoring vendors under it. Source: [Fora Soft](https://www.forasoft.com/learn/elearning-video/articles-elearning/proctoring-data-privacy-legal-landscape).
- Design consequence: record the screen only, with no webcam and no audio. Ask for consent in the invitation email. Set a deletion schedule. Do not run AI analysis on the video without the Illinois disclosures.

## 9. Open risks to test first

1. VNC lag. Tested on 2026-10-08: about 5 minutes of typing in VS Code through the console's View tab felt "a little slow but fine". The tester was in India (UTC+5:30), and the desktop's region is unknown. A full 2 to 3 hour session is untested.
2. AI key exposure. Anything inside the VM is readable by the candidate. Use a proxy with a spending cap, or let candidates sign in to their own AI accounts.
3. Hidden tests. Keep them outside the VM until the end. Run them on a copy made with `fromSnapshot`, so the candidate's final state stays untouched.
4. Setup time. Installing tools and signing in takes time. Preinstall a generous set in a custom template. Start the clock on a "Start" button. Allow 10 to 15 minutes of setup that does not count.
5. Stream link lifetime. Answered: the link stops working after `kill()`. It cannot be revoked any other way, because `stream.stop()` is a no-op and the link is the session id. So `kill()` ends the Candidate's access. Never show the raw link to the Reviewer.
6. Session length. Untested: whether a busy desktop lives past its first `expiresAt`, up to the plan's maximum session time (1 hour on free, 5 hours on Starter).
6. Idle settings. Do not enable `parkAfterMs` for interviews. Parking can freeze the VM while a candidate reads quietly. The desktops docs say an open connection resets the idle timer. Test this.
7. Recording length. The size of a 3-hour mp4 at the default frame rate is unknown. Its upload time is also unknown.
8. Capacity. If the pool has no warm hosts, desktop creation can fail. Starter allows 2 desktops at a time and 5-hour sessions.

## 10. Idea history

| Idea | Why dropped |
| --- | --- |
| PR preview checker (sandbox + preview URL + Playwright + replay per PR) | GitHub Actions runs Playwright free on public repos. Railway, Render, and Heroku give per-PR environments. The testing space in the cookbook is also crowded. |
| MCP safe runner | Developers rarely adopt tools that only make them safer. Partial overlap with Anthropic sandbox runtime, MCP Cage, and Boomi's gateway. |
| Safe `npx` (`snpx`) | Same reason. `npxc` ([tomchuk/npxc](https://github.com/tomchuk/npxc)) has 94 downloads on crates.io and runs only on Apple Silicon. |
| Screen reader tester (Orca on a desktop) | BrowserStack (NVDA, alpha) and Assistiv Labs already run real screen readers in the cloud. |
| Hyperbeam-style shared browser | The VNC stream has no documented audio and a low frame rate, so watch parties fail. Shared control needs a custom arbiter. |
| Candidate-portal or job-board tracker for super-impress | Automated logins and stealth on third-party portals risk breaking terms of service. At least four forks already do it. |
| Visual regression for Cloudflare Workers | Percy, Chromatic, Applitools, Argos, Lost Pixel, BackstopJS, and Playwright `toHaveScreenshot()` exist, and Cloudflare Browser Rendering takes screenshots natively. |
| Computer-use agent eval grid | The user declined it. Also, Starter allows only 2 desktops at a time. |
| "Run it" README button | Not pursued. Owner pays for strangers' compute, and abuse is a risk. |
| Dev box for parallel coding agents, `remote` command, shareable bug repros | The user did not take them up. |
| GUI-to-API bridge, dependency upgrade checker, resume render check | Not pursued. |
| Multiplayer browser with an agent in the room | Not pursued. |
| Onboarding tester | Overlaps with form-delivery-check and the QA cluster. |

takehome-room was chosen because:

- No fork or PR builds a candidate-side interview environment.
- It fits a company that is hiring through this exact challenge.
- It needs a full desktop with recording and snapshots, which Solari provides and GitHub runners do not.
- It has no third-party terms-of-service risk.
- Demand exists: Canva requires AI in interviews, and Meta pilots it.
- The machine cost is about $0.74 for a 3-hour interview on Starter.

## 11. Facts measured while building (2026-10-08)

These come from live runs on the free plan, not from the docs.

- The `code` desktop template runs Ubuntu 22.04.5 with VS Code, Git 2.34.1 and Python 3.10.12. It has no Node, npm, Cursor or Claude Code. A 2 vCPU / 2 GB desktop had 2 CPUs, 1.98 GB of RAM and only 477 MB of free disk.
- `exec()` on a desktop runs as `root` with no `HOME`. The GUI session (`xfce4-session`) runs as the user `desktop`, with home `/home/desktop`. Files written as root must be handed to `desktop` with `chown`, or VS Code cannot save them. `runuser -l desktop -c "…"` runs a command as that user.
- The SDK viewer `mountDesktop()` loads `@novnc/novnc/lib/rfb.js` through a dynamic import that bundlers cannot follow. noVNC 1.7.0 exports only `./core/rfb.js`, so that path is blocked anyway. Source: `@solarisdk/desktop@0.1.3` `dist/viewer.js` and `@novnc/novnc@1.7.0` `package.json`. Using noVNC's `RFB` class directly works.
- `viewOnly` is a setting in the viewer page only. The stream itself accepts input from anyone who has the link. A Reviewer must never receive the raw stream link.
- Calling `close()` on a desktop handle makes the SDK print a warning that includes the full session id, which is the stream credential. Server logs can therefore contain live desktop credentials.
- A full Interview (open the Room, commit, submit, collect, run hidden tests in a fresh `base` sandbox) took about 14 seconds of machine time end to end. The `base` sandbox has `python3`.
- On the free plan, one desktop and then one sandbox ran one after the other without a concurrency error, because the desktop was killed before the sandbox started.

## 12. Pause, resume and kill (measured 2026-10-09)

These come from live runs on the free plan with `@solarisdk/desktop@0.1.3` and `@solarisdk/sandbox@0.1.4`.

- `onTimeout: "pause"` did not fire in practice. A desktop with a 60 s idle window, no stream and no control channel stayed `ready` more than 3 minutes past its `expiresAt`. Every `get()` call also reset the idle clock: `expiresAt` moved to the time of the call plus the idle window.
- `desktop.pause()` works. It took up to about 60 s to reach `paused`. For that time, `get()` still reported `ready` while the control channel was already dead ("Not connected").
- After a resume, files and running apps survive (VS Code was still open), the session id stays the same, and the original stream URL works again. A resume takes about 10 s. During it, the stream and the control channel refuse connections.
- `autoResume: true` is undocumented. Opening the stream of a paused desktop woke it once and not on a second try. Opening the stream always failed at first (closed with code 1005).
- Recording survives a pause. `record.stop()` after a resume uploaded a full MP4. Whether the video covers the time both before and after the pause is unverified.
- A paused desktop that is killed can come back. Several times, `kill()` returned "ok" and the desktop later showed as `ready` or `paused` again. The account list (`GET /sandboxes`) showed such a desktop in some checks and not others, and `get()` and `list()` disagreed for a while. One leftover held the free plan's only slot, so every new desktop and sandbox failed with 429 `ConcurrencyLimitExceeded`.
- `DesktopClient.destroy()` and `SandboxClient.kill()` both stopped desktops in every test. An earlier note here said `destroy()` once left a desktop running. That was wrong: the running desktop was a different, live Room.
- On the free plan, a full Interview with a pause before Submit (pause, resume during collection, kill, grade) took about 2 to 2.5 minutes, and the hidden tests passed.
