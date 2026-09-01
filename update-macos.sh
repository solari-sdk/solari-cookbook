#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

printf '[solari-ops] macOS update starting\n'

if ! command -v git >/dev/null 2>&1; then
  echo 'ERROR: git is required.' >&2
  exit 1
fi

remote="$(git remote get-url origin 2>/dev/null || true)"
case "$remote" in
  *github.com/tocsindata/solari-cookbook.git|*github.com/tocsindata/solari-cookbook) ;;
  *) echo "ERROR: unexpected origin remote: ${remote:-missing}" >&2; exit 1 ;;
esac

branch="$(git branch --show-current)"
if [[ "$branch" != "develop" && "$branch" != "main" ]]; then
  echo "ERROR: run from develop or main, not '$branch'." >&2
  exit 1
fi

git fetch origin
if [[ "$branch" == "develop" ]]; then
  git pull --ff-only origin develop
else
  git pull --ff-only origin main
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo 'ERROR: Python 3 is required. Install it with Homebrew or python.org, then rerun.' >&2
  exit 1
fi

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip

if [[ -f requirements.txt ]]; then
  python -m pip install -r requirements.txt
fi

if [[ -f requirements-dev.txt ]]; then
  python -m pip install -r requirements-dev.txt
fi

if [[ -d tests ]]; then
  python -m pytest
fi

printf '[solari-ops] macOS update complete\n'
