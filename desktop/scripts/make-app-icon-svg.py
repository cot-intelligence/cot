"""Outline the "cot." wordmark into src-tauri/icons/icon.svg, the app icon source.

Newsreader Bold Italic at opsz 72 (what the app's wordmark renders at display
sizes), shaped with HarfBuzz so kerning matches the browser, on the macOS icon
grid: an 824px Forest tile inset 100px on a 1024 canvas, r185, soft drop shadow.
Run from desktop/ (needs network for the font):
    uv run --with fonttools --with brotli --with uharfbuzz python scripts/make-app-icon-svg.py
Then scripts/make-app-icon.sh renders every size from the SVG.
"""
import io, sys, tempfile, urllib.request
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

FONT_URL = "https://fonts.gstatic.com/s/newsreader/v26/cY9XfjOCX1hbuyalUrK439vogqCz_goCYw7oRTmOFYYzbARA_n8.woff2"
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "icon.svg"
with tempfile.TemporaryDirectory() as tmp:
    woff2 = Path(tmp) / "newsreader-bold-italic.woff2"
    urllib.request.urlretrieve(FONT_URL, woff2)
    font = TTFont(woff2)
    font.ensureDecompiled()
if "fvar" in font:
    font = instancer.instantiateVariableFont(font, {a.axisTag: (72 if a.axisTag == "opsz" else 700 if a.axisTag == "wght" else a.defaultValue) for a in font["fvar"].axes})
font.flavor = None
buf = io.BytesIO(); font.save(buf); data = buf.getvalue()
upem = font["head"].unitsPerEm
gs = font.getGlyphSet()

hbfont = hb.Font(hb.Face(data))
b = hb.Buffer(); b.add_str("cot."); b.guess_segment_properties()
hb.shape(hbfont, b, {"kern": True, "liga": True})
order = font.getGlyphOrder()

# Lay glyphs out in font units (y up), record per-glyph paths.
x = 0; glyphs = []
for info, pos in zip(b.glyph_infos, b.glyph_positions):
    glyphs.append((order[info.codepoint], x + pos.x_offset, pos.y_offset)); x += pos.x_advance

SIZE, INSET, TILE, RADIUS = 1024, 100, 824, 185
FONT_PX = 340
scale = FONT_PX / upem
# Ink bounds of the whole word.
bp = BoundsPen(gs)
for name, gx, gy in glyphs:
    gs[name].draw(TransformPen(bp, (1, 0, 0, 1, gx, gy)))
xmin, ymin, xmax, ymax = bp.bounds
cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
# Map font units -> canvas: flip y, center ink on canvas.
def tf(gx, gy): return (scale, 0, 0, -scale, SIZE / 2 + (gx - cx) * scale, SIZE / 2 + (cy - gy) * scale)
paths = []
for name, gx, gy in glyphs:
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, tf(gx, gy)))
    paths.append((name, pen.getCommands()))

word = " ".join(d for n, d in paths if n != "period")
dot = " ".join(d for n, d in paths if n == "period")
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}">
  <!-- cot. app icon: macOS grid (824 tile inset 100, r185), Newsreader Bold Italic at opsz 72, outlined. -->
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <rect x="{INSET}" y="{INSET}" width="{TILE}" height="{TILE}" rx="{RADIUS}" fill="#0F5B3E" filter="url(#shadow)"/>
  <path fill="#FFFFFF" d="{word}"/>
  <path fill="#C8F169" d="{dot}"/>
</svg>
'''
OUT.write_text(svg)
print("wrote", OUT)
