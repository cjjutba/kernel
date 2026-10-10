# Kernel design canvas backup

Saved October 7, 2026. 136 screens in 18 sections.

project/            The canvas exactly as published: one .dc.html per screen plus canvas.json (layout, titles, section labels).
source/templates/   The templates the screens are generated from (shared sidebar, footer, helmet CSS, floor, workspace...).
source/build.py     Regenerates the screens from the templates, into project/ when run in the repo.
source/render.mjs   Draws screens to design/screens as 1440x900 PNGs, without the claude.ai runtime.
source/floor-art/   The isometric floor art. floor2.svg is the empty floor, floor.svg has the people drawn in. Only the hidden floor pages use it now.

## Changing a screen in the repo

1. Edit the template in source/templates/ (the sidebar is `_sidebar.html` and `_rooms.html`, the footer `_footer.html`).
2. `python3 design/canvas/source/build.py` rebuilds project/. It leaves the floor and Board pages alone: they are hidden (D-104) and keep the sidebar they were drawn with.
3. `node design/canvas/source/render.mjs <Screen> ...` redraws the PNGs. Text rasterizes a little differently from the PNGs made on claude.ai, so only redraw the screens whose markup changed (D-109).

## Restoring

1. Create a new Design canvas in Claude and ask Claude to restore it from this backup.
2. Upload floor-art/floor2.svg and floor-art/floor.svg to the new canvas. Each upload gets a new /_blob/ address.
3. Replace the old addresses in every screen:
   dfa867eded454e73223dfbdbec192b9b -> the new floor2.svg address
   e5f44fa189e70a1d3dc5c74650fa7a09 -> the new floor.svg address
4. Publish canvas.json and all .dc.html files under project/.

Tip: keep a copy of this folder in the Kernel repo (for example design/canvas/) so it lives in git history too.
