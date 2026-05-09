<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="desktop/branding/lockup-dark.svg">
    <img src="desktop/branding/lockup-light.svg" alt="Perfetto Desktop — Unofficial desktop wrapper for Perfetto." width="720">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/tooluse-labs/perfetto-desktop/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/tooluse-labs/perfetto-desktop/actions/workflows/ci.yml/badge.svg"></a>
  <a href="#license"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href="docs/design-docs/perfetto-desktop-architecture.md"><img alt="Status" src="https://img.shields.io/badge/status-CLI%20Agent%20preview-orange.svg"></a>
</p>

---

A Tauri 2 desktop wrapper built by [Tooluse Labs](https://github.com/tooluse-labs).
It packages the upstream Perfetto UI as a native desktop app and adds
**CLI Agent**, a local MCP bridge that lets Codex, Claude Code, and other
agentic MCP clients work against the trace currently open in the GUI.

This repository is product-only. Upstream Perfetto source is treated as
a build dependency: pinned by SHA in [`DEPS`](DEPS) and fetched into
`third_party/perfetto/` by [`scripts/setup.sh`](scripts/setup.sh).
Upstream code is never modified in this repo's history; any patches
that become necessary live as files under `patches/perfetto/` and are
applied at setup time.

## Layout

| Path | Purpose |
| --- | --- |
| `desktop/` | Tauri project (the desktop shell) |
| `ui-overlay/` | Fork-owned UI plugins overlaid into Perfetto's UI tree at setup time. |
| `patches/perfetto/` | Git patches applied to the Perfetto checkout at setup time. |
| `scripts/` | `setup.sh`, `apply-patches.sh`, `sync-overlay.sh`, `update-perfetto.sh` |
| `third_party/perfetto/` | Gitignored. Populated by `setup.sh`. |
| `docs/design-docs/` | Architecture and rollout docs |

## Downloads

Release builds are produced by the GitHub Actions release workflow:

- macOS arm64: unsigned DMG.
- Windows x64: unsigned NSIS `.exe` and MSI `.msi` installers.

The app is not yet code-signed. macOS Gatekeeper and Windows SmartScreen may
warn on first launch.

## Quick start

```sh
git clone https://github.com/tooluse-labs/perfetto-desktop
cd perfetto-desktop
./scripts/bootstrap.sh                          # host toolchain (pnpm + rustup), one-time per machine
./scripts/setup.sh                              # fetch and pin upstream Perfetto + UI build deps
(cd desktop && pnpm install && pnpm tauri dev)  # run the Tauri shell
```

`pnpm tauri dev` invokes the Perfetto UI dev server directly via
`tauri.conf.json:beforeDevCommand`. It calls `ui/build.js` rather
than `ui/run-dev-server` because the wrapper hardcodes
`--only-wasm-memory64` and macOS WKWebView cannot load Memory64
WASM. See `docs/design-docs/perfetto-desktop-architecture.md` §6.1.

`scripts/bootstrap.sh` currently supports macOS only. CI builds the Windows
installer on `windows-latest` (Perfetto UI is prebuilt on Linux and consumed
by the Windows packaging job); local Windows bootstrap docs are still pending.

## CLI Agent

CLI Agent is a local MCP bridge exposed from Perfetto Desktop. It lets an
external agent use your existing Codex or Claude Code subscription while
Perfetto Desktop keeps ownership of the trace and UI state.

Typical flow:

1. Start Perfetto Desktop and open a trace.
2. Open **CLI Agent** in the sidebar under the current trace section.
3. Copy the generated **Codex** or **Claude Code** command.
4. Run the command in a terminal and ask the agent to analyze the loaded trace.

The copy buttons stay disabled until a trace is loaded so the agent starts
with trace context. The bridge listens only on loopback, requires a generated
Bearer token, rejects browser-style cross-site requests, and runs as a single
desktop instance so only one local MCP endpoint owns the default port.

Exposed tools reuse upstream Perfetto MCP naming where possible, including:

- `perfetto-get-trace-info`
- `perfetto-execute-query`
- `perfetto-list-interesting-tables`
- `perfetto-list-table-structure`
- `show-perfetto-sql-view`
- `show-timeline`

## Design

See
[docs/design-docs/perfetto-desktop-architecture.md](docs/design-docs/perfetto-desktop-architecture.md)
(or the
[Chinese version](docs/design-docs/perfetto-desktop-architecture.zh-CN.md))
for the architecture, MVP acceptance criteria, and rollout plan.

## Upstream relationship

- We never modify upstream Perfetto in this repo's history.
- The pinned SHA is bumped via `scripts/update-perfetto.sh`.
- If a patch becomes unavoidable, it is added under `patches/perfetto/`
  as a `.patch` file and applied at setup time. `apply-patches.sh`
  fails loudly if a patch no longer applies cleanly, so upstream drift
  is caught at setup.

## Perfetto Desktop vs perfetto-mcp-rs

[`tooluse-labs/perfetto-mcp-rs`](https://github.com/tooluse-labs/perfetto-mcp-rs)
is the headless companion. Use it when you want an MCP server that loads trace
files directly from your CLI or editor without opening Perfetto Desktop. It is
a standalone Rust binary, speaks stdio MCP, downloads/manages
`trace_processor_shell`, and includes dedicated Chrome analysis tools such as
scroll jank, page load, startup, and main-thread hotspot summaries.

Use Perfetto Desktop CLI Agent when the trace is already open in the GUI and
you want the agent to share that context, run bounded PerfettoSQL, or drive
approved Perfetto UI actions such as opening SQL views and focusing timeline
ranges.

| Area | Perfetto Desktop CLI Agent | `perfetto-mcp-rs` |
| --- | --- | --- |
| Primary use case | Interactive trace investigation with the Perfetto UI visible. | Headless trace analysis from a terminal, editor, or MCP client. |
| Runtime shape | Native Tauri desktop app plus a loopback HTTP MCP bridge. | Standalone Rust MCP server binary. |
| MCP transport | Streamable HTTP on `127.0.0.1` with a generated bearer token. | stdio MCP launched directly by the client. |
| Trace ownership | Perfetto Desktop owns the currently loaded trace and UI state. | The MCP server loads trace files from paths supplied by the agent. |
| UI control | Can expose approved UI actions such as SQL view creation and timeline focus. | No GUI; returns data and summaries to the MCP client only. |
| SQL access | Bounded PerfettoSQL against the loaded GUI trace. | PerfettoSQL via `execute_sql`, returning columnar JSON with row limits. |
| Schema discovery | Reuses upstream Perfetto MCP-style table and structure tools. | Provides `list_tables`, `list_table_structure`, process/thread helpers, and stdlib module discovery. |
| Chrome-specific analysis | General PerfettoSQL and UI-assisted investigation. | Dedicated Chrome tools for scroll jank, page load, startup, main-thread hotspots, and interactions. |
| `trace_processor_shell` | Uses Perfetto UI's loaded trace engine in the desktop app. | Downloads and manages `trace_processor_shell` automatically, or uses `PERFETTO_TP_PATH`. |
| Client setup | Copy per-session commands from the app; token rotates with the desktop session. | Installer can register Claude Code and Codex automatically; manual MCP config is also supported. |
| Platform target | Desktop app releases: macOS arm64 and Windows x64 installers. | Prebuilt binaries for Linux, macOS, and Windows. |
| Batch/CI suitability | Not ideal; requires the desktop app and loaded UI trace. | Good fit for scripts, repeatable CLI workflows, and CI-style analysis. |
| Security boundary | Local loopback server with bearer auth, host/origin checks, and single-instance desktop ownership. | stdio process boundary; access follows whatever file paths the MCP client asks it to load. |

## License

Apache 2.0, same as upstream Perfetto.
