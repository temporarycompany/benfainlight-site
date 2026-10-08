const express   = require('express');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const { spawn } = require('child_process');
const RSSParser = require('rss-parser');

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

function nextAccession() {
  const year  = new Date().getFullYear();
  const objs  = readCollection();
  const nums  = objs
    .map(o => o.accession)
    .filter(a => a && a.startsWith(String(year) + '.'))
    .map(a => parseInt(a.split('.')[1], 10))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${year}.${String(next).padStart(3, '0')}`;
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

  const child = spawn('python3', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  objects.splice(idx, 1);
  writeCollection(objects);
  res.json({ ok: true });
});

// Protected: upload image to collection dir
app.post('/api/collection/upload', requireAuth, collectionUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({ url: '/uploads/collection/' + req.file.filename, filename: req.file.filename });
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
});
