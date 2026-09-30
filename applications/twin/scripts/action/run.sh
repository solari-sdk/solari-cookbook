#!/usr/bin/env bash
# The GitHub Action: verify a pull request in the reporter's environment and report the verdict.
# Inputs come from the environment (see action.yml). The pull request's code runs only inside the
# Solari sandbox; this runner only runs twin itself.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
twin=${TWIN_BIN:-"node $here/../../dist/bin.js"}
output=${GITHUB_OUTPUT:-/dev/null}

if [ -z "${PR:-}" ]; then
  echo "::error::twin verify checks pull requests; run it on pull_request events."
  exit 1
fi

# pull_request runs from forks get no secrets; that is not the pull request's fault.
if [ -z "${SOLARI_API_KEY:-}" ]; then
  echo "::notice::No Solari API key (secrets are not passed to pull requests from forks); nothing to verify."
  echo "verdict=skipped" >>"$output"
  exit 0
fi

capsule=${CAPSULE:-}
if [ -z "$capsule" ]; then
  capsule=$(bash "$here/find-capsule.sh" "$REPO" "$PR")
fi
if [ -z "$capsule" ]; then
  echo "::notice::No twin capsule is attached to an issue this pull request closes; nothing to verify."
  echo "verdict=skipped" >>"$output"
  exit 0
fi
echo "Verifying ${HEAD_SHA:0:12} against $capsule"

comment_file="${RUNNER_TEMP:-/tmp}/twin-verify-comment.md"
rm -f "$comment_file"
status=0
$twin verify "$capsule" --ref "$HEAD_SHA" --repo "$HEAD_REPO" --attempts "${ATTEMPTS:-3}" \
  --comment "$comment_file" || status=$?
if [ ! -s "$comment_file" ]; then
  echo "::error::twin verify stopped before reaching a verdict (exit $status)."
  exit 1
fi

verdict=$(head -n 1 "$comment_file" | sed -n 's/^<!-- twin-verify verdict=\([a-z-]*\) -->$/\1/p')
echo "verdict=$verdict" >>"$output"
cat "$comment_file" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
if [ "${COMMENT:-true}" = true ]; then
  bash "$here/comment.sh" "$REPO" "$PR" "$comment_file"
fi
if [ "$verdict" != fixed ]; then
  echo "::error::twin: $verdict in the reporter's environment."
  exit 1
fi
