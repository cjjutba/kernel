# Providers redesign

The canvas Settings, Providers was redesigned on, in October 2026, saved so later work can check the page against it. There was no Linear issue. The decisions are in `docs/decisions/feat-providers-redesign.md`.

Live canvas: https://claude.ai/artifact/XsAvYJ9HD344HkyBL1niyU

## What is the spec

The PNGs in `design/screens/` (`SettingsProviders*.png`, and the Account and usage, Add account and Usage popover screens whose meters changed color) are the spec. They were captured from the build after it was checked against this canvas, so `pnpm shots:compare` keeps working. The old `design/canvas/project/SettingsProviders*.dc.html` files draw the page before the redesign and are out of date.

## The canvas

`canvas/` holds the artboards as published. They are Design canvas files and need the claude.ai runtime: `design/redesign/render.mjs` can't draw them, since they use loops and imports.

| Artboard | Shows |
|---|---|
| `Main` | The Claude Code tab, clickable: switch, the row menu, rename, Remove with its dialog, the limit banner after switching to Work, toasts |
| `Codex` | The Codex tab, which imports `Main` |
| `Light` | The page in light |
| `Narrow` | The page in a 1024px window |
| `States` | Every row, banner, dialog and toast, in dark |
| `StatesLight` | The same in light |

The canvas's nav icons are drawn by hand. The app's are Hugeicons.
