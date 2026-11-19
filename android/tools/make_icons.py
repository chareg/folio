"""Builds Folio's adaptive launcher icon foreground from the desktop icon (build/icon.png).

The desktop icon is the italic "F." on a dark rounded square. Android draws its own
mask, so we lift just the letter and the pink dot onto a transparent layer and let the
background drawable supply the dark gradient. Run from android/: python3 tools/make_icons.py
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = Image.open(os.path.join(ROOT, "..", "build", "icon.png")).convert("RGBA")
W, H = src.size
px = src.load()

# Background of the source tile is a dark gradient; the glyphs are much brighter.
out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
op = out.load()
for y in range(H):
    for x in range(W):
        r, g, b, a = px[x, y]
        lum = max(r, g, b)
        k = (lum - 52) / (200 - 52)
        k = 0 if k < 0 else 1 if k > 1 else k
        inner = 36 <= x < W - 36 and 36 <= y < H - 36  # skip the tile's light rim
        if k > 0 and a > 0 and inner:
            # undo the dark background blend so edges stay crisp on any background
            def un(c):
                v = (c - 30 * (1 - k)) / k
                return int(max(0, min(255, v)))
            op[x, y] = (un(r), un(g), un(b), int(255 * k * a / 255))

bbox = out.split()[3].point(lambda a: 255 if a > 90 else 0).getbbox()
glyph = out.crop(bbox)
gw, gh = glyph.size
# Fit the glyph inside the 66/108 safe zone (a little smaller so it breathes).
SIZE = 432
target = int(SIZE * 0.54)
scale = target / max(gw, gh)
glyph = glyph.resize((max(1, int(gw * scale)), max(1, int(gh * scale))), Image.LANCZOS)
canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
canvas.paste(glyph, ((SIZE - glyph.width) // 2 + int(SIZE * 0.01), (SIZE - glyph.height) // 2), glyph)

for name, px_size in {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}.items():
    d = os.path.join(ROOT, "app", "res", "mipmap-" + name)
    os.makedirs(d, exist_ok=True)
    canvas.resize((px_size, px_size), Image.LANCZOS).save(os.path.join(d, "ic_launcher_foreground.png"), optimize=True)

# A flat preview of how a launcher will draw it, for the README / checking by eye.
prev = Image.new("RGBA", (SIZE, SIZE))
for y in range(SIZE):
    t = (y / SIZE) * 0.6 + 0.2
    for x in range(SIZE):
        u = (t + x / SIZE * 0.4)
        c0, c1 = (0x29, 0x23, 0x3a), (0x16, 0x13, 0x1d)
        prev.putpixel((x, y), tuple(int(c0[i] + (c1[i] - c0[i]) * min(1, u)) for i in range(3)) + (255,))
prev.alpha_composite(canvas)
mask = Image.new("L", (SIZE, SIZE), 0)
from PIL import ImageDraw
ImageDraw.Draw(mask).ellipse((0, 0, SIZE - 1, SIZE - 1), fill=255)
prev.putalpha(mask)
prev.save(os.path.join(ROOT, "tools", "icon-preview.png"))
print("icons written", bbox)
