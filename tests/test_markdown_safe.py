from app.markdown_safe import render_markdown_safe


def test_safe_markdown_subset_and_html_escape():
    rendered = render_markdown_safe("# Heading\n\n- **Bold** item\n- `code`\n\n<script>alert(1)</script>")
    assert "<h1>Heading</h1>" in rendered
    assert "<strong>Bold</strong>" in rendered
    assert "<code>code</code>" in rendered
    assert "<script>" not in rendered
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in rendered
