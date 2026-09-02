#!/bin/bash

set -euo pipefail

RUNNER_IMAGE="${RUNNER_IMAGE:-z-ai-python-deploy-runner:test}"
SCRIPT_DIR="$(cd "$(dirname "$0")/../.zscripts" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

PROJECT_DIR="$TEST_ROOT/project"
BUILD_DIR="$TEST_ROOT/build"
mkdir -p "$PROJECT_DIR" "$BUILD_DIR/next-service-dist"

cat >"$PROJECT_DIR/requirements.txt" <<'EOF'
idna==3.10
EOF
cat >"$PROJECT_DIR/check_runtime.py" <<'EOF'
import idna

assert idna.__version__ == "3.10"
print("python artifact import passed")
EOF

PROJECT_DIR="$PROJECT_DIR" BUILD_DIR="$BUILD_DIR" \
    bash "$SCRIPT_DIR/python-runtime-build.sh"

docker run --rm \
    --entrypoint sh \
    -v "$BUILD_DIR:/app" \
    "$RUNNER_IMAGE" \
    -c 'PYTHONPATH=/app/python-runtime/site-packages:/app/next-service-dist python /app/next-service-dist/check_runtime.py'
