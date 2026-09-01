from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path

SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "data", "dist", "build"}
SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".sqlite", ".sqlite3", ".db", ".pyc"}
FORBIDDEN_FILENAMES = {".env", "id_rsa", "id_ed25519", "credentials.json", "service-account.json"}
MAX_FILE_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class Pattern:
    name: str
    regex: re.Pattern[str]


PATTERNS = [
    Pattern("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    Pattern("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    Pattern("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b")),
    Pattern("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    Pattern("stripe-live-key", re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b")),
    Pattern("generic-bearer-token", re.compile(r"(?i)\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{24,}")),
    Pattern("credential-in-url", re.compile(r"https://[^\s/@:]+:[^\s/@]+@[^\s]+")),
]

PLACEHOLDER_MARKERS = ("example", "placeholder", "redacted", "your_", "your-", "<token>", "<secret>", "${", "process.env", "os.environ", "getenv(")


def _text_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        yield path


def _is_placeholder(line: str) -> bool:
    lower = line.lower()
    return any(marker in lower for marker in PLACEHOLDER_MARKERS)


def scan(root: Path, *, deny_terms: list[str] | None = None) -> list[str]:
    findings: list[str] = []
    deny_terms = [term for term in (deny_terms or []) if term]
    for path in _text_files(root):
        relative = path.relative_to(root)
        if path.name in FORBIDDEN_FILENAMES or (path.name.startswith(".env.") and path.name not in {".env.example", ".env.sample"}):
            findings.append(f"{relative}: forbidden sensitive filename")
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if not _is_placeholder(line):
                for pattern in PATTERNS:
                    if pattern.regex.search(line):
                        findings.append(f"{relative}:{number}: possible {pattern.name}")
            lower = line.casefold()
            for term in deny_terms:
                if term.casefold() in lower:
                    findings.append(f"{relative}:{number}: configured deny term {term!r}")
    return sorted(set(findings))


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan the public repository tree for likely secrets and configured private terms.")
    parser.add_argument("root", nargs="?", default=".")
    args = parser.parse_args()
    deny_terms = [term.strip() for term in os.getenv("SOLARI_PUBLIC_DENY_TERMS", "").split(",") if term.strip()]
    findings = scan(Path(args.root).resolve(), deny_terms=deny_terms)
    if findings:
        print("Public-release scan findings:")
        for finding in findings:
            print(f"- {finding}")
        return 1
    print("Public-release scan: no likely secrets or configured deny terms found in the current tree.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
