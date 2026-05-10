# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

This is a **product wrapper**, not a fork. Upstream Perfetto is a build dependency:

- `DEPS` pins `PERFETTO_SHA`. `scripts/setup.sh` clones (partial / blobless) into the gitignored `third_party/perfetto/`, applies `patches/perfetto/*.patch`, then `scripts/sync-overlay.sh` rsync-replaces `ui-overlay/plugins/*/` into `third_party/perfetto/ui/src/plugins/*/`.
- **Never edit `third_party/perfetto/` directly** — that directory is reset by `setup.sh` and is its own git repo, so edits silently disappear and `git rev-parse` from inside it resolves to the inner toplevel. Make durable changes through `ui-overlay/`, `patches/perfetto/`, `DEPS`, or repository scripts (this rule is also stated in `AGENTS.md`).
- All scripts anchor cwd on `BASH_SOURCE`, not `git rev-parse --show-toplevel`, for the reason above. CI fails the build if any script reverts to `rev-parse`.

## Commands

```sh
# One-time host toolchain (macOS only — bootstrap.sh hard-errors on other OSes)
./scripts/bootstrap.sh

# Fetch / pin Perfetto, apply patches, sync overlay, install UI build deps
./scripts/setup.sh
./scripts/setup.sh --no-ui-deps          # Windows, or any host consuming a prebuilt ui/out/dist

# Desktop dev / build (UI dev server on port 10000)
(cd desktop && pnpm install --frozen-lockfile)
(cd desktop && pnpm tauri dev)
(cd desktop && pnpm tauri build)         # macOS .app / .dmg

# Static check + lint (matches CI)
(cd desktop/src-tauri && cargo check --locked)
shellcheck scripts/*.sh

# Rust unit tests live in src-tauri/src/*.rs (#[cfg(test)] modules)
(cd desktop/src-tauri && cargo test)
(cd desktop/src-tauri && cargo test powershell_claude_command_writes_config_to_a_temp_file)

# Bump pinned upstream
./scripts/update-perfetto.sh <sha>       # or `latest` to track origin/HEAD

# Windows local packaging (requires VS 2022 + a prebuilt ui/out/dist already in place)
powershell -ExecutionPolicy Bypass -File scripts\package-windows-local.ps1
powershell -ExecutionPolicy Bypass -File scripts\package-windows-local.ps1 -Bundles nsis,msi
```

There is no JS/TS test runner; the only programmatic tests are the Rust ones in `desktop/src-tauri/src/agent_bridge.rs`.

## Things CI will fail you on (regression guards in `.github/workflows/ci.yml`)

These are non-obvious invariants — read the corresponding workflow step before "simplifying" them:

- **No `--only-wasm-memory64` / `run-dev-server` in `tauri.conf.json:beforeDevCommand`.** macOS WKWebView cannot load Memory64 WASM, so the dev server must call `ui/build.js --serve` directly. See `docs/design-docs/perfetto-desktop-architecture.md` §6.1.
- **Default-enable patches must keep adding their plugin IDs to `defaultPlugins`.** `0002` adds `com.google.PerfettoMcp`, `0004` adds `com.tooluselabs.PerfettoDesktop`. The CI grep is anchored on `^+  '<id>',` — preserve that line shape.
- **`apply-patches.sh` must keep its `git apply --reverse --check` idempotency probe.** Removing it makes a second `setup.sh` run on an already-patched checkout error out.
- **All `scripts/*.sh` must reference `BASH_SOURCE`** (cwd-anchoring rule above).
- **Windows release must enable `tauri/custom-protocol`.** The release job greps `tauri-windows-build.log` for that string; without it the bundled UI assets aren't served and the WebView falls through to the local IIS splash page.

## Agent Bridge — what it is and how its two halves talk

The bulk of the fork-specific code is the local MCP bridge (`Tauri-side` Rust + `WebView-side` TS plugin):

- **Rust edge** — `desktop/src-tauri/src/agent_bridge.rs`. Loopback HTTP/1 server (default `127.0.0.1:38471`, falls back to ephemeral on bind clash) speaking JSON-RPC at `POST /mcp`. Validates `Host`, blocks browser `Origin`/cross-site `sec-fetch-site`, and constant-time-checks a bearer (`pdb_<uuid_simple>`) regenerated per session. Auto-starts at app launch via `spawn_auto_start`. State machine: `Disabled → Starting → Listening → PendingAuthorization → Connected` (plus reserved `Error`).
- **WebView pump** — `ui-overlay/plugins/com.tooluselabs.PerfettoDesktop/index.ts` long-polls `agent_bridge_next_rpc_request` (~25s timeout) and replies via `agent_bridge_complete_rpc_request`. The pump is the entire scheduler — no `setInterval`. Tools are registered in `bridge_tools.ts` against an in-memory MCP transport pair.
- **Why the trace getter is a closure (not a captured Trace)** — `bridge_tools.ts` keeps a single `AgentBridgeToolServer` alive across trace load/unload by calling `getTrace()` lazily on each tool invocation. Capturing the Trace eagerly tears down and rebuilds `tools/list` every time, churning the agent's tool surface. Preserve this when porting upstream changes from `com.google.PerfettoMcp/uitools.ts`.
- **PerfettoSQL caps inside the bridge:** row cap 500, byte cap 1 MiB, 15 s timeout, single statement only, only `SELECT` / `WITH` / `INCLUDE PERFETTO MODULE`. Multi-statement input is rejected before reaching the engine.
- **Bearer command templates are deliberately different across shells.** `SessionConfig::new` produces both bash/zsh and PowerShell variants. PowerShell goes via a temp file because `claude.cmd` / `codex.cmd` (npm-bin shims) hand argv to `cmd.exe`, whose tokenizer strips embedded `"`. The Codex PS form flips outer-double / inner-single quotes for the same reason. **The unit tests in `agent_bridge.rs` lock this shape down — do not "unify" them.** If you change either, run those tests.
- **Single-instance** via `tauri-plugin-single-instance`: the second launch focuses the existing window rather than spawning another bridge that would lose the default port.
- **Windows-only WebView data dir override**: `main.rs` sets `webview-v2` so stale Edge WebView caches from prior installs don't mask packaged UI assets (see commit `f543ef2`).

## Patches and overlay — when to use which

- **`patches/perfetto/`** — small, surgical diffs against upstream files we don't own (e.g. seeding `defaultPlugins`, gating `install-build-deps` on `PERFETTO_SKIP_TEST_DATA`). Keep them as small as possible because every upstream SHA bump risks rebase. They must be idempotently reapplyable.
- **`ui-overlay/plugins/<id>/`** — files we wholly own. `sync-overlay.sh` does `rm -rf` + `cp -R` per plugin, so removing a file from the overlay removes it from the destination too. Use reverse-DNS plugin IDs (`com.tooluselabs.PerfettoDesktop`).
- **Neither** — it's a desktop-shell-only concern: edit `desktop/src-tauri/` directly.

## Commit / PR style

Conventional Commits (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, `release:`). Subjects imperative and specific (e.g. `fix: drop --watch from beforeDevCommand`). When changing `DEPS`, `patches/perfetto/`, or release workflow behavior, call it out explicitly in the PR body — those areas have outsized blast radius.
