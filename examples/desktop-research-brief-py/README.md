# desktop-research-brief-py

An autonomous computer-use agent that produces a **cited competitive/technical research brief** on any
company or product, using nothing but a Solari Linux desktop, a browser, a text editor, and screenshots.

Give it a target and a homepage. It launches Chrome on a Solari Desktop, reads the site, plans which
subpages and web searches to run, navigates through real-world friction (crashed tabs, cookie banners,
login popups, captchas, certificate warnings), extracts findings with source URLs into a persistent
checkpoint, then opens Mousepad on the same desktop, pastes a cited Markdown brief, saves it via the
GUI, verifies the file, and hands you a download link.

No DOM. No selectors. No Playwright. Every decision is made from a 1280x720 screenshot. That is the
point: this is the failure-prone, long-horizon desktop work that reliable computer-use agents must
survive, and this example shows the engineering that makes them survive it.

```
python main.py --target "Pinetree Research" --homepage https://pinetree-research.com
```

A typical run: 9 plan tasks, ~30 desktop actions, ~30 model calls, 60-100 cited findings from 6-8
sources, one 900-word brief, 5-8 minutes, well under $1 in model usage. Sample output is in
[`sample_output/brief.md`](sample_output/brief.md).

## Why this exists

Everyone building agents needs to research competitors, prospects, or papers, and everyone does it the
same way: twenty tabs, a scratch document, an afternoon. This turns that into a command. It is also a
reference implementation of the reliability mechanisms a screenshot-driven agent needs - each one is
in the code with a comment naming the failure it prevents.

## Quickstart

Requirements: Python 3.10+, a Solari API key on a plan that includes Desktops (Starter or above;
see gotcha 1), an Anthropic API key.

```
git clone <your fork>
cd solari-cookbook/examples/desktop-research-brief-py
python -m venv .venv && . .venv/bin/activate        # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env                                  # then paste your two keys into .env
python -m checks.smoke                                # 40s: create VM, click, type, screenshot, destroy
python main.py --target "Pinetree Research" --homepage https://pinetree-research.com --max-tasks 3
python main.py --target "Pinetree Research" --homepage https://pinetree-research.com --resume
```

Watch it live: console.getsolari.com -> Desktops -> Open, while a run is in progress.

Outputs land in `runs/<target-slug>/`: `checkpoint.json` (all findings, visited URLs, every action and
observation), `frames/NNN.png` (every distinct screen the agent saw), `brief.md`.

## Architecture

Strict separation of perception -> planning -> action -> memory. No module reaches across.

| module | role | the failure it exists to prevent |
|---|---|---|
| `agent/session.py` | create -> connect -> ready -> yield -> **always** destroy | leaked VMs billing until timeout |
| `agent/perception.py` | screenshot -> immutable `Observation` with size check + digest | acting on a blank or mis-sized frame; needing a model call to detect "nothing changed" |
| `agent/brain.py` | every model interaction as a **forced tool call** (`decide`, `judge`, `extract`); lenient coordinate parsing; API retry with visible backoff | parsing prose; schema drift (`"393, 575"`); silent SDK retries hiding flakiness |
| `agent/actuator.py` | the only code that touches mouse/keyboard/clipboard; keysym chords; transport retry; settle detection; frame logging | one choke point for retries and logs; chords that arrive as separate keys |
| `agent/browser.py` | detect the browser, launch, maximise, navigate with **typed-URL read-back via clipboard** and an address-bar-aware judge | a corrupted URL becoming a Google search behind a captcha; trusting "a page loaded" |
| `agent/memory.py` | findings + visited URLs + action log in one atomic JSON checkpoint | re-fetching pages already read; losing everything on a crash; uncited facts |
| `agent/planner.py` | homepage screenshot + memory -> ordered tasks; **model proposes, code guarantees** required coverage | plans that forget funding/GitHub/jobs; invented URLs; stale years |
| `agent/loop.py` | observe -> reason (with memory) -> act -> update -> terminate; budget, stall detection, scroll cap, URL ground truth, per-task isolation, honest status | runaway cost; oscillation; one dead site killing the run; "done" with zero findings |
| `agent/report.py` | findings -> cited brief -> pasted into Mousepad -> saved via GTK dialog -> **read back and compared** | typing 900 words through xdotool; claiming a save that did not happen |
| `agent/chaos.py` | fault injection (transport errors, stale frames, 429s) for `checks/chaos` | reliability claims without evidence |

The action schema the model fills (`brain.ACTION_TOOL`): `click | double_click | right_click | type |
key | scroll | wait | done | fail`, with `x, y, text, keys, scroll_dy, memory_note, summary`. That
closed vocabulary is also the security boundary: the model cannot run commands, touch files, or
install anything. See "Safety".

## What "reliable" means here, concretely

Observed in real runs of this example, all recovered without human intervention:

- Chrome renderer crash ("Aw, Snap!" error code 5) on load -> retry reloaded, page read.
- CrunchBase behind a Cloudflare CAPTCHA -> detected, **not** bypassed, task marked failed with reason.
- LinkedIn sign-in popup -> dismissed with Escape, 20 findings extracted from the visible company card.
- Typed URL rewritten by Chrome autocomplete -> normalised comparison, no false alarm.
- Model returned `"x": "393, 575"` -> parsed; when still invalid, the error is fed back and the model retries.
- Model scrolled up/down indefinitely instead of clicking -> scroll cap, then forced choice.
- `python -m checks.chaos`: 15 injected faults (transport, stale frames, rate limits) in one run, 15 absorbed.

## Safety

The agent never defeats a security control. Certificate warnings, CAPTCHAs, login walls and paywalls
are hard stops in the system prompt and are marked `failed` by the loop. It never enters credentials.
Web page text is treated as data, never as instructions. Secrets live only in `.env` (gitignored) and
are read by the two official SDKs; they never enter a prompt, a log, the VM, or a screenshot. All
`exec` calls use argument lists, never shell strings. Report paths are `/root/reports/<slug>-<ts>.md`
with a `[a-z0-9-]` slug - nothing from the web becomes a path. Everything the model does happens inside
a disposable VM that holds no credentials and is destroyed at the end of the run.

## Gotchas (the things that bit us, so they will not bite you)

1. **Desktops need a paid plan.** On Free, `DesktopClient.create()` raises `PlanError: Desktop requires
   a paid plan` *after* auth succeeds, although the pricing page lists a desktop under Free. Starter
   (promo codes apply at checkout) unlocks it.
2. **`desktop.streamUrl` is a `wss://` socket, not a web page.** To watch live, open the session from
   console.getsolari.com -> Desktops.
3. **Destroyed sessions linger as "Stopped" rows** in the console. Delete them periodically.
4. **Key chords:** `keyboard.hotkey("ctrl", "l")` does *not* arrive as a chord on the default template.
   `keyboard.press("Control_L+l")` (X11 keysyms joined by `+`, one token) does. `actuator.key()`
   translates `ctrl+l` for you.
5. **`desktop.open(app, [url])` drops the arguments** (Chrome opens `about:blank`). Launch produces a
   window; every URL goes through the address bar.
6. **Chrome runs with `--no-sandbox`** and shows a permanent infobar; on the 2 GB default it hit
   renderer crashes. This example creates the VM with `mem_mb=4096` and retries loads.
7. **`mouse.scroll` direction is undocumented** in SDK 0.2.0. Scrolling here is `Page_Down`/`Page_Up`.
8. **Google captchas datacenter IPs** on the first query. Searches go through DuckDuckGo.
9. **Chrome autocomplete rewrites typed URLs** (trailing `/`, case). Compare normalised.
10. **`exec()` of a GUI binary has no display** on this template (the fallback "open URL via exec"
    is silent). `exec("xdotool", [...])` for window management does work.
11. **Mousepad runs as root** with a red warning banner above the text area; the GTK save dialog
    accepts an absolute path typed into the name field.
12. **Models return integers as strings** (`"294"`, `"393, 575"`). Coerce; never `<=` raw model output.
13. **Windows:** `.\.venv\Scripts\Activate.ps1` may need
    `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first.

## Cost and limits

Screen is 1280x720 - below Anthropic's image-resize threshold, so the pixels the model sees are the
pixels Solari clicks (change it and coordinates drift). Each `decide`/`judge`/`extract` is one image
call. A full run is ~30 calls on `claude-sonnet-4-6`, well under $1. `--max-actions` (default 90) is
a hard budget; `--timeout-min` (default 25) kills the VM even if this process dies.

## Extending

- Different target: change the two flags. Nothing is specific to Pinetree Research.
- Different sources: edit `planner.REQUIRED_SEARCHES` (guaranteed coverage) or let the model's plan
  stand alone by clearing it.
- Different output: `report.REPORT_TEMPLATE` is the brief's structure; `write_on_desktop` will paste
  anything you compose.
- Different editor/app: `report.write_on_desktop` is ~40 lines; swap `mousepad` for LibreOffice and the
  save dialog keystrokes.
- Different model: `config.MODEL`. Anything that supports images + tool use works; grounding quality
  varies.

## Checks

`checks/` holds the incremental gates the example was built with, in order. Run any with
`python -m checks.<name>` from this directory: `smoke`, `ground`, `nav`, `keys`, `memory`, `plan`,
`loop`, `report`, `chaos`. `memory` part A and `chaos` part A need no VM and no model.
