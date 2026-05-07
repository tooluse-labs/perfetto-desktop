#!/usr/bin/env bash
# Bootstrap third_party/perfetto/ at the SHA pinned in DEPS, then apply
# any patches and overlay plugins.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# shellcheck disable=SC1091
source DEPS

PERFETTO_DIR=third_party/perfetto

if [[ ! -d $PERFETTO_DIR/.git ]]; then
  echo "==> Cloning $PERFETTO_REPO into $PERFETTO_DIR"
  rm -rf "$PERFETTO_DIR"
  git clone "$PERFETTO_REPO" "$PERFETTO_DIR"
fi

echo "==> Pinning $PERFETTO_DIR to $PERFETTO_SHA"
(
  cd "$PERFETTO_DIR"
  git fetch origin
  git -c advice.detachedHead=false reset --hard "$PERFETTO_SHA"
  git clean -fdx
)

./scripts/apply-patches.sh
./scripts/sync-overlay.sh

echo "==> Done. Build with:"
echo "    (cd third_party/perfetto && ./ui/build)"
echo "    (cd desktop && pnpm install && pnpm tauri dev)"
