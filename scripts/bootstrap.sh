#!/usr/bin/env bash
# Bootstrap the host toolchain required to build perfetto-desktop:
# pnpm (for desktop/) and a stable Rust toolchain (for src-tauri/).
#
# Idempotent: skips anything already on PATH. Phase 1 supports macOS
# only; Linux/Windows are tracked for Phase 2.
set -euo pipefail

# Anchor on the script's own location, not git rev-parse, because the
# Perfetto checkout under third_party/perfetto/ is itself a git repo —
# rev-parse from inside it returns the inner toplevel, not ours.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "ERROR: scripts/bootstrap.sh currently supports macOS only." >&2
    echo "Linux/Windows toolchain bootstrap is a Phase 2 deliverable." >&2
    exit 1
    ;;
esac

if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew (brew) is required. Install it from https://brew.sh and re-run." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "==> Installing pnpm via Homebrew"
  brew install pnpm
else
  echo "==> pnpm already installed: $(pnpm --version)"
fi

# rustup installs to $HOME/.cargo/bin which may not be on PATH yet
# (the user hasn't sourced ~/.cargo/env in this shell), so check both.
RUSTC="$(command -v rustc || true)"
if [[ -z "$RUSTC" && -x "$HOME/.cargo/bin/rustc" ]]; then
  RUSTC="$HOME/.cargo/bin/rustc"
fi
if [[ -z "$RUSTC" ]]; then
  if ! command -v rustup-init >/dev/null 2>&1; then
    echo "==> Installing rustup via Homebrew"
    brew install rustup
  fi
  RUSTUP_INIT="$(command -v rustup-init || echo "$(brew --prefix rustup)/bin/rustup-init")"

  echo "==> Installing stable Rust toolchain via $RUSTUP_INIT"
  "$RUSTUP_INIT" -y --default-toolchain stable --profile minimal --no-modify-path

  echo
  echo "==> Rust installed under \$HOME/.cargo. Add to PATH for this shell:"
  echo "    source \"\$HOME/.cargo/env\""
else
  echo "==> rustc already installed: $("$RUSTC" --version)"
fi

echo
echo "==> Host toolchain ready. Next:"
echo "    ./scripts/setup.sh                      # fetch Perfetto + UI build deps"
echo "    (cd desktop && pnpm install)"
echo "    (cd desktop && pnpm tauri dev)"
