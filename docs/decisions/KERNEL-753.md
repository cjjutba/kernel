# KERNEL-753: Kernel's own PR state glyphs

**Decision.** The PR state glyphs and the archive box are drawn by hand in `icons.tsx` (the `K` table), not taken from Hugeicons. `Icon` draws them like any other name, with the same API and the typed size scale `12 | 14 | 16 | 20`. This lifts the "No hand-drawn SVG beside `Icon`" rule in `icon-sizes-and-stroke.md` for these glyphs only. Every other icon stays on Hugeicons until KERNEL-754 redraws them in this style.

**Why.** `branch` and `pr` looked alike, conflict, checks failed, changes requested and blockers all drew `pr` in red, `prDraft` read as a colon, `merged` looked small and sideways, and `archive` read as a face. Each state now has its own shape, so it reads without its color at 12, 14 and 16px.

**The set.** `branch` (no PR), `pr` (open), `prReady` (ready to merge), `prDraft`, `prCifail` (checks failed), `prChanges` (changes requested, also blockers found), `prConflict` (merge conflict), `merged`, `prClosed`, `archive`. Tones are unchanged: muted, add, del, and purple only for merged.

## House rules for the style

- **Grid.** 16 units, `viewBox="0 0 16 16"`, drawn at the pixel size of the caller. Keep a 1.5 unit margin from the edge, so a 1.4 stroke never clips.
- **Stroke.** 1.4 units, `fill="none"`, `stroke="currentColor"`, round caps and joins. It matches the 2.1 on Hugeicons' 24 grid. No glyph sets its own stroke.
- **Nodes.** A commit node is a ring of radius 1.75, never filled. A line leaves a node at its edge (center plus 1.75), so line and ring never overlap.
- **Corners.** Never sharp. Curves use a radius of 2 to 4 units; boxes and bubbles round their corners at 1.2 to 3. Joins are round.
- **Color.** Only `currentColor`. The tone comes from the caller (`GlyphTone`, DESIGN.md), never from the glyph.
- **Meaning.** One shape per state. A state is never told apart by color alone. Dashes mean not final (draft), a check means ready, an x in a box means failed, a speech bubble means a person asked for something, arrows meeting mean two sides collide.
- **Legibility.** Check every new glyph at 12px at 1x before it ships. A detail that closes up at 12px is cut, not shrunk.

**How to apply.** Add a glyph to `K` in `icons.tsx` with the same rules and add its name to the callers. The sidebar picks it in `workspaceGlyph.ts`, the PR header in `pr/model.ts` (`glyph`), chat notes in `NOTE_GLYPH` and History in `prGlyph`.
