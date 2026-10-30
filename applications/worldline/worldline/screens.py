"""Small SVG evidence renderers for non-GUI and offline runs."""

from __future__ import annotations

import html
from pathlib import Path


def write_terminal_screen(path: Path, title: str, lines: list[str], badge: str) -> None:
    visible = lines[:14]
    text = "".join(
        f'<text x="76" y="{158 + index * 31}" class="row">{html.escape(line[:108])}</text>'
        for index, line in enumerate(visible)
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="bg" x1="0" x2="1"><stop stop-color="#0d1210"/><stop offset="1" stop-color="#1c2b22"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#bg)"/><rect x="42" y="38" width="1196" height="644" rx="22" fill="#101512" stroke="#354039"/>
<circle cx="78" cy="75" r="8" fill="#ff7067"/><circle cx="104" cy="75" r="8" fill="#f6c453"/><circle cx="130" cy="75" r="8" fill="#63ce8c"/>
<text x="72" y="120" font-family="Arial" font-size="24" font-weight="700" fill="#eaf1e9">{html.escape(title)}</text>
<rect x="1080" y="87" width="116" height="33" rx="16" fill="#c9fb69"/><text x="1138" y="109" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="#101512">{html.escape(badge.upper())}</text>
<style>.row{{font: 19px 'Courier New',monospace;fill:#afc1b4}}</style>{text}
<rect x="72" y="612" width="1136" height="1" fill="#303a34"/><text x="72" y="650" font-family="Arial" font-size="15" fill="#77847b">Worldline · remote execution evidence</text>
</svg>"""
    path.write_text(svg, encoding="utf-8")
