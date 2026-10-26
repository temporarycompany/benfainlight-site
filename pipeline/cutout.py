"""
temporary collection: background-removal pipeline for object photos.

Usage:
    pip install -r requirements.txt
    python pipeline/cutout.py input.jpg output.webp            # cutout (front/back)
    python pipeline/cutout.py input.jpg output.webp label_crop # label plate
    python pipeline/cutout.py input.jpg output.webp cutout --debug debug.jpg

Prints one JSON line: {"w", "h", "bodyColour", "qa": {...}, "review": bool, "peakMB"}.
"review": true means a person should look at the result before it is used.

What it does:
1. Downscales a working copy to 1200px. The outline is the union of
   rembg's u2net and isnet-general-use masks (each alone sometimes clips a
   hem or cuff). isnet then proposes pockets of surface still inside the
   outline (under the arms); each is removed only if its colour and
   texture match the surface around the object. Then the strip of surface
   between a long sleeve and the body (both models fill it in when the
   sleeve lies close) is removed: a tall, light, surface-textured ridge with
   garment on both sides. The outline is then snapped to the
   real edge with GrabCut, allowed to move only ~1% of the image either
   way (u2net sometimes clips a hem by a few pixels).
   History: the first version merged both models and refined with OpenCV
   GrabCut plus a "remove pale patches from dark shirts" rule. On the grey
   quilt GrabCut grew shirts into the quilt and the pale-patch rule cut
   holes in sun-lit sleeves. Both are gone.
2. Keeps the largest shape, closes small gaps, fills only SMALL holes
   (under 0.2% of the object) so the gap between a long sleeve and the
   body stays open.
3. QA: model agreement, whether the object runs off the frame, how much of
   the frame it fills, how different it looks from the surface, whether
   an edge (hem, cuff) looks clipped, and left-right symmetry (a lopsided
   cutout has lost part of the object).
4. Scales the mask back to full resolution, chokes the edge ~2px (no halo),
   feathers it, crops tight to the object and writes a 1600px-max WebP with
   transparency. Tight crop is deliberate: it matches the first 39 objects;
   the site adds the breathing room (48px plate padding, card at 86%).

Notes:
- First run downloads the models (~180MB isnet + ~170MB u2net) to U2NET_HOME.
- Needs ~2-4GB RAM. Takes ~15-25s per photo on a CPU.
- Shoot on the dark mat, whole object inside the frame with a margin.
  Dark objects on the grey quilt and white objects on a white sheet are
  the hardest cases. QA flags most bad photos, but always look at the
  review sheet before uploading.
- Label photos are NOT cut out: use label_crop (centre square, 840px WebP).
"""
import sys
import json
import resource
import numpy as np
import cv2
from PIL import Image, ImageFilter, ImageOps
from scipy import ndimage as ndi
from rembg import remove, new_session

try:  # iPhone HEIC support, if installed
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

_SESSIONS = None


def sessions():
    global _SESSIONS
    if _SESSIONS is None:
        _SESSIONS = [new_session("isnet-general-use"), new_session("u2net")]
    return _SESSIONS


# ── colour/texture model of "surface" vs "object" ─────────────────────────────

def _features(a: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(a, cv2.COLOR_RGB2LAB).astype(np.float32)
    L = lab[..., 0]
    mu = cv2.blur(L, (9, 9))
    tex = np.sqrt(np.maximum(cv2.blur(L * L, (9, 9)) - mu * mu, 0))
    return np.dstack([lab, tex * 1.5])


def _fit(samples: np.ndarray, k: int = 5):
    samples = samples.astype(np.float32)
    k = max(1, min(k, len(samples) // 50))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, lab, cen = cv2.kmeans(samples, k, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    lab = lab.ravel()
    comps = []
    for j in range(k):
        s = samples[lab == j]
        if len(s) < 10:
            continue
        comps.append((cen[j], s.var(0) + 4.0, len(s) / len(samples)))
    return comps


def _loglik(x: np.ndarray, comps) -> np.ndarray:
    out = np.full(len(x), -1e9, np.float32)
    for mean, var, w in comps:
        ll = -0.5 * (((x - mean) ** 2) / var + np.log(2 * np.pi * var)).sum(1) + np.log(w)
        out = np.maximum(out, ll)
    return out


def _sample(mask: np.ndarray, feats: np.ndarray, n: int, rng) -> np.ndarray:
    idx = np.flatnonzero(mask)
    if len(idx) > n:
        idx = rng.choice(idx, n, replace=False)
    return feats.reshape(-1, feats.shape[-1])[idx]


def surface_models(a: np.ndarray, m: np.ndarray):
    """Colour + texture models of the shooting surface (learned from pixels
    around the object) and of the object (learned from its interior)."""
    h, w = m.shape
    rng = np.random.default_rng(0)
    feats = _features(a)
    bg = ~ndi.binary_dilation(m, iterations=max(6, int(0.006 * max(h, w))))
    fg = ndi.binary_erosion(m, iterations=max(12, int(0.03 * max(h, w))))
    if bg.sum() < 500 or fg.sum() < 500:
        return None
    bgm = _fit(_sample(bg, feats, 30000, rng))
    fgm = _fit(_sample(fg, feats, 30000, rng))
    core = _sample(fg, feats, 20000, rng)
    llr = lambda x: _loglik(x, bgm) - _loglik(x, fgm)
    # separability: how little of the object's interior could pass for
    # surface (low = hard photo, e.g. faded charcoal shirt on grey quilt)
    sep = 1.0 - float((llr(core) > 2.0).mean())
    # contrast: distance between the typical surface colour and the typical
    # object colour (CIELAB-ish units). White shirt on white sheet ~ 5-10.
    lab = feats[..., :3]
    contrast = float(np.linalg.norm(np.median(lab[bg], 0) - np.median(lab[fg], 0)))
    return feats, llr, sep, contrast


def _tidy(m: np.ndarray) -> np.ndarray:
    m = ndi.binary_opening(m, iterations=2)
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


def snap_edge(a: np.ndarray, m: np.ndarray, frac: float = 0.01) -> np.ndarray:
    h, w = m.shape
    r = max(6, int(frac * max(h, w)))
    inner = ndi.binary_erosion(m, iterations=r)
    outer = ndi.binary_dilation(m, iterations=r)
    if inner.sum() < 1000:
        return m
    gm = np.full(m.shape, cv2.GC_BGD, np.uint8)
    gm[outer] = cv2.GC_PR_BGD
    gm[m] = cv2.GC_PR_FGD
    gm[inner] = cv2.GC_FGD
    bgd = np.zeros((1, 65)); fgd = np.zeros((1, 65))
    try:
        cv2.grabCut(cv2.cvtColor(a, cv2.COLOR_RGB2BGR), gm, None, bgd, fgd, 4, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        return m
    out = (gm == cv2.GC_FGD) | (gm == cv2.GC_PR_FGD)
    out = ndi.binary_opening(out, iterations=1)
    return _tidy(out)


def remove_sleeve_gaps(a, m):
    """Remove the strip of surface between a long sleeve and the body.
    Both models fill it in when the sleeve lies close to the body. A strip
    is removed only if (1) its brightness and texture match the surface
    around the object, (2) it touches the outside, (3) on most of its rows
    there is garment both to its left and to its right, and (4) it is
    taller than it is wide. Sun-lit areas on an outer edge fail (3).
    Returns (mask, removed_share)."""
    h, w = m.shape
    L = cv2.cvtColor(a, cv2.COLOR_RGB2LAB)[..., 0].astype(np.float32)
    Lb = cv2.blur(L, (9, 9))
    tex = cv2.blur(np.abs(L - cv2.GaussianBlur(L, (0, 0), 1.5)), (15, 15))
    bg = ~ndi.binary_dilation(m, iterations=max(8, int(0.01 * max(h, w))))
    if bg.sum() < 1000:
        return m, 0.0
    lo, hi = np.percentile(Lb[bg], [3, 97])
    tlo = np.percentile(tex[bg], 10)
    # (a) surface-like brightness and texture
    surf = (Lb >= lo) & (Lb <= hi) & (tex >= tlo)
    # (b) a light ridge: brighter than the fabric a short way to either side
    d = max(8, int(0.012 * w))
    Lv = cv2.blur(L, (5, 21))
    left = np.roll(Lv, d, axis=1); right = np.roll(Lv, -d, axis=1)
    ridge = np.minimum(Lv - left, Lv - right) > 6
    ridge = ndi.binary_dilation(ridge, iterations=2)
    cand = m & surf & ridge
    cand = ndi.binary_opening(cand, iterations=1)
    cand = ndi.binary_closing(cand, structure=np.ones((9, 3)), iterations=1) & m
    lab, n = ndi.label(cand)
    if not n:
        return m, 0.0
    outside = ndi.binary_dilation(~m, iterations=3)
    reach = max(6, int(0.04 * w))
    garment = m & ~cand
    drop = np.zeros(n + 1, bool)
    for k, sl in enumerate(ndi.find_objects(lab), 1):
        ys, xs = sl
        hh, ww = ys.stop - ys.start, xs.stop - xs.start
        if hh < 0.04 * h or hh < 1.5 * ww:
            continue
        reg = lab[ys, :] == k
        if not (reg & outside[ys, :]).any():
            continue
        both = 0; rows = 0
        for r in range(reg.shape[0]):
            cols = np.flatnonzero(reg[r])
            if not len(cols):
                continue
            rows += 1
            y = ys.start + r
            l0, r0 = cols.min(), cols.max()
            left = garment[y, max(0, l0 - reach):l0].any()
            right = garment[y, r0 + 1:min(w, r0 + 1 + reach)].any()
            both += left and right
        if rows and both / rows > 0.7:
            drop[k] = True
    if not drop.any():
        return m, 0.0
    rem = ndi.binary_dilation(drop[lab], iterations=2) & m
    return _tidy(m & ~rem), float(rem.sum() / m.sum())



def remove_seeded(a, m, lines, band=0.025):
    """Manual fix for surface the automatic steps missed (from fixes.json).
    Each entry is a line of (x, y) points, as fractions of the photo's width
    and height, drawn along the leftover surface (e.g. down the strip
    between a long sleeve and the body). An entry {"poly": [...]} is a
    traced outline of leftover surface, removed exactly as drawn. An entry
    {"outline": [...]} replaces the whole mask with a traced garment outline,
    and {"add": [...]} adds a traced polygon the models missed. The line is marked as definite
    background, garment more than `band` away from it as definite object,
    and GrabCut finds the real edges in between. It cannot reach beyond the
    band, so it cannot eat into the rest of the garment."""
    h, w = m.shape
    r = max(6, int(band * w))
    for pts in lines:
        rr = r
        if isinstance(pts, dict) and "outline" in pts:
            # Whole-garment outline traced by hand. For photos the models
            # cannot read at all (a white shirt on a white sheet): the mask
            # becomes exactly this polygon, and later "poly" entries can
            # still cut holes such as a sleeve gap.
            P = np.array([[int(round(x * w)), int(round(y * h))] for x, y in pts["outline"]], np.int32)
            cut = np.zeros((h, w), np.uint8)
            cv2.fillPoly(cut, [P], 1)
            m = cut.astype(bool)
            continue
        if isinstance(pts, dict) and "add" in pts:
            # Part of the garment the models dropped (e.g. a dark sleeve on
            # the dark quilt): this traced polygon is added to the mask.
            P = np.array([[int(round(x * w)), int(round(y * h))] for x, y in pts["add"]], np.int32)
            cut = np.zeros((h, w), np.uint8)
            cv2.fillPoly(cut, [P], 1)
            m = m | cut.astype(bool)
            continue
        if isinstance(pts, dict) and "poly" in pts:
            # Exact cut: a traced polygon of leftover surface is removed as
            # drawn. Cleanest edges; use it where GrabCut leaves ragged bites.
            P = np.array([[int(round(x * w)), int(round(y * h))] for x, y in pts["poly"]], np.int32)
            cut = np.zeros((h, w), np.uint8)
            cv2.fillPoly(cut, [P], 1)
            m &= ~cut.astype(bool)
            continue
        if isinstance(pts, dict):  # {"line": [...], "band": 0.008} for tight spots
            rr = max(3, int(pts.get("band", band) * w))
            pts = pts["line"]
        if len(pts) and not isinstance(pts[0], (list, tuple)):
            pts = [pts]
        P = np.array([[int(x * w), int(y * h)] for x, y in pts], np.int32)
        line = np.zeros((h, w), np.uint8)
        if len(P) == 1:
            cv2.circle(line, tuple(P[0]), 3, 1, -1)
        else:
            cv2.polylines(line, [P], False, 1, 3)
        line = line.astype(bool)
        near = ndi.binary_dilation(line, iterations=rr)
        gm = np.full((h, w), cv2.GC_BGD, np.uint8)
        gm[m] = cv2.GC_FGD
        gm[m & near] = cv2.GC_PR_FGD
        gm[line] = cv2.GC_BGD
        ys, xs = np.nonzero(near)
        y0, y1 = max(0, ys.min() - rr), min(h, ys.max() + rr)
        x0, x1 = max(0, xs.min() - rr), min(w, xs.max() + rr)
        sub = gm[y0:y1, x0:x1].copy()
        bgd = np.zeros((1, 65)); fgd = np.zeros((1, 65))
        try:
            cv2.grabCut(cv2.cvtColor(np.ascontiguousarray(a[y0:y1, x0:x1]), cv2.COLOR_RGB2BGR),
                        sub, None, bgd, fgd, 5, cv2.GC_INIT_WITH_MASK)
        except cv2.error:
            continue
        keep = (sub == cv2.GC_FGD) | (sub == cv2.GC_PR_FGD)
        m[y0:y1, x0:x1] &= keep
    return _tidy(m)


def build_mask(work: Image.Image, seeds=None):
    a = np.array(work)
    isnet, u2 = [np.array(remove(work, session=s, only_mask=True)) for s in sessions()]
    # Outline = union of both models' confident masks. (The old pipeline
    # merged their loose masks and let OpenCV GrabCut grow the result,
    # which pulled the grey quilt into the cutout. u2net alone clipped
    # the hem of 2026.050's back.)
    m = _tidy((u2 > 127) | (isnet > 127))
    sm = surface_models(a, m)
    sep = 1.0
    contrast = 99.0
    if sm is not None:
        feats, llr, sep, contrast = sm
        # isnet proposes pockets of surface u2net kept (e.g. under the
        # arms); each is removed only if its colour/texture also says
        # "surface". Without that check, isnet sometimes bites into a
        # sleeve.
        veto = m & (isnet <= 40)
        lab, n = ndi.label(veto)
        if n:
            F = feats.reshape(-1, feats.shape[-1])
            r = np.zeros(m.size, np.float32)
            idx = np.flatnonzero(veto)
            r[idx] = llr(F[idx])
            r = r.reshape(m.shape)
            means = ndi.mean(r, lab, range(1, n + 1))
            sizes = ndi.sum(veto, lab, range(1, n + 1))
            drop = np.zeros(n + 1, bool)
            drop[1:] = (means > 2.0) & (sizes > 30)
            if drop.any():
                m = _tidy(m & ~drop[lab])
    m, gap_removed = remove_sleeve_gaps(a, m)
    if seeds:
        m = remove_seeded(a, m, seeds)
    # Clipped-edge check: snap the outline to the real colour edge in a
    # narrow band. If that would add a sizeable strip (a hem, a cuff, the
    # end of a sleeve), the cutout has probably clipped the garment, so a
    # person must look. The snapped mask is NOT used for the output: on
    # textured surfaces it tends to pull in surface.
    snapped = snap_edge(a, m)
    add = snapped & ~m
    clip = 0.0
    if add.any() and sm is not None:
        feats, llr, _, _ = sm
        F = feats.reshape(-1, feats.shape[-1])
        r = np.zeros(m.size, np.float32)
        idx = np.flatnonzero(add)
        r[idx] = llr(F[idx])
        r = r.reshape(m.shape)
        lab, n = ndi.label(add)
        sizes = ndi.sum(add, lab, range(1, n + 1))
        means = ndi.mean(r, lab, range(1, n + 1))
        # only strips that look like the garment count; strips that look
        # like the surface are GrabCut wandering into the quilt
        garment = sizes * (means < -2.0)
        clip = float(garment.max() / max(1, m.sum())) if n else 0.0
    # Symmetry: a garment laid flat (or a book, flyer, ticket) is roughly
    # mirror-symmetric left to right. A lopsided mask means part of the
    # object was lost, e.g. a white shirt on a white sheet.
    ys, xs = np.nonzero(m)
    sym = 1.0
    if len(xs):
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        box = m[y0:y1, x0:x1]
        mir = box[:, ::-1]
        sym = float((box & mir).sum() / max(1, (box | mir).sum()))
    fr = 3
    touches = bool(m[:fr].any() or m[-fr:].any() or m[:, :fr].any() or m[:, -fr:].any())
    alt = isnet > 127
    union = (m | alt).sum()
    agree = float((m & alt).sum() / union) if union else 0.0
    qa = {"separability": round(sep, 3), "modelAgreement": round(agree, 3),
          "touchesFrame": touches, "objectShare": round(float(m.mean()), 3),
          "clippedEdge": round(clip, 4), "contrast": round(contrast, 1),
          "symmetry": round(sym, 3), "sleeveGapRemoved": round(gap_removed, 4)}
    review = (agree < 0.95 or touches or qa["objectShare"] < 0.12 or sep < 0.95
              or clip > 0.004 or contrast < 20
              or sym < 0.8)
    return m, qa, bool(review)


def cutout(src: str, dst: str, max_px: int = 1600, debug: str = None, seeds=None):
    big = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    big.thumbnail((2400, 2400))
    work = big.copy(); work.thumbnail((1200, 1200))
    m, qa, review = build_mask(work, seeds)
    sm = Image.fromarray((m * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.5)).resize(big.size, Image.BICUBIC)
    # Choke the edge ~2px at full size so the surface colour does not show
    # as a dark/light halo around the garment.
    sm = sm.filter(ImageFilter.MinFilter(5))
    al = np.clip((np.array(sm).astype(float) - 128) * 3 + 128, 0, 255).astype("uint8")
    A = Image.fromarray(al).filter(ImageFilter.GaussianBlur(0.8))
    r = big.copy(); r.putalpha(A)
    r = r.crop(r.getchannel("A").getbbox())
    r.thumbnail((max_px, max_px), Image.LANCZOS)
    r.save(dst, quality=84, method=6)
    arr = np.array(r)
    px = arr[arr[..., 3] > 250][:, :3]
    if debug:
        _debug_sheet(work, m, r, debug)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_mb = peak // 1024 if sys.platform != "darwin" else peak // (1024 * 1024)
    return {"w": r.width, "h": r.height,
            "bodyColour": "#%02x%02x%02x" % tuple(np.median(px, axis=0).astype(int)),
            "qa": qa, "review": review, "peakMB": int(peak_mb)}


def _debug_sheet(work, m, r, path, s=600):
    tiles = []
    t = work.copy(); t.thumbnail((s, s)); tiles.append(t)
    mk = Image.fromarray((m * 255).astype("uint8")).convert("RGB"); mk.thumbnail((s, s)); tiles.append(mk)
    c = r.copy(); c.thumbnail((s, s))
    st = Image.new("RGBA", (s, s), (242, 242, 240, 255)); st.alpha_composite(c, ((s - c.width) // 2, (s - c.height) // 2))
    tiles.append(st.convert("RGB"))
    S = Image.new("RGB", (s * 3 + 12, s), "white")
    for i, t in enumerate(tiles):
        S.paste(t, (i * (s + 6), (s - t.height) // 2))
    S.save(path, quality=85)


def label_crop(src: str, dst: str, max_px: int = 840):
    t = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    w, h = t.size; s = min(w, h) * 0.8
    t = t.crop((int((w - s) / 2), int((h - s) / 2), int((w + s) / 2), int((h + s) / 2)))
    t.thumbnail((max_px, max_px), Image.LANCZOS)
    t.save(dst, quality=82)
    return {"w": t.width, "h": t.height}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python cutout.py <input> <output> [cutout|label_crop] [--debug sheet.jpg]", file=sys.stderr)
        sys.exit(1)
    args = sys.argv[1:]
    dbg = None
    if "--debug" in args:
        i = args.index("--debug"); dbg = args[i + 1]; del args[i:i + 2]
    mode = args[2] if len(args) > 2 else "cutout"
    if mode == "label_crop":
        print(json.dumps({"ok": True, **label_crop(args[0], args[1])}))
    else:
        print(json.dumps(cutout(args[0], args[1], debug=dbg)))
