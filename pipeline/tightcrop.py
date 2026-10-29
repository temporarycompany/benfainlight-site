"""Interior book plates (spreads, title pages, colophons): a straightened,
centred crop of the photo with an even border of background around the book.
Nothing is cut out or hidden: hands holding the book stay in; everything
further out (legs, furniture, the rest of the quilt) is cropped away.

1. Find the book with the cutout models (u2net + isnet union).
2. Remove thin protrusions (fingers, hands, arms) with a morphological
   opening, so they don't pull the crop off centre.
3. Fit the minimum-area rectangle, rotate the photo so the book is level.
4. Grow the box to the book's real edges (page blocks the opening trimmed),
   staying within 4% of it so arms are not followed.
5. Crop centred on the book with an even border on all four sides
   (MARGIN, default 7% of the book's longer side). If the photo runs out on
   one side, the border on that axis (left/right or top/bottom) shrinks
   equally on both sides, so the book stays centred; the other axis keeps
   its full border. A border under 3% is reported (`lowBorder`). If the book itself touches the photo's edge, the plate
   is flagged: it needs a reshoot with space around the book.
6. Save as an opaque WebP, 1600px max.

usage: tightcrop.py src dst      (env: MARGIN=0.07, OPEN_R=0.035)"""
import os, sys, json
sys.path.insert(0, 'pipeline')
import numpy as np, cv2
from PIL import Image, ImageOps
from scipy import ndimage as ndi
import cutout as c

MARGIN = float(os.environ.get('MARGIN', '0.07'))
OPEN_R = float(os.environ.get('OPEN_R', '0.035'))


def masks(work):
    m, qa, rv = c.build_mask(work)
    H, W = m.shape
    R = int(OPEN_R * max(H, W))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * R + 1, 2 * R + 1))
    op = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, k)
    lab, n = ndi.label(op)
    if n > 1:
        op = (lab == (np.argmax(ndi.sum(op, lab, range(1, n + 1))) + 1)).astype(np.uint8)
    return m.astype(np.uint8), op


def tight(src, dst, max_px=1600):
    big = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
    work = big.copy(); work.thumbnail((1200, 1200))
    m, op = masks(work)
    cs, _ = cv2.findContours(op, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnt = max(cs, key=cv2.contourArea).astype(np.float32)
    (cx, cy), _, ang = cv2.minAreaRect(cnt)
    if ang > 45: ang -= 90
    if ang < -45: ang += 90
    if abs(ang) > 12: ang = 0.0
    h, w = m.shape
    R = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    mr = cv2.warpAffine(m, R, (w, h), flags=cv2.INTER_NEAREST)
    opr = cv2.warpAffine(op, R, (w, h), flags=cv2.INTER_NEAREST)
    ys, xs = np.nonzero(opr)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    # grow to the real page edges, but no further than 4% beyond the opened box
    g = int(0.04 * max(x1 - x0, y1 - y0))
    win = np.zeros_like(mr); win[max(0, y0 - g):y1 + g + 1, max(0, x0 - g):x1 + g + 1] = 1
    core = np.zeros_like(mr); core[y0:y1 + 1, x0:x1 + 1] = 1
    near = mr & win
    # only keep strips that hug the book (columns/rows mostly covered), not hands
    cols = near[y0:y1 + 1].mean(0) > 0.5
    rows = near[:, x0:x1 + 1].mean(1) > 0.5
    xs2 = np.nonzero(cols)[0]; ys2 = np.nonzero(rows)[0]
    if len(xs2): x0, x1 = min(x0, xs2.min()), max(x1, xs2.max())
    if len(ys2): y0, y1 = min(y0, ys2.min()), max(y1, ys2.max())
    touches = x0 <= 2 or y0 <= 2 or x1 >= w - 3 or y1 >= h - 3
    # centred crop with an even border, shrunk symmetrically where the photo ends
    bw, bh = x1 - x0, y1 - y0
    mpx = MARGIN * max(bw, bh)
    mx = max(0.0, min(mpx, x0, w - 1 - x1))
    my = max(0.0, min(mpx, y0, h - 1 - y1))
    s = big.width / w
    X0, X1 = (x0 - mx) * s, (x1 + mx) * s
    Y0, Y1 = (y0 - my) * s, (y1 + my) * s
    mm = min(mx, my)
    a = np.array(big)
    Rb = cv2.getRotationMatrix2D((cx * s, cy * s), ang, 1.0)
    rot = cv2.warpAffine(a, Rb, (a.shape[1], a.shape[0]), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    im = Image.fromarray(rot[int(Y0):int(np.ceil(Y1)), int(X0):int(np.ceil(X1))])
    im.thumbnail((max_px, max_px), Image.LANCZOS)
    im.save(dst, quality=86, method=6)
    return {'size': list(im.size), 'angle': round(float(ang), 2),
            'border': round(float(mm / max(bw, bh)), 3), 'lowBorder': bool(mm / max(bw, bh) < 0.03), 'bookTouchesEdge': bool(touches)}


if __name__ == '__main__':
    print(json.dumps({'dst': sys.argv[2], **tight(sys.argv[1], sys.argv[2])}), flush=True)
