#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.zscripts" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

PROJECT_DIR="$TEST_ROOT/project"
BUILD_DIR="$TEST_ROOT/build"
mkdir -p \
    "$PROJECT_DIR/scripts" \
    "$PROJECT_DIR/.venv" \
    "$BUILD_DIR/next-service-dist"

cat >"$PROJECT_DIR/requirements.txt" <<'EOF'
EOF
cat >"$PROJECT_DIR/scripts/report.py" <<'EOF'
print("report")
EOF
cat >"$PROJECT_DIR/.venv/should-not-copy.py" <<'EOF'
ignored
EOF

PROJECT_DIR="$PROJECT_DIR" BUILD_DIR="$BUILD_DIR" \
    bash "$SCRIPT_DIR/python-runtime-build.sh"

test -f "$BUILD_DIR/next-service-dist/scripts/report.py"
test ! -e "$BUILD_DIR/next-service-dist/.venv/should-not-copy.py"

PYPROJECT_DIR="$TEST_ROOT/pyproject-app"
PYPROJECT_BUILD="$TEST_ROOT/pyproject-build"
mkdir -p "$PYPROJECT_DIR" "$PYPROJECT_BUILD/next-service-dist"
cat >"$PYPROJECT_DIR/pyproject.toml" <<'EOF'
[project]
name = "deploy-test"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = []
EOF
cat >"$PYPROJECT_DIR/app.py" <<'EOF'
print("pyproject app")
EOF

PROJECT_DIR="$PYPROJECT_DIR" BUILD_DIR="$PYPROJECT_BUILD" \
    bash "$SCRIPT_DIR/python-runtime-build.sh"
test -f "$PYPROJECT_BUILD/next-service-dist/app.py"
test -f "$PYPROJECT_BUILD/python-runtime/requirements.txt"

NODE_ONLY_PROJECT="$TEST_ROOT/node-only"
NODE_ONLY_BUILD="$TEST_ROOT/node-only-build"
mkdir -p "$NODE_ONLY_PROJECT/mini-services/python-worker" "$NODE_ONLY_BUILD"
cat >"$NODE_ONLY_PROJECT/package.json" <<'EOF'
{"name": "node-only"}
EOF
cat >"$NODE_ONLY_PROJECT/mini-services/python-worker/main.py" <<'EOF'
print("unsupported preview-only service")
EOF

PROJECT_DIR="$NODE_ONLY_PROJECT" BUILD_DIR="$NODE_ONLY_BUILD" \
    bash "$SCRIPT_DIR/python-runtime-build.sh"
test ! -e "$NODE_ONLY_BUILD/python-runtime"

echo "python runtime build tests passed"
