# KERNEL-663: Hugeicons is the icon set

Status: trial, judged from a side-by-side sheet.

Kernel's icons come from `@hugeicons/core-free-icons` (MIT, free stroke-rounded set), drawn by `@hugeicons/react`. `Icon` in `src/renderer/src/icons.tsx` keeps its API and every `IconName`; each name maps to its closest Hugeicons glyph. Its `stroke` prop is still in the old 16px grid and is multiplied by 1.5, so the default 1.4 draws at 2.1 on Hugeicons' 24px grid.

The library is now the icon spec. The glyphs in the `design/screens/` PNGs are expected to differ, and that difference is not a bug in a screen comparison. Spacing, size and color still follow the PNGs.

Not changed: `ClaudeMark`, the Linear issue state and priority shapes, and the Material Icon Theme file icons (KERNEL-399). Pro packages are out, because they need a license token in CI.
