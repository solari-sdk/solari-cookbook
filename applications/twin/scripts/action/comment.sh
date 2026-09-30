#!/usr/bin/env bash
# Posts the verify comment on the pull request, or updates the one twin posted before, so each push
# edits one comment instead of adding another. Usage: comment.sh <owner/repo> <pr-number> <file>
set -euo pipefail
repo=$1
pr=$2
file=$3

id=$(gh api "repos/$repo/issues/$pr/comments" --paginate \
  --jq '.[] | select(.body | startswith("<!-- twin-verify")) | .id' | tail -n 1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$repo/issues/comments/$id" -F "body=@$file" >/dev/null
else
  gh api -X POST "repos/$repo/issues/$pr/comments" -F "body=@$file" >/dev/null
fi
