#!/usr/bin/env bash
# Prints the first twin capsule linked from an issue the pull request closes (its body, then its
# comments), or nothing. Usage: find-capsule.sh <owner/repo> <pr-number>. Needs gh and GH_TOKEN.
set -euo pipefail
repo=$1
pr=$2

# GitHub issue attachments, or any https link to a file named like a capsule.
pattern='https://github\.com/user-attachments/files/[0-9]+/[^][()<>" ]+\.json|https://[^][()<>" ]*capsule[^][()<>" ]*\.json'

issues=$(gh pr view "$pr" --repo "$repo" --json closingIssuesReferences --jq '.closingIssuesReferences[].url')
for issue in $issues; do
  url=$(gh issue view "$issue" --json body,comments --jq '.body, .comments[].body' | grep -oE "$pattern" | head -n 1 || true)
  if [ -n "$url" ]; then
    echo "$url"
    exit 0
  fi
done
