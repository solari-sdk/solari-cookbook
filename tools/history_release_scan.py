from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

try:
    from tools.public_release_scan import FORBIDDEN_FILENAMES, PATTERNS, _is_placeholder
except ModuleNotFoundError:  # direct execution from tools/ sets sys.path to that directory
    from public_release_scan import FORBIDDEN_FILENAMES, PATTERNS, _is_placeholder

SYNTHETIC_SCANNER_FIXTURES = {
    ("tests/test_public_release_scan.py", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"),
}


def _run_git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def _sensitive_filename(path_text: str) -> bool:
    name = Path(path_text).name
    return name in FORBIDDEN_FILENAMES or (name.startswith(".env.") and name not in {".env.example", ".env.sample"})


def _known_scanner_fixture(path_text: str, content: str) -> bool:
    """Ignore only exact, public synthetic tokens used to prove the scanner itself.

    This exception is deliberately path-and-value bounded so a different credential-shaped
    value in the same test file, or the same value anywhere else, is still reported.
    """
    return any(path_text == path and token in content for path, token in SYNTHETIC_SCANNER_FIXTURES)


def scan_history(root: Path, *, deny_terms: list[str] | None = None) -> list[str]:
    root = root.resolve()
    deny_terms = [term for term in (deny_terms or []) if term]
    _run_git(root, "rev-parse", "--is-inside-work-tree")
    findings: set[str] = set()

    names = _run_git(root, "log", "--all", "--name-only", "--pretty=format:")
    for path_text in (line.strip() for line in names.splitlines() if line.strip()):
        if _sensitive_filename(path_text):
            findings.add(f"history:{path_text}: forbidden sensitive filename")

    command = [
        "git", "log", "--all", "--format=commit:%H", "--patch", "--no-ext-diff", "--unified=0",
        "--no-renames", "--no-color",
    ]
    process = subprocess.Popen(
        command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )
    assert process.stdout is not None
    commit = "unknown"
    path_text = "unknown"
    for raw_line in process.stdout:
        line = raw_line.rstrip("\n")
        if line.startswith("commit:"):
            commit = line.removeprefix("commit:").strip()[:12] or "unknown"
            continue
        if line.startswith("+++ b/"):
            path_text = line[6:]
            continue
        if not line.startswith(("+", "-")) or line.startswith(("+++", "---")):
            continue
        content = line[1:]
        if not _is_placeholder(content) and not _known_scanner_fixture(path_text, content):
            for pattern in PATTERNS:
                if pattern.regex.search(content):
                    findings.add(f"{commit}:{path_text}: possible {pattern.name}")
        lower = content.casefold()
        for term in deny_terms:
            if term.casefold() in lower:
                findings.add(f"{commit}:{path_text}: configured deny term {term!r}")
    stderr = process.stderr.read() if process.stderr is not None else ""
    returncode = process.wait()
    if returncode != 0:
        raise RuntimeError(stderr.strip() or "git history patch scan failed")
    return sorted(findings)


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan reachable Git history for likely secrets, sensitive filenames, and configured private terms.")
    parser.add_argument("root", nargs="?", default=".")
    args = parser.parse_args()
    deny_terms = [term.strip() for term in os.getenv("SOLARI_PUBLIC_DENY_TERMS", "").split(",") if term.strip()]
    findings = scan_history(Path(args.root), deny_terms=deny_terms)
    if findings:
        print("Git-history public-release scan findings:")
        for finding in findings:
            print(f"- {finding}")
        return 1
    print("Git-history public-release scan: no likely secrets, sensitive filenames, or configured deny terms found in reachable history.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
