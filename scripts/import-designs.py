"""
Turn folders of frame artwork into designs the booth can use.

    uv run --with pillow --with numpy --with scipy scripts/import-designs.py ~/Downloads

A development tool: the booth itself never runs Python. It reads three folders
of transparent PNGs, one per layout --

    strip-frame 3/   Trio strips, 600x1800 (one 2x6in strip), 3 holes each
    strip-frame 4/   Quad strips, 600x1800, 4 holes each
    bigframe 4/      Grand sheets, any 2:3 size (scaled to 1200x1800), 4 holes

-- finds the transparent photo holes in each, and writes frames/designs/:

    <layout>/<name>.webp    the art, lossless (a third the size of the PNG)
    thumbs/<id>.jpg         a small picture for the picker, holes greyed
    designs.json            where every hole is, read by frames.js

A hole is a large connected patch of transparent pixels. Shaped holes (hearts,
stars, clouds) are fine: the photo fills the hole's bounding box and the art on
top trims it to shape, so the slot is the box plus a little bleed under the
art, so no paper shows at a soft edge. A design whose hole count does not match
its layout is refused and named, rather than half-imported.

Re-running replaces everything under frames/designs/, so it is the one place
designs come from: add a PNG to a folder, run this, commit.
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frames" / "designs"

# folder name, short key, frame id in frames.json, holes per strip/sheet, size
LAYOUTS = [
    ("strip-frame 3", "trio", "strip_3x2", 3, (600, 1800)),
    ("strip-frame 4", "quad", "strip_4x2", 4, (600, 1800)),
    ("bigframe 4", "grand", "grand_4", 4, (1200, 1800)),
]

CLEAR = 24          # alpha below this is a hole
MIN_HOLE = 0.01     # of the image area; smaller clear patches are art, not holes
BLEED = 6           # px the photo runs under the art (0.5 mm at 300 dpi)
MERGE = 0.10        # boxes overlapping this much of the smaller one are one hole



def number(path):
    digits = "".join(c for c in path.stem if c.isdigit())
    return int(digits) if digits else 0


def find_holes(alpha):
    """Bounding boxes of the transparent photo holes, merged across thin lines."""
    H, W = alpha.shape
    labels, _ = ndimage.label(alpha < CLEAR)
    boxes = []
    for i, sl in enumerate(ndimage.find_objects(labels), start=1):
        ys, xs = sl
        if (labels[sl] == i).sum() >= MIN_HOLE * W * H:
            boxes.append([xs.start, ys.start, xs.stop, ys.stop])

    # A line of art drawn across a hole (B14's heart) splits it into pieces
    # whose boxes overlap heavily. Interlocking shapes (SV-9's hearts) come
    # within a pixel of each other without overlapping, so touching is not
    # enough: only real overlap joins two patches into one hole.
    def overlap(p, q):
        w = min(p[2], q[2]) - max(p[0], q[0])
        h = min(p[3], q[3]) - max(p[1], q[1])
        if w <= 0 or h <= 0:
            return 0.0
        smaller = min((p[2] - p[0]) * (p[3] - p[1]), (q[2] - q[0]) * (q[3] - q[1]))
        return w * h / smaller

    merged = True
    while merged:
        merged = False
        for a in range(len(boxes)):
            for b in range(a + 1, len(boxes)):
                p, q = boxes[a], boxes[b]
                if overlap(p, q) >= MERGE:
                    boxes[a] = [min(p[0], q[0]), min(p[1], q[1]), max(p[2], q[2]), max(p[3], q[3])]
                    del boxes[b]
                    merged = True
                    break
            if merged:
                break
    return boxes


def with_bleed(boxes, W, H):
    """Grow each box under the art, never into a neighbour."""
    out = []
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        bleed = BLEED
        for j, (a0, b0, a1, b1) in enumerate(boxes):
            if i == j:
                continue
            # Keep half the gap to a neighbour in reserve.
            gx = max(a0 - x1, x0 - a1)
            gy = max(b0 - y1, y0 - b1)
            gap = max(gx, gy)
            if gap >= 0:
                bleed = min(bleed, max(0, gap // 2 - 1))
        out.append({
            "x": max(0, x0 - bleed), "y": max(0, y0 - bleed),
            "w": min(W, x1 + bleed) - max(0, x0 - bleed),
            "h": min(H, y1 + bleed) - max(0, y0 - bleed),
        })
    return out


def reading_order(holes, H, rows):
    """Top to bottom; for a two-by-two sheet, row by row, left to right."""
    if rows == 1:
        return sorted(holes, key=lambda r: r["y"])
    return sorted(holes, key=lambda r: (r["y"] + r["h"] / 2 > H / 2, r["x"]))


def paper_colour(rgba):
    """The design's dominant colour, from an opaque band just inside its edge."""
    a = np.asarray(rgba)
    band = np.concatenate([a[:24].reshape(-1, 4), a[-24:].reshape(-1, 4),
                           a[:, :24].reshape(-1, 4), a[:, -24:].reshape(-1, 4)])
    band = band[band[:, 3] > 250][:, :3]
    if not len(band):
        return "#FFFFFF"
    # Most common colour, to 8 levels per channel, so a pattern does not average to mud.
    q = (band // 8) * 8 + 4
    vals, counts = np.unique(q, axis=0, return_counts=True)
    r, g, b = (int(v) for v in vals[counts.argmax()])
    return f"#{r:02X}{g:02X}{b:02X}"


def thumbnail(rgba, holes, width):
    """The design as the picker shows it: holes in a soft grey, JPEG."""
    grey = Image.new("RGBA", rgba.size, (218, 218, 218, 255))
    grey.alpha_composite(rgba)
    h = round(rgba.height * width / rgba.width)
    return grey.convert("RGB").resize((width, h), Image.LANCZOS)


def main(src):
    src = Path(src).expanduser()
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "thumbs").mkdir(parents=True)

    designs, refused, holes_by_name = [], [], {}
    for folder, key, layout, per, size in LAYOUTS:
        files = sorted((src / folder).glob("*.png"), key=number)
        if not files:
            refused.append(f"{folder}: no PNGs found in {src / folder}")
            continue
        (OUT / key).mkdir()
        rows = 2 if key == "grand" else 1
        for f in files:
            im = Image.open(f).convert("RGBA")
            if im.size != size:
                im = im.resize(size, Image.LANCZOS)
            W, H = im.size
            boxes = find_holes(np.asarray(im)[:, :, 3])
            if len(boxes) != per:
                refused.append(f"{folder}/{f.name}: found {len(boxes)} holes, a {key} needs {per}")
                continue
            holes = reading_order(with_bleed(boxes, W, H), H, rows)

            did = f"{key}-{f.stem}"
            rel = f"{key}/{f.stem}.webp"
            im.save(OUT / rel, "WEBP", lossless=True, method=6)
            thumbnail(im, holes, 150 if rows == 1 else 240).save(
                OUT / "thumbs" / f"{did}.jpg", "JPEG", quality=84, optimize=True)

            entry = {
                "id": did,
                "layout": layout,
                "label": str(number(f)),
                "art": rel,
                "thumb": f"thumbs/{did}.jpg",
                "background": paper_colour(im),
                "holes": holes,
            }
            holes_by_name[f.stem] = (rel, holes)
            designs.append(entry)
            print(f"  {did:14} {len(holes)} holes  paper {entry['background']}")

    # No keychains from a Grand sheet. It is two photos wide and the insert is
    # one, so anything small has to be a different picture from the one that
    # was printed -- either a stranger's frame borrowed from the Quad set, or
    # the photos stacked on bare paper. Both were worse than not offering it,
    # so the booth says so at the menu instead.

    (OUT / "designs.json").write_text(json.dumps(designs, indent=1))
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"\n{len(designs)} designs -> {OUT.relative_to(ROOT)} ({size / 1e6:.1f} MB)")
    if refused:
        print("\nNOT imported:")
        for r in refused:
            print("  " + r)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "~/Downloads"))
