#!/usr/bin/env python3
"""
Builds the Android app's image resources from the web app's icons (v3.9).

    python3 android/tools/make-icons.py        (run from the repository root; needs Pillow)

Writes into android/app/src/main/res/:
  mipmap-*/ic_launcher.png             legacy launcher icon (Android 7) <- client/public/icons/icon-512.png
  mipmap-*/ic_launcher_foreground.png  adaptive icon foreground (Android 8+): the logo in the 66 dp safe zone
  mipmap-*/ic_launcher_monochrome.png  themed-icon layer (Android 13+): the logo's silhouette
  drawable-*/splash.png                splash screen logo
  drawable-*/ic_notification_icon.png  white-on-transparent silhouette for the status bar

Everything except the legacy icon redraws the logo (blue football with laces, green check badge) from
its geometry in the 512 px maskable icon, so it stays sharp at every size. The adaptive icon's
background is the app colour (#10171A, mipmap-anydpi-v26/ic_launcher.xml). Only needed again if the
logo changes — the PNGs are committed.
"""
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ICONS = os.path.join(ROOT, "client", "public", "icons")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]
LAUNCHER = [48, 72, 96, 144, 192]
ADAPTIVE = [108, 162, 216, 324, 432]  # 108 dp adaptive icon layers
SPLASH = [300, 450, 600, 900, 1200]
NOTIFICATION = [24, 36, 48, 72, 96]

BG = (16, 23, 26)          # #10171A, the web manifest's background/theme colour
BLUE = (74, 143, 194)      # football
LACE = (237, 243, 241)     # laces
GREEN = (63, 174, 88)      # check badge
CHECK = (16, 23, 26)       # check mark

# Logo geometry in the 512 px maskable icon's coordinates.
ELLIPSE = (255.5, 255.5, 108.0, 66.5)            # centre x, centre y, radius x, radius y
OUTLINE = 2.8                                     # white 32 % rim
LACE_BAR = ((204.0, 255.5), (307.0, 255.5), 4.8)  # from, to, width (round caps)
LACE_TICKS = [((x, 245.0), (x, 266.0), 4.4) for x in (235.5, 255.5, 275.5)]
BADGE = (349.0, 198.0, 18.5)                      # centre x, centre y, radius
CHECK_PTS = [(341.5, 198.5), (347.5, 204.5), (357.5, 191.0)]
CHECK_W = 4.6
CONTENT = (147.0, 179.5, 367.5, 323.5)            # bounding box of the whole logo


def _line(draw, a, b, w, fill, k, ox, oy):
    """Thick line with round caps, in logo units scaled by k and shifted by (ox, oy)."""
    (x1, y1), (x2, y2) = a, b
    p1 = (ox + x1 * k, oy + y1 * k)
    p2 = (ox + x2 * k, oy + y2 * k)
    draw.line([p1, p2], fill=fill, width=max(1, round(w * k)))
    r = w * k / 2
    for (cx, cy) in (p1, p2):
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def _polyline(draw, pts, w, fill, k, ox, oy):
    for a, b in zip(pts, pts[1:]):
        _line(draw, a, b, w, fill, k, ox, oy)


def logo(size, fill_ratio=0.8, ss=4):
    """Colour logo on a transparent square (RGB of transparent pixels = BG, to avoid dark halos)."""
    S = size * ss
    img = Image.new("RGBA", (S, S), BG + (0,))
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = CONTENT
    k = fill_ratio * S / (x1 - x0)
    ox = S / 2 - (x0 + x1) / 2 * k
    oy = S / 2 - (y0 + y1) / 2 * k
    cx, cy, rx, ry = ELLIPSE
    # rim: a slightly larger white-ish ellipse under the fill
    rim = tuple(round(BG[i] + 0.32 * (255 - BG[i])) for i in range(3)) + (255,)
    e = OUTLINE / 2
    d.ellipse([ox + (cx - rx - e) * k, oy + (cy - ry - e) * k, ox + (cx + rx + e) * k, oy + (cy + ry + e) * k], fill=rim)
    rim_in = tuple(round(BLUE[i] + 0.32 * (255 - BLUE[i])) for i in range(3)) + (255,)
    d.ellipse([ox + (cx - rx) * k, oy + (cy - ry) * k, ox + (cx + rx) * k, oy + (cy + ry) * k], fill=rim_in)
    d.ellipse([ox + (cx - rx + e) * k, oy + (cy - ry + e) * k, ox + (cx + rx - e) * k, oy + (cy + ry - e) * k], fill=BLUE + (255,))
    a, b, w = LACE_BAR
    _line(d, a, b, w, LACE + (255,), k, ox, oy)
    for a, b, w in LACE_TICKS:
        _line(d, a, b, w, LACE + (255,), k, ox, oy)
    bx, by, br = BADGE
    d.ellipse([ox + (bx - br) * k, oy + (by - br) * k, ox + (bx + br) * k, oy + (by + br) * k], fill=GREEN + (255,))
    _polyline(d, CHECK_PTS, CHECK_W, CHECK + (255,), k, ox, oy)
    return img.resize((size, size), Image.LANCZOS)


def silhouette(size, fill_ratio=22 / 24, ss=8):
    """White silhouette (notification bar, themed icon): football with lace cut-outs, badge with a check cut-out."""
    S = size * ss
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    x0, y0, x1, y1 = CONTENT
    k = fill_ratio * S / (x1 - x0)
    ox = S / 2 - (x0 + x1) / 2 * k
    oy = S / 2 - (y0 + y1) / 2 * k
    cx, cy, rx, ry = ELLIPSE
    d.ellipse([ox + (cx - rx) * k, oy + (cy - ry) * k, ox + (cx + rx) * k, oy + (cy + ry) * k], fill=255)
    a, b, w = LACE_BAR
    _line(d, a, b, w * 1.6, 0, k, ox, oy)
    for a, b, w in LACE_TICKS:
        _line(d, a, b, w * 1.6, 0, k, ox, oy)
    bx, by, br = BADGE
    gap = 7.0  # transparent ring between the badge and the football
    d.ellipse([ox + (bx - br - gap) * k, oy + (by - br - gap) * k, ox + (bx + br + gap) * k, oy + (by + br + gap) * k], fill=0)
    d.ellipse([ox + (bx - br) * k, oy + (by - br) * k, ox + (bx + br) * k, oy + (by + br) * k], fill=255)
    _polyline(d, CHECK_PTS, CHECK_W * 1.5, 0, k, ox, oy)
    alpha = m.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.putalpha(alpha)
    return out


def save(img, folder, name):
    path = os.path.join(RES, folder, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    return path


def main():
    icon = Image.open(os.path.join(ICONS, "icon-512.png")).convert("RGBA")
    written = []
    for dens, a, b, c, n in zip(DENSITIES, LAUNCHER, ADAPTIVE, SPLASH, NOTIFICATION):
        written.append(save(icon.resize((a, a), Image.LANCZOS), f"mipmap-{dens}", "ic_launcher.png"))
        # 54 of 108 dp wide: the logo's farthest point (the badge) stays inside the 66 dp safe circle.
        written.append(save(logo(b, fill_ratio=0.5), f"mipmap-{dens}", "ic_launcher_foreground.png"))
        written.append(save(silhouette(b, fill_ratio=0.5), f"mipmap-{dens}", "ic_launcher_monochrome.png"))
        written.append(save(logo(c), f"drawable-{dens}", "splash.png"))
        written.append(save(silhouette(n), f"drawable-{dens}", "ic_notification_icon.png"))
    print(f"wrote {len(written)} images under {RES}")


if __name__ == "__main__":
    sys.exit(main())
