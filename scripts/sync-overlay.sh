#!/usr/bin/env bash
# Sync ui-overlay/plugins/<name>/ into
# third_party/perfetto/ui/src/plugins/<name>/, one plugin at a time, so
# upstream's other plugins are untouched.
#
# Uses rsync --delete inside each plugin dir so removed overlay files
# are reflected in the destination.
set -euo pipefail
shopt -s nullglob

cd "$(git rev-parse --show-toplevel)"

PERFETTO_PLUGINS_DIR=third_party/perfetto/ui/src/plugins
OVERLAYS=(ui-overlay/plugins/*/)

if [[ ${#OVERLAYS[@]} -eq 0 ]]; then
  echo "==> No overlays in ui-overlay/plugins/, skipping"
  exit 0
fi

if [[ ! -d $PERFETTO_PLUGINS_DIR ]]; then
  echo "ERROR: $PERFETTO_PLUGINS_DIR not found. Run scripts/setup.sh first." >&2
  exit 1
fi

for overlay in "${OVERLAYS[@]}"; do
  name=$(basename "$overlay")
  echo "==> Syncing overlay plugin: $name"
  mkdir -p "$PERFETTO_PLUGINS_DIR/$name"
  rsync -a --delete "$overlay" "$PERFETTO_PLUGINS_DIR/$name/"
done
