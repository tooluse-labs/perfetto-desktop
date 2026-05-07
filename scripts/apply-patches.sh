#!/usr/bin/env bash
# Apply every .patch under patches/perfetto/ to third_party/perfetto/.
# Fails loudly if any patch no longer applies cleanly, so upstream drift
# surfaces at setup time, not at build time.
set -euo pipefail
shopt -s nullglob

cd "$(git rev-parse --show-toplevel)"

PERFETTO_DIR=third_party/perfetto
PATCHES=(patches/perfetto/*.patch)

if [[ ${#PATCHES[@]} -eq 0 ]]; then
  echo "==> No patches in patches/perfetto/, skipping"
  exit 0
fi

if [[ ! -d $PERFETTO_DIR/.git ]]; then
  echo "ERROR: $PERFETTO_DIR is not a git checkout. Run scripts/setup.sh first." >&2
  exit 1
fi

for p in "${PATCHES[@]}"; do
  abs=$(cd "$(dirname "$p")" && pwd)/$(basename "$p")
  echo "==> Applying $p"
  if ! git -C "$PERFETTO_DIR" apply --check "$abs"; then
    echo "ERROR: $p does not apply cleanly to current $PERFETTO_DIR." >&2
    echo "Hint: rebase the patch against the current pinned SHA." >&2
    exit 1
  fi
  git -C "$PERFETTO_DIR" apply "$abs"
done
