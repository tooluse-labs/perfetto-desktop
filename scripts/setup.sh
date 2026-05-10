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
  echo "==> Cloning $PERFETTO_REPO into $PERFETTO_DIR (partial, blobless)"
  rm -rf "$PERFETTO_DIR"
  # Partial clone: skip blob download, lazily fetch on demand. Cuts the
  # cold-cache clone of google/perfetto from minutes to ~30s while still
  # giving apply-patches.sh and reset --hard a real git repo to work on.
  git clone --filter=blob:none "$PERFETTO_REPO" "$PERFETTO_DIR"
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
  # PERFETTO_SKIP_TEST_DATA=1 short-circuits Perfetto's unconditional
  # //test/data sync (~398 binary trace fixtures used by upstream's diff
  # tests, hundreds of MB). The desktop wrapper only builds the UI, so
  # those fixtures are dead weight. Patch 0006 wires the env var.
  (cd "$PERFETTO_DIR" && PERFETTO_SKIP_TEST_DATA=1 ./tools/install-build-deps --ui)
else
  echo "==> Skipping UI build deps (--no-ui-deps)"
fi

echo "==> Done. Build with:"
echo "    (cd desktop && pnpm install && pnpm tauri dev)"
