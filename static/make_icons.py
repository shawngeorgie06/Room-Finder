"""Generate PNG app icons from the SVG door motif.

iOS Safari does not reliably render SVG apple-touch-icons, so the home-screen
icon needs raster PNGs. Run locally after changing the design; the PNGs are
committed so the Render deploy needs no image dependency:

    python static/make_icons.py
"""
import os
from PIL import Image, ImageDraw

BG = (8, 8, 8, 255)        # #080808
GREEN = (63, 255, 139, 255)  # #3fff8b
HERE = os.path.dirname(__file__)


def draw_motif(size, inset=0.0):
    """Render the door/screen icon at `size` px. `inset` (0–1) shrinks the
    motif toward the center for maskable safe-zone padding; the background
    stays full-bleed."""
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    # Work in the original 32x32 coordinate space, scaled and centered.
    scale = size / 32.0 * (1 - inset)
    off = size * inset / 2.0

    def px(v):
        return v * scale + off

    sw = max(2, round(2 * scale))  # stroke width

    # Door frame: rounded rect outline (orig x6 y8 w20 h16 rx2)
    d.rounded_rectangle(
        [px(6), px(8), px(6 + 20), px(8 + 16)],
        radius=2 * scale, outline=GREEN, width=sw,
    )
    # Door panel (orig x13 y18 w6 h6)
    d.rectangle([px(13), px(18), px(13 + 6), px(18 + 6)], fill=GREEN)
    # Knob/notch: dark disc then green disc (orig cx24 cy10 r4 / r3)
    d.ellipse([px(24 - 4), px(10 - 4), px(24 + 4), px(10 + 4)], fill=BG)
    d.ellipse([px(24 - 3), px(10 - 3), px(24 + 3), px(10 + 3)], fill=GREEN)
    return img


def rounded(img, radius_frac=0.0):
    """Apply transparent rounded corners (for PWA 'any' icons; iOS and
    maskable want full-bleed squares so they pass radius_frac=0)."""
    if radius_frac <= 0:
        return img
    size = img.size[0]
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size, size], radius=size * radius_frac, fill=255
    )
    img.putalpha(mask)
    return img


def save(img, name):
    path = os.path.join(HERE, name)
    img.save(path, "PNG")
    print("wrote", name, img.size)


# apple-touch-icon: full-bleed square, iOS rounds it itself
save(draw_motif(180), "apple-touch-icon.png")
# PWA "any": rounded corners
save(rounded(draw_motif(512), 0.18), "icon-512.png")
# PWA maskable: content inside ~80% safe zone, full-bleed background
save(draw_motif(512, inset=0.22), "icon-512-maskable.png")
