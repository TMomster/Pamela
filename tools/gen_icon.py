"""Generate a Pamela program icon (white petals + black core) as a multi-size
ICO, using only the Python standard library (no Pillow / cairosvg available).

The source flower SVG could not be rasterised in this environment, so we draw a
simplified 8-petal flower: black core, white petals with a thin grey outline so
the white stays visible on light backgrounds. Output: icons/icon.ico.
"""
import struct
import math
import os

SIZES = [16, 32, 48, 64, 128, 256]


def petal_hit(dx, dy, dist, long, short):
    for k in range(8):
        ang = math.pi / 4 * k
        u = dx * math.cos(ang) + dy * math.sin(ang)
        v = -dx * math.sin(ang) + dy * math.cos(ang)
        eu = (u - dist) / long
        ev = v / short
        if eu * eu + ev * ev <= 1.0:
            return True
    return False


def make_pixels(size):
    cx = cy = size / 2
    core_r = size * 39.5 / 256.0
    dist = size * 0.30
    long = size * 0.22
    short = size * 0.12
    olong = long + size * 0.02
    oshort = short + size * 0.02
    buf = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            dx = x - cx + 0.5
            dy = y - cy + 0.5
            r = g = b = a = 0
            if dx * dx + dy * dy <= core_r * core_r:
                r = g = b = 0
                a = 255
            elif petal_hit(dx, dy, dist, olong, oshort):
                if petal_hit(dx, dy, dist, long, short):
                    r = g = b = 255
                else:
                    r = g = b = 120
                a = 255
            idx = (y * size + x) * 4
            buf[idx] = r
            buf[idx + 1] = g
            buf[idx + 2] = b
            buf[idx + 3] = a
    return bytes(buf)


def bmp_data(px, size):
    # BITMAPINFOHEADER；按 ICO 规范把 biHeight 加倍。
    hdr = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
    rows = bytearray()
    for y in range(size - 1, -1, -1):
        rows += px[y * size * 4:(y + 1) * size * 4]
    return hdr + bytes(rows)


def main():
    imgs = [bmp_data(make_pixels(s), s) for s in SIZES]
    out = bytearray()
    out += struct.pack("<HHH", 0, 1, len(imgs))
    off = 6 + 16 * len(imgs)
    for s, d in zip(SIZES, imgs):
        bw = s if s < 256 else 0
        out += struct.pack("<BBBBHHII", bw, bw, 0, 0, 1, 32, len(d), off)
        off += len(d)
    for d in imgs:
        out += d
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "icons", "icon.ico")
    with open(path, "wb") as f:
        f.write(out)
    with open(os.path.join(here, "_genlog.txt"), "w") as f:
        f.write("OK sizes=%s bytes=%d" % (SIZES, len(out)))


main()
