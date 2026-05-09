# Perfetto Desktop Icon

## Design Intent

The icon positions Perfetto Desktop as a modern trace analysis
workbench. The design favors small-size readability: a focus lens, a
highlighted trace waveform, and one event marker.

## Visual Concept

The full-bleed rounded square reads as a desktop application tile. The
central lens and highlighted trace waveform communicate trace analysis
without relying on a letterform.

The warm waveform and amber event marker reference the product's trace
viewer workflow without adding noise at Dock and Finder sizes.

## Color

- Deep navy background (`#0B1020`): focused desktop tool tone.
- Cyan-to-teal primary mark (`#4CC9F0` to `#2DD4BF`): live performance
  analysis and inspection.
- Warm waveform and amber accent (`#FF765C`, `#FFA14A`, `#FFD86F`,
  `#FFB000`): selected trace activity and points of interest.

## Files

The vector source and rendered high-resolution PNGs are stored outside
this generated icon set:

- `desktop/branding/icon-source.svg`
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
