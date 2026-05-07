#!/usr/bin/env bash
# Bump PERFETTO_SHA in DEPS to a new commit, then re-run setup.
#
# Usage:
#   scripts/update-perfetto.sh <new-sha>
#   scripts/update-perfetto.sh latest          # pin to current upstream HEAD
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# shellcheck disable=SC1091
source DEPS

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <sha|latest>" >&2
  exit 1
fi

NEW_SHA=$1

if [[ $NEW_SHA == latest ]]; then
  echo "==> Resolving upstream HEAD"
  NEW_SHA=$(git ls-remote "$PERFETTO_REPO" HEAD | awk '{print $1}')
fi

if [[ ! $NEW_SHA =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: '$NEW_SHA' does not look like a git SHA" >&2
  exit 1
fi

echo "==> Updating DEPS: $PERFETTO_SHA -> $NEW_SHA"

# Cross-platform sed in-place: write to temp, then move.
tmp=$(mktemp)
awk -v new="$NEW_SHA" '
  /^PERFETTO_SHA=/ { print "PERFETTO_SHA=" new; next }
  { print }
' DEPS > "$tmp"
mv "$tmp" DEPS

./scripts/setup.sh

echo "==> Verify build, then commit:"
echo "    git add DEPS"
echo "    git commit -m \"deps: bump perfetto to $NEW_SHA\""
