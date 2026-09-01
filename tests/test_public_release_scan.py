from pathlib import Path

from tools.public_release_scan import scan


def test_public_release_scan_detects_secret_and_sensitive_filename(tmp_path: Path):
    (tmp_path / "safe.txt").write_text("public data only\n", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("token=ghp_abcdefghijklmnopqrstuvwxyz1234567890\n", encoding="utf-8")  # placeholder synthetic scanner fixture
    (tmp_path / ".env").write_text("A=B\n", encoding="utf-8")
    findings = scan(tmp_path)
    assert any("github-token" in finding for finding in findings)
    assert any("forbidden sensitive filename" in finding for finding in findings)


def test_public_release_scan_allows_documented_placeholders_and_deny_terms(tmp_path: Path):
    (tmp_path / "example.md").write_text("placeholder Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n", encoding="utf-8")
    assert scan(tmp_path) == []
    (tmp_path / "notes.md").write_text("private-project-name\n", encoding="utf-8")
    findings = scan(tmp_path, deny_terms=["private-project-name"])
    assert any("configured deny term" in finding for finding in findings)
