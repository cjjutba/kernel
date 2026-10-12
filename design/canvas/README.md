# Kernel design canvas backup

Saved October 7, 2026.

project/            The canvas exactly as published: one .dc.html per screen plus canvas.json (layout, titles, section labels).
source/templates/   The templates the screens are generated from (shared sidebar, footer, helmet CSS, workspace...).
source/build.py     Regenerates the screens from the templates, into project/ when run in the repo.
source/render.mjs   Draws screens to design/screens as 1440x900 PNGs, without the claude.ai runtime.

## Changing a screen in the repo

1. Edit the template in source/templates/ (the sidebar is `_sidebar.html` and `_rooms.html`, the footer `_footer.html`).
2. `python3 design/canvas/source/build.py` rebuilds project/.
3. `node design/canvas/source/render.mjs <Screen> ...` redraws the PNGs. Text rasterizes a little differently from the PNGs made on claude.ai, so only redraw the screens whose markup changed (D-109).

## Restoring

1. Create a new Design canvas in Claude and ask Claude to restore it from this backup.
2. Publish canvas.json and all .dc.html files under project/.

Tip: keep a copy of this folder in the Kernel repo (for example design/canvas/) so it lives in git history too.
