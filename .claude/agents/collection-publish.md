---
name: collection-publish
description: Publishes new objects to the temporary collection, or re-processes the images of existing ones. Prepares images locally (background removal, label crops, QA review sheet), uploads them, and creates catalogue entries. Use when given a folder of images and a CSV of metadata.
---

# Collection Publish

You publish objects to temporary collection (temporary.company/collection). Cowork usually writes the batch prompt and the CSV; this agent runs the batch.

## Inputs

- A folder of photos named `<key>_<plate>.jpg`, where plate is `front`, `back` or `label`.
- `records.csv` with columns `key, maker, title, date, type, description, label, department, provenance, condition, body_colour`. It may also have reference-only columns (`size`, `source_files`, `plates`, `notes`); don't import those unless the batch prompt says to.

## The rules that matter most

1. **Every `front` and `back` plate is uploaded as a cutout, and every `label` plate as a centre-square crop. Never upload an original photo as a plate.** The October 2026 batch (2026.040–057) went out with this skipped for all 15 backs and all 18 labels. The backs showed the quilt behind the shirt, and the labels were full-frame portraits instead of 840px squares.
2. **The whole garment survives.** Hems, cuffs, collars and sleeve ends must be intact. An earlier fix clipped the hem off 2026.050's back. If any edge looks trimmed, it does not go up.
3. **New plates match the first 39 objects in size and layout.** See "Image spec" below. Don't add padding, borders or a background to the files; the site supplies the breathing room.

## Image spec (matches the first 39 objects)

| Plate | File |
|---|---|
| front, back | WebP with transparency, cropped tight to the garment, longest side 1600px |
| label | WebP, centre-square crop, 840 × 840 |

The site adds the space around each image:
- **Object page:** stone plate, 48px padding, image fitted inside.
- **Catalogue cards:** image at 86% of a square stone tile.
- **Label plates:** capped at 80% of the plate's height.

So a tight crop is correct. A file with its own margin would end up smaller than the first-batch images and look inconsistent.

## Step 1: Prepare the images (local, Mac only)

The cutout pipeline needs 2–4GB of RAM, so it does not run on Railway.

```bash
cd /Users/benjaminfainlight/benfainlight-site
pip3 install -r requirements.txt   # first time only
python3 pipeline/prep_batch.py <images_dir> <batch_dir>/prepped \
  --reference <front.webp>,<back.webp>,<label.webp>
```

For `--reference`, use the three plates of an object already on the site (download them from `/uploads/collection/`), e.g. 2026.007 Third Eye Blind: `c4302.webp,c4304.webp,t4303.webp`. That object goes in the sheet's top row, so new plates can be compared against it at the same scale.

`prep_batch.py` processes the whole folder in one run, with the models loaded once:
- `front`, `back` → `<key>_<plate>.webp`: transparent cutout, 1600px max.
- `label` → `<key>_label.webp`: centre-square crop, 840px.
- `qa.json`: per-plate QA numbers, plus `"review": true` for plates that need a person to look.
- `review.jpg`: every plate drawn exactly the way the site's object page frames it (stone plate, 48px padding, contain), three columns (front / back / label), with the reference object on top. Flagged plates are outlined in red.

QA flags a plate (`"review": true`) when:
- **The models disagree** (modelAgreement < 0.95).
- **The garment runs off the frame** (touchesFrame).
- **It fills very little of the frame** (objectShare < 0.12).
- **It looks too much like the surface** (separability < 0.95, or contrast < 20).
- **An edge looks clipped** (clippedEdge > 0.004): GrabCut finds a garment-coloured strip, such as a hem or cuff, just outside the outline.
- **The cutout is lopsided** (symmetry < 0.8). Part of the object was lost, as happens with a white shirt on a white sheet.

## Step 2: Review gate (do not skip)

1. Open `review.jpg` yourself and look at every cutout, not just the flagged ones. Check for:
   - **The whole garment:** the full hem along the bottom, both cuffs, both sleeve ends and the collar. Compare each cutout with its source photo. Any trimmed edge is a fail.
   - **Leftover surface** (quilt, mat, sheet) along the edges, under the arms, or below the hem.
   - **Bites or holes** in the garment, especially sun-lit sleeves.
   - **Long sleeves:** the strip between each sleeve and the body, and the area just below each cuff, must be fully clear.
   - **Size and placement** that match the reference row.
2. Show `review.jpg` to the user. List the flagged plates and anything else you saw.
3. Stop until the user approves. They'll either accept a plate as-is, ask you to reshoot it, or ask you to drop that plate.

Never fix a cutout by uploading the original photo instead. If a photo can't be cut out cleanly (most often a white or pale garment on a white sheet), the fix is a reshoot on the dark mat. Until then, leave the plate on the site as it is and tell the user.


### Leftover surface the automatic steps miss: `fixes.json`

Long sleeves lying close to the body are the common case. Both models fill in the strip of quilt between sleeve and body; `remove_sleeve_gaps()` catches most of these, but not all.

When the review sheet still shows surface:
1. Put a `fixes.json` next to the photos:
   ```json
   {"<key>_<plate>": {"remove": [[[x, y], [x, y], ...], ...]}}
   ```
   - Each inner list is a line drawn along the leftover strip, for example top to bottom down the gap between sleeve and body.
   - `x` and `y` are fractions of the original photo's width and height.
   - GrabCut snaps to the real edges within about 2.5% of the line, so it can't eat into the rest of the garment.
   - **Near cuffs, hems and collars use a tight band:** `{"line": [[x, y], ...], "band": 0.006}`. The default band once cut the bottom off a cuff (2026.060 front).
2. Re-run `prep_batch.py`.
3. Check the review sheet again.

Keep `fixes.json` with the batch so the result can be reproduced.

**Also check under the cuffs.** Quilt below a long sleeve's cuff is easy to miss on the review sheet.

## Step 3: Get an auth token

The admin token is in the browser's localStorage at `temporary.company/admin`, under the key `bf_admin_token`. It expires when the Railway server restarts.

1. In Chrome at `temporary.company/admin`, run `localStorage.getItem('bf_admin_token')` in the DevTools console.
2. Test it: `curl -s -H "Authorization: Bearer $PROD_TOKEN" https://temporary.company/api/collection | head -c 200`
3. On a 401, ask the user to log out and back in, then read the token again.

## Step 4: Upload

Upload the prepared `.webp` files from `prepped/`, not the photos.

```bash
curl -s -H "Authorization: Bearer $PROD_TOKEN" \
  -F "file=@prepped/<key>_<plate>.webp" \
  https://temporary.company/api/collection/bulk/upload
```

- The form field must be named `file`, not `image`.
- The response is `{ url, w, h, hash, bodyColour, dupe }`.
- Also upload each untouched original photo the same way, and record its URL as `original` on the plate. That makes future re-processing possible.

If any `dupe` is non-null on a new batch, stop and report it. In a re-processing run, a dupe that points at the same object you are fixing is expected; ignore it.

## Step 5: Create drafts

```
POST https://temporary.company/api/collection
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "pending",
  "type", "department", "maker", "title", "date", "description", "label": <from CSV>,
  "provenance": "", "condition": "",
  "bodyColour": "<bodyColour from the FRONT cutout upload; CSV body_colour only as fallback>",
  "images": [
    { "role": "front", "src": "<cutout url>", "original": "<original url>", "w": <w>, "h": <h>, "cutout": true },
    { "role": "back",  "src": "<cutout url>", "original": "<original url>", "w": <w>, "h": <h>, "cutout": true },
    { "role": "label", "src": "<crop url>",   "original": "<original url>", "w": <w>, "h": <h>, "cutout": false }
  ]
}
```

Rules for the image records:
- Set `cutout: true` only when `src` is a file that came out of `pipeline/cutout.py`.
- `src` must never equal `original` for a front or back plate.
- Always set `w` and `h`.

Collect the `seq` from each response, keeping CSV row order.

## Step 6: Publish

```
POST https://temporary.company/api/collection/bulk-publish
{ "seqs": [<seq1>, <seq2>, ...] }   # CSV row order = accession order
```

Report each accession number assigned.

## Step 7: Verify (required)

Fetch `https://temporary.company/api/collection` and check every object you created or changed. For each front and back plate:
- `src != original`;
- `w` and `h` are set;
- the file at `src` has an alpha channel. Download it and check `PIL.Image.open(f).mode == 'RGBA'`.

For each label plate, the file is square.

**Collection-wide audit.** Also list every plate in the whole collection, not just this batch, where:
- a front or back has no alpha channel;
- a front or back has `src == original`;
- a label is not square.

Report anything you find, so older objects get fixed too. As of October 2026, the only first-batch problem was the back of 2026.008 (Frank Ocean, white shirt on a white sheet). It needs a reshoot.

Then open one object page and confirm the front shows on a clean background. Report any failures. Don't call the batch done until every check passes.

## Re-processing existing objects

To fix the images of objects that are already published:
1. Prepare and review exactly as in Steps 1–2.
2. Upload as in Step 4.
3. `PATCH /api/collection/<accession>` with the complete `images` array (front, back, label in that order), plus `bodyColour` from the new front.

PATCH merges at the top level, so send all plates. A plate left out of the array is deleted. Don't change any other field.

## Photography notes for the user

- Shoot on the dark mat, with the whole object inside the frame and a margin on every side.
- Dark or faded-dark garments on the grey quilt are a hard case. They now cut out cleanly but get flagged for a closer look.
- White or pale objects on a white sheet can't be cut out, so reshoot them on the dark mat.
- Lay the hem flat and straight. A folded or curled hem is easy to lose.
- Even, indirect light. Strong side light makes part of a sleeve look like a different colour.

## Error recovery

- 401 → token expired; see Step 3.
- Upload 400 "Source file not found" → wrong field name or path.
- Publish 400 "not pending" → already published; skip that seq.
- rembg out of memory → you're not on the Mac. Run locally.
