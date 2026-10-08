"""
temporary collection: background-removal pipeline for object photos.

Usage:
    pip install -r requirements.txt
    python pipeline/cutout.py input.jpg output.webp

What it does (the same steps used to make the 39 objects in public/img):
1. Downscales a working copy to 1200px and builds a mask from two models
   (rembg isnet-general-use + u2net), refined with OpenCV GrabCut.
2. Keeps the largest shape, closes small gaps, and fills only SMALL holes
   (under 0.2% of the shirt). Larger holes, like the gap between a long
   sleeve and the body, stay open. Filling every hole caused the old
   "sheet stuck under the arm" bug.
3. For dark objects, removes pale, low-saturation patches that touch the
   outline (sheet showing at the armpits).
4. Scales the mask back to full resolution, feathers the edge, crops to
   the object and writes a 1600px-max WebP with transparency.

Notes:
- First run downloads the models (~180MB isnet + ~170MB u2net) to U2NET_HOME
  (set to /data/u2net on Railway so models persist across deploys).
- Needs ~2-4GB RAM. Takes ~10-15s per photo on a CPU.
- Works best on the dark mat. White objects on a white sheet will fail;
  reshoot them on the mat.
- Label photos are NOT cut out: crop the centre square and save as WebP.
"""
import sys
import os
import json
import resource
import numpy as np
import cv2
from PIL import Image, ImageFilter, ImageOps
from scipy import ndimage as ndi
from rembg import remove, new_session

_SESSIONS = None


def sessions():
    global _SESSIONS
    if _SESSIONS is None:
        _SESSIONS = [new_session("isnet-general-use"), new_session("u2net")]
    return _SESSIONS


def build_mask(work: Image.Image) -> np.ndarray:
    a = np.array(work)
    ms = [np.array(remove(work, session=s, only_mask=True)) for s in sessions()]
    soft = np.maximum(ms[0], ms[1])
    gm = np.full(soft.shape, cv2.GC_PR_BGD, np.uint8)
    gm[soft > 30] = cv2.GC_PR_FGD
    gm[np.minimum(ms[0], ms[1]) > 200] = cv2.GC_FGD
    b = 10
    gm[:b, :] = gm[-b:, :] = cv2.GC_BGD
    gm[:, :b] = gm[:, -b:] = cv2.GC_BGD
    bg = np.zeros((1, 65)); fg = np.zeros((1, 65))
    cv2.grabCut(cv2.cvtColor(a, cv2.COLOR_RGB2BGR), gm, None, bg, fg, 5, cv2.GC_INIT_WITH_MASK)
    m = (gm == 1) | (gm == 3)
    m = ndi.binary_opening(m, iterations=3)
    lab, n = ndi.label(m)
    if n:
        m = lab == (np.argmax(ndi.sum(m, lab, range(1, n + 1))) + 1)
    m = ndi.binary_closing(m, iterations=3)
    holes = ndi.binary_fill_holes(m) & ~m
    hl, hn = ndi.label(holes)
    if hn:
        sizes = ndi.sum(holes, hl, range(1, hn + 1))
        lim = m.sum() * 0.002
        for k, sz in enumerate(sizes, 1):
            if sz < lim:
                m[hl == k] = True
    return m


def remove_sheet_on_dark(rgba: np.ndarray) -> np.ndarray:
    m = rgba[..., 3] > 128
    rgb = rgba[..., :3].astype(float) / 255
    L = rgb.mean(2); sat = rgb.max(2) - rgb.min(2)
    if np.median(L[m]) > 0.4:
        return rgba
    cand = ndi.binary_opening(m & (L > 0.45) & (sat < 0.2), iterations=2)
    edge = m & ~ndi.binary_erosion(m, iterations=14)
    lab, n = ndi.label(cand)
    for k in range(1, n + 1):
        comp = lab == k
        if (comp & edge).any() and comp.sum() > m.sum() * 0.001:
            m[ndi.binary_dilation(comp, iterations=3)] = False
    al = Image.fromarray((m * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.2))
    out = Image.fromarray(rgba[..., :3]); out.putalpha(al)
    return np.array(out)


def cutout(src: str, dst: str, max_px: int = 1600):
    big = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    big.thumbnail((2400, 2400))
    work = big.copy(); work.thumbnail((1200, 1200))
    m = build_mask(work)
    sm = Image.fromarray((m * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.5)).resize(big.size, Image.BICUBIC)
    al = np.clip((np.array(sm).astype(float) - 128) * 3 + 128, 0, 255).astype("uint8")
    A = Image.fromarray(al).filter(ImageFilter.GaussianBlur(0.8))
    r = big.copy(); r.putalpha(A)
    r = Image.fromarray(remove_sheet_on_dark(np.array(r)))
    r = r.crop(r.getchannel("A").getbbox())
    r.thumbnail((max_px, max_px), Image.LANCZOS)
    r.save(dst, quality=84, method=6)
    px = np.array(r)[np.array(r)[..., 3] > 250][:, :3]
    peak_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Linux reports in kB; macOS in bytes
    peak_mb = peak_kb // 1024 if sys.platform != "darwin" else peak_kb // (1024 * 1024)
    return {"w": r.width, "h": r.height, "bodyColour": "#%02x%02x%02x" % tuple(np.median(px, axis=0).astype(int)), "peakMB": peak_mb}


def label_crop(src: str, dst: str, max_px: int = 1000):
    t = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    w, h = t.size; s = min(w, h) * 0.8
    t = t.crop((int((w - s) / 2), int((h - s) / 2), int((w + s) / 2), int((h + s) / 2)))
    t.thumbnail((max_px, max_px)); t.save(dst, quality=82)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python cutout.py <input> <output> [label_crop]", file=sys.stderr)
        sys.exit(1)
    mode = sys.argv[3] if len(sys.argv) > 3 else "cutout"
    if mode == "label_crop":
        label_crop(sys.argv[1], sys.argv[2])
        print(json.dumps({"ok": True}))
    else:
        print(json.dumps(cutout(sys.argv[1], sys.argv[2])))
