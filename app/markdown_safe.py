from __future__ import annotations

import html
import re

_INLINE_CODE = re.compile(r"`([^`]+)`")
_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")


def _inline(text: str) -> str:
    escaped = html.escape(text, quote=True)
    escaped = _INLINE_CODE.sub(r"<code>\1</code>", escaped)
    escaped = _BOLD.sub(r"<strong>\1</strong>", escaped)
    escaped = _ITALIC.sub(r"<em>\1</em>", escaped)
    return escaped


def render_markdown_safe(markdown: str) -> str:
    """Render a deliberately small Markdown subset without allowing raw HTML.

    Supported constructs are h1-h3 headings, unordered lists, paragraphs,
    inline code, bold and italic text. Source HTML is always escaped first.
    This is intentionally not a full Markdown implementation.
    """
    output: list[str] = []
    paragraph: list[str] = []
    in_list = False

    def flush_paragraph() -> None:
        if paragraph:
            output.append(f"<p>{' '.join(_inline(line) for line in paragraph)}</p>")
            paragraph.clear()

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            output.append("</ul>")
            in_list = False

    for raw_line in markdown.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            flush_paragraph()
            close_list()
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            flush_paragraph()
            close_list()
            level = len(heading.group(1))
            output.append(f"<h{level}>{_inline(heading.group(2))}</h{level}>")
            continue
        if line.startswith("- "):
            flush_paragraph()
            if not in_list:
                output.append("<ul>")
                in_list = True
            output.append(f"<li>{_inline(line[2:])}</li>")
            continue
        close_list()
        paragraph.append(line.strip())

    flush_paragraph()
    close_list()
    return "\n".join(output)
