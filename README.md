<table>
  <tr>
    <td width="120">
      <img src="desktop/branding/github-repo-logo.png" alt="Perfetto Desktop logo" width="96">
    </td>
    <td>
      <h1>Perfetto Desktop</h1>
      <p>Unofficial desktop wrapper for <a href="https://github.com/google/perfetto">Perfetto</a>.</p>
    </td>
  </tr>
</table>

<p>
  <a href="https://github.com/tooluse-labs/perfetto-desktop/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/tooluse-labs/perfetto-desktop/actions/workflows/ci.yml/badge.svg"></a>
  <a href="#license"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href="docs/design-docs/perfetto-desktop-architecture.md"><img alt="Status" src="https://img.shields.io/badge/status-Phase%201%20MVP-orange.svg"></a>
</p>

---

A Tauri 2 desktop wrapper built by [Tooluse Labs](https://github.com/tooluse-labs),
with a planned multi-LLM AI analysis plugin landing under
`ui-overlay/plugins/` in Phase 2.

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
| `ui-overlay/` | Fork-owned UI plugins overlaid into Perfetto's UI tree at setup time. Empty in Phase 1. |
| `patches/perfetto/` | Git patches applied to the Perfetto checkout at setup time. Empty in Phase 1. |
| `scripts/` | `setup.sh`, `apply-patches.sh`, `sync-overlay.sh`, `update-perfetto.sh` |
| `third_party/perfetto/` | Gitignored. Populated by `setup.sh`. |
| `docs/design-docs/` | Architecture and rollout docs |

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

`scripts/bootstrap.sh` currently supports macOS only (per Phase 1's
single-platform target); Linux and Windows bootstrap is a Phase 2
deliverable.

## Design

See
[docs/design-docs/perfetto-desktop-architecture.md](docs/design-docs/perfetto-desktop-architecture.md)
(or the
[Chinese version](docs/design-docs/perfetto-desktop-architecture.zh-CN.md))
for the architecture, MVP acceptance criteria, and rollout plan.

## Status

Pre-MVP, Phase 1 (desktop wrapper).

- Pinned Perfetto SHA: see `DEPS`.
- Phase 1 expects zero upstream patches.
- Phase 2 will add a multi-LLM AI plugin under `ui-overlay/plugins/`.

## Upstream relationship

- We never modify upstream Perfetto in this repo's history.
- The pinned SHA is bumped via `scripts/update-perfetto.sh`.
- If a patch becomes unavoidable, it is added under `patches/perfetto/`
  as a `.patch` file and applied at setup time. `apply-patches.sh`
  fails loudly if a patch no longer applies cleanly, so upstream drift
  is caught at setup.

## License

Apache 2.0, same as upstream Perfetto.
