---
name: collection-publish
description: Publishes new objects to the temporary collection. Runs background removal locally, uploads images, and creates catalogue entries. Use when given a folder of images and a CSV of metadata.
---

# Collection Publish Skill

You are helping publish new objects to the temporary collection at temporary.company/collection. This skill covers the full workflow: background removal, image upload, metadata import, and publishing.

## Overview

New batches arrive as:
- A folder of images named `<key>_<plate>.jpg` (plates: `front`, `back`, `label`)
- A CSV with columns: `key, maker, title, date, type, description, label, department, provenance, condition, body_colour`

The workflow:
1. Run rembg locally on all `front` (and `back`) images to remove backgrounds
2. Upload all images to production
3. Create draft objects from the CSV
4. Publish in CSV row order

## Step 1 — Background Removal (local, Mac only)

Install rembg if not present:
```bash
pip3 install rembg[cpu] pillow
```

Run on each front/back image. Use the project's own cutout script:
```bash
cd /Users/benjaminfainlight/benfainlight-site
python3 pipeline/cutout.py <src_path> <dst_path> cutout
```

Output goes to a `cutouts/` subfolder alongside the source images. Name the output `<key>_<plate>_cut.png`.

Process all front images first, then back images. Skip label images (no cutout needed).

After cutout, use the cutout version as the image to upload for that plate. Set `cutout: true` on those images.

## Step 2 — Get Auth Token

The admin token is stored in the browser's localStorage at `temporary.company/admin` under the key `bf_admin_token`. It expires when the Railway server restarts.

To get a fresh token:
1. Open Chrome and navigate to `temporary.company/admin`  
2. If the collection panel is showing, the token is valid — read it:
   ```javascript
   // Run in Chrome DevTools console at temporary.company/admin
   localStorage.getItem('bf_admin_token')
   ```
3. Test it: `curl -s -H "Authorization: Bearer <token>" https://temporary.company/api/collection | python3 -m json.tool | head -5`
4. If 401, ask the user to log out and back in at temporary.company/admin, then re-read the token

Set it as an env var for the upload script: `export PROD_TOKEN=<token>`

## Step 3 — Upload Images

Use the bulk upload endpoint. For each image file (cutout version for front/back, original for label):

```
POST https://temporary.company/api/collection/bulk/upload
Authorization: Bearer <token>
Content-Type: multipart/form-data
field name: file
```

The response includes `{ url, w, h, hash, bodyColour, dupe }`. If `dupe` is non-null, stop and report — the image already exists in the collection.

Use the upload script at `/private/tmp/claude-501/-Users-benjaminfainlight/9853dc31-d9cd-48fe-96ba-fd729640b0fb/scratchpad/batch-upload-prod.js` as a reference for the multipart upload format (field name must be `file`, not `image`).

## Step 4 — Duplicate Check

Before creating any drafts, confirm no uploads returned `dupe: non-null`. If any did, list them and stop. Do not publish until the user reviews.

## Step 5 — Create Draft Objects

```
POST https://temporary.company/api/collection
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "pending",
  "type": "<from CSV>",
  "department": "<from CSV>",
  "maker": "<from CSV>",
  "title": "<from CSV>",
  "date": "<from CSV>",
  "description": "<from CSV>",
  "label": "<from CSV>",
  "provenance": "",
  "condition": "",
  "bodyColour": "<from front upload bodyColour, fall back to CSV body_colour>",
  "images": [
    { "role": "front", "src": "<upload url>", "w": <w>, "h": <h>, "cutout": true },
    { "role": "back",  "src": "<upload url>", "w": <w>, "h": <h>, "cutout": true },
    { "role": "label", "src": "<upload url>", "w": <w>, "h": <h> }
  ]
}
```

Collect the `seq` from each response. Preserve CSV row order.

## Step 6 — Publish

```
POST https://temporary.company/api/collection/bulk-publish
Authorization: Bearer <token>
Content-Type: application/json

{ "seqs": [<seq1>, <seq2>, ...] }
```

Response: `{ "published": [{ "accession", "maker", "title" }, ...] }`

Report each accession number assigned.

## Key Rules

- **Never publish if there are duplicates or upload errors** — stop and report to the user
- **CSV row order = accession order** — pass seqs in CSV order to bulk-publish
- **bodyColour**: use the value returned by the front image upload; fall back to CSV `body_colour` only if the upload didn't return one
- **cutout flag**: set `true` only on images that actually went through background removal (front and back); leave it off for label images
- **provenance and condition**: always leave empty (`""`) unless the CSV has values
- **Front image is primary**: the front cutout is what appears in index thumbnails and the carousel hero

## Error Recovery

- 401 on any API call → token expired, get a fresh one (Step 2)
- Upload 400 with "Source file not found" → wrong field name or path issue
- Publish 400 with "not pending" → draft was already published; skip that seq
- rembg OOM → running on Railway (not enough RAM); must run locally on Mac

## After Publishing

Confirm the new entries appear at `https://temporary.company/collection` and that the primary image shows the clean transparent background (no photography surface visible). Check one individual item page opens at the top showing the front image.
