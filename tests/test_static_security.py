from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static-console"


def test_static_console_has_strict_script_policy_and_no_inline_script() -> None:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    assert "script-src 'self'" in html
    assert "unsafe-inline" not in html
    assert "object-src 'none'" in html
    assert "frame-ancestors 'none'" in html
    script_tags = re.findall(r"<script\b([^>]*)>", html, flags=re.I)
    assert script_tags
    assert all("src=" in tag for tag in script_tags)


def test_static_javascript_never_uses_eval_or_function_constructor() -> None:
    javascript = "\n".join(path.read_text(encoding="utf-8") for path in STATIC.glob("*.js"))
    assert "eval(" not in javascript
    assert "new Function(" not in javascript
    assert ".innerHTML" not in javascript


def test_offline_shell_lists_existing_local_assets() -> None:
    worker = (STATIC / "service-worker.js").read_text(encoding="utf-8")
    match = re.search(r"const SHELL=\[(.*?)\];", worker, flags=re.S)
    assert match, "service worker must declare the offline shell"
    entries = re.findall(r"['\"](\./[^'\"]+)['\"]", match.group(1))
    assert entries
    for entry in entries:
        relative = entry.removeprefix("./")
        if not relative:
            continue
        assert (STATIC / relative).exists(), f"offline shell asset missing: {entry}"
