"""Single source of truth for knobs. Everything else imports from here."""
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # one place, at import. Every module that imports config gets the keys.

# Vision model. Seen in the Claude Console sample request; pinned so a model rename is a one-line fix.
MODEL = "claude-sonnet-4-6"

# Screen geometry. 1280x720 is below Anthropic's 1568px image resize threshold, so the coordinates
# Claude returns are the coordinates Solari clicks. Go bigger and they silently drift.
SCREEN_W, SCREEN_H = 1280, 720
RESOLUTION = f"{SCREEN_W}x{SCREEN_H}"

SOLARI_BASE_URL = "https://api.getsolari.com"
DESKTOP_TEMPLATE = "default"

RUNS_DIR = Path("runs")  # per-run screenshots, action logs, checkpoints. Gitignored.