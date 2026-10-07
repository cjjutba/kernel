# Kernel design canvas backup

Saved October 7, 2026. 119 screens in 18 sections.

project/            The canvas exactly as published: one .dc.html per screen plus canvas.json (layout, titles, section labels).
source/templates/   The templates the screens are generated from (shared sidebar, footer, helmet CSS, floor, workspace...).
source/build.py     Regenerates every screen from the templates. Update the output path at the top before running.
source/floor-art/   The isometric floor art. floor2.svg is the empty floor, floor.svg has the people drawn in.

## Restoring

1. Create a new Design canvas in Claude and ask Claude to restore it from this backup.
2. Upload floor-art/floor2.svg and floor-art/floor.svg to the new canvas. Each upload gets a new /_blob/ address.
3. Replace the old addresses in every screen:
   dfa867eded454e73223dfbdbec192b9b -> the new floor2.svg address
   e5f44fa189e70a1d3dc5c74650fa7a09 -> the new floor.svg address
4. Publish canvas.json and all .dc.html files under project/.

Tip: keep a copy of this folder in the Kernel repo (for example design/canvas/) so it lives in git history too.
