import subprocess
from pathlib import Path

from tools.history_release_scan import scan_history


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _init_repo(repo: Path) -> None:
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "fixture@example.invalid")
    _git(repo, "config", "user.name", "Fixture")


def test_history_scan_detects_secret_removed_from_current_tree(tmp_path: Path):
    repo = tmp_path / "repo"
    _init_repo(repo)
    secret = "AKIA" + ("A" * 16)
    (repo / "temporary.txt").write_text(f"credential={secret}\n", encoding="utf-8")
    _git(repo, "add", "temporary.txt")
    _git(repo, "commit", "-m", "fixture history")
    (repo / "temporary.txt").write_text("clean\n", encoding="utf-8")
    _git(repo, "commit", "-am", "remove fixture value")
    findings = scan_history(repo)
    assert any("aws-access-key" in finding for finding in findings)


def test_history_scan_accepts_clean_placeholder_history(tmp_path: Path):
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / ".env.example").write_text("API_KEY=your_placeholder_token\n", encoding="utf-8")
    _git(repo, "add", ".env.example")
    _git(repo, "commit", "-m", "safe placeholder")
    assert scan_history(repo) == []


def test_history_scan_ignores_only_exact_public_scanner_fixture(tmp_path: Path):
    repo = tmp_path / "repo"
    _init_repo(repo)
    test_dir = repo / "tests"
    test_dir.mkdir()
    synthetic = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    fixture = test_dir / "test_public_release_scan.py"
    fixture.write_text(f'fixture = "{synthetic}"\n', encoding="utf-8")
    _git(repo, "add", str(fixture.relative_to(repo)))
    _git(repo, "commit", "-m", "scanner fixture")
    assert scan_history(repo) == []

    other = repo / "other.py"
    other.write_text(f'value = "{synthetic}"\n', encoding="utf-8")
    _git(repo, "add", "other.py")
    _git(repo, "commit", "-m", "same value outside bounded fixture")
    assert any("github-token" in finding and "other.py" in finding for finding in scan_history(repo))
