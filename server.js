const express   = require('express');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const { spawn } = require('child_process');
const RSSParser = require('rss-parser');

let sharp;
try { sharp = require('sharp'); } catch(_) { console.warn('[server] sharp not available — image processing disabled'); }

let exifr;
try { exifr = require('exifr'); } catch(_) {}

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); } catch(_) {}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
// Set ADMIN_PASSWORD as an environment variable before deploying.
// On Railway: Settings → Variables → ADMIN_PASSWORD = yourpassword
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// In production (Railway), content lives on a persistent volume at /data.
// DATA_DIR env var is set in Railway → Variables after adding the Volume.
// In local dev, DATA_DIR is unset and we fall back to the repo file.
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const SEED_FILE    = path.join(__dirname, 'content.json');

// On first deploy (volume is empty), seed from the bundled content.json
if (process.env.DATA_DIR && !require('fs').existsSync(CONTENT_FILE)) {
  require('fs').mkdirSync(DATA_DIR, { recursive: true });
  require('fs').copyFileSync(SEED_FILE, CONTENT_FILE);
  console.log('Seeded content.json from repo to volume.');
}

// One-time additive migration: if the volume's content.json already existed
// (from before a new top-level key was introduced in the repo), merge in any
// keys it's missing without touching anything the user has already edited.
if (process.env.DATA_DIR && require('fs').existsSync(CONTENT_FILE)) {
  try {
    const live = JSON.parse(require('fs').readFileSync(CONTENT_FILE, 'utf8'));
    const seed = JSON.parse(require('fs').readFileSync(SEED_FILE, 'utf8'));
    let migrated = false;
    Object.keys(seed).forEach((key) => {
      if (!(key in live)) {
        live[key] = seed[key];
        migrated = true;
      }
    });
    if (migrated) {
      require('fs').writeFileSync(CONTENT_FILE, JSON.stringify(live, null, 2), 'utf8');
      console.log('Migrated content.json on volume with new top-level keys.');
    }
  } catch (e) {
    console.error('Content migration check failed:', e.message);
  }
}

const UPLOADS_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
// Serve uploads from UPLOADS_DIR (the volume in production) before the
// general static middleware, since uploaded files no longer live in
// public/uploads once DATA_DIR is set.
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ── File uploads ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only image files allowed'), ok);
  }
});

// ── Session store (in-memory, 24 h TTL) ──────────────────────────────────────
const sessions = new Map(); // token → expiryMs

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'No token' });
  const expiry = sessions.get(token);
  if (!expiry || Date.now() > expiry) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
  res.json({ token });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers['authorization'] || '').slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

// ── Content routes ────────────────────────────────────────────────────────────
// Public read — the main site fetches this on load
app.get('/api/content', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: 'Could not read content.json' });
  }
});

// Protected write — admin panel posts the full content object
app.put('/api/content', requireAuth, (req, res) => {
  try {
    fs.writeFileSync(CONTENT_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not save content.json' });
  }
});

// ── Upload route ──────────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ── Admin panel ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ── Collection ────────────────────────────────────────────────────────────────
const COLLECTION_FILE    = path.join(DATA_DIR, 'collection.json');
const COLLECTION_SEED    = path.join(__dirname, 'collection.json');
const COLLECTION_DIR     = path.join(UPLOADS_DIR, 'collection');
const COLLECTION_BACKUPS = path.join(DATA_DIR, 'backups');

if (!fs.existsSync(COLLECTION_DIR)) fs.mkdirSync(COLLECTION_DIR, { recursive: true });

// Seed once — never overwrite the volume copy
if (!fs.existsSync(COLLECTION_FILE) && fs.existsSync(COLLECTION_SEED)) {
  fs.copyFileSync(COLLECTION_SEED, COLLECTION_FILE);
  console.log('Seeded collection.json to volume.');
}

// Seed images — copy seed/collection-img/* to uploads only if not already there
const COLLECTION_IMG_SEED = path.join(__dirname, 'seed', 'collection-img');
if (fs.existsSync(COLLECTION_IMG_SEED)) {
  const seedFiles = fs.readdirSync(COLLECTION_IMG_SEED);
  let seeded = 0;
  for (const f of seedFiles) {
    const dst = path.join(COLLECTION_DIR, f);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(COLLECTION_IMG_SEED, f), dst);
      seeded++;
    }
  }
  if (seeded > 0) console.log(`Seeded ${seeded} collection images to volume.`);
}

function readCollection() {
  try { return JSON.parse(fs.readFileSync(COLLECTION_FILE, 'utf8')); }
  catch(e) { return []; }
}

function writeCollection(objects) {
  if (fs.existsSync(COLLECTION_FILE)) {
    fs.mkdirSync(COLLECTION_BACKUPS, { recursive: true });
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dst = path.join(COLLECTION_BACKUPS, `collection.${ts}.json`);
    fs.copyFileSync(COLLECTION_FILE, dst);
    const kept = fs.readdirSync(COLLECTION_BACKUPS)
      .filter(f => f.startsWith('collection.')).sort().reverse();
    kept.slice(10).forEach(f => {
      try { fs.unlinkSync(path.join(COLLECTION_BACKUPS, f)); } catch(_) {}
    });
  }
  const tmp = COLLECTION_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(objects, null, 2), 'utf8');
  fs.renameSync(tmp, COLLECTION_FILE);
}

// ── Tombstones (prevent accession number reuse after deletion) ────────────────
const TOMBSTONES_FILE = path.join(DATA_DIR, 'tombstones.json');

function readTombstones() {
  try { return JSON.parse(fs.readFileSync(TOMBSTONES_FILE, 'utf8')); }
  catch(_) { return []; }
}

function addTombstone(accession) {
  if (!accession) return;
  const t = readTombstones();
  if (!t.includes(accession)) {
    t.push(accession);
    fs.writeFileSync(TOMBSTONES_FILE, JSON.stringify(t), 'utf8');
  }
}

// Promise-chain mutex so concurrent publish requests are serialised
let accessionLock = Promise.resolve();
function withAccessionLock(fn) {
  const next = accessionLock.then(fn);
  accessionLock = next.catch(() => {});
  return next;
}

function nextAccession() {
  const year = new Date().getFullYear();
  const objs = readCollection();
  const tombstones = readTombstones();
  const nums = [
    ...objs.map(o => o.accession),
    ...tombstones,
  ].filter(a => a && a.startsWith(String(year) + '.'))
   .map(a => parseInt(a.split('.')[1], 10))
   .filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `${year}.${String(max + 1).padStart(3, '0')}`;
}

// ── Image processing helpers ──────────────────────────────────────────────────

async function computeBodyColour(buf) {
  if (!sharp) return '#888888';
  try {
    const raw = await sharp(buf)
      .resize(100, 100, { fit: 'cover', position: 'centre' })
      .removeAlpha()
      .raw()
      .toBuffer();
    const counts = {};
    for (let i = 0; i < raw.length; i += 3) {
      const r = raw[i], g = raw[i + 1], b = raw[i + 2];
      if (r > 215 && g > 215 && b > 215) continue; // near-white
      if (r < 40  && g < 40  && b < 40)  continue; // near-black
      const rq = Math.round(r / 32) * 32;
      const gq = Math.round(g / 32) * 32;
      const bq = Math.round(b / 32) * 32;
      const key = `${rq},${gq},${bq}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (!top) return '#888888';
    const [r, g, b] = top[0].split(',').map(Number);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch(_) { return '#888888'; }
}

async function computeHash(buf) {
  if (!sharp) return null;
  try {
    const raw = await sharp(buf)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();
    const avg = raw.reduce((s, v) => s + v, 0) / 64;
    let bits = '';
    for (const v of raw) bits += v >= avg ? '1' : '0';
    return BigInt('0b' + bits).toString(16).padStart(16, '0');
  } catch(_) { return null; }
}

function hashDistance(h1, h2) {
  if (!h1 || !h2) return 64;
  try {
    let xor = BigInt('0x' + h1) ^ BigInt('0x' + h2);
    let dist = 0;
    while (xor > 0n) { if (xor & 1n) dist++; xor >>= 1n; }
    return dist;
  } catch(_) { return 64; }
}

function findHashDupe(objects, hash) {
  if (!hash) return null;
  for (const o of objects) {
    if (o.status !== 'accessioned') continue;
    for (const img of (o.images || [])) {
      if (img.hash && hashDistance(img.hash, hash) < 10) return o.accession;
    }
  }
  return null;
}

// Collection upload (separate multer to collection subdir)
const collectionStorage = multer.diskStorage({
  destination: COLLECTION_DIR,
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, name);
  }
});
const collectionUpload = multer({
  storage: collectionStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (HEIC raws can be large)
  fileFilter: (req, file, cb) => {
    // Accept image formats including HEIC
    const ok = /^image\/(jpeg|png|gif|webp|svg\+xml|heic|heif)$/.test(file.mimetype)
      || /\.(heic|heif)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only image files allowed'), ok);
  }
});

// ── Cutout job queue (one at a time; spawns python3 per job) ──────────────────
const cutoutJobs = new Map();
const cutoutQueue = [];
let cutoutRunning = false;

function runNextCutout() {
  if (cutoutRunning || cutoutQueue.length === 0) return;
  const job = cutoutQueue.shift();
  cutoutRunning = true;
  cutoutJobs.set(job.id, { status: 'running', startedAt: Date.now(), log: [] });

  const u2netHome = process.env.U2NET_HOME || path.join(DATA_DIR, 'u2net');
  const env = { ...process.env, U2NET_HOME: u2netHome };
  const args = [path.join(__dirname, 'pipeline/cutout.py'), job.src, job.dst];
  if (job.mode) args.push(job.mode);

  const python = fs.existsSync('/app/.venv/bin/python3') ? '/app/.venv/bin/python3' : 'python3';
  const child = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let peakKB = 0;

  const memTimer = setInterval(() => {
    try {
      const s = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
      const kb = parseInt(s.match(/VmRSS:\s+(\d+)/)?.[1] || 0, 10);
      if (kb > peakKB) peakKB = kb;
    } catch(_) {}
  }, 2000);

  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => {
    stderr += d;
    cutoutJobs.get(job.id)?.log.push(d.toString().slice(0, 200));
  });

  child.on('close', code => {
    clearInterval(memTimer);
    const peakMB = Math.round(peakKB / 1024);
    console.log(`[cutout] job ${job.id} code=${code} peakRSS≈${peakMB}MB`);
    cutoutRunning = false;
    if (code === 0) {
      let result = {};
      try { result = JSON.parse(stdout.trim()); } catch(_) {}
      cutoutJobs.set(job.id, { status: 'done', result: { ...result, peakMB }, dstUrl: job.dstUrl });
      // Auto-patch the object if accession+role are known
      if (job.accession && job.role) {
        try {
          const objects = readCollection();
          const idx = objects.findIndex(o => o.accession === job.accession);
          if (idx !== -1) {
            const images = (objects[idx].images || []).map(img => {
              if (img.role !== job.role) return img;
              return { ...img, src: job.dstUrl, cutout: true,
                w: result.w || img.w, h: result.h || img.h };
            });
            const bodyColour = job.role === 'front' && result.dominantColour
              ? result.dominantColour : objects[idx].bodyColour;
            objects[idx] = { ...objects[idx], images, bodyColour, updatedAt: new Date().toISOString() };
            writeCollection(objects);
            console.log(`[cutout] auto-patched ${job.accession} ${job.role} → ${job.dstUrl}`);
          }
        } catch(e) {
          console.error('[cutout] auto-patch failed:', e.message);
        }
      }
    } else {
      cutoutJobs.set(job.id, { status: 'error', error: stderr.slice(-800), peakMB });
    }
    runNextCutout();
  });
}

// ── Collection API routes ─────────────────────────────────────────────────────

// Public: list (hides pending/retired by default unless ?all=1)
app.get('/api/collection', (req, res) => {
  let objects = readCollection();
  if (!req.query.all) objects = objects.filter(o => o.status === 'accessioned');
  res.json(objects);
});

// Public: single object
app.get('/api/collection/:accession', (req, res) => {
  const obj = readCollection().find(o => o.accession === req.params.accession);
  if (!obj) return res.status(404).json({ error: 'Not found' });
  res.json(obj);
});

// Protected: create new object
app.post('/api/collection', requireAuth, (req, res) => {
  const objects = readCollection();
  const body    = req.body || {};
  const accession = body.status === 'pending' ? null : (body.accession || nextAccession());
  const seq       = body.seq || (Math.max(0, ...objects.map(o => o.seq || 0)) + 1);
  const now       = new Date().toISOString();
  const obj = {
    accession, seq,
    status:     body.status     || 'pending',
    type:       body.type       || 'Shirt',
    department: body.department || 'Music',
    maker:      body.maker      || '',
    title:      body.title      || '',
    date:       body.date       || null,
    description: body.description || null,
    sleeve:     body.sleeve     || null,
    label:      body.label      || null,
    detail:     body.detail     || null,
    bodyColour: body.bodyColour || null,
    provenance: body.provenance || null,
    condition:  body.condition  || null,
    note:       body.note       || null,
    seenIn:     body.seenIn     || null,
    seenInUrl:  body.seenInUrl  || null,
    media:      body.media      || null,
    images:     body.images     || [],
    createdAt:  now,
    updatedAt:  now,
  };
  objects.push(obj);
  writeCollection(objects);
  res.status(201).json(obj);
});

// Protected: patch single object (atomic)
app.patch('/api/collection/:accession', requireAuth, (req, res) => {
  const objects = readCollection();
  const idx     = objects.findIndex(o => o.accession === req.params.accession);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const updated = { ...objects[idx], ...req.body, updatedAt: new Date().toISOString() };
  // Prevent overwriting accession/seq accidentally
  updated.accession = objects[idx].accession;
  updated.seq       = objects[idx].seq;
  objects[idx] = updated;
  writeCollection(objects);
  res.json(objects[idx]);
});

// Protected: delete object
app.delete('/api/collection/:accession', requireAuth, (req, res) => {
  const objects = readCollection();
  const idx     = objects.findIndex(o => o.accession === req.params.accession);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const acc = objects[idx].accession;
  objects.splice(idx, 1);
  writeCollection(objects);
  if (acc) addTombstone(acc);
  res.json({ ok: true });
});

// Protected: patch pending draft by seq (accession is null for pending objects)
app.patch('/api/collection/by-seq/:seq', requireAuth, (req, res) => {
  const seq = parseInt(req.params.seq, 10);
  const objects = readCollection();
  const idx = objects.findIndex(o => o.seq === seq);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const updated = { ...objects[idx], ...req.body, updatedAt: new Date().toISOString() };
  updated.accession = objects[idx].accession;
  updated.seq       = objects[idx].seq;
  objects[idx] = updated;
  writeCollection(objects);
  res.json(objects[idx]);
});

// Protected: delete pending draft by seq
app.delete('/api/collection/by-seq/:seq', requireAuth, (req, res) => {
  const seq = parseInt(req.params.seq, 10);
  const objects = readCollection();
  const idx = objects.findIndex(o => o.seq === seq);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  objects.splice(idx, 1);
  writeCollection(objects);
  res.json({ ok: true });
});

// Protected: upload image to collection dir
app.post('/api/collection/upload', requireAuth, collectionUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({ url: '/uploads/collection/' + req.file.filename, filename: req.file.filename });
});

// Protected: bulk upload — processes image (resize, EXIF strip, hash, body colour)
app.post('/api/collection/bulk/upload', requireAuth, collectionUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const srcPath = req.file.path;
  const base    = path.basename(srcPath, path.extname(srcPath));
  const webpName = base + '.webp';
  const webpPath = path.join(COLLECTION_DIR, webpName);
  const webpUrl  = '/uploads/collection/' + webpName;
  const origUrl  = '/uploads/collection/' + req.file.filename;

  // Default result (used when sharp is absent)
  let result = { url: origUrl, originalUrl: origUrl, filename: req.file.filename, w: null, h: null, hash: null, bodyColour: '#888888', exif: {}, dupe: null };

  // Read EXIF date before processing (exifr reads original)
  let takenAt = null;
  if (exifr) {
    try {
      const parsed = await exifr.parse(srcPath, { pick: ['DateTimeOriginal', 'CreateDate'] });
      takenAt = (parsed?.DateTimeOriginal || parsed?.CreateDate || null)?.toISOString() ?? null;
    } catch(_) {}
  }

  if (sharp) {
    try {
      const img = sharp(srcPath).rotate();
      const { data, info } = await img
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .withMetadata(false)
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });

      fs.writeFileSync(webpPath, data);

      const [hash, bodyColour] = await Promise.all([computeHash(data), computeBodyColour(data)]);
      const dupe = findHashDupe(readCollection(), hash);

      // Remove original (we keep WebP only)
      try { fs.unlinkSync(srcPath); } catch(_) {}

      result = { url: webpUrl, originalUrl: webpUrl, filename: webpName, w: info.width, h: info.height, hash, bodyColour, exif: { takenAt }, dupe };
    } catch (err) {
      console.error('[bulk/upload] sharp error:', err.message);
      result.exif = { takenAt };
    }
  } else {
    result.exif = { takenAt };
  }

  res.json(result);
});

// Protected: atomic publish of selected pending drafts (by seq[])
app.post('/api/collection/bulk-publish', requireAuth, (req, res) => {
  const { seqs } = req.body || {};
  if (!Array.isArray(seqs) || !seqs.length) return res.status(400).json({ error: 'seqs[] required' });

  return withAccessionLock(async () => {
    const objects    = readCollection();
    const tombstones = readTombstones();
    const year       = new Date().getFullYear();
    const prefix     = `${year}.`;

    // Build set of already-used numbers (live + tombstones)
    const usedNums = new Set(
      [...objects.map(o => o.accession), ...tombstones]
        .filter(a => a && a.startsWith(prefix))
        .map(a => parseInt(a.split('.')[1], 10))
        .filter(n => !isNaN(n))
    );

    // Resolve seq → index, in order supplied
    const toPublish = [];
    for (const seq of seqs) {
      const idx = objects.findIndex(o => o.seq === seq);
      if (idx === -1) return res.status(400).json({ error: `seq ${seq} not found` });
      if (objects[idx].status !== 'pending') return res.status(400).json({ error: `seq ${seq} is not pending` });
      toPublish.push({ idx, obj: objects[idx] });
    }

    // Assign accessions sequentially
    const published = [];
    let n = usedNums.size ? Math.max(...usedNums) + 1 : 1;
    const now = new Date().toISOString();
    for (const { idx, obj } of toPublish) {
      const accession = `${year}.${String(n++).padStart(3, '0')}`;
      usedNums.add(n - 1);
      // Normalise images: accept either {src,role} or {url,plate} from any client
      const images = (obj.images || []).map(img => img.src ? img : { ...img, src: img.url, role: img.plate });
      objects[idx] = { ...obj, accession, status: 'accessioned', images, updatedAt: now };
      published.push({ seq: obj.seq, accession, title: obj.title, maker: obj.maker });
    }

    writeCollection(objects);

    // Auto-queue cutouts for front/back images when pipeline is enabled
    if (process.env.CUTOUT_ENABLED === 'true') {
      for (const { obj, idx } of toPublish) {
        const saved = objects[idx];
        for (const img of (saved.images || [])) {
          if (img.role !== 'front' && img.role !== 'back') continue;
          if (!img.src) continue;
          const srcPath = path.join(COLLECTION_DIR, path.basename(img.src.replace(/^\/uploads\/collection\//, '')));
          if (!fs.existsSync(srcPath)) continue;
          const outName = 'cut-' + path.basename(srcPath, path.extname(srcPath)) + '.webp';
          const dstPath = path.join(COLLECTION_DIR, outName);
          const dstUrl  = '/uploads/collection/' + outName;
          const jobId   = crypto.randomBytes(8).toString('hex');
          cutoutQueue.push({ id: jobId, src: srcPath, dst: dstPath, dstUrl, accession: saved.accession, role: img.role, mode: 'cutout' });
          console.log(`[cutout] queued ${saved.accession} ${img.role}`);
        }
      }
      runNextCutout();
    }

    res.json({ published });
  });
});

// Protected: AI suggestions for a pending draft
app.post('/api/collection/suggest', requireAuth, async (req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  const { imageUrls } = req.body || {};
  if (!Array.isArray(imageUrls) || !imageUrls.length) {
    return res.status(400).json({ error: 'imageUrls[] required' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Load up to 3 images from disk
  const imageContent = [];
  for (const url of imageUrls.slice(0, 3)) {
    const filePath = path.join(COLLECTION_DIR, path.basename(url));
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = fs.readFileSync(filePath);
      imageContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/webp', data: data.toString('base64') }
      });
    } catch(_) {}
  }
  if (!imageContent.length) return res.status(400).json({ error: 'No readable images found' });

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          ...imageContent,
          {
            type: 'text',
            text: `This is a vintage collectible item. From the photos, identify:\n1. maker (artist/band/brand name)\n2. title (e.g. "Self-Titled Tour", "1997 Tour")\n3. date (year or range, e.g. "1997" or "1997–98")\n4. label (the tag brand inside, e.g. "Anvil", "Giant", "Screen Stars", "Delta")\n5. description (one brief sentence, e.g. "Black cotton T-shirt with screen-printed logo")\n6. department (one of: Music, Art, Film & TV, Sport, Other)\n\nReply ONLY with JSON, no explanation:\n{"maker":"","title":"","date":"","label":"","description":"","department":""}\nLeave fields as empty string "" when genuinely uncertain.`
          }
        ]
      }]
    });

    const text = msg.content?.[0]?.text || '';
    let suggestions = {};
    try {
      const match = text.match(/\{[\s\S]*?\}/);
      if (match) suggestions = JSON.parse(match[0]);
    } catch(_) {}

    res.json({ suggestions, inputTokens: msg.usage?.input_tokens || 0, outputTokens: msg.usage?.output_tokens || 0 });
  } catch (err) {
    console.error('[suggest] error:', err.message);
    res.status(500).json({ error: 'AI suggestion failed: ' + err.message });
  }
});

// Protected: queue a cutout job
app.post('/api/collection/cutout', requireAuth, (req, res) => {
  if (process.env.CUTOUT_ENABLED !== 'true') {
    return res.status(503).json({
      error: 'Cutout pipeline is disabled on this server.',
      hint: 'Set CUTOUT_ENABLED=true in Railway env vars (requires ≥4GB RAM). Or run pipeline/cutout.py locally.',
    });
  }
  const { src, accession, role, mode } = req.body || {};
  if (!src) return res.status(400).json({ error: 'src required' });

  const srcPath = path.join(COLLECTION_DIR, path.basename(src.replace(/^\/uploads\/collection\//, '')));
  if (!fs.existsSync(srcPath)) return res.status(400).json({ error: 'Source file not found' });

  const outName = (mode === 'label_crop' ? 'crop-' : 'cut-') + path.basename(srcPath, path.extname(srcPath)) + '.webp';
  const dstPath = path.join(COLLECTION_DIR, outName);
  const dstUrl  = '/uploads/collection/' + outName;

  const jobId = crypto.randomBytes(8).toString('hex');
  cutoutQueue.push({ id: jobId, src: srcPath, dst: dstPath, dstUrl, accession, role, mode: mode || 'cutout' });
  runNextCutout();
  res.json({ jobId, position: cutoutQueue.length });
});

// Protected: poll cutout job status
app.get('/api/collection/jobs/:id', requireAuth, (req, res) => {
  const job = cutoutJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Collection pages (server-render meta for object URLs) ─────────────────────
const tcEsc = s => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

app.get('/collection', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'collection.html'), 'utf8');
    res.send(html.replace('<!-- TC_META -->', '<title>temporary collection · index</title>'));
  } catch(e) {
    res.sendFile(path.join(__dirname, 'public', 'collection.html'));
  }
});

app.get('/collection/:accession', (req, res) => {
  const objects = readCollection();
  const obj = objects.find(o => o.accession === req.params.accession);
  if (!obj) return res.status(404).sendFile(path.join(__dirname, 'public', 'collection.html'));

  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'public', 'collection.html'), 'utf8'); }
  catch(e) { return res.status(500).send('Template not found'); }

  const front   = (obj.images || []).find(i => i.role === 'front');
  const ogImage = front ? `https://${req.get('host')}${front.src}` : '';
  const title   = `${obj.accession} ${obj.maker}, ${obj.title} — temporary collection`;
  const descParts = [obj.maker, obj.title, obj.date, obj.type, obj.department].filter(Boolean);
  const desc    = descParts.join(', ') + '.';

  const meta = [
    `<title>${tcEsc(title)}</title>`,
    `<meta name="description" content="${tcEsc(desc)}">`,
    `<meta property="og:title" content="${tcEsc(title)}">`,
    `<meta property="og:description" content="${tcEsc(desc)}">`,
    `<meta property="og:type" content="website">`,
    ogImage ? `<meta property="og:image" content="${tcEsc(ogImage)}">` : '',
  ].filter(Boolean).join('\n  ');

  res.send(html.replace('<!-- TC_META -->', meta));
});

// ── Substack RSS ──────────────────────────────────────────────────────────────
// Set SUBSTACK_URL env var to your feed, e.g. https://yourname.substack.com/feed
// If not set, endpoint returns [] silently so the site still works.
const rssParser = new RSSParser({
  customFields: {
    item: [['content:encoded', 'contentEncoded']]
  }
});

let substackCache = { posts: null, fetchedAt: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
};
function decodeEntities(str) {
  return str.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
    }
    return HTML_ENTITIES[code] || m;
  });
}

app.get('/api/substack', async (req, res) => {
  const feedUrl = process.env.SUBSTACK_URL;
  if (!feedUrl) return res.json([]);

  // Return cache if fresh
  if (substackCache.posts && Date.now() - substackCache.fetchedAt < CACHE_TTL) {
    return res.json(substackCache.posts);
  }

  try {
    const feed = await rssParser.parseURL(feedUrl);
    const posts = (feed.items || []).map(item => {
      // Strip HTML tags from content to make a plain-text excerpt (~280 chars)
      const raw = item.contentEncoded || item.content || item.summary || '';
      const stripped = decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      const excerpt = stripped.length > 280
        ? stripped.slice(0, 280).replace(/\s+\S*$/, '') + '…'
        : stripped;

      return {
        source:   'substack',
        title:    decodeEntities(item.title || 'Untitled'),
        excerpt:  excerpt,
        link:     item.link     || feedUrl,
        date:     item.pubDate  || item.isoDate || '',
        type:     'Substack',
      };
    });

    substackCache = { posts, fetchedAt: Date.now() };
    res.json(posts);
  } catch (e) {
    console.error('Substack fetch failed:', e.message);
    // Return stale cache if available, otherwise empty
    res.json(substackCache.posts || []);
  }
});

// ── Fallback: serve main site for any non-API path ───────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Site    → http://localhost:${PORT}`);
  console.log(`  ✦ Admin   → http://localhost:${PORT}/admin`);
  console.log(`  ✦ Press Ctrl+C to stop\n`);

  // On startup, queue cutouts for any front/back image where cutout flag was set
  // prematurely (src === original) — fixes the batch uploaded without rembg processing.
  if (process.env.CUTOUT_ENABLED === 'true') {
    const objects = readCollection();
    let queued = 0;
    for (const obj of objects) {
      if (obj.status !== 'accessioned') continue;
      for (const img of (obj.images || [])) {
        if (img.role !== 'front' && img.role !== 'back') continue;
        if (!img.cutout || !img.src || img.src !== img.original) continue;
        const srcPath = path.join(COLLECTION_DIR, path.basename(img.src.replace(/^\/uploads\/collection\//, '')));
        if (!fs.existsSync(srcPath)) continue;
        const outName = 'cut-' + path.basename(srcPath, path.extname(srcPath)) + '.webp';
        const dstPath = path.join(COLLECTION_DIR, outName);
        if (fs.existsSync(dstPath)) continue; // already processed
        const dstUrl = '/uploads/collection/' + outName;
        const jobId  = crypto.randomBytes(8).toString('hex');
        cutoutQueue.push({ id: jobId, src: srcPath, dst: dstPath, dstUrl, accession: obj.accession, role: img.role, mode: 'cutout' });
        queued++;
      }
    }
    if (queued > 0) {
      console.log(`[cutout] startup: queued ${queued} pending cutout(s)`);
      runNextCutout();
    }
  }
});
