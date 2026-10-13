**Icons come in four sizes and one stroke.** `Icon` and `IconButton` take `size` as `12 | 14 | 16 | 20`: 12 for carets, chips and inline meta, 14 for rows, buttons and menu items, 16 as the default for headers and the sidebar, 20 for empty states. Screens had drifted to eleven sizes (9, 10, 11, 12, 13, 14, 15, 16, 18, 20 and the two large marks) and 61 call sites passed their own `stroke` from 0.6 to 2.2, which `Icon` scaled by 1.5 for Hugeicons' 24px grid, so a 1.9 drew at 2.85. The `stroke` prop is gone and every glyph draws at 2.1. Typing the scale makes `pnpm typecheck` reject a new size, which a style note could not.

**Names are typed.** `name` is an `IconName` only. The old `string & {}` escape drew an empty SVG for a typo.

**No hand-drawn SVG beside `Icon`.** The preview caret, the Create PR caret, the Run panel's play triangle and the Update ready arrow now use `Icon` (`chevron`, `chevron`, `play`, `download`). `ContextRing`, the spinners, `ClaudeMark`, `IssueState` and `IssuePriority` stay as drawn, since they are not glyphs from the set. `LargeMark` is the one escape off the scale, for Welcome and Home, and keeps its own thin stroke.

**`x` is the plain cross.** `x` maps to `Cancel01Icon` and `xCircle` stays the circled one, so a failed check row and an error card no longer share a glyph with the circled failure in Settings.
