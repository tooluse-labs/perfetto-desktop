#!/usr/bin/env bash
# Bootstrap third_party/perfetto/ at the SHA pinned in DEPS, then apply
# any patches and overlay plugins.
#
# --no-ui-deps skips `install-build-deps --ui` for hosts that cannot run
# the upstream UI build (e.g. Windows; upstream rejects `--ui` there).
# Those hosts are expected to consume a prebuilt ui/out/dist from a
# separate macOS or Linux job.
set -euo pipefail

UI_DEPS=1
for arg in "$@"; do
  case "$arg" in
    --no-ui-deps) UI_DEPS=0 ;;
    *)
      echo "ERROR: unknown setup.sh argument: $arg" >&2
      exit 1
      ;;
  esac
done

# Anchor on the script's own location, not git rev-parse, because the
# Perfetto checkout under third_party/perfetto/ is itself a git repo —
# rev-parse from inside it returns the inner toplevel, not ours.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

if [[ $UI_DEPS -eq 1 ]]; then
  echo "==> Fetching Perfetto UI build deps (hermetic node, pnpm cache, buildtools)"
  (cd "$PERFETTO_DIR" && ./tools/install-build-deps --ui)
else
  echo "==> Skipping UI build deps (--no-ui-deps)"
fi

echo "==> Done. Build with:"
echo "    (cd desktop && pnpm install && pnpm tauri dev)"
