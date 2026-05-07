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

# Only fetch and reset when the checkout is off the pinned SHA. The
# previous unconditional `git clean -fdx` blew away install-build-deps'
# hermetic node, buildtools, pnpm cache, and venv on every re-run,
# turning subsequent setup.sh calls into multi-minute re-downloads.
current_sha="$(git -C "$PERFETTO_DIR" rev-parse HEAD)"
if [[ "$current_sha" != "$PERFETTO_SHA" ]]; then
  echo "==> Pinning $PERFETTO_DIR to $PERFETTO_SHA (was ${current_sha:0:10})"
  (
    cd "$PERFETTO_DIR"
    git fetch origin
    git -c advice.detachedHead=false reset --hard "$PERFETTO_SHA"
  )
else
  echo "==> $PERFETTO_DIR already at $PERFETTO_SHA"
fi

./scripts/apply-patches.sh
./scripts/sync-overlay.sh

echo "==> Fetching Perfetto UI build deps (hermetic node, pnpm cache, buildtools)"
(cd "$PERFETTO_DIR" && ./tools/install-build-deps --ui)

echo "==> Done. Build with:"
echo "    (cd desktop && pnpm install && pnpm tauri dev)"
