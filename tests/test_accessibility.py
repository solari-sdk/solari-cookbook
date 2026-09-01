from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SURFACES = (ROOT / "app" / "static" / "index.html", ROOT / "static-console" / "index.html")
STYLES = (ROOT / "app" / "static" / "style.css", ROOT / "static-console" / "styles.css")


def _html(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_document_language_title_main_and_single_h1() -> None:
    for path in SURFACES:
        html = _html(path)
        assert re.search(r"<html\b[^>]*\blang=[\"']en[\"']", html, re.I), path
        assert re.search(r"<title>\s*[^<]+\s*</title>", html, re.I), path
        assert re.search(r"<main\b", html, re.I), path
        assert len(re.findall(r"<h1\b", html, re.I)) == 1, path


def test_form_controls_have_label_or_aria_name() -> None:
    for path in SURFACES:
        html = _html(path)
        for match in re.finditer(r"<(input|select|textarea)\b([^>]*)>", html, re.I):
            attrs = match.group(2)
            if re.search(r"\btype=[\"']hidden[\"']", attrs, re.I):
                continue
            identifier = re.search(r"\bid=[\"']([^\"']+)[\"']", attrs, re.I)
            assert identifier, f"{path}: unnamed {match.group(1)}"
            control_id = re.escape(identifier.group(1))
            has_aria = bool(re.search(r"\baria-label(?:ledby)?=[\"'][^\"']+[\"']", attrs, re.I))
            has_for = bool(re.search(rf"<label\b[^>]*\bfor=[\"']{control_id}[\"']", html, re.I))
            has_wrapping_label = bool(re.search(rf"<label\b[^>]*>.*?\bid=[\"']{control_id}[\"'].*?</label>", html, re.I | re.S))
            assert has_aria or has_for or has_wrapping_label, f"{path}: #{identifier.group(1)} has no accessible label"


def test_buttons_have_text_or_accessible_name() -> None:
    for path in SURFACES:
        html = _html(path)
        for attrs, body in re.findall(r"<button\b([^>]*)>(.*?)</button>", html, re.I | re.S):
            text = re.sub(r"<[^>]+>", "", body).strip()
            has_aria = bool(re.search(r"\baria-label(?:ledby)?=[\"'][^\"']+[\"']", attrs, re.I))
            assert text or has_aria, f"{path}: button lacks accessible name"


def test_visualizations_expose_accessible_names() -> None:
    for path in SURFACES:
        html = _html(path)
        for tag in ("canvas", "svg"):
            for attrs in re.findall(rf"<{tag}\b([^>]*)>", html, re.I):
                assert re.search(r"\baria-label=[\"'][^\"']+[\"']", attrs, re.I), f"{path}: {tag} lacks aria-label"


def test_keyboard_focus_and_reduced_motion_are_explicit() -> None:
    for path in STYLES:
        css = path.read_text(encoding="utf-8")
        assert ":focus-visible" in css, path
        assert "outline:" in css, path
        assert "prefers-reduced-motion:reduce" in css, path
