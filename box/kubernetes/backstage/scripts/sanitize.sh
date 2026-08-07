#!/usr/bin/env bash
# Sanitize public GitHub identity references before migrating to a private repo.
#
# Replaces only the personal namespace (younsl); upstream OSS links such as
# github.com/backstage/* and generic test fixtures are intentionally kept.
#
# Usage:
#   ./scripts/sanitize.sh              # dry-run: show what would change
#   ./scripts/sanitize.sh --apply      # rewrite files in place
#
# Override replacement targets via environment variables:
#   NEW_REGISTRY=harbor.example.com/backstage \
#   NEW_SOURCE_URL=https://git.example.com/platform/backstage \
#   ./scripts/sanitize.sh --apply
set -euo pipefail

cd "$(dirname "$0")/.."

NEW_REGISTRY="${NEW_REGISTRY:-registry.example.com/backstage}"
NEW_SOURCE_URL="${NEW_SOURCE_URL:-https://git.example.com/platform/backstage}"

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

REGISTRY_HOST="${NEW_REGISTRY%%/*}"
REGISTRY_PATH="${NEW_REGISTRY#*/}"

# pattern|replacement (longest / most specific first)
RULES=(
  "ghcr.io/younsl/backstage|${NEW_REGISTRY}"
  "ghcr.io/younsl|${REGISTRY_HOST}"
  "https://github.com/younsl/o|${NEW_SOURCE_URL}"
  "younsl/backstage|${REGISTRY_PATH}"
  "registry: ghcr.io|registry: ${REGISTRY_HOST}"
)

# Lines to delete outright (badges pointing at the public registry)
DELETE_PATTERNS=(
  "img.shields.io/badge/GHCR"
)

# Anything matching this pattern is considered an identity leak.
CHECK_PATTERN='younsl\|ghcr\.io'

list_files() {
  grep -rIl \
    --exclude-dir=node_modules --exclude-dir=.yarn --exclude-dir=dist \
    --exclude-dir=.git --exclude-dir=node_modules.bak \
    --exclude=yarn.lock --exclude=sanitize.sh \
    "$CHECK_PATTERN" . 2>/dev/null || true
}

FILES=$(list_files)
if [[ -z "$FILES" ]]; then
  echo "clean: no identity references found"
  exit 0
fi

FILE_COUNT=$(echo "$FILES" | wc -l | tr -d ' ')
echo "== files containing identity references (${FILE_COUNT} files) =="
echo "$FILES"
echo

if ! $APPLY; then
  echo "== dry-run: matching lines (use --apply to rewrite) =="
  echo "$FILES" | xargs grep -In "$CHECK_PATTERN"
  exit 0
fi

for f in $FILES; do
  for pat in "${DELETE_PATTERNS[@]}"; do
    sed -i '' "\|${pat}|d" "$f"
  done
  for rule in "${RULES[@]}"; do
    sed -i '' "s|${rule%%|*}|${rule#*|}|g" "$f"
  done
done

echo "== verification =="
LEFTOVER=$(list_files)
if [[ -n "$LEFTOVER" ]]; then
  echo "FAIL: identity references remain:"
  echo "$LEFTOVER" | xargs grep -In "$CHECK_PATTERN"
  exit 1
fi
echo "OK: no identity references remain"
