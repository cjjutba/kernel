"""Draws the Block K and writes every brand SVG from it.

    <python with fonttools and brotli> brand/k.py

One construction, two cuts. A stem, a channel, and a chevron whose edges run
at a 1:2 slope and meet in a short flat face opposite the stem. The icon cut
is heavy on a 100 x 96 grid. The wordmark cut is drawn at Inter's cap height
with Inter Semibold's stem, so it sits in the word as its first letter.

Writes, next to this file:
  k-icon.svg         icon K, 100 x 96 grid
  k-wordmark.svg     wordmark K, Inter units (2048 per em, cap height 1490)
  wordmark.svg       the lockup, wordmark K plus "ernel" in Inter 600 outlines
  icon-tile.svg      1024 app icon: 824 squircle, glyph with sheen
  icon-tile-32.svg   32 px render drawn on the pixel grid, no sheen
  icon-tile-16.svg   16 px render drawn on the pixel grid, no sheen
"""

import math
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = Path(__file__).parent
REPO = HERE.parent


def n(v):
    """Short number: whole when it is whole, else two decimals."""
    v = round(v, 2)
    return str(int(v)) if v == int(v) else f"{v:.2f}".rstrip("0")


# K construction ------------------------------------------------------------


def k_polygons(H, s, c, f, w):
    """Stem and chevron as point lists, y down, ink box starting at 0,0.

    H height, s stem width, c channel, f flat face height, w chevron width
    measured along a horizontal. Edges of the chevron run 1:2."""
    x0 = s + c
    y1, y2 = (H - f) / 2, (H + f) / 2
    xt = x0 + y1 / 2
    stem = [(0, 0), (s, 0), (s, H), (0, H)]
    chevron = [(x0, y1), (xt, 0), (xt + w, 0), (xt + w - H / 4, H / 2), (xt + w, H), (xt, H), (x0, y2)]
    return stem, chevron, xt + w


def rounded(points, r, ox=0, oy=0):
    """Closed path through points with convex corners filleted at radius r.
    Concave corners stay sharp. Points run clockwise with y down."""
    if r <= 0:
        return "M" + "L".join(f"{n(x + ox)} {n(y + oy)}" for x, y in points) + "Z"
    out = []
    m = len(points)
    for i, (px, py) in enumerate(points):
        ax, ay = points[i - 1]
        bx, by = points[(i + 1) % m]
        cross = (px - ax) * (by - py) - (py - ay) * (bx - px)
        if cross <= 0:
            out.append(("L", (px, py), None))
            continue
        u1 = ((ax - px), (ay - py))
        u2 = ((bx - px), (by - py))
        l1, l2 = math.hypot(*u1), math.hypot(*u2)
        u1 = (u1[0] / l1, u1[1] / l1)
        u2 = (u2[0] / l2, u2[1] / l2)
        theta = math.acos(max(-1, min(1, u1[0] * u2[0] + u1[1] * u2[1])))
        d = r / math.tan(theta / 2)
        t1 = (px + u1[0] * d, py + u1[1] * d)
        t2 = (px + u2[0] * d, py + u2[1] * d)
        out.append(("A", t1, t2))
    d = ""
    for i, (kind, a, b) in enumerate(out):
        cmd = "M" if i == 0 else "L"
        d += f"{cmd}{n(a[0] + ox)} {n(a[1] + oy)}"
        if kind == "A":
            d += f"A{n(r)} {n(r)} 0 0 1 {n(b[0] + ox)} {n(b[1] + oy)}"
    return d + "Z"


def area_centroid_x(polys):
    total = cx = 0
    for p in polys:
        a = sx = 0
        for i in range(len(p)):
            x1, y1 = p[i]
            x2, y2 = p[(i + 1) % len(p)]
            k = x1 * y2 - x2 * y1
            a += k
            sx += (x1 + x2) * k
        total += a / 2
        cx += sx / 6
    return cx / total


def k_path(params, r, ox=0, oy=0):
    stem, chevron, width = k_polygons(*params)
    return rounded(stem, r, ox, oy) + rounded(chevron, r, ox, oy), width


# The icon cut: 100 x 96. Stem 32, channel 14, chevron 34 wide on the
# horizontal, which is 30.4 across the stroke, a touch under the stem so the
# diagonals look as heavy as the vertical. Flat face 16. Corners r 2.5.
ICON = (96, 32, 14, 16, 34)
ICON_R = 2.5

# The wordmark cut, in Inter units: cap height 1490, Inter Semibold's stem 267,
# chevron 284 on the horizontal (254 across, 0.95 of the stem like the icon),
# a 150 channel so it stays open at 18 px, flat face 248 (the icon's 1/6 of H).
WORD = (1490, 267, 150, 248, 284)
WORD_R = ICON_R / 96 * 1490


def svg(view, body, comment):
    return f'<!-- {comment} -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" fill="currentColor">\n  {body}\n</svg>\n'


icon_d, icon_w = k_path(ICON, ICON_R)
(HERE / "k-icon.svg").write_text(
    svg(f"0 0 {n(icon_w)} 96", f'<path d="{icon_d}"/>', "Block K, icon cut. 100 x 96 grid: stem 32, channel 14, chevron 34 at a 1:2 slope, flat face 16, corners r 2.5.")
)

word_d, word_w = k_path(WORD, WORD_R)
(HERE / "k-wordmark.svg").write_text(
    svg(
        f"0 0 {n(word_w)} 1490",
        f'<path d="{word_d}"/>',
        "Block K, wordmark cut. Inter units, cap height 1490: stem 267 (Inter Semibold), channel 150, chevron 284, flat face 248.",
    )
)

# Wordmark lockup -----------------------------------------------------------

font = instantiateVariableFont(TTFont(REPO / "design/site/fonts/inter-var.woff2"), {"wght": 600})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
CAP = 1490
TRACK = -0.02 * 2048
# Inter's kerning for the pairs in "Kernel", measured in Chromium at 2048 px.
KERN = {"Ke": -81, "rn": 20.5}
K_RSB = 53  # Inter K's right side bearing; our K takes its place.

x = word_w + K_RSB + TRACK + KERN["Ke"]
parts = [f'<path d="{word_d}"/>']
prev = "e"
text = "ernel"
for i, ch in enumerate(text):
    if i:
        x += KERN.get(prev + ch, 0)
    g = cmap[ord(ch)]
    pen = SVGPathPen(glyphs, ntos=n)
    glyphs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, CAP)))
    parts.append(f'<path d="{pen.getCommands()}"/>')
    if i < len(text) - 1:
        x += font["hmtx"][g][0] + TRACK
    else:
        bp = BoundsPen(glyphs)
        glyphs[g].draw(bp)
        end = x + bp.bounds[2]
    prev = ch
LOCKUP_W = end
LOCKUP_H = 1513  # the e's overshoot falls 22 under the baseline
(HERE / "wordmark.svg").write_text(
    svg(
        f"0 0 {n(LOCKUP_W)} {LOCKUP_H}",
        "\n  ".join(parts),
        'Kernel wordmark: the wordmark K, then "ernel" in Inter 600 at -0.02em as outlines. Inter units, 2048 per em, baseline at y 1490.',
    )
)

# Icon tiles ----------------------------------------------------------------


def squircle(x, y, w, h, r):
    """Continuous corner rectangle from the UIBezierPath constants."""
    seq = [
        (1.52866483, 0),
        (1.08849323, 0), (0.86840689, 0), (0.63149399, 0.074911),
        (0.37282392, 0.16905899), (0.16905899, 0.37282392), (0.074911, 0.63149399),
        (0, 0.86840689), (0, 1.08849323), (0, 1.52866483),
    ]
    R, B = x + w, y + h

    def corner(fn, swap):
        return [fn(b * r, a * r) if swap else fn(a * r, b * r) for a, b in seq]

    corners = [
        corner(lambda u, v: (R - u, y + v), False),
        corner(lambda u, v: (R - u, B - v), True),
        corner(lambda u, v: (x + u, B - v), False),
        corner(lambda u, v: (x + u, y + v), True),
    ]
    d = ""
    for i, pts in enumerate(corners):
        s, rest = pts[0], pts[1:]
        d += f"{'M' if i == 0 else 'L'}{n(s[0])} {n(s[1])}"
        for k in range(0, len(rest), 3):
            d += "C" + " ".join(f"{n(p[0])} {n(p[1])}" for p in rest[k:k + 3])
    return d + "Z"


CANVAS = "#09090a"  # the app's canvas token
stem, chevron, _ = k_polygons(*ICON)
# Optical center: the chevron's notch puts the ink's mass left of the box
# center, so move the glyph right by half the difference.
cx = area_centroid_x([stem, chevron])
OPTICAL = (icon_w / 2 - cx) / 2

# 1024: the K spans 68% of the 824 tile, 560 px.
SCALE = 560 / icon_w
gx = 512 - icon_w * SCALE / 2 + OPTICAL * SCALE
gy = 512 - 96 * SCALE / 2
tile = squircle(100, 100, 824, 824, 160)
glyph_1024, _ = k_path(ICON, ICON_R)
(HERE / "icon-tile.svg").write_text(f"""<!-- Kernel app icon, 1024 canvas. 824 squircle in the canvas token, a 1 px hairline, the icon K at 68% of the tile width with a vertical sheen. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#c8c8cc"/>
    </linearGradient>
    <clipPath id="tile"><path d="{tile}"/></clipPath>
  </defs>
  <path d="{tile}" fill="{CANVAS}"/>
  <path d="{tile}" fill="none" stroke="#fff" stroke-opacity="0.16" stroke-width="2" clip-path="url(#tile)"/>
  <g transform="translate({n(gx)} {n(gy)}) scale({SCALE:.4f})">
    <path d="{glyph_1024}" fill="url(#sheen)"/>
  </g>
</svg>
""")


def small_tile(size, tile_box, radius, params, origin, hair):
    """A small render drawn on the pixel grid: whole pixel stem and channel,
    flat white glyph, and a hairline that is one real pixel wide."""
    tx, ty, tw = tile_box
    t = squircle(tx, ty, tw, tw, radius)
    d, _ = k_path(params, 0, *origin)
    return f"""<!-- Kernel app icon, {size} px render. Drawn on the pixel grid with a flat white K so the channel stays open. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <defs><clipPath id="tile"><path d="{t}"/></clipPath></defs>
  <path d="{t}" fill="{CANVAS}"/>
  <path d="{t}" fill="none" stroke="#fff" stroke-opacity="{hair}" stroke-width="2" clip-path="url(#tile)"/>
  <path d="{d}" fill="#fff"/>
</svg>
"""


# 32: tile 26 px at 3,3. K 16 tall: stem 5, channel 2, flat face 2, chevron 6.
(HERE / "icon-tile-32.svg").write_text(small_tile(32, (3, 3, 26), 5, (16, 5, 2, 2, 6), (8, 8), 0.22))
# 16: tile 13 px at 1.5,1.5. K 8 tall: stem 3, channel 1, flat face 2, chevron 3.
(HERE / "icon-tile-16.svg").write_text(small_tile(16, (1.5, 1.5, 13), 2.5, (8, 3, 1, 2, 3), (4, 4), 0.2))

print(f"icon K {n(icon_w)} x 96, optical shift {n(OPTICAL)} units; wordmark K {n(word_w)} wide; lockup {n(LOCKUP_W)} x {LOCKUP_H}")
