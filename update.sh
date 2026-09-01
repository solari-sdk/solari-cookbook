#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

stage() { printf '\n==> %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

stage "Verify repository"
command -v git >/dev/null || fail "git is required"
REMOTE="$(git remote get-url origin 2>/dev/null || true)"
case "$REMOTE" in
  *tocsindata/solari-cookbook.git|*tocsindata/solari-cookbook) ;;
  *) fail "origin does not identify tocsindata/solari-cookbook: $REMOTE" ;;
esac
BRANCH="$(git branch --show-current)"
[[ "$BRANCH" == "develop" || "$BRANCH" == develop/* ]] || fail "Run development updates from develop or develop/* (current: $BRANCH)"

stage "Fast-forward source"
git fetch --prune origin
git pull --ff-only origin "$BRANCH"

stage "Check runtime tools"
if [[ -f package-lock.json ]]; then command -v npm >/dev/null || fail "npm is required by package-lock.json"; fi
if [[ -f requirements.txt || -f pyproject.toml ]]; then
  command -v python3 >/dev/null || fail "python3 is required"
  python3 tools/runtime_check.py || fail "unsupported Python runtime"
fi
if [[ -d static-console/tests ]]; then
  command -v node >/dev/null || fail "Node.js is required to run static-console tests"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 20 ]] || fail "Node.js 20+ is required for static-console tests (found: $(node --version))"
fi

stage "Create Python environment"
if [[ -f requirements.txt || -f pyproject.toml ]]; then
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  python -m pip install --upgrade pip
fi

stage "Install dependencies"
if [[ -f package-lock.json ]]; then npm ci; fi
if [[ -f requirements.txt ]]; then python -m pip install -r requirements.txt; fi
if [[ -f requirements-dev.txt ]]; then python -m pip install -r requirements-dev.txt; fi

stage "Build"
if [[ -f package.json ]] && npm run | grep -qE '^  build'; then npm run build; fi

stage "Test"
if [[ -f package.json ]] && npm run | grep -qE '^  test'; then npm test; fi
if [[ -d static-console/tests ]]; then node --test static-console/tests/*.test.mjs; fi
if [[ -d tests ]]; then python -m pytest; fi

stage "Configuration check"
if [[ -z "${SOLARI_API_KEY:-}" ]]; then
  printf 'NOTE: SOLARI_API_KEY is not set. Local non-live tests may still run; live Solari integration tests must fail/skip explicitly rather than inventing credentials.\n'
fi

stage "Update complete"
printf 'Repository: %s\nBranch: %s\n' "$REMOTE" "$BRANCH"
