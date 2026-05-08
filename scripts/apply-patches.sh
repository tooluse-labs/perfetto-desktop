#!/usr/bin/env bash
# Apply every .patch under patches/perfetto/ to third_party/perfetto/.
# Fails loudly if any patch no longer applies cleanly, so upstream drift
# surfaces at setup time, not at build time.
set -euo pipefail
shopt -s nullglob

# Anchor on the script's own location, not git rev-parse, because the
# Perfetto checkout under third_party/perfetto/ is itself a git repo —
# rev-parse from inside it returns the inner toplevel, not ours.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
  # Idempotent: if the patch can be applied in reverse, it is already
  # applied — skip it. Otherwise check forward-applicability and apply.
  if git -C "$PERFETTO_DIR" apply --reverse --check "$abs" 2>/dev/null; then
    echo "==> Already applied, skipping: $p"
    continue
  fi
  echo "==> Applying $p"
  if ! git -C "$PERFETTO_DIR" apply --check "$abs"; then
    echo "ERROR: $p does not apply cleanly to current $PERFETTO_DIR." >&2
    echo "Hint: rebase the patch against the current pinned SHA." >&2
    exit 1
  fi
  git -C "$PERFETTO_DIR" apply "$abs"
done
