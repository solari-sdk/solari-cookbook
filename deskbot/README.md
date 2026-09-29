# Deskbot

An autonomous GUI automation agent that uses **only Solari's desktop**
product — the third submission alongside [`qa-agent`](../qa-agent)
(browser+sandbox) and [`code-agent`](../code-agent) (sandbox), since the
challenge counts single-product demos too ("browsers, sandboxes,
**and/or** desktops").

## Deliberately vision-free

The obvious way to build a desktop agent is a computer-use loop: screenshot
in, click/type decision out (see the cookbook's own
[`desktop-computer-use-py`](../examples/desktop-computer-use-py) example,
where that loop is hardcoded rather than model-driven). `qa-agent`'s README
documents why that's not available here: none of the 11 Mistral models this
AWS account can reach on Bedrock support image input — tested live, not
assumed (`ValidationException` on one, consistent `ServiceUnavailableException`
on every image attempt on the other).

Rather than fake a vision loop or skip the desktop product entirely, Deskbot
is designed around that real constraint: it acts **blind**. It drives the
GUI with known-good coordinates and keyboard input, and checks its own work
the only way it can without eyes — reading real files back with `shell`
(`desktop.exec`), never by looking at a screenshot. A GUI click either had
the effect a file on disk proves it had, or the agent doesn't get to claim
it worked.

## Results (live runs against real Bedrock + Solari, not mocks)

- **Genuinely verified GUI save.** Default task run end to end: opened
  mousepad, typed a 3-line note, saved via the GUI Save-As dialog, and the
  file's content was confirmed byte-for-byte from a fresh `cat` called by
  `main.py` itself *after* the model's `finish` - not the model's own report.
  `matches_expected: True`. See
  [`reports/report-20260904-195249.md`](reports/report-20260904-195249.md).
- **Two real bugs found and fixed via screenshot-assisted debugging** (the
  developer looking at a screenshot to diagnose a wiring issue - not the
  agent, which never sees one):
  1. `keyboard.hotkey(*keys)` sends each key as a separate press/release
     instead of a held chord - `hotkey(["ctrl","shift","s"])` let the `s`
     leak into the document as a literal character instead of triggering
     Mousepad's Save As shortcut, confirmed by comparing before/after
     screenshots and the typed text gaining a stray `s`. Fixed in
     `agent/solari_tools.py` by joining into a single combo string
     (`"ctrl+shift+s"`), which the guest's xdotool passthrough chords
     correctly - confirmed via `xdotool getactivewindow getwindowname`
     reporting `Save As` afterward.
  2. `keyboard.type("line1\nline2")` silently drops the `\n` - Mousepad
     received `line1line2` concatenated, not two lines. Fixed by typing
     each line separately with an explicit `key_press("Return")` between
     them; documented as a known fact in the system prompt since the model
     has no way to discover this itself without vision.
- **The first (buggy) run correctly refused to fabricate success.** Before
  either fix, Deskbot ran the full task, tried five different keyboard
  sequences, checked `shell` after each one, found the file missing every
  time, and honestly reported `success: false` with the real failure
  reasoning instead of guessing it had worked - see
  [`reports/report-20260904-194851.md`](reports/report-20260904-194851.md)
  for the full blind-debugging transcript.

## The verification discipline (same principle as `qa-agent`/`code-agent`)

- `finish`'s `proof` field must cite the exact shell command and exact
  output the model saw — not what it expects to be true.
- If the task produces a file, the model sets `file_path` /
  `expected_content`, and **after** the run ends, `main.py` independently
  `cat`s that file itself (`agent/verify.py`) — a check written by us, not
  the model, and called from our own code after `finish`, before the report
  is allowed to say "independently verified."

## Architecture

```
main.py
  -> Orchestrator (agent/orchestrator.py)
       tools: open_app / click / type_text / hotkey / key_press / shell  -> DesktopToolkit (desktop only)
              finish                                                       -> ends the run, records outcome
  -> verify.py independently re-reads file_path via `shell`, called from main.py
  -> report.py writes reports/report-<timestamp>.md
```

`agent/solari_tools.py` is the only file that talks to Solari directly; its
call patterns (`connect()` before driving the GUI, polling `health()` for
X11 readiness, the mousepad-text-area-is-at-(320,300) fact) are copied from
the cookbook's own `desktop-computer-use-py` example. `agent/bedrock_client.py`
is copied verbatim from `qa-agent` — a product-agnostic Bedrock wrapper.

## Setup

1. `cd deskbot && pip install -r requirements.txt`
2. Copy `.env.example` to `.env` and fill in `SOLARI_API_KEY` and AWS
   credentials with Bedrock Mistral model access — identical requirements to
   `qa-agent`/`code-agent`, see `qa-agent`'s README for the exact steps.
3. `python main.py`

The default task opens mousepad, types a 3-line note, saves it via the GUI
Save dialog, and independently verifies the saved file's content. Give it
your own:

```sh
python main.py --task "Open mousepad, type 'hello world', save it as /root/hello.txt" --max-steps 20
```

## Known rough edges

- **Only mousepad's coordinates are pre-verified.** The system prompt gives
  the model one known-good fact (the mousepad text area is reliably
  clickable at (320, 300) on a 1280x720 screen); everything else about
  driving the GUI — the save dialog's exact key sequence, whether Thunar or
  LibreOffice behave the same way — is something the model has to discover
  empirically via `shell`-based checks within the run, not something this
  project has pre-verified. Tasks outside mousepad text-editing are
  correspondingly less reliable.
- **No independent check for non-file tasks.** `verify.py` only re-checks
  `file_path` claims. A task with no resulting file has no automated
  cross-check beyond the transcript itself — same limitation `code-agent`
  has for tasks with no `service_url`.
- **Desktop pool capacity.** Per the cookbook's own desktop example: if
  `create()` hangs or errors, the desktop pool may have no warm hosts —
  sandboxes and browsers are unaffected, this is desktop-specific.

## Cost note

Every run spins up one desktop VM (screen + X11 + VNC, pricier than a plain
sandbox) on first tool call, billed against your Solari balance. Bedrock
inference is billed per-token by AWS separately — see `qa-agent`'s README
for the same note on model cost.
