#!/usr/bin/env bash
# Sync ui-overlay/plugins/<name>/ into
# third_party/perfetto/ui/src/plugins/<name>/, one plugin at a time, so
# upstream's other plugins are untouched.
#
# Uses rsync --delete inside each plugin dir so removed overlay files
# are reflected in the destination.
set -euo pipefail
shopt -s nullglob

# Anchor on the script's own location, not git rev-parse, because the
# Perfetto checkout under third_party/perfetto/ is itself a git repo —
# rev-parse from inside it returns the inner toplevel, not ours.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
