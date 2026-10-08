#!/usr/bin/env node
/**
 * One-time seed script.
 * 1. Transforms handoff objects.json → collection.json (updates image src paths).
 * 2. Copies all 97 images from handoff public/img/ → public/uploads/collection/.
 *
 * Run once from repo root:
 *   node scripts/seed-collection.js /path/to/temporary-collection-handoff
 */
const fs   = require('fs');
const path = require('path');

const HANDOFF = process.argv[2] || path.join(__dirname, '../../Downloads/temporary-collection-handoff');
const REPO    = path.join(__dirname, '..');

const srcJson = path.join(HANDOFF, 'data/objects.json');
const srcImg  = path.join(HANDOFF, 'public/img');
const dstJson = path.join(REPO, 'collection.json');
const dstImg  = path.join(REPO, 'public/uploads/collection');

if (!fs.existsSync(srcJson)) {
  console.error('Cannot find', srcJson);
  process.exit(1);
}

// 1. Copy images
fs.mkdirSync(dstImg, { recursive: true });
const imgs = fs.readdirSync(srcImg).filter(f => f.endsWith('.webp'));
imgs.forEach(f => fs.copyFileSync(path.join(srcImg, f), path.join(dstImg, f)));
console.log(`Copied ${imgs.length} images → public/uploads/collection/`);

// 2. Transform JSON
const now = new Date().toISOString();
const objects = JSON.parse(fs.readFileSync(srcJson, 'utf8')).map(obj => ({
  ...obj,
  images: obj.images.map(img => ({
    ...img,
    src: '/uploads/collection/' + path.basename(img.src),
    original: null,
  })),
  createdAt: now,
  updatedAt: now,
}));

fs.writeFileSync(dstJson, JSON.stringify(objects, null, 2), 'utf8');
console.log(`Wrote ${objects.length} objects → collection.json`);
