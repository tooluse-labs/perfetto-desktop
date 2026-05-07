# Perfetto Desktop

A [Tooluse Labs](https://github.com/tooluse-labs) Tauri desktop wrapper
for [Perfetto](https://github.com/google/perfetto), with a planned
multi-LLM AI analysis plugin.

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
./scripts/setup.sh                              # fetch and pin upstream Perfetto
(cd third_party/perfetto && ./ui/build)         # build Perfetto UI
(cd desktop && pnpm install && pnpm tauri dev)  # run the Tauri shell
```

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
