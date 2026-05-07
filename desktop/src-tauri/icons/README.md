# Perfetto Desktop Icon

## Design Intent

The icon positions Perfetto Desktop as a focused trace analysis
workbench. The design favors small-size readability: one bold primary
mark, three quiet trace slices, and one event marker.

## Visual Concept

The dark rounded square reads as a desktop application tile. The central
cyan-teal mark combines a soft `p`-like trace loop with a performance
spike, so it suggests Perfetto-adjacent trace analysis without reusing
the official Perfetto gauge logo (a multi-color radial dial, visually
unrelated).

Three muted horizontal trace slices and a single amber event marker
reference the slice/marker language of trace viewers without adding
noise at Dock and Finder sizes.

## Color

- Deep navy background (`#111827` to `#0B1020`): professional
  engineering-tool tone.
- Cyan-to-teal primary mark (`#4CC9F0` to `#2DD4BF`): precision,
  observability, and real-time performance data.
- Dark slate trace slices (`#1E293B` family): trace context kept below
  the primary mark.
- Amber event marker (`#F59E0B`): a single point of interest.

## Files

The high-resolution source is stored outside this generated icon set:

- `desktop/branding/icon-source.png`
- `desktop/branding/github-repo-logo.png`

The Tauri desktop bundle consumes:

- `desktop/src-tauri/icons/32x32.png`
- `desktop/src-tauri/icons/64x64.png`
- `desktop/src-tauri/icons/128x128.png`
- `desktop/src-tauri/icons/128x128@2x.png`
- `desktop/src-tauri/icons/icon.icns`
- `desktop/src-tauri/icons/icon.ico`
- `desktop/src-tauri/icons/icon.png`

`desktop/src-tauri/tauri.conf.json` references these files through
`bundle.icon`.
