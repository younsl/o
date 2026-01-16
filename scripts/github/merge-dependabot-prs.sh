#!/bin/bash
#
# Merge all open Dependabot PRs one by one
# Usage: ./merge-dependabot-prs.sh [--dry-run]
#

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "Dry-run mode enabled. No PRs will be merged."
    echo
fi

# Get all open Dependabot PRs
PRS=$(gh pr list --author "app/dependabot" --state open --json number,title --jq '.[] | "\(.number)\t\(.title)"')

if [[ -z "$PRS" ]]; then
    echo "No open Dependabot PRs found."
    exit 0
fi

echo "Found Dependabot PRs:"
echo "$PRS"
echo
echo "---"

# Process each PR
echo "$PRS" | while IFS=$'\t' read -r PR_NUMBER PR_TITLE; do
    echo
    echo "Processing PR #${PR_NUMBER}: ${PR_TITLE}"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [DRY-RUN] Would merge PR #${PR_NUMBER}"
    else
        if gh pr merge "$PR_NUMBER" --squash --delete-branch; then
            echo "  Merged PR #${PR_NUMBER}"
            sleep 2  # Rate limit
        else
            echo "  Failed to merge PR #${PR_NUMBER} (may need CI to pass first)"
        fi
    fi
done

echo
echo "Done."
