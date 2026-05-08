# Repository Guidelines

## Project Structure & Module Organization

This repository is a product wrapper around upstream Perfetto. Keep upstream source out of this repo history: `third_party/perfetto/` is populated by `./scripts/setup.sh` from the SHA pinned in `DEPS`.

- `desktop/`: Tauri 2 desktop shell, with Rust code in `desktop/src-tauri/src/`.
- `ui-overlay/`: fork-owned Perfetto UI additions copied into the upstream checkout, currently `ui-overlay/plugins/com.tooluselabs.PerfettoDesktop/`.
- `patches/perfetto/`: git patches applied to upstream Perfetto during setup.
- `scripts/`: bootstrap, setup, patch, overlay sync, and upstream update scripts.
- `docs/design-docs/`: architecture and rollout notes.

## Build, Test, and Development Commands

- `./scripts/bootstrap.sh`: install host tooling on macOS, including pnpm and rustup.
- `./scripts/setup.sh`: fetch/pin Perfetto, apply patches, sync overlays, and install Perfetto UI build dependencies.
- `(cd desktop && pnpm install --frozen-lockfile)`: install desktop package dependencies.
- `(cd desktop && pnpm tauri dev)`: run the desktop app against the Perfetto UI dev server on port 10000.
- `(cd desktop && pnpm tauri build)`: build the macOS app/DMG bundle.
- `(cd desktop/src-tauri && cargo check --locked)`: static-check the Rust Tauri shell.
- `shellcheck scripts/*.sh`: lint shell scripts, matching CI.

## Coding Style & Naming Conventions

Use Rust 2021 and normal `rustfmt` formatting for Tauri code. TypeScript overlay files follow the existing Perfetto style: 2-space indentation, single quotes, semicolons, and `snake_case.ts` file names such as `chat_page.ts`. Keep plugin IDs reverse-DNS style, for example `com.tooluselabs.PerfettoDesktop`. Shell scripts should be Bash, `set -euo pipefail` where practical, and anchored from `BASH_SOURCE` so they work when invoked from nested directories.

## Testing Guidelines

There is no standalone unit test suite yet. Before submitting changes, run the closest relevant checks: `cargo check --locked` for Rust, `shellcheck scripts/*.sh` for scripts, and `./scripts/apply-patches.sh` after patch changes. For overlay or patch behavior, verify through `./scripts/setup.sh` or `./scripts/sync-overlay.sh` against a fresh or reset `third_party/perfetto/` checkout.

## Commit & Pull Request Guidelines

Commit history uses Conventional Commit prefixes such as `feat:`, `fix:`, `ci:`, `docs:`, and `refactor:`. Keep subjects imperative and specific, for example `fix: drop --watch from beforeDevCommand`.

Pull requests should include a short problem statement, the chosen approach, commands run, and any visible UI impact. Link related issues or design docs when applicable. Include screenshots for desktop UI changes and call out any updates to `DEPS`, `patches/perfetto/`, or release workflow behavior.

## Agent-Specific Instructions

Do not edit `third_party/perfetto/` directly. Make durable changes through `ui-overlay/`, `patches/perfetto/`, `DEPS`, or repository scripts.
