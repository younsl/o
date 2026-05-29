#!/usr/bin/env bash
# Generate GitHub Actions Job Summary for backstage image release.
# Usage: summary-backstage.sh <image> <version> <commit>
set -euo pipefail

IMAGE="${1:?Usage: summary-backstage.sh <image> <version> <commit>}"
VERSION="${2:?}"
COMMIT="${3:?}"

IMAGE_SIZE=$(docker image inspect "${IMAGE}" --format='{{.Size}}' 2>/dev/null || echo "0")
IMAGE_SIZE_MB=$(awk "BEGIN {printf \"%.1f\", ${IMAGE_SIZE} / 1024 / 1024}")

cat <<EOF >> "$GITHUB_STEP_SUMMARY"
## Backstage Image Released

| Item | Value |
|------|-------|
| Image | \`${IMAGE}\` |
| Backstage Version | ${VERSION} |
| Commit | ${COMMIT} |
| Image Size | ${IMAGE_SIZE_MB} MB |
EOF
