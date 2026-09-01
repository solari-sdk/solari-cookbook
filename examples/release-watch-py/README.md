# Release Watch

A **real** Solari use case: build a launch packet for a public URL using all
three products behind one `slr_live_` key.

| Step | Product | What it does |
| --- | --- | --- |
| 1 | Cloud browser (`solari_browser`) | Stealth Chrome loads the page, reads the DOM, takes a PNG |
| 2 | Sandbox (`solari_sandbox`) | Persistent Python kernel scores copy, links, and CTAs |
| 3 | Desktop (`solari_desktop`) | GUI Chrome on a Linux VM; screenshot as human-review proof |

This is the loop a release or competitive-intel agent actually runs: see the
live site the way a user would, compute in isolation, then keep a screen
recording-grade still of the same URL.

## Run

```bash
cd examples/release-watch-py
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...    # https://console.getsolari.com
python main.py https://docs.getsolari.com
```

Useful flags:

```bash
python main.py https://getsolari.com --skip-desktop
python main.py https://example.com --out ./out
```

`--skip-desktop` still produces `brief.md` + `browser.png` (browser + sandbox
only). The desktop step is best-effort: if the GUI session fails, the packet
from steps 1–2 is kept.

## Output

| File | Source |
| --- | --- |
| `out/extract.json` | Browser DOM extract |
| `out/browser.png` | Playwright screenshot of the cloud session |
| `out/brief.md` / `out/brief.json` | Written by the sandbox kernel |
| `out/desktop.png` | X11 screenshot after opening Chrome |

## Why this is not a quickstart clone

The other examples teach one API each. Release Watch **composes** them: the
sandbox never sees the public internet for the page body (the browser already
fetched it), and the desktop never has to parse HTML. Each product does the
job it is for.

MIT, same as the rest of this cookbook.
