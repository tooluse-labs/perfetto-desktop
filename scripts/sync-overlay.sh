#!/usr/bin/env bash
# Sync ui-overlay/plugins/<name>/ into
# third_party/perfetto/ui/src/plugins/<name>/, one plugin at a time, so
# upstream's other plugins are untouched.
#
# We replace the destination plugin dir wholesale (rm -rf + cp -R) so
# files removed from the overlay disappear from the destination too.
# Avoiding rsync keeps this portable to Windows runners (git-bash) where
# rsync is not available.
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
  dest="$PERFETTO_PLUGINS_DIR/$name"
  echo "==> Syncing overlay plugin: $name"
  rm -rf "$dest"
  mkdir -p "$dest"
  # The trailing /. on the source path is a portable trick that copies
  # the directory's contents (including dotfiles) into the destination,
  # equivalent to `rsync -a --delete src/ dest/`.
  cp -R "${overlay%/}/." "$dest/"
done
