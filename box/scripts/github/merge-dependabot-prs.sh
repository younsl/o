#!/bin/bash
#
# Merge all open Dependabot PRs one by one
# Usage: ./merge-dependabot-prs.sh [--dry-run]
#
# This script auto-detects the repository where it is located,
# so it works correctly regardless of the current working directory.
#

set -euo pipefail

# Auto-detect repository from script location
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null) || {
    echo "Error: Script is not located in a git repository."
    exit 1
}

# Extract owner/repo from git remote
REMOTE_URL=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null) || {
    echo "Error: No git remote 'origin' found."
    exit 1
}

# Parse owner/repo from various URL formats (HTTPS, SSH)
if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
else
    echo "Error: Could not parse GitHub repository from remote URL: $REMOTE_URL"
    exit 1
fi

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "Dry-run mode enabled. No PRs will be merged."
    echo
fi

echo "Repository: $REPO (auto-detected)"

# Get all open Dependabot PRs
PRS=$(gh pr list --repo "$REPO" --author "app/dependabot" --state open --json number,title --jq '.[] | "\(.number)\t\(.title)"')

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
        if gh pr merge "$PR_NUMBER" --repo "$REPO" --squash --delete-branch; then
            echo "  Merged PR #${PR_NUMBER}"
            sleep 2  # Rate limit
        else
            echo "  Failed to merge PR #${PR_NUMBER} (may need CI to pass first)"
        fi
    fi
done

echo
echo "Done."
