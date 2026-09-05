"""Render the four committed receipts into one proof image."""

import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROOF = ROOT / "proof" / "live-runs"
OUT = ROOT / "proof" / "receipts.png"

BG = (13, 17, 23)
FG = (201, 209, 217)
DIM = (110, 118, 129)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
ACCENT = (88, 166, 255)
RULE = (33, 38, 45)

MONO = "/System/Library/Fonts/Menlo.ttc"
S = 2  # supersample factor


def font(size, bold=False):
    return ImageFont.truetype(MONO, size * S, index=1 if bold else 0)


rows = []
for d in sorted(PROOF.iterdir()):
    r = json.loads((d / "receipt.json").read_text())
    rows.append(
        {
            "id": d.name[:8],
            "created": r["created_at"],
            "task": r["task"].get("name", "homepage"),
            "passed": r["evaluator"]["passed"],
            "status": r["buyer"]["status"],
            "score": r["reputation"]["score"],
            "shot": r["verifier"]["evidence"]["screenshot.png"],
            "checks": r["evaluator"]["checks"],
        }
    )
rows.sort(key=lambda x: x["created"])

W, H = 1280, 660
img = Image.new("RGB", (W * S, H * S), BG)
draw = ImageDraw.Draw(img)


def text(x, y, s, size=15, color=FG, bold=False):
    draw.text((x * S, y * S), s, font=font(size, bold), fill=color)


def rule(y, x0=48, x1=W - 48, color=RULE):
    draw.rectangle([x0 * S, y * S, x1 * S, y * S + S], fill=color)


text(48, 44, "Four live Solari Browser runs. Three paid, one refunded.", 22, FG, True)
text(
    48,
    80,
    "The refused run finished cleanly and returned real evidence.",
    16,
    DIM,
)

y = 132
cols = [48, 168, 300, 420, 560, 660]
heads = ["RUN", "TASK", "DECISION", "BUDGET", "SCORE", "SCREENSHOT SHA-256"]
for x, h in zip(cols, heads):
    text(x, y, h, 12, DIM, True)
rule(y + 22)

y += 38
for r in rows:
    ok = r["passed"]
    color = GREEN if ok else RED
    text(cols[0], y, r["id"], 15, FG)
    text(cols[1], y, r["task"], 15, FG)
    text(cols[2], y, "pass" if ok else "fail", 15, color, True)
    text(cols[3], y, r["status"], 15, color)
    text(cols[4], y, f"{r['score']:.3f}", 15, FG)
    text(cols[5], y, r["shot"][:32] + "...", 15, ACCENT if not ok else DIM)
    y += 34

rule(y + 6)
y += 26
text(
    48,
    y,
    "Same screenshot. Same hash. Opposite settlement.",
    17,
    ACCENT,
    True,
)
y += 30
text(
    48,
    y,
    "example.com/pricing serves a soft 404, so the Seller delivered the homepage:",
    14,
    DIM,
)
y += 22
text(
    48,
    y,
    "navigation resolved, session recorded, 17 KB screenshot, 6-event rrweb replay, no exception.",
    14,
    DIM,
)

y += 44
fail = rows[-1]
text(48, y, "evaluator checks, run " + fail["id"], 12, DIM, True)
y += 26
order = ["url", "title", "heading", "screenshot_nonempty", "replay_nonempty"]
for i, name in enumerate(order):
    ok = fail["checks"][name]
    x = 48 + (i % 3) * 300
    yy = y + (i // 3) * 28
    text(x, yy, ("PASS  " if ok else "FAIL  ") + name, 14, GREEN if ok else RED)

y += 84
rule(y)
y += 18
text(
    48,
    y,
    "A completion check pays for this run. The task contract is what refuses it.",
    15,
    FG,
)
y += 26
text(
    48,
    y,
    "budget refunded  |  reputation 1.000 -> 0.750  |  carried into the next receipt",
    14,
    DIM,
)

text(48, H - 44, "python main.py --verify proof/live-runs/<run-id>/receipt.json", 13, DIM)

img.resize((W, H), Image.LANCZOS).save(OUT)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
