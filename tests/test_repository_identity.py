from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CANONICAL_REPOSITORY = "tocsindata/solari-osint-cookbook"
STALE_REPOSITORY = "tocsindata/solari-cookbook"
IDENTITY_FILES = (
    "meta.md",
    "update.sh",
    "update-macos.sh",
    "update.ps1",
)


def test_canonical_repository_identity_is_used_by_metadata_and_updaters() -> None:
    for relative_path in IDENTITY_FILES:
        content = (ROOT / relative_path).read_text(encoding="utf-8")
        assert CANONICAL_REPOSITORY in content, relative_path
        assert STALE_REPOSITORY not in content, relative_path


def test_meta_repository_url_matches_canonical_name() -> None:
    meta = (ROOT / "meta.md").read_text(encoding="utf-8")
    assert f"https://github.com/{CANONICAL_REPOSITORY}" in meta
