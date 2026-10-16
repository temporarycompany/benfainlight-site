"""
temporary collection: prepare a whole batch of plate photos for upload.

Usage:
    python pipeline/prep_batch.py <images_dir> <out_dir> [--reference f,b,l]

<images_dir> holds <key>_<plate>.jpg files, plate = front | back | label.
For each file it writes <out_dir>/<key>_<plate>.webp:
  front, back -> cutout (transparent background, 1600px max)
  label       -> centre-square crop, 840px
and then:
  <out_dir>/qa.json     per-plate QA numbers and a "review" flag
  <out_dir>/review.jpg  every plate drawn exactly as the site's object page
                        frames it (stone plate, 48px padding, contain);
                        flagged plates are outlined in red

Optional: --reference front.webp,back.webp,label.webp puts an object that is
already on the site at the top of the sheet for comparison.

Nothing is uploaded. Look at review.jpg before anything goes to the site.
"""
import glob
import json
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cutout as cut  # noqa: E402

STONE = (242, 242, 240, 255)
PLATES = ("front", "back", "label")


def main(src_dir: str, out_dir: str, reference: list = None):
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(src_dir, "*")))
    jobs = []
    for f in files:
        stem, ext = os.path.splitext(os.path.basename(f))
        if ext.lower() not in (".jpg", ".jpeg", ".png", ".heic", ".webp") or "_" not in stem:
            continue
        key, plate = stem.rsplit("_", 1)
        if plate not in PLATES:
            print(f"skip {f}: plate must be one of {PLATES}", file=sys.stderr)
            continue
        jobs.append((key, plate, f))
    qa = {}
    for i, (key, plate, f) in enumerate(jobs, 1):
        dst = os.path.join(out_dir, f"{key}_{plate}.webp")
        if plate == "label":
            res = {**cut.label_crop(f, dst), "cutout": False, "review": False}
        else:
            res = {**cut.cutout(f, dst), "cutout": True}
        res["file"] = os.path.basename(dst)
        qa.setdefault(key, {})[plate] = res
        flag = "REVIEW" if res.get("review") else "ok"
        print(f"[{i}/{len(jobs)}] {key}_{plate}: {flag} {res.get('qa', '')}", flush=True)
    with open(os.path.join(out_dir, "qa.json"), "w") as fh:
        json.dump(qa, fh, indent=1)
    sheet(qa, out_dir, reference)
    flagged = [f"{k}_{p}" for k, v in qa.items() for p, r in v.items() if r.get("review")]
    print(json.dumps({"plates": len(jobs), "flagged": flagged,
                      "review": os.path.join(out_dir, "review.jpg")}))


# Desktop object-page plate on the site: 952x660 box, 48px padding,
# object-fit: contain, stone background; label plates ("photo") are capped
# at 80% of the height. The review sheet draws every plate the same way, at
# half size, so what gets approved is what the site will show.
PLATE_W, PLATE_H, PAD = 952, 660, 48


def plate_tile(path: str, role: str, scale: float = 0.5) -> Image.Image:
    W, H, P = int(PLATE_W * scale), int(PLATE_H * scale), int(PAD * scale)
    tile = Image.new("RGBA", (W, H), STONE)
    im = Image.open(path).convert("RGBA")
    iw, ih = W - 2 * P, H - 2 * P
    if role == "label":
        ih = int(ih * 0.8)
    k = min(iw / im.width, ih / im.height)
    im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    tile.alpha_composite(im, ((W - im.width) // 2, (H - im.height) // 2))
    return tile.convert("RGB")


def sheet(qa: dict, out_dir: str, reference: list = None):
    rows = [(k, {p: os.path.join(out_dir, v["file"]) for p, v in pl.items()},
             {p: v.get("review") for p, v in pl.items()}) for k, pl in sorted(qa.items())]
    if reference:  # e.g. an object from the first batch, for comparison
        rows.insert(0, ("REFERENCE (already on site)",
                        {p: f for p, f in zip(PLATES, reference) if f}, {}))
    tw, th = int(PLATE_W * 0.5), int(PLATE_H * 0.5)
    W, H = 3 * (tw + 8) + 8, len(rows) * (th + 30) + 8
    S = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(S)
    for r, (key, files, flags) in enumerate(rows):
        y = 8 + r * (th + 30)
        d.text((8, y), key, fill=(17, 17, 17))
        for c, p in enumerate(PLATES):
            if p not in files:
                continue
            x = 8 + c * (tw + 8)
            S.paste(plate_tile(files[p], p), (x, y + 14))
            if flags.get(p):
                d.rectangle([x, y + 14, x + tw - 1, y + 14 + th - 1], outline=(200, 0, 0), width=4)
    S.save(os.path.join(out_dir, "review.jpg"), quality=85)


if __name__ == "__main__":
    args = sys.argv[1:]
    ref = None
    if "--reference" in args:
        i = args.index("--reference"); ref = args[i + 1].split(","); del args[i:i + 2]
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    main(args[0], args[1], ref)
